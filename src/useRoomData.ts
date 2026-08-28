import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ChatMessage,
  ComputerEvent,
  ComputerFileHistoryEntry,
  ComputerFileView,
  ComputerOverview,
  ComputerTreeEntry,
  GameObservation,
  SocketEnvelope
} from "../shared/types";
import {
  ApiError,
  observeGame,
  readChat,
  readChatHistory,
  readComputer,
  readComputerEventHistory,
  readFile,
  readHistory,
  readTree,
  sessionSocketProtocols,
  socketUrl
} from "./api";
import { useSession } from "./hooks/useSession";
import { mergeBySequence } from "./lib/sequence";
import { registerRoomTools, type WebMcpStatus } from "./webmcp";

type ConnectionState = "connecting" | "open" | "closed";

export function useRoomData() {
  const { session, sessionError, sessionLoading, dismissSessionError } = useSession();
  const [game, setGame] = useState<GameObservation | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatHasMore, setChatHasMore] = useState(false);
  const [chatLoadingOlder, setChatLoadingOlder] = useState(false);
  const [computer, setComputer] = useState<ComputerOverview | null>(null);
  const [computerEvents, setComputerEvents] = useState<ComputerEvent[]>([]);
  const [computerEventsHaveMore, setComputerEventsHaveMore] = useState(false);
  const [computerEventsLoadingOlder, setComputerEventsLoadingOlder] = useState(false);
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
  const chatNewestCursor = useRef(0);
  const chatNextBefore = useRef<number | null>(null);
  const chatReady = useRef(false);
  const chatInitialRequest = useRef<Promise<void> | null>(null);
  const chatOlderRequest = useRef(false);
  const computerNewestCursor = useRef(0);
  const computerNextBefore = useRef<number | null>(null);
  const computerReady = useRef(false);
  const computerInitialRequest = useRef<Promise<void> | null>(null);
  const computerOlderRequest = useRef(false);
  const gameRequest = useRef<Promise<void> | null>(null);
  const chatRefreshRequest = useRef<Promise<void> | null>(null);
  const computerRefreshRequest = useRef<Promise<void> | null>(null);
  const treeRequests = useRef(new Map<string, Promise<void>>());
  const selectedPathRef = useRef(selectedPath);
  const selectedFileRequest = useRef<{ path: string; request: Promise<void> } | null>(null);
  selectedPathRef.current = selectedPath;

  const refreshGame = useCallback((): Promise<void> => {
    if (!session) return Promise.resolve();
    if (gameRequest.current) return gameRequest.current;
    const request = (async () => {
      try {
        setGame(await observeGame(session.roomId));
      } catch (cause) {
        reportNonAuthError(cause, setError);
      } finally {
        gameRequest.current = null;
      }
    })();
    gameRequest.current = request;
    return request;
  }, [session]);

  const loadInitialChat = useCallback((): Promise<void> => {
    if (!session || chatReady.current) return Promise.resolve();
    if (chatInitialRequest.current) return chatInitialRequest.current;
    const request = (async () => {
      try {
        const response = await readChatHistory(session.roomId);
        chatNextBefore.current = response.nextBefore;
        chatNewestCursor.current = Math.max(
          chatNewestCursor.current,
          response.messages.at(-1)?.sequence ?? 0
        );
        setChatHasMore(response.hasMore);
        setChat((current) => mergeBySequence(current, response.messages));
        chatReady.current = true;
      } catch (cause) {
        reportNonAuthError(cause, setError);
      } finally {
        chatInitialRequest.current = null;
      }
    })();
    chatInitialRequest.current = request;
    return request;
  }, [session]);

  const loadInitialComputerEvents = useCallback((): Promise<void> => {
    if (!session || computerReady.current) return Promise.resolve();
    if (computerInitialRequest.current) return computerInitialRequest.current;
    const request = (async () => {
      try {
        const response = await readComputerEventHistory(session.roomId);
        computerNextBefore.current = response.nextBefore;
        computerNewestCursor.current = Math.max(
          computerNewestCursor.current,
          response.events.at(-1)?.sequence ?? 0
        );
        setComputerEventsHaveMore(response.hasMore);
        setComputerEvents((current) => mergeBySequence(current, response.events));
        setComputer({
          roomId: response.roomId,
          filesystemRevision: response.filesystemRevision,
          events: response.events
        });
        computerReady.current = true;
      } catch (cause) {
        reportNonAuthError(cause, setError);
      } finally {
        computerInitialRequest.current = null;
      }
    })();
    computerInitialRequest.current = request;
    return request;
  }, [session]);

  const refreshChat = useCallback((): Promise<void> => {
    if (!session) return Promise.resolve();
    if (chatRefreshRequest.current) return chatRefreshRequest.current;
    const request = (async () => {
      if (!chatReady.current) {
        await loadInitialChat();
        return;
      }
      try {
        const response = await readChat(session.roomId, chatNewestCursor.current);
        chatNewestCursor.current = Math.max(chatNewestCursor.current, response.cursor);
        setChat((current) => mergeBySequence(current, response.messages));
      } catch (cause) {
        reportNonAuthError(cause, setError);
      }
    })().finally(() => {
      chatRefreshRequest.current = null;
    });
    chatRefreshRequest.current = request;
    return request;
  }, [loadInitialChat, session]);

  const refreshComputer = useCallback((): Promise<void> => {
    if (!session) return Promise.resolve();
    if (computerRefreshRequest.current) return computerRefreshRequest.current;
    const request = (async () => {
      if (!computerReady.current) {
        await loadInitialComputerEvents();
        return;
      }
      try {
        const response = await readComputer(session.roomId, computerNewestCursor.current);
        setComputer(response);
        computerNewestCursor.current = Math.max(
          computerNewestCursor.current,
          response.events.at(-1)?.sequence ?? 0
        );
        setComputerEvents((current) => mergeBySequence(current, response.events));
      } catch (cause) {
        reportNonAuthError(cause, setError);
      }
    })().finally(() => {
      computerRefreshRequest.current = null;
    });
    computerRefreshRequest.current = request;
    return request;
  }, [loadInitialComputerEvents, session]);

  const loadOlderChat = useCallback(async (): Promise<void> => {
    if (!session || chatOlderRequest.current || chatNextBefore.current === null) return;
    chatOlderRequest.current = true;
    setChatLoadingOlder(true);
    try {
      const response = await readChatHistory(session.roomId, chatNextBefore.current);
      chatNextBefore.current = response.nextBefore;
      setChatHasMore(response.hasMore);
      setChat((current) => mergeBySequence(current, response.messages));
    } catch (cause) {
      reportNonAuthError(cause, setError);
    } finally {
      chatOlderRequest.current = false;
      setChatLoadingOlder(false);
    }
  }, [session]);

  const loadOlderComputerEvents = useCallback(async (): Promise<void> => {
    if (!session || computerOlderRequest.current || computerNextBefore.current === null) return;
    computerOlderRequest.current = true;
    setComputerEventsLoadingOlder(true);
    try {
      const response = await readComputerEventHistory(
        session.roomId,
        computerNextBefore.current
      );
      computerNextBefore.current = response.nextBefore;
      setComputerEventsHaveMore(response.hasMore);
      setComputerEvents((current) => mergeBySequence(current, response.events));
      setComputer((current) =>
        current
          ? { ...current, filesystemRevision: response.filesystemRevision }
          : {
              roomId: response.roomId,
              filesystemRevision: response.filesystemRevision,
              events: []
            }
      );
    } catch (cause) {
      reportNonAuthError(cause, setError);
    } finally {
      computerOlderRequest.current = false;
      setComputerEventsLoadingOlder(false);
    }
  }, [session]);

  const loadTree = useCallback(
    (path: string): Promise<void> => {
      if (!session) return Promise.resolve();
      const current = treeRequests.current.get(path);
      if (current) return current;
      const request = (async () => {
        try {
          const response = await readTree(session.roomId, path);
          setTreeByPath((value) => ({ ...value, [path]: response.entries }));
        } catch (cause) {
          reportNonAuthError(cause, setError);
        } finally {
          treeRequests.current.delete(path);
        }
      })();
      treeRequests.current.set(path, request);
      return request;
    },
    [session]
  );

  const loadSelectedFile = useCallback((): Promise<void> => {
    if (!session || !selectedPath) return Promise.resolve();
    if (selectedFileRequest.current?.path === selectedPath) {
      return selectedFileRequest.current.request;
    }
    const requestedPath = selectedPath;
    const request = (async () => {
      try {
        const [file, history] = await Promise.all([
          readFile(session.roomId, requestedPath),
          readHistory(session.roomId, requestedPath)
        ]);
        if (requestedPath !== selectedPathRef.current) return;
        setSelectedFile(file);
        setFileHistory(history.history);
      } catch (cause) {
        if (requestedPath !== selectedPathRef.current) return;
        setSelectedFile(null);
        setFileHistory([]);
        if (!(cause instanceof ApiError && cause.status === 404)) {
          reportNonAuthError(cause, setError);
        }
      } finally {
        if (selectedFileRequest.current?.path === requestedPath) {
          selectedFileRequest.current = null;
        }
      }
    })();
    selectedFileRequest.current = { path: requestedPath, request };
    return request;
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
    chatNewestCursor.current = 0;
    chatNextBefore.current = null;
    chatReady.current = false;
    computerNewestCursor.current = 0;
    computerNextBefore.current = null;
    computerReady.current = false;
    setChat([]);
    setChatHasMore(false);
    setComputerEvents([]);
    setComputerEventsHaveMore(false);
    void Promise.all([
      refreshGame(),
      loadInitialChat(),
      loadInitialComputerEvents(),
      loadTree("/workspace"),
      loadSelectedFile()
    ]);
  }, [
    loadInitialChat,
    loadInitialComputerEvents,
    loadSelectedFile,
    loadTree,
    refreshGame,
    session
  ]);

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
        computerNewestCursor.current = Math.max(computerNewestCursor.current, event.sequence);
        setComputerEvents((current) => mergeBySequence(current, [event]));
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
    chatHasMore,
    chatLoadingOlder,
    computer,
    computerEvents,
    computerEventsHaveMore,
    computerEventsLoadingOlder,
    treeByPath,
    expandedPaths,
    selectedPath,
    selectedFile,
    fileHistory,
    gameSocket,
    computerSocket,
    webMcpStatus,
    error: sessionError ?? error,
    loading: sessionLoading || game === null,
    loadOlderChat,
    loadOlderComputerEvents,
    toggleDirectory,
    selectFile,
    dismissError: () => {
      dismissSessionError();
      setError(null);
    }
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
    socket = new WebSocket(url, sessionSocketProtocols());
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
