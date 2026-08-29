import { spawnSync } from "node:child_process";

const previousVersion = currentVersion();
let deployedVersion = null;

try {
  runWrangler([
    "deploy",
    "--containers-rollout=none",
    "--message",
    "Atomic Worker and Durable Object release"
  ]);
  deployedVersion = currentVersion();
  if (deployedVersion === previousVersion) {
    throw new Error("The Worker deployment did not create a new production version.");
  }
  runNode(["scripts/canary.mjs", "--expect-version", deployedVersion]);
} catch (cause) {
  process.stderr.write(`Worker release failed: ${messageOf(cause)}\n`);
  runWrangler([
    "rollback",
    previousVersion,
    "--yes",
    "--message",
    `Rollback failed Worker release ${deployedVersion ?? "unknown"}`
  ]);
  await verifyReady(previousVersion);
  throw cause;
}

process.stdout.write(
  `${JSON.stringify({ ok: true, previousVersion, deployedVersion, containersChanged: false })}\n`
);

function currentVersion() {
  const deployments = JSON.parse(runWrangler(["deployments", "list", "--json"], false));
  const latest = deployments
    .slice()
    .sort((left, right) => Date.parse(left.created_on) - Date.parse(right.created_on))
    .at(-1);
  const active = latest?.versions
    ?.slice()
    .sort((left, right) => right.percentage - left.percentage)[0]?.version_id;
  if (!active) throw new Error("The current Worker version was not found.");
  return active;
}

async function verifyReady(expectedVersion) {
  const response = await fetch("https://agentsplaypokemon.com/ready", {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Rollback readiness returned HTTP ${response.status}.`);
  const readiness = await response.json();
  if (readiness.ok !== true || readiness.version !== expectedVersion) {
    throw new Error("Rollback readiness did not return the expected version.");
  }
}

function runNode(arguments_) {
  run(process.execPath, arguments_);
}

function runWrangler(arguments_, showOutput = true) {
  return run("./node_modules/.bin/wrangler", arguments_, showOutput);
}

function run(command, arguments_, showOutput = true) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: process.env
  });
  if (showOutput) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
