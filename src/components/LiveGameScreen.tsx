import { useEffect, useRef, useState } from "react";

import type { PokemonPartySnapshot } from "../../shared/types";
import { gameStreamUrl, readGameFrame, sessionSocketProtocols } from "../api";

type StreamState = "checkpoint" | "connecting" | "live" | "retrying";

interface LiveGameScreenProps {
  roomId: string;
  frameUrl: string;
  alt: string;
  mode: "demo" | "rom";
  onPartyUpdate?: (snapshot: PokemonPartySnapshot) => void;
}

export function LiveGameScreen({
  roomId,
  frameUrl,
  alt,
  mode,
  onPartyUpdate
}: LiveGameScreenProps) {
  const enabled = mode === "rom";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [checkpointUrl, setCheckpointUrl] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>(
    enabled ? "connecting" : "checkpoint"
  );

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setCheckpointUrl(null);
    void readGameFrame(frameUrl)
      .then((frame) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(frame);
        setCheckpointUrl(objectUrl);
      })
      .catch(() => {
        if (active) setCheckpointUrl(null);
      });
    return () => {
      active = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [frameUrl]);

  useEffect(() => {
    if (!enabled) {
      setStreamState("checkpoint");
      return;
    }

    let stopped = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let attempt = 0;
    let connectionGeneration = 0;
    let displayingLiveFrame = false;
    let latestFrame:
      | { data: ArrayBuffer; generation: number; source: WebSocket }
      | undefined;
    let drawing = false;

    const drawLatestFrame = async (): Promise<void> => {
      if (drawing || stopped || latestFrame === undefined) return;
      const frame = latestFrame;
      latestFrame = undefined;
      drawing = true;
      try {
        const bitmap = await createImageBitmap(new Blob([frame.data], { type: "image/png" }));
        try {
          if (
            stopped ||
            frame.generation !== connectionGeneration ||
            frame.source.readyState !== WebSocket.OPEN
          ) {
            return;
          }
          const canvas = canvasRef.current;
          const context = canvas?.getContext("2d", { alpha: false });
          if (!canvas || !context) {
            throw new Error("game canvas is unavailable");
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          context.imageSmoothingEnabled = false;
          context.drawImage(bitmap, 0, 0);
          if (!displayingLiveFrame) {
            displayingLiveFrame = true;
            setStreamState("live");
          }
        } finally {
          bitmap.close();
        }
      } catch {
        latestFrame = undefined;
        if (frame.generation === connectionGeneration) {
          frame.source.close(1011, "frame decode failed");
        }
      } finally {
        drawing = false;
        if (latestFrame !== undefined) void drawLatestFrame();
      }
    };

    const connect = (): void => {
      if (stopped) return;
      setStreamState(attempt === 0 ? "connecting" : "retrying");
      displayingLiveFrame = false;
      const generation = ++connectionGeneration;
      const nextSocket = new WebSocket(gameStreamUrl(roomId), sessionSocketProtocols());
      socket = nextSocket;
      nextSocket.binaryType = "arraybuffer";
      nextSocket.addEventListener("open", () => {
        if (generation === connectionGeneration) attempt = 0;
      });
      nextSocket.addEventListener("message", (event) => {
        if (generation !== connectionGeneration) return;
        if (typeof event.data === "string") {
          const snapshot = parsePartyMessage(event.data);
          if (snapshot !== null) onPartyUpdate?.(snapshot);
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        latestFrame = { data: event.data, generation, source: nextSocket };
        void drawLatestFrame();
      });
      nextSocket.addEventListener("close", () => {
        if (stopped || generation !== connectionGeneration) return;
        connectionGeneration += 1;
        displayingLiveFrame = false;
        latestFrame = undefined;
        setStreamState("retrying");
        const delay = Math.min(5_000, 250 * 2 ** attempt);
        attempt += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
      nextSocket.addEventListener("error", () => nextSocket.close());
    };

    connect();
    return () => {
      stopped = true;
      connectionGeneration += 1;
      latestFrame = undefined;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close(1000, "page closed");
    };
  }, [enabled, onPartyUpdate, roomId]);

  const live = streamState === "live";
  return (
    <div className="game-screen-media" data-stream-state={streamState}>
      {checkpointUrl !== null ? (
        <img className="game-screen game-frame-fallback" src={checkpointUrl} alt={alt} />
      ) : null}
      <div className={`game-stream-layer${live ? " is-live" : ""}`} aria-hidden="true">
        <canvas
          ref={canvasRef}
          className="game-screen game-stream-canvas"
          width="160"
          height="144"
        />
      </div>
      <span className="screen-mode">{streamLabel(mode, streamState)}</span>
    </div>
  );
}

export function parsePartyMessage(message: string): PokemonPartySnapshot | null {
  try {
    const envelope = JSON.parse(message) as { type?: unknown; payload?: unknown };
    if (envelope.type !== "pokemon.party" || !isPartySnapshot(envelope.payload)) return null;
    return envelope.payload;
  } catch {
    return null;
  }
}

function isPartySnapshot(value: unknown): value is PokemonPartySnapshot {
  if (!isRecord(value) || typeof value.available !== "boolean" || !Array.isArray(value.party)) {
    return false;
  }
  if (value.party.length > 6) return false;
  return value.party.every((member) => {
    if (!isRecord(member)) return false;
    return (
      isIntegerInRange(member.slot, 1, 6) &&
      typeof member.nickname === "string" &&
      typeof member.species === "string" &&
      isIntegerInRange(member.pokedexNumber, 1, 151) &&
      isIntegerInRange(member.level, 1, 100) &&
      isIntegerInRange(member.hp, 0, 999) &&
      isIntegerInRange(member.maxHp, 1, 999) &&
      member.hp <= member.maxHp &&
      isIntegerInRange(member.experience, 0, 0xffffff) &&
      isIntegerInRange(member.xpEarnedThisLevel, 0, 0xffffff) &&
      isIntegerInRange(member.xpNeededThisLevel, 0, 0xffffff) &&
      member.xpEarnedThisLevel <= member.xpNeededThisLevel &&
      (member.level === 100
        ? member.xpEarnedThisLevel === 0 && member.xpNeededThisLevel === 0
        : member.xpNeededThisLevel > 0) &&
      ["OK", "SLP", "PSN", "BRN", "FRZ", "PAR", "FNT"].includes(String(member.status)) &&
      typeof member.active === "boolean" &&
      typeof member.fainted === "boolean"
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function streamLabel(mode: "demo" | "rom", state: StreamState): string {
  if (mode === "demo") return "DEMO MAP";
  if (state === "live") return "LIVE · 30 FPS";
  if (state === "retrying") return "CHECKPOINT · RETRYING";
  return "STREAM CONNECTING";
}
