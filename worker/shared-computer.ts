import { DurableObject, tracing } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  shellQuote,
  type WorkspaceClient,
  type WorkspaceOptions,
  withWorkspace,
  WorkspaceProxy
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";

import type {
  AgentIdentity,
  ComputerAgentActivity,
  ComputerEvent,
  ComputerEventHistoryPage,
  ComputerExecResult,
  ComputerFileView,
  ComputerOverview,
  ComputerReleaseStatus,
  ComputerRuntimeProbe,
  ComputerSnapshot,
  ComputerTreeEntry,
  SocketEnvelope
} from "../shared/types";
import { bytesToBase64, readStream, safeTextPreview } from "./lib/encoding";
import {
  BackendCircuitBreaker,
  CommandAdmission,
  extractProcessMetrics,
  isBackendFailure
} from "./lib/command-guard";
import { makeHistoryPage } from "./lib/history-page";
import { InputError, parseCommand, parseWorkspacePath } from "./lib/validation";

interface ComputerMetaRow {
  [key: string]: SqlStorageValue;
  room_id: string | null;
  initialized: number;
  filesystem_revision: number;
  updated_at: number;
}

interface ComputerEventRow {
  [key: string]: SqlStorageValue;
  sequence: number;
  agent_id: string;
  display_name: string;
  event_type: string;
  command: string | null;
  exit_code: number | null;
  stdout_preview: string | null;
  stderr_preview: string | null;
  filesystem_revision: number;
  created_at: number;
}

interface ComputerActivityAggregateRow {
  [key: string]: SqlStorageValue;
  count: number;
  first_at: number | null;
  last_at: number | null;
}

interface SnapshotManifestEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  mtime: number;
  objectKey?: string;
  target?: string;
}

interface SnapshotManifest {
  version: 1;
  roomId: string;
  snapshotId: string;
  filesystemRevision: number;
  createdAt: number;
  entries: SnapshotManifestEntry[];
}

const MAX_FILE_VIEW_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 5_000;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const EXEC_RATE_LIMIT_MS = 1_000;
const COMPUTER_EVENT_HISTORY_PAGE_SIZE = 20;
const AUTOMATIC_SNAPSHOT_IDLE_DELAY_MS = 1_000;
const AUTOMATIC_SNAPSHOT_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
const MANUAL_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const COMPUTER_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const TOMBSTONE_ALERT_THRESHOLD = 10_000;

function computerContainerEnv(env: Env): Record<string, string> {
  return {
    COMPUTER_VAR_COMPUTER_OUTPUT_LIMIT_BYTES: env.COMPUTER_OUTPUT_LIMIT_BYTES,
    COMPUTER_VAR_COMPUTER_EXEC_TIMEOUT_SECONDS: String(
      Math.max(1, Math.floor(Number(env.COMPUTER_EXEC_TIMEOUT_MS) / 1000) - 1)
    )
  };
}

class SharedComputerContainerBase extends withWorkspaceContainer(
  class extends DurableObject<Env> {}
) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "SHARED_COMPUTERS", id: this.ctx.id.toString() },
    egress: { mode: "none" },
    containerEnv: computerContainerEnv(this.env)
  });

  workspaceContext(): DurableObjectState {
    return this.ctx;
  }
}

function workspaceOptions(self: InstanceType<typeof SharedComputerContainerBase>): WorkspaceOptions {
  const ctx = self.workspaceContext();
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: ctx.id.toString(),
    backends: [self.backend],
    observer: createCloudflareObserver({ tracing })
  };
}

