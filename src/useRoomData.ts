import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ChatMessage,
  ComputerEvent,
  ComputerFileHistoryEntry,
  ComputerFileView,
  ComputerOverview,
  ComputerTreeEntry,
  GameInput,
  GameObservation,
  SessionInfo,
  SocketEnvelope
} from "../shared/types";
import {
  ApiError,
  observeGame,
  readChat,
  readComputer,
  readFile,
  readHistory,
  readTree,
  sendChat,
  socketUrl,
  startSession,
  submitVote
} from "./api";
import { registerRoomTools, type WebMcpStatus } from "./webmcp";

type ConnectionState = "connecting" | "open" | "closed";

let sessionRequest: Promise<SessionInfo> | undefined;

export function useRoomData() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [game, setGame] = useState<GameObservation | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [computer, setComputer] = useState<ComputerOverview | null>(null);
  const [computerEvents, setComputerEvents] = useState<ComputerEvent[]>([]);
  const [treeByPath, setTreeByPath] = useState<Record<string, ComputerTreeEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(["/workspace"])
  );
  const [selectedPath, setSelectedPath] = useState("/workspace/current_goal.md");
  const [selectedFile, setSelectedFile] = useState<ComputerFileView | null>(null);
  const [fileHistory, setFileHistory] = useState<ComputerFileHistoryEntry[]>([]);
  const [gameSocket, setGameSocket] = useState<ConnectionState>("connecting");
  const [computerSocket, setComputerSocket] = useState<ConnectionState>("connecting");
  const [webMcpStatus, setWebMcpStatus] = useState<WebMcpStatus>("registering");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const chatCursor = useRef(0);
  const computerCursor = useRef(0);

  useEffect(() => {
    let active = true;
    sessionRequest ??= startSession();
    void sessionRequest
      .then((value) => {
        if (active) setSession(value);
      })
      .catch((cause: unknown) => {
        sessionRequest = undefined;
        if (active) setError(messageOf(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshGame = useCallback(async () => {
    if (!session) return;
    try {
      setGame(await observeGame(session.roomId));
    } catch (cause) {
      reportNonAuthError(cause, setError);
    }
  }, [session]);

  const refreshChat = useCallback(async () => {
    if (!session) return;
    try {
      const response = await readChat(session.roomId, chatCursor.current);
      chatCursor.current = response.cursor;
      if (response.messages.length > 0) {
        setChat((current) => appendUnique(current, response.messages, (item) => item.sequence, 160));
      }
    } catch (cause) {
      reportNonAuthError(cause, setError);
    }
  }, [session]);

  const refreshComputer = useCallback(async () => {
    if (!session) return;
    try {
      const response = await readComputer(session.roomId, computerCursor.current);
      setComputer(response);
      computerCursor.current = response.events.at(-1)?.sequence ?? computerCursor.current;
      if (response.events.length > 0) {
        setComputerEvents((current) =>
          appendUnique(current, response.events, (item) => item.sequence, 120)
        );
      }
    } catch (cause) {
      reportNonAuthError(cause, setError);
    }
  }, [session]);

  const loadTree = useCallback(
    async (path: string) => {
      if (!session) return;
      try {
        const response = await readTree(session.roomId, path);
        setTreeByPath((current) => ({ ...current, [path]: response.entries }));
      } catch (cause) {
        reportNonAuthError(cause, setError);
      }
    },
    [session]
  );

  const loadSelectedFile = useCallback(async () => {
    if (!session || !selectedPath) return;
    try {
      const [file, history] = await Promise.all([
        readFile(session.roomId, selectedPath),
        readHistory(session.roomId, selectedPath)
      ]);
      setSelectedFile(file);
      setFileHistory(history.history);
    } catch (cause) {
      setSelectedFile(null);
      setFileHistory([]);
      if (!(cause instanceof ApiError && cause.status === 404)) {
        reportNonAuthError(cause, setError);
      }
    }
  }, [selectedPath, session]);

  const refreshAll = useCallback(() => {
    void refreshGame();
    void refreshChat();
    void refreshComputer();
    void loadTree("/workspace");
    void loadSelectedFile();
  }, [loadSelectedFile, loadTree, refreshChat, refreshComputer, refreshGame]);

  useEffect(() => {
    if (!session) return;
    chatCursor.current = 0;
    computerCursor.current = 0;
    void Promise.all([
      refreshGame(),
      refreshChat(),
      refreshComputer(),
      loadTree("/workspace"),
      loadSelectedFile()
    ]);
  }, [loadSelectedFile, loadTree, refreshChat, refreshComputer, refreshGame, session]);

  useEffect(() => {
    if (!session) return;
    const gameTimer = window.setInterval(() => void refreshGame(), 2_000);
    const chatTimer = window.setInterval(() => void refreshChat(), 2_500);
    const computerTimer = window.setInterval(() => void refreshComputer(), 3_000);
    const treeTimer = window.setInterval(() => {
      void loadTree("/workspace");
      void loadSelectedFile();
    }, 4_000);
    return () => {
      window.clearInterval(gameTimer);
      window.clearInterval(chatTimer);
      window.clearInterval(computerTimer);
      window.clearInterval(treeTimer);
    };
  }, [loadSelectedFile, loadTree, refreshChat, refreshComputer, refreshGame, session]);

  useEffect(() => {
    if (!session) return;
    return connectRoomSocket(
      socketUrl(session.roomId, "game"),
      setGameSocket,
      () => {
        void refreshGame();
        void refreshChat();
      }
    );
  }, [refreshChat, refreshGame, session]);

  useEffect(() => {
    if (!session) return;
    return connectRoomSocket(
      socketUrl(session.roomId, "computer"),
      setComputerSocket,
      (envelope) => {
        if (envelope.source !== "computer") return;
        const event = envelope.payload as ComputerEvent;
        if (typeof event?.sequence !== "number") return;
        computerCursor.current = Math.max(computerCursor.current, event.sequence);
        setComputerEvents((current) => appendUnique(current, [event], (item) => item.sequence, 120));
        setComputer((current) =>
          current ? { ...current, filesystemRevision: event.filesystemRevision } : current
        );
      }
    );
  }, [session]);

  useEffect(() => {
    if (!session) return;
    return registerRoomTools(session.roomId, setWebMcpStatus, refreshAll);
  }, [refreshAll, session]);

  const vote = useCallback(
    async (input: GameInput) => {
      if (!session) return;
      try {
        setGame(await submitVote(session.roomId, input));
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [session]
  );

  const postChat = useCallback(
    async (message: string) => {
      if (!session) return;
      try {
        const created = await sendChat(session.roomId, message);
        chatCursor.current = Math.max(chatCursor.current, created.sequence);
        setChat((current) => appendUnique(current, [created], (item) => item.sequence, 160));
      } catch (cause) {
        setError(messageOf(cause));
        throw cause;
      }
    },
    [session]
  );

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!treeByPath[path]) void loadTree(path);
    },
    [loadTree, treeByPath]
  );

  const selectFile = useCallback((path: string) => setSelectedPath(path), []);

  useEffect(() => {
    void loadSelectedFile();
  }, [loadSelectedFile]);

  return {
    session,
    game,
    chat,
    computer,
    computerEvents,
    treeByPath,
    expandedPaths,
    selectedPath,
    selectedFile,
    fileHistory,
    gameSocket,
    computerSocket,
    webMcpStatus,
    error,
    loading,
    vote,
    postChat,
    toggleDirectory,
    selectFile,
    dismissError: () => setError(null)
  };
}

function connectRoomSocket(
  url: string,
  setState: (state: ConnectionState) => void,
  onEnvelope: (envelope: SocketEnvelope) => void
): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retryTimer: number | undefined;
  let attempt = 0;

  const connect = () => {
    if (stopped) return;
    setState("connecting");
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      attempt = 0;
      setState("open");
    });
    socket.addEventListener("message", (event) => {
      try {
        onEnvelope(JSON.parse(String(event.data)) as SocketEnvelope);
      } catch {
        // Ignore a malformed frame. The polling path still repairs the view.
      }
    });
    socket.addEventListener("close", () => {
      setState("closed");
      if (stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      attempt += 1;
      retryTimer = window.setTimeout(connect, delay);
    });
    socket.addEventListener("error", () => socket?.close());
  };
  connect();
  return () => {
    stopped = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    socket?.close(1000, "page closed");
  };
}

function appendUnique<T>(
  current: T[],
  incoming: T[],
  key: (item: T) => number,
  limit: number
): T[] {
  const map = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) map.set(key(item), item);
  return [...map.values()].sort((left, right) => key(left) - key(right)).slice(-limit);
}

function reportNonAuthError(cause: unknown, setError: (message: string) => void): void {
  if (cause instanceof ApiError && cause.status === 401) {
    window.location.reload();
    return;
  }
  setError(messageOf(cause));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
