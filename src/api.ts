import type {
  ChatMessage,
  ComputerFileHistoryEntry,
  ComputerFileView,
  ComputerOverview,
  ComputerTreeEntry,
  GameInput,
  GameObservation,
  SessionInfo
} from "../shared/types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function startSession(): Promise<SessionInfo> {
  return api<SessionInfo>("/api/session", { method: "POST" });
}

export async function observeGame(roomId: string): Promise<GameObservation> {
  return api<GameObservation>(`/rooms/${encodeURIComponent(roomId)}/game`);
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

function webSocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin"
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
