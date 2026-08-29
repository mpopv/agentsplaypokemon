import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ChatMessage,
  ComputerEvent,
  ComputerFileView,
  ComputerOverview,
  ComputerTreeEntry,
  GameObservation,
  SocketEnvelope,
  VoteTallyUpdate
} from "../shared/types";
import {
  ApiError,
  observePublicGame,
  publicSocketUrl,
  readPublicChat,
  readPublicChatHistory,
  readPublicComputer,
  readPublicComputerEventHistory,
  readPublicFile,
  readPublicRoom,
  readPublicTree
} from "./api";
import { mergeBySequence } from "./lib/sequence";

type ConnectionState = "connecting" | "open" | "closed";

export function useRoomData() {
  const [roomId, setRoomId] = useState<string | null>(null);
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
  const [gameSocket, setGameSocket] = useState<ConnectionState>("connecting");
  const [computerSocket, setComputerSocket] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const chatNewestCursor = useRef(0);
  const chatNextBefore = useRef<number | null>(null);
  const computerNewestCursor = useRef(0);
  const computerNextBefore = useRef<number | null>(null);
  const selectedPathRef = useRef(selectedPath);
  const expandedPathsRef = useRef(expandedPaths);
  const previousRevision = useRef<number | null>(null);
  const requests = useRef(new Set<string>());
  selectedPathRef.current = selectedPath;
  expandedPathsRef.current = expandedPaths;

  useEffect(() => {
    let active = true;
    void readPublicRoom()
      .then((room) => {
        if (active) setRoomId(room.roomId);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageOf(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshGame = useCallback(async (): Promise<void> => {
    if (!roomId || !beginRequest(requests.current, "game")) return;
    try {
      setGame(await observePublicGame(roomId));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      requests.current.delete("game");
    }
  }, [roomId]);

  const refreshChat = useCallback(async (): Promise<void> => {
    if (!roomId || !beginRequest(requests.current, "chat")) return;
    try {
      const response = await readPublicChat(roomId, chatNewestCursor.current);
      chatNewestCursor.current = Math.max(chatNewestCursor.current, response.cursor);
      setChat((current) => mergeBySequence(current, response.messages));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      requests.current.delete("chat");
    }
  }, [roomId]);

  const refreshComputer = useCallback(async (): Promise<void> => {
    if (!roomId || !beginRequest(requests.current, "computer")) return;
    try {
      const response = await readPublicComputer(roomId, computerNewestCursor.current);
      computerNewestCursor.current = Math.max(
        computerNewestCursor.current,
        response.events.at(-1)?.sequence ?? 0
      );
      setComputer(response);
      setComputerEvents((current) => mergeBySequence(current, response.events));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      requests.current.delete("computer");
    }
  }, [roomId]);

  const loadTree = useCallback(
    async (path: string): Promise<void> => {
      const requestKey = `tree:${path}`;
      if (!roomId || !beginRequest(requests.current, requestKey)) return;
      try {
        const response = await readPublicTree(roomId, path);
        setTreeByPath((current) => ({ ...current, [path]: response.entries }));
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        requests.current.delete(requestKey);
      }
    },
    [roomId]
  );

  const loadSelectedFile = useCallback(async (): Promise<void> => {
    const requestedPath = selectedPath;
    const requestKey = `file:${requestedPath}`;
    if (!roomId || !requestedPath || !beginRequest(requests.current, requestKey)) return;
    try {
      const file = await readPublicFile(roomId, requestedPath);
      if (selectedPathRef.current === requestedPath) setSelectedFile(file);
    } catch (cause) {
      if (selectedPathRef.current !== requestedPath) return;
      setSelectedFile(null);
      if (!(cause instanceof ApiError && cause.status === 404)) setError(messageOf(cause));
    } finally {
      requests.current.delete(requestKey);
    }
  }, [roomId, selectedPath]);

  const loadOlderChat = useCallback(async (): Promise<void> => {
    if (!roomId || chatLoadingOlder || chatNextBefore.current === null) return;
    setChatLoadingOlder(true);
    try {
      const response = await readPublicChatHistory(roomId, chatNextBefore.current);
      chatNextBefore.current = response.nextBefore;
      setChatHasMore(response.hasMore);
      setChat((current) => mergeBySequence(current, response.messages));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setChatLoadingOlder(false);
    }
  }, [chatLoadingOlder, roomId]);

  const loadOlderComputerEvents = useCallback(async (): Promise<void> => {
    if (!roomId || computerEventsLoadingOlder || computerNextBefore.current === null) return;
    setComputerEventsLoadingOlder(true);
    try {
      const response = await readPublicComputerEventHistory(
        roomId,
        computerNextBefore.current
      );
      computerNextBefore.current = response.nextBefore;
      setComputerEventsHaveMore(response.hasMore);
      setComputerEvents((current) => mergeBySequence(current, response.events));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setComputerEventsLoadingOlder(false);
    }
  }, [computerEventsLoadingOlder, roomId]);

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    void Promise.all([
      observePublicGame(roomId),
      readPublicChatHistory(roomId),
      readPublicComputerEventHistory(roomId),
      readPublicTree(roomId, "/workspace"),
      readPublicFile(roomId, selectedPath).catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 404) return null;
        throw cause;
      })
    ])
      .then(([nextGame, nextChat, nextComputer, nextTree, nextFile]) => {
        if (!active) return;
        setGame(nextGame);
        chatNextBefore.current = nextChat.nextBefore;
        chatNewestCursor.current = nextChat.messages.at(-1)?.sequence ?? 0;
        setChat(nextChat.messages);
        setChatHasMore(nextChat.hasMore);
        computerNextBefore.current = nextComputer.nextBefore;
        computerNewestCursor.current = nextComputer.events.at(-1)?.sequence ?? 0;
        setComputer({
          roomId: nextComputer.roomId,
          filesystemRevision: nextComputer.filesystemRevision,
          events: nextComputer.events
        });
        setComputerEvents(nextComputer.events);
        setComputerEventsHaveMore(nextComputer.hasMore);
        setTreeByPath({ "/workspace": nextTree.entries });
        setSelectedFile(nextFile);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageOf(cause));
      });
    return () => {
      active = false;
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    const delay = gameSocket === "open" && computerSocket === "open" ? 30_000 : 2_500;
    const timer = window.setInterval(() => {
      void refreshGame();
      void refreshChat();
      void refreshComputer();
    }, delay);
    return () => window.clearInterval(timer);
  }, [computerSocket, gameSocket, refreshChat, refreshComputer, refreshGame, roomId]);

  useEffect(() => {
    if (!roomId) return;
    return connectRoomSocket(publicSocketUrl(roomId, "game"), setGameSocket, (envelope) => {
      if (envelope.source !== "game") return;
      if (envelope.type === "game.state") {
        setGame(envelope.payload as GameObservation);
        return;
      }
      if (envelope.type === "vote.tally") {
        const update = envelope.payload as VoteTallyUpdate;
        setGame((current) => current && current.voteWindow?.id === update.windowId
          ? { ...current, votes: update.votes, activeAgents: update.activeAgents }
          : current);
        return;
      }
      if (envelope.type === "chat.sent") {
        const message = envelope.payload as ChatMessage;
        if (typeof message.sequence !== "number") return;
        chatNewestCursor.current = Math.max(chatNewestCursor.current, message.sequence);
        setChat((current) => mergeBySequence(current, [message]));
      }
    });
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    return connectRoomSocket(publicSocketUrl(roomId, "computer"), setComputerSocket, (envelope) => {
      if (envelope.source !== "computer") return;
      const event = envelope.payload as ComputerEvent;
      if (typeof event.sequence !== "number") return;
      computerNewestCursor.current = Math.max(computerNewestCursor.current, event.sequence);
      setComputerEvents((current) => mergeBySequence(current, [event]));
      setComputer((current) => current
        ? { ...current, filesystemRevision: event.filesystemRevision, events: [event] }
        : current);
    });
  }, [roomId]);

  useEffect(() => {
    const revision = computer?.filesystemRevision;
    if (revision === undefined) return;
    if (previousRevision.current === null) {
      previousRevision.current = revision;
      return;
    }
    if (revision === previousRevision.current) return;
    previousRevision.current = revision;
    if (document.visibilityState !== "visible") return;
    for (const path of expandedPathsRef.current) void loadTree(path);
    void loadSelectedFile();
  }, [computer?.filesystemRevision, loadSelectedFile, loadTree]);

  useEffect(() => {
    void loadSelectedFile();
  }, [loadSelectedFile]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!treeByPath[path]) void loadTree(path);
  }, [loadTree, treeByPath]);

  return {
    roomId,
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
    gameSocket,
    computerSocket,
    error,
    loading: roomId === null || game === null,
    loadOlderChat,
    loadOlderComputerEvents,
    toggleDirectory,
    selectFile: setSelectedPath,
    dismissError: () => setError(null)
  };
}

function beginRequest(active: Set<string>, key: string): boolean {
  if (active.has(key)) return false;
  active.add(key);
  return true;
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
        // The reconciliation request repairs a malformed or missed event.
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
