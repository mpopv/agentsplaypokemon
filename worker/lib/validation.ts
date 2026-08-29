import { GAME_INPUTS, type GameInput } from "../../shared/types";

const ROOM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_ROOT = "/workspace";

export class InputError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status = 400, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "InputError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function parseRoomId(value: string): string {
  if (!ROOM_ID.test(value)) {
    throw new InputError(
      "roomId must use lowercase letters, numbers, or hyphens and must be 1 to 64 characters"
    );
  }
  return value;
}

export function parseAgentId(value: string): string {
  if (!AGENT_ID.test(value)) {
    throw new InputError("agentId must be a UUID");
  }
  return value.toLowerCase();
}

export function parseGameInput(value: unknown): GameInput {
  if (typeof value !== "string" || !GAME_INPUTS.includes(value as GameInput)) {
    throw new InputError(`input must be one of: ${GAME_INPUTS.join(", ")}`);
  }
  return value as GameInput;
}

export function parseChatMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw new InputError("message must be a string");
  }
  const message = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (message.length === 0 || message.length > 500) {
    throw new InputError("message must be between 1 and 500 characters");
  }
  return message;
}

export function parseCommand(value: unknown): string {
  if (typeof value !== "string") {
    throw new InputError("command must be a string");
  }
  if (value.includes("\u0000")) {
    throw new InputError("command must not contain a null byte");
  }
  if (value.trim().length === 0 || value.length > 8192) {
    throw new InputError("command must be between 1 and 8192 characters");
  }
  return value;
}

export function parseWorkspacePath(value: unknown, defaultPath = WORKSPACE_ROOT): string {
  const raw = value === undefined ? defaultPath : value;
  if (typeof raw !== "string") {
    throw new InputError("path must be a string");
  }
  if (raw.includes("\u0000") || raw.includes("\\")) {
    throw new InputError("path contains an invalid character");
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new InputError("path must not contain '..'");
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new InputError("path must be inside /workspace");
  }
  return normalized;
}

export function parseCursor(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InputError("cursor must be a non-negative integer");
  }
  return parsed;
}

export function parseOptionalCursor(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  return parseCursor(value);
}

export async function readJsonObject(
  request: Request,
  maxBytes = 16 * 1024
): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new InputError("request body is too large", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new InputError("request body is too large", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function enforceSameOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") {
    throw new InputError("cross-site mutations are not allowed", 403);
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new InputError("request origin is not allowed", 403);
  }
}
