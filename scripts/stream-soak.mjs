const arguments_ = process.argv.slice(2);
const baseUrl = readArgument("--url") ?? process.env.APP_ORIGIN ?? "https://agentsplaypokemon.com";
const requestedSeconds = Number(readArgument("--seconds") ?? 0);
const requestedHours = Number(readArgument("--hours") ?? 12);
const durationMs = requestedSeconds > 0 ? requestedSeconds * 1_000 : requestedHours * 60 * 60 * 1_000;
if (!Number.isFinite(durationMs) || durationMs < 10_000) {
  throw new Error("The soak duration must be at least 10 seconds.");
}

const room = await readJson("/public/room");
const game = await readJson(`/public/rooms/${encodeURIComponent(room.roomId)}/game`);
if (game.mode !== "rom") throw new Error("The stream soak requires a room with a ROM.");

let frames = 0;
let textMessages = 0;
let reconnects = 0;
let maximumFrameGapMs = 0;
let lastFrameAt = 0;
let stopped = false;
let socket;
const startedAt = performance.now();
const deadline = Date.now() + durationMs;

await new Promise((resolve, reject) => {
  const connect = () => {
    if (stopped) return;
    const next = new WebSocket(webSocketUrl(`/public/rooms/${encodeURIComponent(room.roomId)}/game-stream`));
    socket = next;
    next.binaryType = "arraybuffer";
    const connectTimer = setTimeout(() => next.close(), 10_000);
    next.addEventListener("open", () => clearTimeout(connectTimer));
    next.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        textMessages += 1;
        return;
      }
      const now = performance.now();
      if (lastFrameAt > 0) maximumFrameGapMs = Math.max(maximumFrameGapMs, now - lastFrameAt);
      lastFrameAt = now;
      frames += 1;
    });
    next.addEventListener("close", () => {
      clearTimeout(connectTimer);
      if (stopped) return;
      reconnects += 1;
      setTimeout(connect, 500);
    });
    next.addEventListener("error", () => next.close());
  };
  connect();
  const progress = setInterval(() => {
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    process.stdout.write(
      `${JSON.stringify({ elapsedSeconds: Math.round(elapsedSeconds), frames, averageFps: Number((frames / elapsedSeconds).toFixed(2)), reconnects, maximumFrameGapMs: Math.round(maximumFrameGapMs) })}\n`
    );
  }, 60_000);
  const finish = setInterval(() => {
    if (Date.now() < deadline) return;
    stopped = true;
    clearInterval(progress);
    clearInterval(finish);
    socket?.close(1000, "soak complete");
    resolve();
  }, 1_000);
  setTimeout(() => {
    if (frames === 0) reject(new Error("The stream did not deliver a frame within 15 seconds."));
  }, 15_000);
});

const elapsedSeconds = (performance.now() - startedAt) / 1_000;
const averageFps = frames / elapsedSeconds;
assert(averageFps >= 12, `The stream averaged ${averageFps.toFixed(2)} fps.`);
assert(maximumFrameGapMs < 5_000, `The longest frame gap was ${Math.round(maximumFrameGapMs)} ms.`);
process.stdout.write(
  `${JSON.stringify({ ok: true, roomId: room.roomId, elapsedSeconds: Math.round(elapsedSeconds), frames, textMessages, averageFps: Number(averageFps.toFixed(2)), reconnects, maximumFrameGapMs: Math.round(maximumFrameGapMs) }, null, 2)}\n`
);

async function readJson(path) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  return response.json();
}

function webSocketUrl(path) {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function readArgument(name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1] ?? null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
