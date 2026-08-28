import { Hono } from "hono";

import type { AgentIdentity, AgentProfile } from "../shared/types";
import { GameRoomDO } from "./game-room";
import {
  authorizeAdmin,
  createSession,
  publicSession,
  requireSession
} from "./lib/auth";
import { renderDemoFrame } from "./lib/demo-frame";
import type { RuntimeEnv } from "./lib/runtime-env";
import {
  enforceSameOrigin,
  InputError,
  parseAgentId,
  parseChatMessage,
  parseCommand,
  parseCursor,
  parseGameInput,
  parseOptionalCursor,
  parseRoomId,
  parseWorkspacePath,
  readJsonObject
} from "./lib/validation";
import { SharedComputerDO, WorkspaceProxy } from "./shared-computer";

export { GameRoomDO, SharedComputerDO, WorkspaceProxy };

interface AppVariables {
  agent: AgentIdentity;
  roomId: string;
}

const app = new Hono<{ Bindings: RuntimeEnv; Variables: AppVariables }>();
const READINESS_TIMEOUT_MS = 3_000;

app.use("*", async (context, next) => {
  await next();
  context.header("x-content-type-options", "nosniff");
  context.header("x-frame-options", "DENY");
  context.header("referrer-policy", "no-referrer");
  context.header("cross-origin-opener-policy", "same-origin");
  context.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  context.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "img-src 'self' data: blob: https://raw.githubusercontent.com; " +
      "connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'"
  );
  if (
    context.req.path === "/health" ||
    context.req.path === "/ready" ||
    context.req.path.startsWith("/api/") ||
    context.req.path.startsWith("/rooms/")
  ) {
    context.header("cache-control", "no-store");
  }
  const versionId = context.env.WORKER_VERSION?.id;
  if (versionId) context.header("x-worker-version", versionId);
});

app.get("/health", (context) =>
  context.json({
    ok: true,
    service: "agents-play-pokemon",
    version: context.env.WORKER_VERSION?.id ?? null,
    time: Date.now()
  })
);

app.get("/ready", async (context) => {
  const startedAt = Date.now();
  const roomId = parseRoomId(context.env.DEFAULT_ROOM_ID);
  const checks = await Promise.all([
    readinessCheck("game-room", async () => {
      const descriptor = await context.env.GAME_ROOMS.getByName(roomId).frameDescriptor(roomId);
      return {
        roomId,
        mode: descriptor.mode,
        frameRevision: descriptor.frameRevision
      };
    }),
    readinessCheck("shared-computer", async () => {
      const overview = await context.env.SHARED_COMPUTERS.getByName(roomId).overview(roomId, 0);
      return {
        roomId,
        filesystemRevision: overview.filesystemRevision
      };
    })
  ]);
  const ok = checks.every((check) => check.ok);
  return context.json(
    {
      ok,
      service: "agents-play-pokemon",
      version: context.env.WORKER_VERSION?.id ?? null,
      roomId,
      durationMs: Date.now() - startedAt,
      checks,
      time: Date.now()
    },
    ok ? 200 : 503
  );
});

app.post("/api/session", async (context) => {
  enforceSameOrigin(context.req.raw);
  const result = await createSession(context.req.raw, context.env);
  return context.json({ ...publicSession(result.session), token: result.token });
});

app.use("/rooms/:roomId/*", async (context, next) => {
  const session = await requireSession(context.req.raw, context.env);
  const roomId = parseRoomId(context.req.param("roomId"));
  if (session.roomId !== roomId) {
    throw new InputError("this session does not have access to the requested room", 403);
  }
  context.set("agent", { agentId: session.agentId, displayName: session.displayName });
  context.set("roomId", roomId);
  await next();
});

app.get("/rooms/:roomId/game", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const game = context.env.GAME_ROOMS.getByName(roomId);
  return context.json(await game.observe(roomId, context.get("agent")));
});

app.post("/rooms/:roomId/votes", async (context) => {
  enforceSameOrigin(context.req.raw);
  const roomId = parseRoomId(context.req.param("roomId"));
  const body = await readJsonObject(context.req.raw);
  const input = parseGameInput(body.input);
  const game = context.env.GAME_ROOMS.getByName(roomId);
  return context.json(await game.vote(roomId, context.get("agent"), input));
});

app.get("/rooms/:roomId/chat", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const after = parseCursor(context.req.query("after"));
  const game = context.env.GAME_ROOMS.getByName(roomId);
  const messages = await game.readChat(roomId, context.get("agent"), after);
  return context.json({
    messages,
    cursor: messages.at(-1)?.sequence ?? after
  });
});

app.get("/rooms/:roomId/chat/history", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const before = parseOptionalCursor(context.req.query("before"));
  const game = context.env.GAME_ROOMS.getByName(roomId);
  return context.json(await game.readChatHistory(roomId, context.get("agent"), before));
});

