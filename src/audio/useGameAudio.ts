import { useCallback, useEffect, useRef, useState } from "react";

import { gameAudioUrl, sessionSocketProtocols } from "../api";
import audioWorkletUrl from "./game-audio-worklet.js?url&no-inline";
import {
  GAME_AUDIO_SAMPLE_RATE,
  isGameAudioConfig,
  parseGameAudioPacket
} from "./audio-protocol";

export type GameAudioState =
  | "off"
  | "starting"
  | "buffering"
  | "live"
  | "retrying"
  | "error";

interface AudioResources {
  context: AudioContext;
  node: AudioWorkletNode;
  socket?: WebSocket;
  retryTimer?: number;
}

export function useGameAudio(roomId: string, available: boolean) {
  const [state, setState] = useState<GameAudioState>("off");
  const generation = useRef(0);
  const requested = useRef(false);
  const resources = useRef<AudioResources | null>(null);

  const stop = useCallback(() => {
    requested.current = false;
    generation.current += 1;
    const current = resources.current;
    resources.current = null;
    if (current?.retryTimer !== undefined) window.clearTimeout(current.retryTimer);
    current?.socket?.close(1000, "sound stopped");
    current?.node.disconnect();
    if (current !== null) void current.context.close();
    setState("off");
  }, []);

  const start = useCallback(async () => {
    if (!available || requested.current) return;
    requested.current = true;
    setState("starting");
    const currentGeneration = ++generation.current;
    let pendingContext: AudioContext | undefined;

    try {
      const context = new AudioContext({
        latencyHint: "interactive",
        sampleRate: GAME_AUDIO_SAMPLE_RATE
      });
      pendingContext = context;
      await context.audioWorklet.addModule(audioWorkletUrl);
      if (!requested.current || currentGeneration !== generation.current) {
        await context.close();
        return;
      }
      const node = new AudioWorkletNode(context, "game-audio", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      node.connect(context.destination);
      await context.resume();
      const current: AudioResources = { context, node };
      resources.current = current;
      pendingContext = undefined;

      node.port.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!requested.current || currentGeneration !== generation.current) return;
        if (!isAudioWorkletState(event.data)) return;
        setState(event.data.state === "playing" ? "live" : "buffering");
      });
      node.port.start();

      let reconnectAttempt = 0;
      const connect = (): void => {
        if (!requested.current || currentGeneration !== generation.current) return;
        setState(reconnectAttempt === 0 ? "buffering" : "retrying");
        let configured = false;
        let lastSequence = -1;
        const socket = new WebSocket(gameAudioUrl(roomId), sessionSocketProtocols());
        current.socket = socket;
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          reconnectAttempt = 0;
        });
        socket.addEventListener("message", (event) => {
          if (!requested.current || currentGeneration !== generation.current) return;
          if (typeof event.data === "string") {
            if (!isGameAudioConfig(event.data)) {
              socket.close(1002, "audio configuration is not valid");
              return;
            }
            configured = true;
            return;
          }
          if (!configured || !(event.data instanceof ArrayBuffer)) return;
          const packet = parseGameAudioPacket(event.data, lastSequence);
          if (packet === null) return;
          lastSequence = packet.sequence;
          node.port.postMessage({ type: "audio", pcm: packet.pcm }, [packet.pcm]);
        });
        socket.addEventListener("close", () => {
          if (!requested.current || currentGeneration !== generation.current) return;
          setState("retrying");
          const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt);
          reconnectAttempt += 1;
          current.retryTimer = window.setTimeout(connect, delay);
        });
        socket.addEventListener("error", () => socket.close());
      };

      connect();
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      console.error("game audio could not start", cause);
      requested.current = false;
      const current = resources.current;
      resources.current = null;
      current?.node.disconnect();
      if (current !== null) void current.context.close();
      if (pendingContext !== undefined) void pendingContext.close();
      setState("error");
    }
  }, [available, roomId]);

  useEffect(() => stop, [roomId, stop]);

  useEffect(() => {
    if (!available && requested.current) stop();
  }, [available, stop]);

  return { state, start, stop };
}

function isAudioWorkletState(
  value: unknown
): value is { type: "state"; state: "playing" | "buffering" } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "state" &&
    (candidate.state === "playing" || candidate.state === "buffering")
  );
}
