import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const STATE_PATH = ".wrangler/worker-candidate.json";

if (mode === "candidate") {
  createCandidate();
} else if (mode === "promote") {
  promoteCandidate();
} else {
  throw new Error("Use 'candidate' or 'promote'.");
}

function createCandidate() {
  assertClean();
  const deployments = JSON.parse(runWrangler(["deployments", "list", "--json"], false));
  const latestDeployment = deployments
    .slice()
    .sort((left, right) => Date.parse(left.created_on) - Date.parse(right.created_on))
    .at(-1);
  const current = latestDeployment?.versions
    ?.slice()
    .sort((left, right) => right.percentage - left.percentage)[0]?.version_id;
  if (!current) throw new Error("The current Worker version was not found.");

  const output = runWrangler([
    "versions",
    "upload",
    "--strict",
    "--message",
    "Agent canary candidate",
    "--preview-alias",
    "agent-canary"
  ]);
  const candidate = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(output)?.[1];
  if (!candidate) throw new Error("The uploaded Worker version ID was not found.");

  runWrangler([
    "versions",
    "deploy",
    `${current}@100`,
    `${candidate}@0`,
    "--yes",
    "--message",
    `Canary ${candidate} at zero percent`
  ]);

  const previewUrl = output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/i)?.[0] ?? null;
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(
    STATE_PATH,
    `${JSON.stringify({ current, candidate, previewUrl, createdAt: new Date().toISOString() }, null, 2)}\n`
  );
  process.stdout.write(`\nCandidate: ${candidate}\n`);
  if (previewUrl) process.stdout.write(`Preview: ${previewUrl}\n`);
  process.stdout.write(
    "Open the preview in the Codex built-in browser and call game.observe. " +
    "Then run npm run release:worker:promote -- --webmcp-canary-passed.\n"
  );
}

function promoteCandidate() {
  assertClean();
  if (!process.argv.includes("--webmcp-canary-passed")) {
    throw new Error("Run the live game.observe canary before promotion.");
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  if (!/^[0-9a-f-]{36}$/i.test(state.candidate)) {
    throw new Error("The saved candidate version is not valid.");
  }

  runNode(["scripts/canary.mjs", "--version", state.candidate]);
  runWrangler([
    "versions",
    "deploy",
    `${state.candidate}@100`,
    "--yes",
    "--message",
    `Promote canary ${state.candidate}`
  ]);
  runNode(["scripts/canary.mjs", "--expect-version", state.candidate]);
}

function assertClean() {
  runNode(["scripts/assert-clean.mjs"]);
}

function runNode(arguments_) {
  const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runWrangler(arguments_, showOutput = true) {
  const result = spawnSync("./node_modules/.bin/wrangler", arguments_, { encoding: "utf8" });
  if (showOutput) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}
