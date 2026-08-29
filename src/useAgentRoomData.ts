import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessage, GameObservation } from "../shared/types";
import {
  ApiError,
  observePublicGame,
  readPublicChat,
  readPublicChatHistory,
  readPublicGameFrame
} from "./api";
import { useSession } from "./hooks/useSession";
import { mergeBySequence } from "./lib/sequence";
import { registerRoomTools, type WebMcpStatus } from "./webmcp";

const POLL_INTERVAL_MS = 5_000;
const MAX_VISIBLE_CHAT_MESSAGES = 30;

export function pollAgentRoom(roomId: string, after: number | null) {
  return Promise.allSettled([
    observePublicGame(roomId),
    after === null ? readPublicChatHistory(roomId) : readPublicChat(roomId, after)
  ]);
}

export function useAgentRoomData() {
  const { session, sessionError, sessionLoading, dismissSessionError } = useSession();
  const [game, setGame] = useState<GameObservation | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [frameObjectUrl, setFrameObjectUrl] = useState<string | null>(null);
  const [webMcpStatus, setWebMcpStatus] = useState<WebMcpStatus>("registering");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const chatCursor = useRef(0);
  const chatReady = useRef(false);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const frameUrl = useRef<string | null>(null);
  const frameRevision = useRef<number | null>(null);
  const active = useRef(true);

  const refresh = useCallback((): Promise<void> => {
    if (!session) return Promise.resolve();
    if (refreshRequest.current) return refreshRequest.current;

    const request = (async () => {
      const [gameResult, chatResult] = await pollAgentRoom(
        session.roomId,
        chatReady.current ? chatCursor.current : null
      );
      if (!active.current) return;
      const failures: unknown[] = [];
      let updated = false;

      if (gameResult.status === "fulfilled") {
        setGame(gameResult.value);
        updated = true;
        if (frameRevision.current !== gameResult.value.frameRevision) {
          try {
            const blob = await readPublicGameFrame(gameResult.value.frameUrl);
            if (!active.current) return;
            const nextUrl = URL.createObjectURL(blob);
            const previousUrl = frameUrl.current;
            frameRevision.current = gameResult.value.frameRevision;
            frameUrl.current = nextUrl;
            setFrameObjectUrl(nextUrl);
            if (previousUrl) URL.revokeObjectURL(previousUrl);
          } catch (cause) {
            failures.push(cause);
          }
        }
      } else {
        failures.push(gameResult.reason);
      }

      if (chatResult.status === "fulfilled") {
        const messages = chatResult.value.messages;
        const cursor = "cursor" in chatResult.value
          ? chatResult.value.cursor
          : messages.at(-1)?.sequence ?? 0;
        chatCursor.current = Math.max(chatCursor.current, cursor);
        chatReady.current = true;
        setChat((current) =>
          mergeBySequence(current, messages).slice(-MAX_VISIBLE_CHAT_MESSAGES)
        );
        updated = true;
      } else {
        failures.push(chatResult.reason);
      }

      if (updated) setLastUpdatedAt(Date.now());
      setRefreshError(failures.length === 0 ? null : messageOf(failures[0]));
    })().finally(() => {
      refreshRequest.current = null;
    });

    refreshRequest.current = request;
    return request;
  }, [session]);

  useEffect(() => {
    if (!session) return;
    chatCursor.current = 0;
    chatReady.current = false;
    setChat([]);
    setGame(null);
    let stopped = false;
    let timer: number | undefined;

    const tick = async () => {
      const startedAt = Date.now();
      await refresh();
      if (stopped) return;
      const delay = Math.max(0, POLL_INTERVAL_MS - (Date.now() - startedAt));
      timer = window.setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, session]);

  useEffect(() => {
    if (!session) return;
    return registerRoomTools(session.roomId, setWebMcpStatus);
  }, [session]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    };
  }, []);

  return {
    session,
    game,
    chat,
    frameObjectUrl,
    webMcpStatus,
    error: sessionError ?? refreshError,
    loading: sessionLoading || game === null,
    lastUpdatedAt,
    dismissError: () => {
      dismissSessionError();
      setRefreshError(null);
    }
  };
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 401) {
    window.location.reload();
  }
  return cause instanceof Error ? cause.message : String(cause);
}
