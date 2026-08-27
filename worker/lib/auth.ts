import {
  AGENT_SESSION_PROTOCOL_PREFIX,
  type AgentIdentity,
  type SessionInfo
} from "../../shared/types";
import type { RuntimeEnv } from "./runtime-env";
import { InputError, parseRoomId } from "./validation";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 2_048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SessionPayload extends AgentIdentity {
  roomId: string;
  issuedAt: number;
}

export interface SessionResult {
  session: SessionPayload;
  token: string;
}

export async function createSession(request: Request, env: RuntimeEnv): Promise<SessionResult> {
  const existingToken = readSessionToken(request);
  if (existingToken !== null) {
    const existing = await verifySessionToken(existingToken, env);
    if (existing !== null) return { session: existing, token: existingToken };
  }

  const agentId = crypto.randomUUID();
  const session: SessionPayload = {
    agentId,
    displayName: `Agent-${agentId.slice(0, 8).toUpperCase()}`,
    roomId: parseRoomId(env.DEFAULT_ROOM_ID),
    issuedAt: Date.now()
  };
  const token = await signSession(session, requireSecret(env.SESSION_SIGNING_SECRET));
  return { session, token };
}

export async function requireSession(request: Request, env: RuntimeEnv): Promise<SessionPayload> {
  const session = await readSession(request, env);
  if (session === null) throw new InputError("a signed tab session is required", 401);
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
  const token = readSessionToken(request);
  if (token === null) return null;
  return verifySessionToken(token, env);
}

async function verifySessionToken(
  token: string,
  env: RuntimeEnv
): Promise<SessionPayload | null> {
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

function readSessionToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    return match?.[1] && match[1].length <= MAX_TOKEN_LENGTH ? match[1] : null;
  }

  const protocols = request.headers.get("sec-websocket-protocol");
  if (protocols === null || protocols.length > MAX_TOKEN_LENGTH * 2) return null;
  const protocol = protocols.trim();
  if (!protocol.startsWith(AGENT_SESSION_PROTOCOL_PREFIX)) return null;
  const token = protocol.slice(AGENT_SESSION_PROTOCOL_PREFIX.length);
  return token.length <= MAX_TOKEN_LENGTH && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ? token
    : null;
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
