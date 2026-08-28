import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
if (result.stdout.trim()) {
  throw new Error("Release commands require a clean Git worktree.");
}
