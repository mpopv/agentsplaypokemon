const arguments_ = process.argv.slice(2);
const baseUrl = readArgument("--url") ?? process.env.APP_ORIGIN ?? "https://agentsplaypokemon.com";
const spectatorCount = readNonnegativeInteger("--spectators", 10);
const agentCount = readNonnegativeInteger("--agents", 5);
const commandCount = readNonnegativeInteger("--commands", 5);
const workspaceFiles = readNonnegativeInteger("--workspace-files", 0);
const durationSeconds = readNonnegativeInteger("--duration", 10);
const highOutput = arguments_.includes("--high-output");
const origin = new URL(baseUrl).origin;
const socketClients = [];
const loadDirectory = `/workspace/.load-test-${Date.now()}`;

const room = await readJson("/public/room");
const sessionCount = Math.max(agentCount, commandCount, workspaceFiles > 0 || highOutput ? 1 : 0);
const sessions = await Promise.all(Array.from({ length: sessionCount }, () => createSession()));

try {
  await openSpectatorSockets(room.roomId, spectatorCount, socketClients);
  if (workspaceFiles > 0) {
    const session = sessions[0];
    await agentRequest(session, "/computer/exec", {
      method: "POST",
      body: JSON.stringify({
        command: `mkdir -p '${loadDirectory}' && seq 1 ${workspaceFiles} | xargs -I{} touch '${loadDirectory}/file-{}'`,
        cwd: "/workspace"
      }),
      timeoutMs: 20_000
    });
    await delay(1_100);
  }

  const readSamples = [];
  const voteSamples = [];
  await Promise.all(sessions.slice(0, agentCount).map(async (session, index) => {
    const observe = await timedAgentRequest(session, "/game");
    readSamples.push(observe.durationMs);
    const chat = await timedAgentRequest(session, "/chat?after=0");
    readSamples.push(chat.durationMs);
    const vote = await timedAgentRequest(session, "/votes", {
      method: "POST",
      body: JSON.stringify({ input: ["up", "down", "left", "right", "a"][index % 5] })
    });
    voteSamples.push(vote.durationMs);
  }));

  let highOutputCommand = null;
  if (highOutput) {
    highOutputCommand = await timedAgentRequest(sessions[0], "/computer/exec", {
      method: "POST",
      body: JSON.stringify({
        command: "python3 -c 'import sys; sys.stdout.write(\"x\" * 2000000)'",
        cwd: "/workspace"
      }),
      timeoutMs: 20_000,
      acceptError: true,
      captureJson: true
    });
    await delay(1_100);
  }

  const commandResults = await Promise.all(
    sessions.slice(0, commandCount).map((session) => timedAgentRequest(
      session,
      "/computer/exec",
      {
        method: "POST",
        body: JSON.stringify({
          command: "true",
          cwd: "/workspace"
        }),
        timeoutMs: 20_000,
        acceptError: true,
        captureJson: true
      }
    ))
  );

  if (durationSeconds > 0) await delay(durationSeconds * 1_000);
  const acceptedCommands = commandResults.filter((result) => result.status === 200);
  const busyCommands = commandResults.filter((result) => result.status === 429 || result.status === 503);
  const unexpectedCommands = commandResults.filter(
    (result) => result.status !== 200 && result.status !== 429 && result.status !== 503
  );
  const overloadResponses = commandResults.filter((result) => result.overloaded);
  const highOutputResult = highOutputCommand?.body ?? null;
  const acceptedExitCodes = acceptedCommands.map((item) => item.body?.exitCode ?? null);
  const acceptedCommandErrors = acceptedCommands.map((item) => String(item.body?.stderr ?? ""));
  const result = {
    roomId: room.roomId,
    spectators: spectatorCount,
    publicSockets: socketClients.length,
    agents: agentCount,
    commands: commandCount,
    workspaceFiles,
    readP95Ms: percentile(readSamples, 0.95),
    voteP95Ms: percentile(voteSamples, 0.95),
    acceptedCommands: acceptedCommands.length,
    acceptedCommandP95Ms: percentile(acceptedCommands.map((item) => item.durationMs), 0.95),
    acceptedExitCodes,
    acceptedCommandErrors,
    busyCommands: busyCommands.length,
    busyRejectionP95Ms: percentile(busyCommands.map((item) => item.durationMs), 0.95),
    overloadResponses: overloadResponses.length,
    unexpectedCommands: unexpectedCommands.length,
    highOutputExitCode: highOutputResult?.exitCode ?? null,
    highOutputReturnedBytes: highOutputResult
      ? Buffer.byteLength(String(highOutputResult.stdout ?? ""))
      : null,
    highOutputStatus: highOutputCommand?.status ?? null
  };
  assert(result.readP95Ms < 300, `Read p95 was ${result.readP95Ms} ms.`);
  assert(result.voteP95Ms < 300, `Vote p95 was ${result.voteP95Ms} ms.`);
  assert(result.acceptedCommands <= 4, "More than four commands were accepted.");
  assert(result.acceptedCommandP95Ms < 10_000, "Accepted command p95 exceeded 10 seconds.");
  assert(result.busyRejectionP95Ms < 200, "Busy rejection p95 exceeded 200 ms.");
  assert(result.overloadResponses === 0, "A Durable Object overload response occurred.");
  assert(result.unexpectedCommands === 0, "An unexpected command response occurred.");
  assert(
    result.acceptedExitCodes.every((exitCode) => exitCode === 0),
    `An accepted command failed: ${JSON.stringify({ exitCodes: result.acceptedExitCodes, errors: result.acceptedCommandErrors })}.`
  );
  if (highOutput) {
    assert(result.highOutputStatus === 200, `The high-output command returned HTTP ${result.highOutputStatus}.`);
    assert(
      result.highOutputExitCode === 125,
      `The high-output command exited with ${result.highOutputExitCode}.`
    );
    assert(
      result.highOutputReturnedBytes <= 33_000,
      "The high-output response exceeded the returned-output limit."
    );
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} finally {
  for (const socket of socketClients) socket.close(1000, "load test complete");
  if (workspaceFiles > 0 && sessions[0]) {
    await delay(1_100);
    await agentRequest(sessions[0], "/computer/exec", {
      method: "POST",
      body: JSON.stringify({ command: `rm -rf '${loadDirectory}'`, cwd: "/workspace" }),
      timeoutMs: 20_000
    }).catch((cause) => {
      process.stderr.write(`Fixture cleanup failed: ${messageOf(cause)}\n`);
    });
  }
}

async function openSpectatorSockets(roomId, count, target) {
  const openings = [];
  for (let index = 0; index < count; index += 1) {
    openings.push(openSocket(`/public/rooms/${encodeURIComponent(roomId)}/game-socket`, target));
    openings.push(openSocket(`/public/rooms/${encodeURIComponent(roomId)}/computer-socket`, target));
  }
  await Promise.all(openings);
}

function openSocket(path, target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl(path));
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`A spectator socket did not open: ${path}`));
    }, 8_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      target.push(socket);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`A spectator socket failed: ${path}`));
    });
  });
}

