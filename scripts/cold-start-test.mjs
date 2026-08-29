const arguments_ = process.argv.slice(2);
const baseUrl = readArgument("--url") ?? process.env.APP_ORIGIN ?? "https://agentsplaypokemon.com";
const roomId = readArgument("--room") ?? process.env.APP_ROOM ?? "main";
const iterations = readPositiveInteger("--iterations", 5);
const adminToken = process.env.APP_ADMIN_TOKEN;
if (!adminToken) throw new Error("Set APP_ADMIN_TOKEN before a cold-start test.");

const results = [];
for (let index = 0; index < iterations; index += 1) {
  const startedAt = performance.now();
  const [computer, game] = await Promise.all([
    adminRequest(`/admin/rooms/${encodeURIComponent(roomId)}/computer/restart`),
    adminRequest(`/admin/rooms/${encodeURIComponent(roomId)}/game/restart`)
  ]);
  const session = await createSession();
  const commandStartedAt = performance.now();
  const command = await readJson(`/rooms/${encodeURIComponent(roomId)}/computer/exec`, {
    method: "POST",
    headers: {
      origin: new URL(baseUrl).origin,
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ command: "true", cwd: "/workspace" }),
    timeoutMs: 20_000
  });
  results.push({
    iteration: index + 1,
    totalMs: Math.round(performance.now() - startedAt),
    immediateCommandMs: Math.round(performance.now() - commandStartedAt),
    computerProbeMs: computer.totalMs,
    gameProbeMs: game.durationMs,
    commandExitCode: command.exitCode
  });
}

const commandP95 = percentile(results.map((result) => result.immediateCommandMs), 0.95);
assert(results.every((result) => result.commandExitCode === 0), "A command failed after restart.");
assert(commandP95 < 10_000, `The post-restart command p95 was ${commandP95} ms.`);
process.stdout.write(`${JSON.stringify({ ok: true, roomId, commandP95, results }, null, 2)}\n`);

function createSession() {
  return readJson("/api/session", {
    method: "POST",
    headers: { origin: new URL(baseUrl).origin }
  });
}

function adminRequest(path) {
  return readJson(path, {
    method: "POST",
    headers: {
      origin: new URL(baseUrl).origin,
      authorization: `Bearer ${adminToken}`
    },
    timeoutMs: 30_000
  });
}

async function readJson(path, init = {}) {
  const { timeoutMs = 8_000, ...requestInit } = init;
  const url = new URL(path, baseUrl);
  const response = await fetch(url, {
    ...requestInit,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function readArgument(name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1] ?? null;
}

function readPositiveInteger(name, fallback) {
  const value = Number(readArgument(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