export class SharedComputerDO extends withWorkspace(
  SharedComputerContainerBase,
  workspaceOptions
) {
  private executionTail: Promise<void> = Promise.resolve();
  private readonly admission = new CommandAdmission(4);
  private readonly circuit = new BackendCircuitBreaker(2, 30_000);
  private snapshotRunning = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  async exec(
    roomId: string,
    agent: AgentIdentity,
    commandValue: unknown,
    cwdValue?: unknown
  ): Promise<ComputerExecResult> {
    const command = parseCommand(commandValue);
    const cwd = parseWorkspacePath(cwdValue);
    this.identify(roomId);
    this.circuit.assertAvailable();
    const accepted = this.admission.admit(agent.agentId);
    try {
      this.enforceExecRateLimit(agent.agentId);
    } catch (error) {
      accepted.release();
      throw error;
    }
    const acceptedAt = Date.now();

    try {
      return await this.serialized(async () => {
        await this.ensureInitialized(roomId);
        const startedAt = Date.now();
        let workspaceAcquireMs = 0;
        let containerConnectMs = 0;
        let commandMs = 0;
      try {
        const workspaceStartedAt = Date.now();
        using workspace = await getWorkspace(this);
        workspaceAcquireMs = Date.now() - workspaceStartedAt;
        const containerStartedAt = Date.now();
        using run = await workspace.runtime.exec(
          `/usr/local/bin/agent-exec ${shellQuote(command)}`,
          {
            cwd,
            encoding: "utf8",
            timeoutMs: Number(this.env.COMPUTER_EXEC_TIMEOUT_MS) + 2_000
          }
        );
        containerConnectMs = Date.now() - containerStartedAt;
        const commandStartedAt = Date.now();
        const result = await run.result();
        commandMs = Date.now() - commandStartedAt;
        const parsed = extractProcessMetrics(result.stderr);
        const filesystemRevision = result.pulled > 0
          ? this.advanceRevision()
          : this.readMeta().filesystem_revision;
        const event = this.appendEvent({
          agent,
          eventType: "exec",
          command,
          exitCode: result.exitCode,
          stdoutPreview: result.stdout.slice(0, 2_048),
          stderrPreview: parsed.stderr.slice(0, 2_048),
          filesystemRevision
        });
        this.broadcast("exec.completed", event);
        this.circuit.recordSuccess();
        console.log({
          message: "computer exec completed",
          requestId: crypto.randomUUID(),
          agentIdHash: await shortHash(agent.agentId),
          queueDepthAtArrival: accepted.depthAtArrival,
          queueWaitMs: startedAt - acceptedAt,
          workspaceAcquireMs,
          containerConnectMs,
          commandMs,
          syncMs: 0,
          filesystemRevision,
          filesystemEntries: parsed.metrics?.filesystemEntries ?? null,
          filesystemBytes: parsed.metrics?.filesystemBytes ?? null,
          stdoutProducedBytes: parsed.metrics?.stdoutProducedBytes ?? null,
          stderrProducedBytes: parsed.metrics?.stderrProducedBytes ?? null,
          stdoutReturnedBytes: parsed.metrics?.stdoutReturnedBytes ?? result.stdout.length,
          stderrReturnedBytes: parsed.metrics?.stderrReturnedBytes ?? parsed.stderr.length,
          totalMs: Date.now() - acceptedAt,
          status: "completed"
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: parsed.stderr,
          durationMs: Date.now() - startedAt,
          filesystemRevision
        };
      } catch (error) {
        if (isBackendFailure(error)) this.circuit.recordFailure();
        const filesystemRevision = this.readMeta().filesystem_revision;
        const message = error instanceof Error ? error.message : String(error);
        const event = this.appendEvent({
          agent,
          eventType: "exec.error",
          command,
          exitCode: null,
          stdoutPreview: null,
          stderrPreview: message.slice(0, 2_048),
          filesystemRevision
        });
        this.broadcast("exec.error", event);
        console.error({
          message: "computer exec failed",
          queueDepthAtArrival: accepted.depthAtArrival,
          queueWaitMs: startedAt - acceptedAt,
          workspaceAcquireMs,
          containerConnectMs,
          commandMs,
          totalMs: Date.now() - acceptedAt,
          status: "failed",
          errorName: error instanceof Error ? error.name : "Error",
          errorMessage: message,
          overloaded: readBooleanProperty(error, "overloaded"),
          retryable: readBooleanProperty(error, "retryable")
        });
        throw error;
      }
      });
    } finally {
      accepted.release();
    }
  }

  async overview(roomId: string, after = 0): Promise<ComputerOverview> {
    this.identify(roomId);
    await this.ensureInitialized(roomId);
    return {
      roomId,
      filesystemRevision: this.readMeta().filesystem_revision,
      events: this.readEvents(after, 100)
    };
  }

  async eventHistory(roomId: string, before?: number): Promise<ComputerEventHistoryPage> {
    this.identify(roomId);
    await this.ensureInitialized(roomId);
    const rows = before === undefined
      ? this.ctx.storage.sql
          .exec<ComputerEventRow>(
            `SELECT sequence, agent_id, display_name, event_type, command, exit_code,
                    stdout_preview, stderr_preview, filesystem_revision, created_at
             FROM computer_events
             ORDER BY sequence DESC
             LIMIT ?`,
            COMPUTER_EVENT_HISTORY_PAGE_SIZE + 1
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<ComputerEventRow>(
            `SELECT sequence, agent_id, display_name, event_type, command, exit_code,
                    stdout_preview, stderr_preview, filesystem_revision, created_at
             FROM computer_events
             WHERE sequence < ?
             ORDER BY sequence DESC
             LIMIT ?`,
            before,
            COMPUTER_EVENT_HISTORY_PAGE_SIZE + 1
          )
          .toArray();
    const page = makeHistoryPage(rows, COMPUTER_EVENT_HISTORY_PAGE_SIZE);
    return {
      roomId,
      filesystemRevision: this.readMeta().filesystem_revision,
      events: page.items.map(mapEvent),
      nextBefore: page.nextBefore,
      hasMore: page.hasMore
    };
  }

  agentActivity(roomId: string, agentId: string): ComputerAgentActivity {
    this.identify(roomId);
    const summary = this.ctx.storage.sql
      .exec<{
        display_name: string;
        command_count: number;
        first_recorded_at: number | null;
        last_recorded_at: number | null;
      }>(
        `SELECT display_name, command_count, first_recorded_at, last_recorded_at
         FROM computer_agent_summaries
         WHERE agent_id = ?`,
        agentId
      )
      .toArray()[0];
    const stats = this.ctx.storage.sql
      .exec<ComputerActivityAggregateRow>(
        `SELECT COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM computer_events
         WHERE agent_id = ?`,
        agentId
      )
      .one();
    const last = this.ctx.storage.sql
      .exec<ComputerEventRow>(
        `SELECT sequence, agent_id, display_name, event_type, command, exit_code,
                stdout_preview, stderr_preview, filesystem_revision, created_at
         FROM computer_events
         WHERE agent_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
        agentId
      )
      .toArray()[0];

    return {
      displayName: last?.display_name ?? summary?.display_name ?? null,
      firstRecordedAt: minimumTimestamp(summary?.first_recorded_at, stats.first_at),
      lastRecordedAt: maximumTimestamp(summary?.last_recorded_at, stats.last_at),
      commandCount: Number(summary?.command_count ?? 0) + Number(stats.count),
      lastCommand:
        last?.command !== null && last?.command !== undefined
          ? {
              command: last.command,
              eventType: last.event_type,
              exitCode: last.exit_code,
              filesystemRevision: last.filesystem_revision,
              createdAt: last.created_at
            }
          : null
    };
  }

  async tree(roomId: string, pathValue?: unknown): Promise<ComputerTreeEntry[]> {
    this.identify(roomId);
    await this.ensureInitialized(roomId);
    const path = parseWorkspacePath(pathValue);
    using workspace = await getWorkspace(this);
    const entries = await workspace.fs.readdir(path, { limit: 500 });
    return entries
      .map((entry) => ({
        name: entry.name,
        path: path === "/workspace" ? `${path}/${entry.name}` : `${path}/${entry.name}`,
        size: entry.size,
        mtime: entry.mtime,
        type: entry.isSymbolicLink
          ? ("symlink" as const)
          : entry.isDirectory
            ? ("directory" as const)
            : ("file" as const)
      }))
      .sort((left, right) => {
        if (left.type === right.type) return left.name.localeCompare(right.name);
        if (left.type === "directory") return -1;
        if (right.type === "directory") return 1;
        return left.name.localeCompare(right.name);
      });
  }

  async file(roomId: string, pathValue: unknown): Promise<ComputerFileView> {
    this.identify(roomId);
    await this.ensureInitialized(roomId);
    const path = parseWorkspacePath(pathValue);
    using workspace = await getWorkspace(this);
    const stat = await workspace.fs.stat(path);
    if (!stat.isFile) throw new InputError("path is not a file", 400);
    const stream = await workspace.fs.readFile(path, { byteLength: MAX_FILE_VIEW_BYTES + 1 });
    const bytes = await readStream(stream);
    const truncated = bytes.byteLength > MAX_FILE_VIEW_BYTES;
    const visible = truncated ? bytes.subarray(0, MAX_FILE_VIEW_BYTES) : bytes;
    const text = safeTextPreview(visible, MAX_FILE_VIEW_BYTES);
    return {
      path,
      size: stat.size,
      mtime: stat.mtime,
      mode: stat.mode,
      encoding: text === null ? "base64" : "utf8",
      content: text === null ? bytesToBase64(visible) : text,
      truncated
    };
  }

  async snapshot(roomId: string, reason: string): Promise<ComputerSnapshot> {
    this.identify(roomId);
    if (this.snapshotRunning) throw new InputError("a snapshot is already running", 409);
    this.snapshotRunning = true;
    try {
      return await this.serialized(() => this.createSnapshot(roomId, reason));
    } finally {
      this.snapshotRunning = false;
    }
  }

  async automaticMaintenance(roomId: string): Promise<{
    snapshot: ComputerSnapshot | { skipped: true; reason: string };
    deletedSnapshots: number;
    deletedEvents: number;
    tombstones: number;
  }> {
    this.identify(roomId);
    let snapshot: ComputerSnapshot | { skipped: true; reason: string };
    if (this.admission.queueDepth > 0 || this.snapshotRunning) {
      snapshot = { skipped: true, reason: "computer-busy" };
    } else {
      this.snapshotRunning = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, AUTOMATIC_SNAPSHOT_IDLE_DELAY_MS));
        if (this.admission.queueDepth > 0) {
          snapshot = { skipped: true, reason: "command-arrived" };
        } else if (this.latestSnapshotRevision() === this.readMeta().filesystem_revision) {
          snapshot = { skipped: true, reason: "filesystem-unchanged" };
        } else {
          snapshot = await this.serialized(() => this.createSnapshot(roomId, "automatic-hourly"));
        }
      } finally {
        this.snapshotRunning = false;
      }
    }

    const retention = await this.runRetention(roomId);
    return { snapshot, ...retention };
  }

  async restore(roomId: string, snapshotId: string): Promise<ComputerSnapshot> {
    return this.serialized(async () => {
      this.identify(roomId);
      const snapshot = this.ctx.storage.sql
        .exec<{
          manifest_key: string;
          filesystem_revision: number;
          file_count: number;
          total_bytes: number;
          created_at: number;
        }>(
          `SELECT manifest_key, filesystem_revision, file_count, total_bytes, created_at
           FROM snapshots WHERE snapshot_id = ?`,
          snapshotId
        )
        .toArray()[0];
      if (!snapshot) throw new InputError("snapshot does not exist", 404);
      const manifestObject = await this.env.PRIVATE_DATA.get(snapshot.manifest_key);
      if (manifestObject === null) throw new Error("snapshot manifest object is missing");
      const manifest = (await manifestObject.json()) as SnapshotManifest;
      if (manifest.version !== 1 || manifest.roomId !== roomId || manifest.snapshotId !== snapshotId) {
        throw new Error("snapshot manifest does not match this room");
      }

      using workspace = await getWorkspace(this);
      await workspace.fs.rm("/workspace", { recursive: true, force: true });
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await workspace.fs.chmod("/workspace", 0o777);

      const directories = manifest.entries
        .filter((entry) => entry.type === "directory")
        .sort((left, right) => depth(left.path) - depth(right.path));
      for (const entry of directories) {
        await workspace.fs.mkdir(entry.path, { recursive: true });
        await workspace.fs.chmod(entry.path, entry.mode);
      }
      for (const entry of manifest.entries.filter((item) => item.type === "file")) {
        if (!entry.objectKey) throw new Error(`snapshot object key is missing for ${entry.path}`);
        const object = await this.env.PRIVATE_DATA.get(entry.objectKey);
        if (object === null) throw new Error(`snapshot object is missing for ${entry.path}`);
        await workspace.fs.writeFile(entry.path, object.body);
        await workspace.fs.chmod(entry.path, entry.mode);
      }
      for (const entry of manifest.entries.filter((item) => item.type === "symlink")) {
        if (entry.target === undefined) throw new Error(`snapshot target is missing for ${entry.path}`);
        await workspace.fs.symlink(entry.target, entry.path);
      }

      const filesystemRevision = this.advanceRevision();
      this.appendAdminEvent("snapshot.restored", snapshotId, filesystemRevision);
      return {
        snapshotId,
        filesystemRevision,
        fileCount: snapshot.file_count,
        totalBytes: snapshot.total_bytes,
        uploadedFileCount: 0,
        uploadedBytes: 0,
        createdAt: snapshot.created_at
      };
    });
  }

  async reset(roomId: string): Promise<{ filesystemRevision: number }> {
    return this.serialized(async () => {
      this.identify(roomId);
      using workspace = await getWorkspace(this);
      await workspace.fs.rm("/workspace", { recursive: true, force: true });
      await this.seedWorkspace(workspace);
      this.ctx.storage.sql.exec("UPDATE computer_meta SET initialized = 1 WHERE id = 1");
      const filesystemRevision = this.advanceRevision();
      this.appendAdminEvent("workspace.reset", null, filesystemRevision);
      return { filesystemRevision };
    });
  }

  releaseStatus(roomId: string): ComputerReleaseStatus {
    this.identify(roomId);
    return {
      queueDepth: this.admission.queueDepth,
      snapshotRunning: this.snapshotRunning,
      circuitOpenUntil: this.circuit.circuitOpenUntil
    };
  }

  async deepProbe(roomId: string): Promise<ComputerRuntimeProbe> {
    this.identify(roomId);
    if (this.admission.queueDepth > 0 || this.snapshotRunning) {
      throw new InputError("the shared computer is busy; retry the probe shortly", 503, 2);
    }
    this.circuit.assertAvailable();
    const startedAt = Date.now();
    let workspaceAcquireMs = 0;
    let containerConnectMs = 0;
    let commandMs = 0;
    try {
      const workspaceStartedAt = Date.now();
      using workspace = await getWorkspace(this);
      workspaceAcquireMs = Date.now() - workspaceStartedAt;
      const containerStartedAt = Date.now();
      using run = await workspace.runtime.exec("true", {
        cwd: "/workspace",
        encoding: "utf8",
        timeoutMs: Number(this.env.COMPUTER_EXEC_TIMEOUT_MS) + 2_000
      });
      containerConnectMs = Date.now() - containerStartedAt;
      const commandStartedAt = Date.now();
      const result = await run.result();
      commandMs = Date.now() - commandStartedAt;
      if (result.exitCode !== 0) throw new Error(`deep probe exited with ${result.exitCode}`);
      this.circuit.recordSuccess();
      const probe = {
        ok: true as const,
        workspaceAcquireMs,
        containerConnectMs,
        commandMs,
        totalMs: Date.now() - startedAt
      };
      console.log({ message: "computer deep probe completed", ...probe });
      return probe;
    } catch (error) {
      if (isBackendFailure(error)) this.circuit.recordFailure();
      console.error({
        message: "computer deep probe failed",
        workspaceAcquireMs,
        containerConnectMs,
        commandMs,
        totalMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async restartRuntime(roomId: string): Promise<ComputerRuntimeProbe> {
    this.identify(roomId);
    if (this.admission.queueDepth > 0 || this.snapshotRunning) {
      throw new InputError("the shared computer must be idle before restart", 409);
    }
    const container = this.getWorkspaceContainer();
    await container.restart(computerContainerEnv(this.env), false);
    this.circuit.recordSuccess();
    return this.deepProbe(roomId);
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ws") return this.backend.handleFetch(request);
    if (
      path !== "/internal/computer-socket" &&
      path !== "/internal/public-computer-socket"
    ) {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const agentId = request.headers.get("x-agent-id");
    const isPublic = path === "/internal/public-computer-socket";
    if (!isPublic && !agentId) return new Response("unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(
      server,
      isPublic ? ["computer"] : ["computer", `agent:${agentId}`]
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    socket.send(
      JSON.stringify({ source: "computer", type: "pong", payload: {}, createdAt: Date.now() })
    );
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS computer_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        room_id TEXT,
        initialized INTEGER NOT NULL DEFAULT 0,
        filesystem_revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO computer_meta (id, updated_at) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS computer_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        command TEXT,
        exit_code INTEGER,
        stdout_preview TEXT,
        stderr_preview TEXT,
        filesystem_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS computer_events_agent
        ON computer_events(agent_id, sequence DESC);

      CREATE TABLE IF NOT EXISTS exec_rate_limits (
        agent_id TEXT PRIMARY KEY,
        last_exec_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        manifest_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        filesystem_revision INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshot_objects (
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        object_key TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      );
      CREATE INDEX IF NOT EXISTS snapshot_objects_key ON snapshot_objects(object_key);

      CREATE TABLE IF NOT EXISTS computer_agent_summaries (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        command_count INTEGER NOT NULL,
        first_recorded_at INTEGER,
        last_recorded_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS computer_admin_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        detail TEXT,
        filesystem_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private identify(roomId: string): void {
    const current = this.readMeta().room_id;
    if (current === null) {
      this.ctx.storage.sql.exec(
        "UPDATE computer_meta SET room_id = ?, updated_at = ? WHERE id = 1",
        roomId,
        Date.now()
      );
      return;
    }
    if (current !== roomId) throw new Error("room identity does not match this Durable Object");
  }

  private readMeta(): ComputerMetaRow {
    return this.ctx.storage.sql.exec<ComputerMetaRow>("SELECT * FROM computer_meta WHERE id = 1").one();
  }

  private async ensureInitialized(_roomId: string): Promise<void> {
    const meta = this.readMeta();
    if (meta.initialized === 1) return;
    using workspace = await getWorkspace(this);
    await this.seedWorkspace(workspace);
    this.ctx.storage.sql.exec(
      "UPDATE computer_meta SET initialized = 1, updated_at = ? WHERE id = 1",
      Date.now()
    );
  }

  private async seedWorkspace(workspace: WorkspaceClient): Promise<void> {
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.chmod("/workspace", 0o777);
    await workspace.fs.writeFile(
      "/workspace/README.md",
      "# Shared Computer\n\nAll agents use this workspace. Coordinate through files, Git, SQLite, or scripts.\n"
    );
    await workspace.fs.writeFile(
      "/workspace/current_goal.md",
      "# Current Goal\n\nExplore the game, share observations, and agree on the next move.\n"
    );
    await workspace.fs.chmod("/workspace/README.md", 0o666);
    await workspace.fs.chmod("/workspace/current_goal.md", 0o666);
  }

  private enforceExecRateLimit(agentId: string): void {
    const now = Date.now();
    const last = this.ctx.storage.sql
      .exec<{ last_exec_at: number }>(
        "SELECT last_exec_at FROM exec_rate_limits WHERE agent_id = ?",
        agentId
      )
      .toArray()[0];
    if (last && now - last.last_exec_at < EXEC_RATE_LIMIT_MS) {
      throw new InputError("wait one second before you run another command", 429, 1);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO exec_rate_limits (agent_id, last_exec_at)
       VALUES (?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET last_exec_at = excluded.last_exec_at`,
      agentId,
      now
    );
  }

  private advanceRevision(): number {
    return this.ctx.storage.sql
      .exec<{ filesystem_revision: number }>(
        `UPDATE computer_meta
         SET filesystem_revision = filesystem_revision + 1, updated_at = ?
         WHERE id = 1
         RETURNING filesystem_revision`,
        Date.now()
      )
      .one().filesystem_revision;
  }

  private latestSnapshotRevision(): number | null {
    return this.ctx.storage.sql
      .exec<{ filesystem_revision: number }>(
        "SELECT filesystem_revision FROM snapshots ORDER BY created_at DESC LIMIT 1"
      )
      .toArray()[0]?.filesystem_revision ?? null;
  }

  private async createSnapshot(roomId: string, reason: string): Promise<ComputerSnapshot> {
    const startedAt = Date.now();
    await this.ensureInitialized(roomId);
    using workspace = await getWorkspace(this);
    const found = await workspace.fs.find("/workspace", undefined, {
      limit: MAX_SNAPSHOT_ENTRIES + 1
    });
    if (found.length > MAX_SNAPSHOT_ENTRIES) {
      throw new InputError(`snapshot contains more than ${MAX_SNAPSHOT_ENTRIES} entries`, 413);
    }
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
      .randomUUID()
      .slice(0, 8)}`;
    const createdAt = Date.now();
    const filesystemRevision = this.readMeta().filesystem_revision;
    const previous = await this.latestSnapshotManifest();
    const previousByPath = new Map(previous?.entries.map((entry) => [entry.path, entry]) ?? []);
    const entries: SnapshotManifestEntry[] = [];
    let totalBytes = 0;
    let uploadedFileCount = 0;
    let uploadedBytes = 0;

    for (const foundEntry of found) {
      const stat = await workspace.fs.lstat(foundEntry.path);
      const type = stat.isSymbolicLink
        ? ("symlink" as const)
        : stat.isDirectory
          ? ("directory" as const)
          : ("file" as const);
      const entry: SnapshotManifestEntry = {
        path: foundEntry.path,
        type,
        size: stat.size,
        mode: stat.mode,
        mtime: stat.mtime
      };
      if (type === "file") {
        totalBytes += stat.size;
        if (totalBytes > MAX_SNAPSHOT_BYTES) {
          throw new InputError("snapshot is larger than 100 MiB", 413);
        }
        const old = previousByPath.get(foundEntry.path);
        if (old?.type === "file" && old.size === stat.size && old.mtime === stat.mtime && old.objectKey) {
          entry.objectKey = old.objectKey;
        } else {
          entry.objectKey = snapshotFileKey(roomId, snapshotId, foundEntry.path);
          const stream = await workspace.fs.readFile(foundEntry.path);
          await putKnownLength(this.env.PRIVATE_DATA, entry.objectKey, stream, stat.size);
          uploadedFileCount += 1;
          uploadedBytes += stat.size;
        }
      } else if (type === "symlink") {
        entry.target = await workspace.fs.readlink(foundEntry.path);
      }
      entries.push(entry);
    }

    const manifest: SnapshotManifest = {
      version: 1,
      roomId,
      snapshotId,
      filesystemRevision,
      createdAt,
      entries
    };
    const manifestKey = snapshotManifestKey(roomId, snapshotId);
    await this.env.PRIVATE_DATA.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" }
    });
    const fileEntries = entries.filter(
      (entry): entry is SnapshotManifestEntry & { objectKey: string } =>
        entry.type === "file" && entry.objectKey !== undefined
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO snapshots
        (snapshot_id, manifest_key, reason, filesystem_revision, file_count, total_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      snapshotId,
      manifestKey,
      reason.slice(0, 200),
      filesystemRevision,
      fileEntries.length,
      totalBytes,
      createdAt
    );
    for (const entry of fileEntries) {
      this.ctx.storage.sql.exec(
        `INSERT INTO snapshot_objects (snapshot_id, path, object_key)
         VALUES (?, ?, ?)`,
        snapshotId,
        entry.path,
        entry.objectKey
      );
    }
    this.appendAdminEvent("snapshot.created", snapshotId, filesystemRevision);
    console.log({
      message: "computer snapshot completed",
      reason,
      filesystemRevision,
      fileCount: fileEntries.length,
      totalBytes,
      r2PutCount: uploadedFileCount + 1,
      r2PutBytes: uploadedBytes,
      durationMs: Date.now() - startedAt
    });
    return {
      snapshotId,
      filesystemRevision,
      fileCount: fileEntries.length,
      totalBytes,
      uploadedFileCount,
      uploadedBytes,
      createdAt
    };
  }

  private async latestSnapshotManifest(): Promise<SnapshotManifest | null> {
    const row = this.ctx.storage.sql
      .exec<{ manifest_key: string }>(
        "SELECT manifest_key FROM snapshots ORDER BY created_at DESC LIMIT 1"
      )
      .toArray()[0];
    if (!row) return null;
    const object = await this.env.PRIVATE_DATA.get(row.manifest_key);
    if (object === null) return null;
    const manifest = (await object.json()) as SnapshotManifest;
    return manifest.version === 1 ? manifest : null;
  }

  private async runRetention(roomId: string): Promise<{
    deletedSnapshots: number;
    deletedEvents: number;
    tombstones: number;
  }> {
    const now = Date.now();
    const eventCutoff = now - COMPUTER_EVENT_RETENTION_MS;
    const oldAgents = this.ctx.storage.sql
      .exec<{
        agent_id: string;
        display_name: string;
        command_count: number;
        first_at: number;
        last_at: number;
      }>(
        `SELECT agent_id, MAX(display_name) AS display_name, COUNT(*) AS command_count,
                MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM computer_events
         WHERE created_at < ? AND agent_id != 'system'
         GROUP BY agent_id`,
        eventCutoff
      )
      .toArray();
    for (const agent of oldAgents) {
      this.ctx.storage.sql.exec(
        `INSERT INTO computer_agent_summaries
          (agent_id, display_name, command_count, first_recorded_at, last_recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           display_name = excluded.display_name,
           command_count = computer_agent_summaries.command_count + excluded.command_count,
           first_recorded_at = MIN(computer_agent_summaries.first_recorded_at, excluded.first_recorded_at),
           last_recorded_at = MAX(computer_agent_summaries.last_recorded_at, excluded.last_recorded_at)`,
        agent.agent_id,
        agent.display_name,
        agent.command_count,
        agent.first_at,
        agent.last_at
      );
    }
    const deletedEvents = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM computer_events WHERE created_at < ?",
          eventCutoff
        )
        .one().count
    );
    this.ctx.storage.sql.exec("DELETE FROM computer_events WHERE created_at < ?", eventCutoff);
    this.ctx.storage.sql.exec("DELETE FROM exec_rate_limits WHERE last_exec_at < ?", now - 60_000);

    const snapshotRows = this.ctx.storage.sql
      .exec<{
        snapshot_id: string;
        manifest_key: string;
        reason: string;
        created_at: number;
      }>(
        `SELECT snapshot_id, manifest_key, reason, created_at
         FROM snapshots
         WHERE (reason LIKE 'automatic-%' AND created_at < ?)
            OR (reason NOT LIKE 'automatic-%' AND created_at < ?)
         ORDER BY created_at ASC`,
        now - AUTOMATIC_SNAPSHOT_RETENTION_MS,
        now - MANUAL_SNAPSHOT_RETENTION_MS
      )
      .toArray();
    let deletedSnapshots = 0;
    for (const snapshot of snapshotRows) {
      const objectRows = this.ctx.storage.sql
        .exec<{ object_key: string }>(
          "SELECT object_key FROM snapshot_objects WHERE snapshot_id = ?",
          snapshot.snapshot_id
        )
        .toArray();
      this.ctx.storage.sql.exec(
        "DELETE FROM snapshot_objects WHERE snapshot_id = ?",
        snapshot.snapshot_id
      );
      for (const object of objectRows) {
        const references = Number(
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM snapshot_objects WHERE object_key = ?",
              object.object_key
            )
            .one().count
        );
        if (references === 0) await this.env.PRIVATE_DATA.delete(object.object_key);
      }
      await this.env.PRIVATE_DATA.delete(snapshot.manifest_key);
      this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_id = ?", snapshot.snapshot_id);
      deletedSnapshots += 1;
    }

    const tombstones = this.tableExists("vfs_changes")
      ? Number(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_changes").one().count)
      : 0;
    if (tombstones >= TOMBSTONE_ALERT_THRESHOLD) {
      console.warn({
        message: "workspace tombstone count needs maintenance",
        roomId,
        tombstones,
        threshold: TOMBSTONE_ALERT_THRESHOLD
      });
    }
    console.log({
      message: "computer retention completed",
      roomId,
      deletedSnapshots,
      deletedEvents,
      tombstones
    });
    return { deletedSnapshots, deletedEvents, tombstones };
  }

  private tableExists(name: string): boolean {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
        name
      )
      .one().count > 0;
  }

  private appendEvent(input: {
    agent: AgentIdentity;
    eventType: string;
    command: string | null;
    exitCode: number | null;
    stdoutPreview: string | null;
    stderrPreview: string | null;
    filesystemRevision: number;
  }): ComputerEvent {
    const row = this.ctx.storage.sql
      .exec<ComputerEventRow>(
        `INSERT INTO computer_events
          (agent_id, display_name, event_type, command, exit_code, stdout_preview,
           stderr_preview, filesystem_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING sequence, agent_id, display_name, event_type, command, exit_code,
                   stdout_preview, stderr_preview, filesystem_revision, created_at`,
        input.agent.agentId,
        input.agent.displayName,
        input.eventType,
        input.command,
        input.exitCode,
        input.stdoutPreview,
        input.stderrPreview,
        input.filesystemRevision,
        Date.now()
      )
      .one();
    return mapEvent(row);
  }

  private appendAdminEvent(
    eventType: string,
    detail: string | null,
    filesystemRevision: number
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO computer_admin_events
        (event_type, detail, filesystem_revision, created_at)
       VALUES (?, ?, ?, ?)`,
      eventType,
      detail,
      filesystemRevision,
      Date.now()
    );
  }

  private readEvents(after: number, limit: number): ComputerEvent[] {
    return this.ctx.storage.sql
      .exec<ComputerEventRow>(
        `SELECT sequence, agent_id, display_name, event_type, command, exit_code,
                stdout_preview, stderr_preview, filesystem_revision, created_at
         FROM computer_events
         WHERE sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
        after,
        limit
      )
      .toArray()
      .map(mapEvent);
  }

  private broadcast(type: string, payload: unknown): void {
    const envelope: SocketEnvelope = {
      source: "computer",
      type,
      payload,
      createdAt: Date.now()
    };
    const message = JSON.stringify(envelope);
    for (const socket of this.ctx.getWebSockets("computer")) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "broadcast failed");
      }
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail;
    let release: (() => void) | undefined;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export { WorkspaceProxy };

function mapEvent(row: ComputerEventRow): ComputerEvent {
  return {
    sequence: row.sequence,
    agentId: row.agent_id,
    displayName: row.display_name,
    eventType: row.event_type,
    command: row.command,
    exitCode: row.exit_code,
    stdoutPreview: row.stdout_preview,
    stderrPreview: row.stderr_preview,
    filesystemRevision: row.filesystem_revision,
    createdAt: row.created_at
  };
}

function snapshotManifestKey(roomId: string, snapshotId: string): string {
  return `computer/snapshots/${roomId}/${snapshotId}/manifest.json`;
}

function snapshotFileKey(roomId: string, snapshotId: string, path: string): string {
  return `computer/snapshots/${roomId}/${snapshotId}/files/${encodeURIComponent(path)}`;
}

function depth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function minimumTimestamp(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length === 0 ? null : Math.min(...present);
}

function maximumTimestamp(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length === 0 ? null : Math.max(...present);
}

function readBooleanProperty(error: unknown, key: "overloaded" | "retryable"): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    key in error &&
    (error as Record<string, unknown>)[key] === true
  );
}

async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function putKnownLength(
  bucket: R2Bucket,
  key: string,
  source: ReadableStream<Uint8Array>,
  length: number
): Promise<void> {
  if (length === 0) {
    await bucket.put(key, new Uint8Array());
    return;
  }
  const fixed = new FixedLengthStream(length);
  await Promise.all([source.pipeTo(fixed.writable), bucket.put(key, fixed.readable)]);
}
