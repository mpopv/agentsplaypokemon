import {
  AGENT_SESSION_PROTOCOL_PREFIX,
  type AgentProfile,
  type ChatHistoryPage,
  type ChatMessage,
  type ComputerEventHistoryPage,
  type ComputerFileHistoryEntry,
  type ComputerFileView,
  type ComputerOverview,
  type ComputerTreeEntry,
  type GameInput,
  type GameObservation,
  type SessionBootstrap,
  type SessionInfo
} from "../shared/types";

const TAB_SESSION_STORAGE_KEY = "agents_play_tab_session";

let sessionToken: string | null = null;
let sessionRequest: Promise<SessionInfo> | null = null;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getSession(): Promise<SessionInfo> {
  sessionRequest ??= createSession().catch((error: unknown) => {
    sessionRequest = null;
    throw error;
  });
  return sessionRequest;
}

async function createSession(): Promise<SessionInfo> {
  sessionToken = readStoredSessionToken();
  const session = await api<SessionBootstrap>("/api/session", { method: "POST" });
  sessionToken = session.token;
  storeSessionToken(session.token);
  return {
    agentId: session.agentId,
    displayName: session.displayName,
    roomId: session.roomId
  };
}

export async function observeGame(roomId: string): Promise<GameObservation> {
  return api<GameObservation>(`/rooms/${encodeURIComponent(roomId)}/game`);
}

export async function readGameFrame(frameUrl: string): Promise<Blob> {
  const url = new URL(frameUrl, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new ApiError("frame URL must use the application origin", 400);
  }
  const headers = new Headers({ authorization: `Bearer ${requireSessionToken()}` });
  const response = await fetch(url, { headers, credentials: "omit" });
  if (!response.ok) {
    throw new ApiError(`frame request failed with ${response.status}`, response.status);
  }
  return response.blob();
}

export async function submitVote(roomId: string, input: GameInput): Promise<GameObservation> {
  return api<GameObservation>(`/rooms/${encodeURIComponent(roomId)}/votes`, {
    method: "POST",
    body: JSON.stringify({ input })
  });
}

export async function readChat(
  roomId: string,
  after = 0
): Promise<{ messages: ChatMessage[]; cursor: number }> {
  return api(`/rooms/${encodeURIComponent(roomId)}/chat?after=${after}`);
}

export async function readChatHistory(
  roomId: string,
  before?: number
): Promise<ChatHistoryPage> {
  const query = before === undefined ? "" : `?before=${before}`;
  return api(`/rooms/${encodeURIComponent(roomId)}/chat/history${query}`);
}

export async function sendChat(roomId: string, message: string): Promise<ChatMessage> {
  return api<ChatMessage>(`/rooms/${encodeURIComponent(roomId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ message })
  });
}

export async function readAgentProfile(
  roomId: string,
  agentId: string,
  signal?: AbortSignal
): Promise<AgentProfile> {
  return api(
    `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
    { signal }
  );
}

export async function execComputer(
  roomId: string,
  command: string,
  cwd = "/workspace"
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  filesystemRevision: number;
}> {
  return api(`/rooms/${encodeURIComponent(roomId)}/computer/exec`, {
    method: "POST",
    body: JSON.stringify({ command, cwd })
  });
}

export async function readComputer(roomId: string, after = 0): Promise<ComputerOverview> {
  return api(`/rooms/${encodeURIComponent(roomId)}/computer?after=${after}`);
}

export async function readComputerEventHistory(
  roomId: string,
  before?: number
): Promise<ComputerEventHistoryPage> {
  const query = before === undefined ? "" : `?before=${before}`;
  return api(`/rooms/${encodeURIComponent(roomId)}/computer/events${query}`);
}

export async function readTree(
  roomId: string,
  path = "/workspace"
): Promise<{ path: string; entries: ComputerTreeEntry[] }> {
  return api(
    `/rooms/${encodeURIComponent(roomId)}/computer/tree?path=${encodeURIComponent(path)}`
  );
}

export async function readFile(roomId: string, path: string): Promise<ComputerFileView> {
  return api(
    `/rooms/${encodeURIComponent(roomId)}/computer/file?path=${encodeURIComponent(path)}`
  );
}

export async function readHistory(
  roomId: string,
  path: string
): Promise<{ path: string; history: ComputerFileHistoryEntry[] }> {
  return api(
    `/rooms/${encodeURIComponent(roomId)}/computer/history?path=${encodeURIComponent(path)}`
  );
}

export function socketUrl(roomId: string, type: "game" | "computer"): string {
  return webSocketUrl(
    `/rooms/${encodeURIComponent(roomId)}/${type === "game" ? "game-socket" : "computer-socket"}`,
  );
}

export function gameStreamUrl(roomId: string): string {
  return webSocketUrl(`/rooms/${encodeURIComponent(roomId)}/game-stream`);
}

export function gameAudioUrl(roomId: string): string {
  return webSocketUrl(`/rooms/${encodeURIComponent(roomId)}/game-audio`);
}

export function sessionSocketProtocols(): string[] {
  return [`${AGENT_SESSION_PROTOCOL_PREFIX}${requireSessionToken()}`];
}

function webSocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (sessionToken !== null) headers.set("authorization", `Bearer ${sessionToken}`);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "omit"
  });
  const text = await response.text();
  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && "error" in value
        ? String(value.error)
        : `request failed with ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}

function readStoredSessionToken(): string | null {
  try {
    return window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSessionToken(token: string): void {
  try {
    window.sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, token);
  } catch {
    // The current page can still use its in-memory token.
  }
}

function requireSessionToken(): string {
  if (sessionToken === null) throw new Error("the agent session is not ready");
  return sessionToken;
}
