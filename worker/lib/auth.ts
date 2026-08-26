import type { AgentIdentity, SessionInfo } from "../../shared/types";
import type { RuntimeEnv } from "./runtime-env";
import { InputError, parseRoomId } from "./validation";

const COOKIE_NAME = "agents_play_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SessionPayload extends AgentIdentity {
  roomId: string;
  issuedAt: number;
}

export interface SessionResult {
  session: SessionPayload;
  setCookie?: string;
}

export async function createSession(request: Request, env: RuntimeEnv): Promise<SessionResult> {
  const existing = await readSession(request, env);
  if (existing !== null) return { session: existing };

  const agentId = crypto.randomUUID();
  const session: SessionPayload = {
    agentId,
    displayName: `Agent-${agentId.slice(0, 4).toUpperCase()}`,
    roomId: parseRoomId(env.DEFAULT_ROOM_ID),
    issuedAt: Date.now()
  };
  const token = await signSession(session, requireSecret(env.SESSION_SIGNING_SECRET));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    session,
    setCookie: `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${secure}`
  };
}

export async function requireSession(request: Request, env: RuntimeEnv): Promise<SessionPayload> {
  const session = await readSession(request, env);
  if (session === null) throw new InputError("a signed browser session is required", 401);
  return session;
}

export function publicSession(session: SessionPayload): SessionInfo {
  return { agentId: session.agentId, displayName: session.displayName, roomId: session.roomId };
}

export async function authorizeAdmin(request: Request, env: RuntimeEnv): Promise<void> {
  const configured = env.ADMIN_TOKEN;
  if (!configured) throw new InputError("ADMIN_TOKEN is not configured", 503);
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${configured}`;
  if (!constantTimeEqual(encoder.encode(supplied), encoder.encode(expected))) {
    throw new InputError("admin authorization is required", 401);
  }
}

async function readSession(request: Request, env: RuntimeEnv): Promise<SessionPayload | null> {
  const token = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (token === null) return null;
  const secret = env.SESSION_SIGNING_SECRET;
  if (!secret) throw new InputError("SESSION_SIGNING_SECRET is not configured", 503);
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) return null;
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(signaturePart);
  } catch {
    return null;
  }
  if (signature.byteLength !== 32) return null;
  const key = await importHmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature),
    encoder.encode(payloadPart)
  );
  if (!valid) return null;

  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payloadPart))) as Partial<SessionPayload>;
    if (
      typeof parsed.agentId !== "string" ||
      typeof parsed.displayName !== "string" ||
      typeof parsed.roomId !== "string" ||
      parseRoomId(parsed.roomId) !== parsed.roomId ||
      typeof parsed.issuedAt !== "number" ||
      Date.now() - parsed.issuedAt > SESSION_TTL_SECONDS * 1000 ||
      parsed.issuedAt > Date.now() + 60_000
    ) {
      return null;
    }
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart));
  return `${payloadPart}.${toBase64Url(new Uint8Array(signature))}`;
}

function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function requireSecret(value: string | undefined): string {
  if (!value) throw new InputError("SESSION_SIGNING_SECRET is not configured", 503);
  if (value.length < 32) {
    throw new InputError("SESSION_SIGNING_SECRET must contain at least 32 characters", 503);
  }
  return value;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new TypeError("invalid Base64URL value");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new TypeError("non-canonical Base64URL value");
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