app.post("/rooms/:roomId/chat", async (context) => {
  enforceSameOrigin(context.req.raw);
  const roomId = parseRoomId(context.req.param("roomId"));
  const body = await readJsonObject(context.req.raw);
  const message = parseChatMessage(body.message);
  const game = context.env.GAME_ROOMS.getByName(roomId);
  return context.json(await game.sendChat(roomId, context.get("agent"), message), 201);
});

app.get("/rooms/:roomId/agents/:agentId", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const agentId = parseAgentId(context.req.param("agentId"));
  const [gameActivity, computerActivity] = await Promise.all([
    context.env.GAME_ROOMS.getByName(roomId).agentActivity(
      roomId,
      context.get("agent"),
      agentId
    ),
    context.env.SHARED_COMPUTERS.getByName(roomId).agentActivity(roomId, agentId)
  ]);
  const displayName = gameActivity.displayName ?? computerActivity.displayName;
  const firstRecordedAt = minimumTimestamp(
    gameActivity.firstRecordedAt,
    computerActivity.firstRecordedAt,
    gameActivity.lastSeenAt
  );
  const lastActiveAt = maximumTimestamp(
    gameActivity.lastRecordedAt,
    gameActivity.lastSeenAt,
    computerActivity.lastRecordedAt
  );
  if (displayName === null || firstRecordedAt === null || lastActiveAt === null) {
    throw new InputError("agent was not found in this room", 404);
  }
  const profile: AgentProfile = {
    agentId,
    displayName,
    firstRecordedAt,
    lastActiveAt,
    online: gameActivity.online,
    voteWindowCount: gameActivity.voteWindowCount,
    chatMessageCount: gameActivity.chatMessageCount,
    commandCount: computerActivity.commandCount,
    lastVote: gameActivity.lastVote,
    lastChat: gameActivity.lastChat,
    lastCommand: computerActivity.lastCommand
  };
  return context.json(profile);
});

app.get("/rooms/:roomId/game/frame", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const game = context.env.GAME_ROOMS.getByName(roomId);
  const descriptor = await game.frameDescriptor(roomId);
  if (descriptor.mode === "rom" && descriptor.frameKey) {
    const frame = await context.env.PRIVATE_DATA.get(descriptor.frameKey);
    if (frame !== null) {
      return new Response(frame.body, {
        headers: {
          "content-type": frame.httpMetadata?.contentType ?? "image/png",
          "cache-control": "private, max-age=2",
          etag: frame.httpEtag
        }
      });
    }
  }
  return new Response(
    renderDemoFrame({
      x: descriptor.demoX,
      y: descriptor.demoY,
      lastInput: descriptor.lastInput,
      revision: descriptor.frameRevision
    }),
    {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "private, max-age=2"
      }
    }
  );
});

app.get("/rooms/:roomId/game-socket", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  return forwardSocket(
    context.req.raw,
    context.env.GAME_ROOMS.getByName(roomId),
    "/internal/game-socket",
    context.get("agent"),
    roomId
  );
});

app.get("/rooms/:roomId/game-stream", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  return forwardSocket(
    context.req.raw,
    context.env.GAME_ROOMS.getByName(roomId),
    "/internal/game-stream",
    context.get("agent"),
    roomId
  );
});

app.post("/rooms/:roomId/computer/exec", async (context) => {
  enforceSameOrigin(context.req.raw);
  const roomId = parseRoomId(context.req.param("roomId"));
  const body = await readJsonObject(context.req.raw);
  const command = parseCommand(body.command);
  const cwd = parseWorkspacePath(body.cwd);
  const computer = context.env.SHARED_COMPUTERS.getByName(roomId);
  return context.json(await computer.exec(roomId, context.get("agent"), command, cwd));
});

app.get("/rooms/:roomId/computer", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const after = parseCursor(context.req.query("after"));
  const computer = context.env.SHARED_COMPUTERS.getByName(roomId);
  return context.json(await computer.overview(roomId, after));
});

app.get("/rooms/:roomId/computer/events", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const before = parseOptionalCursor(context.req.query("before"));
  const computer = context.env.SHARED_COMPUTERS.getByName(roomId);
  return context.json(await computer.eventHistory(roomId, before));
});

app.get("/rooms/:roomId/computer/tree", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const path = parseWorkspacePath(context.req.query("path"));
  const computer = context.env.SHARED_COMPUTERS.getByName(roomId);
  return context.json({ path, entries: await computer.tree(roomId, path) });
});

app.get("/rooms/:roomId/computer/file", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const path = parseWorkspacePath(context.req.query("path"));
  const computer = context.env.SHARED_COMPUTERS.getByName(roomId);
  return context.json(await computer.file(roomId, path));
});

app.get("/rooms/:roomId/computer/history", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const path = parseWorkspacePath(context.req.query("path"));
  const computer = context.env.SHARED_COMPUTERS.getByName(roomId);
  return context.json({ path, history: await computer.history(roomId, path) });
});

app.get("/rooms/:roomId/computer-socket", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  return forwardSocket(
    context.req.raw,
    context.env.SHARED_COMPUTERS.getByName(roomId),
    "/internal/computer-socket",
    context.get("agent"),
    roomId
  );
});

