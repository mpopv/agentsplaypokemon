import { spawnSync } from "node:child_process";

const baseUrl = process.env.APP_ORIGIN ?? "https://agentsplaypokemon.com";
const adminToken = process.env.APP_ADMIN_TOKEN;
if (!adminToken) throw new Error("Set APP_ADMIN_TOKEN before a container release.");

runNode(["scripts/assert-clean.mjs"]);
runNpm(["run", "check"]);

const room = await readJson("/public/room");
const roomId = process.env.APP_ROOM ?? room.roomId;
await waitForIdle(roomId);
await Promise.all([
  adminRequest(`/admin/rooms/${encodeURIComponent(roomId)}/game/checkpoint`),
  adminRequest(`/admin/rooms/${encodeURIComponent(roomId)}/computer/snapshot`, {
    body: JSON.stringify({ reason: "pre-container-release" }),
    headers: { "content-type": "application/json" }
  })
]);
runNode(["scripts/canary.mjs", "--url", baseUrl, "--deep"]);
runWrangler(["deploy", "--containers-rollout=gradual"]);
runNode(["scripts/canary.mjs", "--url", baseUrl, "--deep"]);

process.stdout.write(
  `${JSON.stringify({ ok: true, roomId, checks: ["idle", "checkpoint", "snapshot", "pre-deploy-deep-canary", "gradual-deploy", "post-deploy-deep-canary"] })}\n`
);

async function waitForIdle(roomId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await adminRequest(
      `/admin/rooms/${encodeURIComponent(roomId)}/computer/status`,
      { method: "GET" }
    );
    if (status.queueDepth === 0 && status.snapshotRunning === false) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("The shared computer did not become idle within 60 seconds.");
}

function adminRequest(path, init = {}) {
  const headers = new Headers({
    origin: new URL(baseUrl).origin,
    authorization: `Bearer ${adminToken}`,
    ...init.headers
  });
  return readJson(path, { method: init.method ?? "POST", ...init, headers });
}

async function readJson(path, init = {}) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function runNode(arguments_) {
  run(process.execPath, arguments_);
}

function runNpm(arguments_) {
  run("npm", arguments_);
}

function runWrangler(arguments_) {
  run("./node_modules/.bin/wrangler", arguments_);
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: process.env,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