function createSession() {
  return readJson("/api/session", { method: "POST", headers: { origin } });
}

async function timedAgentRequest(session, path, init = {}) {
  const startedAt = performance.now();
  const response = await rawAgentRequest(session, path, init);
  const result = {
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
    overloaded: response.headers.get("x-overloaded") === "true",
    body: null
  };
  if (!response.ok && !init.acceptError) {
    throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`);
  }
  if (init.captureJson && response.ok) result.body = await response.json();
  else await response.body?.cancel();
  return result;
}

async function agentRequest(session, path, init = {}) {
  const response = await rawAgentRequest(session, path, init);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function rawAgentRequest(session, path, init = {}) {
  const {
    timeoutMs = 8_000,
    acceptError: _acceptError,
    captureJson: _captureJson,
    ...requestInit
  } = init;
  const headers = new Headers({
    origin,
    authorization: `Bearer ${session.token}`,
    ...requestInit.headers
  });
  if (requestInit.body !== undefined) headers.set("content-type", "application/json");
  return fetch(new URL(`/rooms/${encodeURIComponent(session.roomId)}${path}`, baseUrl), {
    ...requestInit,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function readJson(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  return response.json();
}

function webSocketUrl(path) {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function readArgument(name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1] ?? null;
}

function readNonnegativeInteger(name, fallback) {
  const value = Number(readArgument(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be nonnegative.`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
