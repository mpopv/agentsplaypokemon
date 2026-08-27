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
  ComputerEvent,
  ComputerEventHistoryPage,
  ComputerExecResult,
  ComputerFileHistoryEntry,
  ComputerFileView,
  ComputerOverview,
  ComputerSnapshot,
  ComputerTreeEntry,
  SocketEnvelope
} from "../shared/types";
import { bytesToBase64, readStream, safeTextPreview } from "./lib/encoding";
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

interface FileIndexRow {
  [key: string]: SqlStorageValue;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: number;
}

interface FileHistoryRow {
  [key: string]: SqlStorageValue;
  sequence: number;
  path: string;
  operation: "created" | "updated" | "deleted";
  size: number;
  mtime: number;
  filesystem_revision: number;
  preview: string | null;
  created_at: number;
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
const MAX_HISTORY_FILE_BYTES = 256 * 1024;
const MAX_TRACKED_ENTRIES = 2_000;
const MAX_SNAPSHOT_ENTRIES = 5_000;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const EXEC_RATE_LIMIT_MS = 1_000;
const COMPUTER_EVENT_HISTORY_PAGE_SIZE = 20;

class SharedComputerContainerBase extends withWorkspaceContainer(
  class extends DurableObject<Env> {}
) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "SHARED_COMPUTERS", id: this.ctx.id.toString() },
    egress: { mode: "none" },
    containerEnv: {
      COMPUTER_VAR_COMPUTER_OUTPUT_LIMIT_BYTES: this.env.COMPUTER_OUTPUT_LIMIT_BYTES,
      COMPUTER_VAR_COMPUTER_EXEC_TIMEOUT_SECONDS: String(
        Math.max(1, Math.floor(Number(this.env.COMPUTER_EXEC_TIMEOUT_MS) / 1000) - 1)
      )
    }
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
    return this.serialized(async () => {
      this.identify(roomId);
      await this.ensureInitialized(roomId);
      this.enforceExecRateLimit(agent.agentId);
      const startedAt = Date.now();
      try {
        using workspace = await getWorkspace(this);
        using run = await workspace.runtime.exec(
          `/usr/local/bin/agent-exec ${shellQuote(command)}`,
          {
            cwd,
            encoding: "utf8",
            timeoutMs: Number(this.env.COMPUTER_EXEC_TIMEOUT_MS) + 2_000
          }
        );
        const result = await run.result();
        const filesystemRevision = this.advanceRevision();
        try {
          await this.captureFileHistory(workspace, roomId, filesystemRevision);
        } catch (error) {
          this.appendEvent({
            agent: { agentId: "system", displayName: "System" },
            eventType: "history.error",
            command: null,
            exitCode: null,
            stdoutPreview: null,
            stderrPreview: error instanceof Error ? error.message : String(error),
            filesystemRevision
          });
        }
        const event = this.appendEvent({
          agent,
          eventType: "exec",
          command,
          exitCode: result.exitCode,
          stdoutPreview: result.stdout.slice(0, 2_048),
          stderrPreview: result.stderr.slice(0, 2_048),
          filesystemRevision
        });
        this.broadcast("exec.completed", event);
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - startedAt,
          filesystemRevision
        };
      } catch (error) {
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
        throw error;
      }
    });
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

  history(roomId: string, pathValue: unknown): ComputerFileHistoryEntry[] {
    this.identify(roomId);
    const path = parseWorkspacePath(pathValue);
    return this.ctx.storage.sql
      .exec<FileHistoryRow>(
        `SELECT sequence, path, operation, size, mtime, filesystem_revision, preview, created_at
         FROM file_history
         WHERE path = ?
         ORDER BY sequence DESC
         LIMIT 100`,
        path
      )
      .toArray()
      .map(mapFileHistory);
  }

  async snapshot(roomId: string, reason: string): Promise<ComputerSnapshot> {
    return this.serialized(async () => {
      this.identify(roomId);
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
      const entries: SnapshotManifestEntry[] = [];
      let totalBytes = 0;

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
          entry.objectKey = snapshotFileKey(roomId, snapshotId, foundEntry.path);
          const stream = await workspace.fs.readFile(foundEntry.path);
          await putKnownLength(this.env.PRIVATE_DATA, entry.objectKey, stream, stat.size);
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
      this.ctx.storage.sql.exec(
        `INSERT INTO snapshots
          (snapshot_id, manifest_key, reason, filesystem_revision, file_count, total_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        snapshotId,
        manifestKey,
        reason.slice(0, 200),
        filesystemRevision,
        entries.filter((entry) => entry.type === "file").length,
        totalBytes,
        createdAt
      );
      this.appendAdminEvent("snapshot.created", snapshotId, filesystemRevision);
      return {
        snapshotId,
        filesystemRevision,
        fileCount: entries.filter((entry) => entry.type === "file").length,
        totalBytes,
        createdAt
      };
    });
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
      await this.captureFileHistory(workspace, roomId, filesystemRevision);
      this.appendAdminEvent("snapshot.restored", snapshotId, filesystemRevision);
      return {
        snapshotId,
        filesystemRevision,
        fileCount: snapshot.file_count,
        totalBytes: snapshot.total_bytes,
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
      await this.captureFileHistory(workspace, roomId, filesystemRevision);
      this.appendAdminEvent("workspace.reset", null, filesystemRevision);
      return { filesystemRevision };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ws") return this.backend.handleFetch(request);
    if (path !== "/internal/computer-socket") return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const agentId = request.headers.get("x-agent-id");
    if (!agentId) return new Response("unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["computer", `agent:${agentId}`]);
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

      CREATE TABLE IF NOT EXISTS exec_rate_limits (
        agent_id TEXT PRIMARY KEY,
        last_exec_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_index (
        path TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('created', 'updated', 'deleted')),
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        filesystem_revision INTEGER NOT NULL,
        preview TEXT,
        object_key TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_history_path ON file_history(path, sequence DESC);

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        manifest_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        filesystem_revision INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
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

  private async ensureInitialized(roomId: string): Promise<void> {
    const meta = this.readMeta();
    if (meta.initialized === 1) return;
    using workspace = await getWorkspace(this);
    await this.seedWorkspace(workspace);
    this.ctx.storage.sql.exec(
      "UPDATE computer_meta SET initialized = 1, updated_at = ? WHERE id = 1",
      Date.now()
    );
    await this.captureFileHistory(workspace, roomId, meta.filesystem_revision);
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
      throw new InputError("wait one second before you run another command", 429);
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

  private async captureFileHistory(
    workspace: WorkspaceClient,
    roomId: string,
    filesystemRevision: number
  ): Promise<void> {
    const found = await workspace.fs.find("/workspace", undefined, {
      limit: MAX_TRACKED_ENTRIES + 1
    });
    const truncated = found.length > MAX_TRACKED_ENTRIES;
    const visible = truncated ? found.slice(0, MAX_TRACKED_ENTRIES) : found;
    const previous = new Map(
      this.ctx.storage.sql
        .exec<FileIndexRow>("SELECT path, type, size, mtime FROM file_index")
        .toArray()
        .map((row) => [row.path, row])
    );
    const current = new Set<string>();

    for (const entry of visible) {
      const stat = await workspace.fs.lstat(entry.path);
      const type = stat.isSymbolicLink
        ? ("symlink" as const)
        : stat.isDirectory
          ? ("directory" as const)
          : ("file" as const);
      current.add(entry.path);
      const old = previous.get(entry.path);
      const changed = !old || old.type !== type || old.size !== stat.size || old.mtime !== stat.mtime;
      if (changed) {
        const operation = old ? ("updated" as const) : ("created" as const);
        let preview: string | null = type === "directory" ? "[directory]" : null;
        let objectKey: string | null = null;
        if (type === "symlink") {
          preview = `[symlink -> ${await workspace.fs.readlink(entry.path)}]`;
        } else if (type === "file") {
          const length = Math.min(stat.size, MAX_HISTORY_FILE_BYTES);
          const stream = await workspace.fs.readFile(entry.path, { byteLength: length });
          const bytes = await readStream(stream);
          preview = safeTextPreview(bytes);
          if (stat.size <= MAX_HISTORY_FILE_BYTES) {
            objectKey = historyObjectKey(roomId, filesystemRevision, entry.path);
            await this.env.PRIVATE_DATA.put(objectKey, bytes);
          }
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO file_history
            (path, operation, size, mtime, filesystem_revision, preview, object_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          entry.path,
          operation,
          stat.size,
          stat.mtime,
          filesystemRevision,
          preview,
          objectKey,
          Date.now()
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO file_index (path, type, size, mtime)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET type = excluded.type, size = excluded.size, mtime = excluded.mtime`,
        entry.path,
        type,
        stat.size,
        stat.mtime
      );
    }

    if (!truncated) {
      for (const [path, old] of previous) {
        if (current.has(path)) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO file_history
            (path, operation, size, mtime, filesystem_revision, preview, object_key, created_at)
           VALUES (?, 'deleted', ?, ?, ?, NULL, NULL, ?)`,
          path,
          old.size,
          old.mtime,
          filesystemRevision,
          Date.now()
        );
        this.ctx.storage.sql.exec("DELETE FROM file_index WHERE path = ?", path);
      }
    }
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

function mapFileHistory(row: FileHistoryRow): ComputerFileHistoryEntry {
  return {
    sequence: row.sequence,
    path: row.path,
    operation: row.operation,
    size: row.size,
    mtime: row.mtime,
    filesystemRevision: row.filesystem_revision,
    preview: row.preview,
    createdAt: row.created_at
  };
}

function historyObjectKey(roomId: string, revision: number, path: string): string {
  return `computer/history/${roomId}/${revision}/${encodeURIComponent(path)}`;
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
