const arguments_ = process.argv.slice(2);
const baseUrl = readArgument("--url") ?? "https://agentsplaypokemon.com";
const overrideVersion = readArgument("--version");
const expectedVersion = readArgument("--expect-version") ?? overrideVersion;
const origin = new URL(baseUrl).origin;
const commonHeaders = new Headers({ origin });
if (overrideVersion) {
  commonHeaders.set(
    "cloudflare-workers-version-overrides",
    `agents-play-pokemon=\"${overrideVersion}\"`
  );
}

const readiness = await readJson("/ready");
assert(readiness.ok === true, "The readiness probe failed.");
assert(
  readiness.checks?.every((check) => check.ok === true),
  "A readiness dependency failed."
);
if (expectedVersion) {
  assert(readiness.version === expectedVersion, "The readiness probe returned another version.");
}

const session = await readJson("/api/session", { method: "POST" });
assert(typeof session.token === "string", "The session token is missing.");
assert(typeof session.roomId === "string", "The session room is missing.");
const authorization = `Bearer ${session.token}`;
const protectedHeaders = new Headers(commonHeaders);
protectedHeaders.set("authorization", authorization);

const game = await readJson(`/rooms/${encodeURIComponent(session.roomId)}/game`, {
  headers: protectedHeaders
});
const [chat, computer, frame] = await Promise.all([
  readJson(`/rooms/${encodeURIComponent(session.roomId)}/chat?after=0`, {
    headers: protectedHeaders
  }),
  readJson(`/rooms/${encodeURIComponent(session.roomId)}/computer?after=0`, {
    headers: protectedHeaders
  }),
  readResponse(game.frameUrl, { headers: protectedHeaders })
]);

assert(typeof game.voteWindow?.endsAt === "number", "The game vote window is missing.");
assert(Array.isArray(chat.messages), "The chat result is not valid.");
assert(typeof computer.filesystemRevision === "number", "The computer result is not valid.");
assert(frame.headers.get("content-type")?.startsWith("image/"), "The game frame is not an image.");

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: readiness.version,
    roomId: session.roomId,
    checks: ["ready", "session", "game", "frame", "chat", "computer"]
  })}\n`
);

async function readJson(path, init = {}) {
  const response = await readResponse(path, init);
  return response.json();
}

async function readResponse(path, init = {}) {
  const url = new URL(path, origin);
  const headers = new Headers(commonHeaders);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  return response;
}

function readArgument(name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1] ?? null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