app.use("/admin/*", async (context, next) => {
  enforceSameOrigin(context.req.raw);
  await authorizeAdmin(context.req.raw, context.env);
  await next();
});

app.put("/admin/rooms/:roomId/rom", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const contentType = context.req.header("content-type") ?? "";
  if (!contentType.startsWith("application/octet-stream")) {
    throw new InputError("ROM upload must use application/octet-stream");
  }
  const declared = Number(context.req.header("content-length") ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > 8 * 1024 * 1024) {
    throw new InputError("ROM size must be between 1 byte and 8 MiB", 413);
  }
  const bytes = new Uint8Array(await context.req.arrayBuffer());
  if (bytes.byteLength !== declared) throw new InputError("ROM upload is incomplete");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const romKey = `game/${roomId}/rom-${sha256}.gb`;
  const existed = (await context.env.PRIVATE_DATA.head(romKey)) !== null;
  await context.env.PRIVATE_DATA.put(romKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" }
  });
  try {
    await context.env.GAME_ROOMS.getByName(roomId).configureRom(roomId, romKey, sha256);
  } catch (error) {
    if (!existed) await context.env.PRIVATE_DATA.delete(romKey);
    throw error;
  }
  return context.json({ roomId, sha256, configured: true }, 201);
});

app.post("/admin/rooms/:roomId/computer/snapshot", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const body = await optionalJsonObject(context.req.raw);
  const reason = typeof body.reason === "string" ? body.reason : "manual";
  return context.json(
    await context.env.SHARED_COMPUTERS.getByName(roomId).snapshot(roomId, reason),
    201
  );
});

app.post("/admin/rooms/:roomId/computer/restore", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const body = await readJsonObject(context.req.raw);
  if (typeof body.snapshotId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(body.snapshotId)) {
    throw new InputError("snapshotId is not valid");
  }
  return context.json(
    await context.env.SHARED_COMPUTERS.getByName(roomId).restore(roomId, body.snapshotId)
  );
});

app.post("/admin/rooms/:roomId/computer/reset", async (context) => {
  const roomId = parseRoomId(context.req.param("roomId"));
  const body = await readJsonObject(context.req.raw);
  if (body.confirm !== roomId) {
    throw new InputError(`confirm must equal '${roomId}'`);
  }
  return context.json(await context.env.SHARED_COMPUTERS.getByName(roomId).reset(roomId));
});

app.notFound(async (context) => {
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  const status = error instanceof InputError ? error.status : readErrorStatus(error);
  if (status >= 500) {
    console.error({
      message: "request failed",
      path: context.req.path,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return context.json(
    { error: error instanceof Error ? error.message : "request failed" },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503
  );
});

export default {
  async fetch(request: Request, env: RuntimeEnv, executionContext: ExecutionContext): Promise<Response> {
    return await app.fetch(request, env, executionContext);
  },

  async scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
    _executionContext: ExecutionContext
  ): Promise<void> {
    const roomId = parseRoomId(env.DEFAULT_ROOM_ID);
    try {
      await env.SHARED_COMPUTERS.getByName(roomId).snapshot(roomId, "automatic-15-minute");
      console.log({ message: "automatic computer snapshot completed", roomId });
    } catch (error) {
      console.error({
        message: "automatic computer snapshot failed",
        roomId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
} satisfies ExportedHandler<RuntimeEnv>;

async function forwardSocket(
  request: Request,
  stub: DurableObjectStub,
  path: string,
  agent: AgentIdentity,
  roomId: string
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new InputError("websocket upgrade required", 426);
  }
  const selectedProtocol = request.headers.get("sec-websocket-protocol");
  if (selectedProtocol === null) {
    throw new InputError("websocket session protocol required", 401);
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("sec-websocket-protocol");
  headers.set("x-agent-id", agent.agentId);
  headers.set("x-agent-name", agent.displayName);
  headers.set("x-room-id", roomId);
  const response = await stub.fetch(
    new Request(`https://internal${path}`, { method: "GET", headers })
  );
  if (response.status !== 101 || response.webSocket === null) return response;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("sec-websocket-protocol", selectedProtocol);
  return new Response(null, {
    status: 101,
    headers: responseHeaders,
    webSocket: response.webSocket
  });
}

async function optionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-length") || request.headers.get("content-length") === "0") {
    return {};
  }
  return readJsonObject(request);
}

function readErrorStatus(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    return error.status;
  }
  return 500;
}

function minimumTimestamp(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}

function maximumTimestamp(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

async function readinessCheck(
  name: string,
  check: () => Promise<unknown>
): Promise<
  | { name: string; ok: true; durationMs: number; detail: unknown }
  | { name: string; ok: false; durationMs: number; error: string }
> {
  const startedAt = Date.now();
  try {
    const detail = await withDeadline(check(), READINESS_TIMEOUT_MS);
    return { name, ok: true, durationMs: Date.now() - startedAt, detail };
  } catch (cause) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("readiness check timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
