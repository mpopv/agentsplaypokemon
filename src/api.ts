import {
  AGENT_SESSION_PROTOCOL_PREFIX,
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
const REQUEST_TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 200;

let sessionToken: string | null = null;
let sessionRequest: Promise<SessionInfo> | undefined;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getSession(): Promise<SessionInfo> {
  sessionRequest ??= createSession().catch((cause: unknown) => {
    sessionRequest = undefined;
    throw cause;
  });
  return sessionRequest;
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
  const response = await request(url, { headers });
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
  const response = await request(path, { ...init, headers });
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

async function createSession(): Promise<SessionInfo> {
  sessionToken = readStoredSessionToken();
  const session = await api<SessionBootstrap>("/api/session", {
    method: "POST",
    headers: { "x-retry-safe": "session-bootstrap" }
  });
  sessionToken = session.token;
  storeSessionToken(session.token);
  return {
    agentId: session.agentId,
    displayName: session.displayName,
    roomId: session.roomId
  };
}

async function request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const retrySafe = method === "GET" || headers.get("x-retry-safe") !== null;
  headers.delete("x-retry-safe");
  const attempts = retrySafe ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithDeadline(input, {
        ...init,
        headers,
        credentials: "omit"
      });
      if (attempt + 1 < attempts && isRetryableStatus(response.status)) {
        await response.body?.cancel();
        await retryDelay(attempt);
        continue;
      }
      return response;
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      if (attempt + 1 >= attempts) {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          throw new ApiError("request timed out", 0);
        }
        throw cause;
      }
      await retryDelay(attempt);
    }
  }

  throw new ApiError("request failed", 0);
}

async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 ||
    status === 502 || status === 504;
}

async function retryDelay(attempt: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 100);
  await new Promise((resolve) =>
    globalThis.setTimeout(resolve, RETRY_DELAY_MS * 2 ** attempt + jitter)
  );
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
