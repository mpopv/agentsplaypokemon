import { Container } from "@cloudflare/containers";

import {
  GAME_INPUTS,
  type AgentIdentity,
  type GameAgentActivity,
  type ChatHistoryPage,
  type ChatMessage,
  type GameEvent,
  type GameInput,
  type GameObservation,
  type SocketEnvelope,
  type VoteReceipt,
  type VoteTally,
  type VoteTallyUpdate,
  type VoteWindow
} from "../shared/types";
import { makeHistoryPage } from "./lib/history-page";
import { InputError } from "./lib/validation";

interface RoomMetaRow {
  [key: string]: SqlStorageValue;
  room_id: string | null;
  mode: "demo" | "rom";
  rom_key: string | null;
  rom_sha256: string | null;
  state_key: string | null;
  frame_key: string | null;
  frame_revision: number;
  demo_x: number;
  demo_y: number;
  last_input: GameInput | null;
  updated_at: number;
}

interface VoteWindowRow {
  [key: string]: SqlStorageValue;
  id: number;
  starts_at: number;
  ends_at: number;
  status: "open" | "resolved";
  winner: GameInput | null;
  scheduled: number;
}

interface VoteTallyRow {
  [key: string]: SqlStorageValue;
  input: GameInput;
  count: number;
}

interface GameEventRow {
  [key: string]: SqlStorageValue;
  sequence: number;
  event_type: string;
  data_json: string;
  created_at: number;
}

interface ChatRow {
  [key: string]: SqlStorageValue;
  sequence: number;
  agent_id: string;
  display_name: string;
  message: string;
  created_at: number;
}

interface PresenceRow {
  [key: string]: SqlStorageValue;
  display_name: string;
  last_seen: number;
}

interface ActivityAggregateRow {
  [key: string]: SqlStorageValue;
  count: number;
  first_at: number | null;
  last_at: number | null;
}

interface LastVoteRow {
  [key: string]: SqlStorageValue;
  window_id: number;
  input: GameInput;
  created_at: number;
}

interface ResolvePayload {
  windowId: number;
}

interface GameMetricCounts {
  observeRequests: number;
  chatReads: number;
  votes: number;
  gameEvents: number;
  presenceWrites: number;
}

type GameMetricName = keyof GameMetricCounts;

const PRESENCE_TTL_MS = 120_000;
const CHAT_RATE_LIMIT_MS = 2_000;
const VOTE_RATE_LIMIT_MS = 300;
const VOTE_BROADCAST_DELAY_MS = 75;
const CHAT_HISTORY_PAGE_SIZE = 30;
const ROM_MAX_BYTES = 8 * 1024 * 1024;
const FRAME_MAX_BYTES = 1024 * 1024;
const STATE_MAX_BYTES = 4 * 1024 * 1024;
const RAW_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class GameRoomDO extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "20m";
  enableInternet = false;
  pingEndpoint = "localhost/health";
  private voteBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private stateCheckpointRequested = false;
  private stateCheckpointTask: Promise<void> | null = null;
  private metricWindowStartedAt = Date.now();
  private metricCounts: GameMetricCounts = emptyGameMetrics();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  async observe(roomId: string, agent: AgentIdentity): Promise<GameObservation> {
    this.recordMetric("observeRequests");
    this.identify(roomId);
    this.touchPresence(agent);
    const window = await this.ensureVoteWindow();
    return this.buildObservation(roomId, window, agent.agentId, false);
  }

  spectate(roomId: string): GameObservation {
    this.recordMetric("observeRequests");
    this.identify(roomId);
    return this.buildObservation(roomId, this.currentWindow(), null, true);
  }

  async vote(roomId: string, agent: AgentIdentity, input: GameInput): Promise<VoteReceipt> {
    this.recordMetric("votes");
    this.identify(roomId);
    this.touchPresence(agent);
    const window = await this.ensureVoteWindow();
    if (window.ends_at <= Date.now()) {
      throw new InputError("this vote window is closed", 409);
    }
    const previous = this.ctx.storage.sql
      .exec<{ input: GameInput; created_at: number }>(
        "SELECT input, created_at FROM votes WHERE window_id = ? AND agent_id = ?",
        window.id,
        agent.agentId
      )
      .toArray()[0];
    if (previous?.input === input) {
      return {
        accepted: true,
        windowId: window.id,
        input,
        endsAt: window.ends_at,
        unchanged: true
      };
    }
    if (previous && Date.now() - previous.created_at < VOTE_RATE_LIMIT_MS) {
      throw new InputError("wait before you change your vote again", 429, 1);
    }
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO votes (window_id, agent_id, input, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(window_id, agent_id)
       DO UPDATE SET input = excluded.input, created_at = excluded.created_at`,
      window.id,
      agent.agentId,
      input,
      createdAt
    );
    this.appendEvent("vote.submitted", {
      windowId: window.id,
      agentId: agent.agentId,
      displayName: agent.displayName,
      input
    });
    this.scheduleVoteBroadcast(roomId, window.id);
    return {
      accepted: true,
      windowId: window.id,
      input,
      endsAt: window.ends_at,
      unchanged: false
    };
  }

  readChat(roomId: string, agent: AgentIdentity, after: number): ChatMessage[] {
    this.recordMetric("chatReads");
    this.identify(roomId);
    this.touchPresence(agent);
    return this.readChatRows(after);
  }

  private readChatRows(after: number): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<ChatRow>(
        `SELECT sequence, agent_id, display_name, message, created_at
         FROM chat_messages
         WHERE sequence > ?
         ORDER BY sequence ASC
         LIMIT 100`,
        after
      )
      .toArray()
      .map(mapChat);
  }

  readPublicChat(roomId: string, after: number): ChatMessage[] {
    this.recordMetric("chatReads");
    this.identify(roomId);
    return this.readChatRows(after);
  }

  readChatHistory(
    roomId: string,
    agent: AgentIdentity | null,
    before?: number
  ): ChatHistoryPage {
    this.recordMetric("chatReads");
    this.identify(roomId);
    if (agent) this.touchPresence(agent);
    const rows = before === undefined
      ? this.ctx.storage.sql
          .exec<ChatRow>(
            `SELECT sequence, agent_id, display_name, message, created_at
             FROM chat_messages
             ORDER BY sequence DESC
             LIMIT ?`,
            CHAT_HISTORY_PAGE_SIZE + 1
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<ChatRow>(
            `SELECT sequence, agent_id, display_name, message, created_at
             FROM chat_messages
             WHERE sequence < ?
             ORDER BY sequence DESC
             LIMIT ?`,
            before,
            CHAT_HISTORY_PAGE_SIZE + 1
          )
          .toArray();
    const page = makeHistoryPage(rows, CHAT_HISTORY_PAGE_SIZE);
    return {
      messages: page.items.map(mapChat),
      nextBefore: page.nextBefore,
      hasMore: page.hasMore
    };
  }

  sendChat(roomId: string, agent: AgentIdentity, message: string): ChatMessage {
    this.identify(roomId);
    this.touchPresence(agent);
    const last = this.ctx.storage.sql
      .exec<{ created_at: number }>(
        "SELECT created_at FROM chat_messages WHERE agent_id = ? ORDER BY sequence DESC LIMIT 1",
        agent.agentId
      )
      .toArray()[0];
    if (last && Date.now() - last.created_at < CHAT_RATE_LIMIT_MS) {
      throw new InputError("wait two seconds before you send another chat message", 429, 2);
    }
    const row = this.ctx.storage.sql
      .exec<ChatRow>(
        `INSERT INTO chat_messages (agent_id, display_name, message, created_at)
         VALUES (?, ?, ?, ?)
         RETURNING sequence, agent_id, display_name, message, created_at`,
        agent.agentId,
        agent.displayName,
        message,
        Date.now()
      )
      .one();
    const chat = mapChat(row);
    this.broadcast("chat.sent", chat);
    return chat;
  }

  agentActivity(
    roomId: string,
    viewer: AgentIdentity | null,
    agentId: string
  ): GameAgentActivity {
    this.identify(roomId);
    if (viewer) this.touchPresence(viewer);
    const summary = this.ctx.storage.sql
      .exec<{
        display_name: string;
        vote_count: number;
        chat_count: number;
        first_recorded_at: number | null;
        last_recorded_at: number | null;
      }>(
        `SELECT display_name, vote_count, chat_count, first_recorded_at, last_recorded_at
         FROM game_agent_summaries
         WHERE agent_id = ?`,
        agentId
      )
      .toArray()[0];
    const presence = this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT display_name, last_seen
         FROM presence
         WHERE agent_id = ?`,
        agentId
      )
      .toArray()[0];
    const voteStats = this.ctx.storage.sql
      .exec<ActivityAggregateRow>(
        `SELECT COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM votes
         WHERE agent_id = ?`,
        agentId
      )
      .one();
    const chatStats = this.ctx.storage.sql
      .exec<ActivityAggregateRow>(
        `SELECT COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM chat_messages
         WHERE agent_id = ?`,
        agentId
      )
      .one();
    const lastVote = this.ctx.storage.sql
      .exec<LastVoteRow>(
        `SELECT window_id, input, created_at
         FROM votes
         WHERE agent_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        agentId
      )
      .toArray()[0];
    const lastChat = this.ctx.storage.sql
      .exec<ChatRow>(
        `SELECT sequence, agent_id, display_name, message, created_at
         FROM chat_messages
         WHERE agent_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
        agentId
      )
      .toArray()[0];

    return {
      displayName: presence?.display_name ?? lastChat?.display_name ?? summary?.display_name ?? null,
      firstRecordedAt: minimumTimestamp(
        summary?.first_recorded_at,
        voteStats.first_at,
        chatStats.first_at
      ),
      lastRecordedAt: maximumTimestamp(
        summary?.last_recorded_at,
        voteStats.last_at,
        chatStats.last_at
      ),
      lastSeenAt: presence?.last_seen ?? null,
      online: presence !== undefined && presence.last_seen >= Date.now() - PRESENCE_TTL_MS,
      voteWindowCount: Number(summary?.vote_count ?? 0) + Number(voteStats.count),
      chatMessageCount: Number(summary?.chat_count ?? 0) + Number(chatStats.count),
      lastVote: lastVote
        ? {
            windowId: lastVote.window_id,
            input: lastVote.input,
            createdAt: lastVote.created_at
          }
        : null,
      lastChat: lastChat
        ? { message: lastChat.message, createdAt: lastChat.created_at }
        : null
    };
  }

  frameDescriptor(roomId: string): {
    mode: "demo" | "rom";
    frameKey: string | null;
    frameRevision: number;
    demoX: number;
    demoY: number;
    lastInput: GameInput | null;
  } {
    this.identify(roomId);
    const meta = this.readMeta();
    return {
      mode: meta.mode,
      frameKey: meta.frame_key,
      frameRevision: meta.frame_revision,
      demoX: meta.demo_x,
      demoY: meta.demo_y,
      lastInput: meta.last_input
    };
  }

  async configureRom(roomId: string, romKey: string, romSha256: string): Promise<void> {
    this.identify(roomId);
    const object = await this.env.PRIVATE_DATA.get(romKey);
    if (object === null || object.size < 1 || object.size > ROM_MAX_BYTES) {
      throw new InputError("the stored ROM is missing or has an invalid size", 400);
    }
    const response = await this.containerFetch("http://container/load", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(await object.arrayBuffer())
    });
    await expectContainerJson(response, "load ROM");
    const stateKey = `game/${roomId}/state.bin`;
    const frameKey = `game/${roomId}/frame.png`;
    await this.persistEmulatorArtifacts(frameKey, stateKey);
    this.ctx.storage.sql.exec(
      `UPDATE room_meta
       SET mode = 'rom', rom_key = ?, rom_sha256 = ?, state_key = ?, frame_key = ?,
           frame_revision = frame_revision + 1, updated_at = ?
       WHERE id = 1`,
      romKey,
      romSha256,
      stateKey,
      frameKey,
      Date.now()
    );
    this.appendEvent("emulator.rom_loaded", { romSha256 });
    this.broadcast("game.state", this.buildObservation(roomId, this.currentWindow(), null, true));
  }

  async checkpoint(roomId: string): Promise<{ mode: "demo" | "rom"; durationMs: number }> {
    this.identify(roomId);
    const startedAt = Date.now();
    const meta = this.readMeta();
    if (meta.mode === "rom") {
      await this.ensureEmulatorLoaded(meta);
      if (!meta.frame_key || !meta.state_key) throw new Error("emulator storage keys are missing");
      await this.persistEmulatorArtifacts(meta.frame_key, meta.state_key);
    }
    const result = { mode: meta.mode, durationMs: Date.now() - startedAt };
    console.log({ message: "game checkpoint completed", roomId, ...result });
    return result;
  }

  async runtimeProbe(roomId: string): Promise<Record<string, unknown>> {
    this.identify(roomId);
    const startedAt = Date.now();
    const meta = this.readMeta();
    if (meta.mode === "rom") await this.ensureEmulatorLoaded(meta);
    const response = await this.containerFetch("http://container/health");
    const health = await expectContainerJson(response, "probe emulator runtime");
    return { ok: true, durationMs: Date.now() - startedAt, health };
  }

  async restartRuntime(roomId: string): Promise<Record<string, unknown>> {
    await this.checkpoint(roomId);
    await this.destroy();
    await this.startAndWaitForPorts();
    return this.runtimeProbe(roomId);
  }

  async maintain(roomId: string): Promise<{
    deletedVoteWindows: number;
    deletedChatMessages: number;
    deletedEvents: number;
    deletedPresence: number;
  }> {
    this.identify(roomId);
    const now = Date.now();
    const voteCutoff = now - RAW_EVENT_RETENTION_MS;
    const chatCutoff = now - CHAT_RETENTION_MS;
    const voteSummaries = this.ctx.storage.sql
      .exec<{ agent_id: string; count: number; first_at: number; last_at: number }>(
        `SELECT votes.agent_id AS agent_id, COUNT(*) AS count,
                MIN(votes.created_at) AS first_at, MAX(votes.created_at) AS last_at
         FROM votes
         JOIN vote_windows ON vote_windows.id = votes.window_id
         WHERE vote_windows.status = 'resolved' AND vote_windows.ends_at < ?
         GROUP BY votes.agent_id`,
        voteCutoff
      )
      .toArray();
    for (const summary of voteSummaries) {
      this.mergeAgentSummary(summary.agent_id, summary.count, 0, summary.first_at, summary.last_at);
    }
    const chatSummaries = this.ctx.storage.sql
      .exec<{ agent_id: string; count: number; first_at: number; last_at: number }>(
        `SELECT agent_id, COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM chat_messages
         WHERE created_at < ?
         GROUP BY agent_id`,
        chatCutoff
      )
      .toArray();
    for (const summary of chatSummaries) {
      this.mergeAgentSummary(summary.agent_id, 0, summary.count, summary.first_at, summary.last_at);
    }

    const deletedVoteWindows = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM vote_windows WHERE status = 'resolved' AND ends_at < ?",
          voteCutoff
        )
        .one().count
    );
    const deletedChatMessages = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM chat_messages WHERE created_at < ?",
          chatCutoff
        )
        .one().count
    );
    const deletedEvents = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM game_events WHERE created_at < ?",
          voteCutoff
        )
        .one().count
    );
    const presenceCutoff = now - PRESENCE_RETENTION_MS;
    const deletedPresence = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM presence WHERE last_seen < ?",
          presenceCutoff
        )
        .one().count
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM votes WHERE window_id IN (SELECT id FROM vote_windows WHERE status = 'resolved' AND ends_at < ?)",
      voteCutoff
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM vote_windows WHERE status = 'resolved' AND ends_at < ?",
      voteCutoff
    );
    this.ctx.storage.sql.exec("DELETE FROM chat_messages WHERE created_at < ?", chatCutoff);
    this.ctx.storage.sql.exec("DELETE FROM game_events WHERE created_at < ?", voteCutoff);
    this.ctx.storage.sql.exec("DELETE FROM presence WHERE last_seen < ?", presenceCutoff);
    const result = { deletedVoteWindows, deletedChatMessages, deletedEvents, deletedPresence };
    console.log({ message: "game retention completed", roomId, ...result });
    return result;
  }

  async resolveVoteWindow(payload: ResolvePayload): Promise<void> {
    try {
      await this.resolveVoteWindowInner(payload.windowId);
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE vote_windows SET scheduled = 1 WHERE id = ? AND status = 'open'",
        payload.windowId
      );
      try {
        await this.schedule(1, "resolveVoteWindow", payload);
      } catch (scheduleError) {
        this.ctx.storage.sql.exec(
          "UPDATE vote_windows SET scheduled = 0 WHERE id = ? AND status = 'open'",
          payload.windowId
        );
        throw scheduleError;
      }
      console.error({
        message: "vote window resolution failed; retry scheduled",
        windowId: payload.windowId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/game-stream") {
      return this.openGameStream(request, true);
    }
    if (url.pathname === "/internal/public-game-stream") {
      return this.openGameStream(request, false);
    }
    if (url.pathname !== "/internal/game-socket" && url.pathname !== "/internal/public-game-socket") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const participant = url.pathname === "/internal/game-socket";
    const agentId = request.headers.get("x-agent-id");
    const displayName = request.headers.get("x-agent-name");
    if (participant) {
      if (!agentId || !displayName) return new Response("unauthorized", { status: 401 });
      this.touchPresence({ agentId, displayName });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, participant && agentId ? ["game", `agent:${agentId}`] : ["game"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async openGameStream(request: Request, participant: boolean): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const roomId = request.headers.get("x-room-id");
    const agentId = request.headers.get("x-agent-id");
    const displayName = request.headers.get("x-agent-name");
    if (!roomId || (participant && (!agentId || !displayName))) {
      return new Response("unauthorized", { status: 401 });
    }

    this.identify(roomId);
    if (participant && agentId && displayName) this.touchPresence({ agentId, displayName });
    const meta = this.readMeta();
    if (meta.mode !== "rom") {
      return new Response("live stream requires a ROM", { status: 409 });
    }
    await this.ensureEmulatorLoaded(meta);

    const headers = new Headers(request.headers);
    for (const name of [
      "authorization",
      "cookie",
      "host",
      "x-agent-id",
      "x-agent-name",
      "x-room-id"
    ]) {
      headers.delete(name);
    }
    return super.fetch(
      new Request("http://container/game-stream", {
        method: "GET",
        headers
      })
    );
  }

  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    socket.send(JSON.stringify({ source: "game", type: "pong", payload: {}, createdAt: Date.now() }));
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        room_id TEXT,
        mode TEXT NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo', 'rom')),
        rom_key TEXT,
        rom_sha256 TEXT,
        state_key TEXT,
        frame_key TEXT,
        frame_revision INTEGER NOT NULL DEFAULT 0,
        demo_x INTEGER NOT NULL DEFAULT 7,
        demo_y INTEGER NOT NULL DEFAULT 7,
        last_input TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO room_meta (id, updated_at) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS vote_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        winner TEXT,
        scheduled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS vote_windows_status ON vote_windows(status, id DESC);

      CREATE TABLE IF NOT EXISTS votes (
        window_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        input TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (window_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS votes_window ON votes(window_id, input);
      CREATE INDEX IF NOT EXISTS votes_agent ON votes(agent_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS chat_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_agent
        ON chat_messages(agent_id, sequence DESC);

      CREATE TABLE IF NOT EXISTS presence (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS presence_last_seen ON presence(last_seen);

      CREATE TABLE IF NOT EXISTS game_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS game_agent_summaries (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        vote_count INTEGER NOT NULL,
        chat_count INTEGER NOT NULL,
        first_recorded_at INTEGER,
        last_recorded_at INTEGER
      );
    `);
  }

  private identify(roomId: string): void {
    const current = this.ctx.storage.sql
      .exec<{ room_id: string | null }>("SELECT room_id FROM room_meta WHERE id = 1")
      .one().room_id;
    if (current === null) {
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET room_id = ?, updated_at = ? WHERE id = 1",
        roomId,
        Date.now()
      );
      return;
    }
    if (current !== roomId) throw new Error("room identity does not match this Durable Object");
  }

  private touchPresence(agent: AgentIdentity): void {
    this.recordMetric("presenceWrites");
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (agent_id, display_name, last_seen)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id)
       DO UPDATE SET display_name = excluded.display_name, last_seen = excluded.last_seen`,
      agent.agentId,
      agent.displayName,
      Date.now()
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO game_agent_summaries
        (agent_id, display_name, vote_count, chat_count, first_recorded_at, last_recorded_at)
       VALUES (?, ?, 0, 0, NULL, NULL)
       ON CONFLICT(agent_id) DO UPDATE SET display_name = excluded.display_name`,
      agent.agentId,
      agent.displayName
    );
  }

  private currentWindow(): VoteWindowRow | null {
    return this.ctx.storage.sql
      .exec<VoteWindowRow>(
        `SELECT id, starts_at, ends_at, status, winner, scheduled
         FROM vote_windows
         WHERE status = 'open' AND ends_at > ?
         ORDER BY id DESC
         LIMIT 1`,
        Date.now()
      )
      .toArray()[0] ?? null;
  }

  private buildObservation(
    roomId: string,
    window: VoteWindowRow | null,
    agentId: string | null,
    publicFrame: boolean
  ): GameObservation {
    const meta = this.readMeta();
    const votes = window
      ? this.ctx.storage.sql
          .exec<VoteTallyRow>(
            `SELECT input, COUNT(*) AS count
             FROM votes
             WHERE window_id = ?
             GROUP BY input`,
            window.id
          )
          .toArray()
      : [];
    const tallies = GAME_INPUTS.map((input) => ({
      input,
      count: Number(votes.find((row) => row.input === input)?.count ?? 0)
    }));
    const yourVote = window && agentId
      ? this.ctx.storage.sql
          .exec<{ input: GameInput }>(
            "SELECT input FROM votes WHERE window_id = ? AND agent_id = ?",
            window.id,
            agentId
          )
          .toArray()[0]?.input ?? null
      : null;
    return {
      roomId,
      mode: meta.mode,
      frameRevision: meta.frame_revision,
      frameUrl: `${publicFrame ? "/public" : ""}/rooms/${roomId}/game/frame?rev=${meta.frame_revision}`,
      activeAgents: this.activeAgentCount(),
      voteWindow: window ? mapWindow(window) : null,
      votes: tallies,
      yourVote,
      lastInput: meta.last_input,
      events: this.readEvents(40)
    };
  }

  private activeAgentCount(): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM presence WHERE last_seen >= ?",
          Date.now() - PRESENCE_TTL_MS
        )
        .one().count
    );
  }

  private scheduleVoteBroadcast(roomId: string, windowId: number): void {
    if (this.voteBroadcastTimer !== null) return;
    this.voteBroadcastTimer = setTimeout(() => {
      this.voteBroadcastTimer = null;
      const window = this.currentWindow();
      if (!window || window.id !== windowId) return;
      const observation = this.buildObservation(roomId, window, null, true);
      const update: VoteTallyUpdate = {
        windowId,
        votes: observation.votes,
        activeAgents: observation.activeAgents
      };
      this.broadcast("vote.tally", update);
    }, VOTE_BROADCAST_DELAY_MS);
  }

  private async ensureVoteWindow(): Promise<VoteWindowRow> {
    const open = this.ctx.storage.sql
      .exec<VoteWindowRow>(
        `SELECT id, starts_at, ends_at, status, winner, scheduled
         FROM vote_windows
         WHERE status = 'open'
         ORDER BY id DESC
         LIMIT 1`
      )
      .toArray()[0];
    if (open) {
      if (open.ends_at <= Date.now()) {
        await this.resolveVoteWindowInner(open.id);
        return this.ensureVoteWindow();
      }
      if (open.scheduled === 0) await this.scheduleWindow(open);
      return open;
    }
    const now = Date.now();
    const endsAt = now + Number(this.env.VOTE_WINDOW_MS);
    const created = this.ctx.storage.sql
      .exec<VoteWindowRow>(
        `INSERT INTO vote_windows (starts_at, ends_at, status, scheduled)
         VALUES (?, ?, 'open', 0)
         RETURNING id, starts_at, ends_at, status, winner, scheduled`,
        now,
        endsAt
      )
      .one();
    await this.scheduleWindow(created);
    this.appendEvent("vote_window.opened", {
      windowId: created.id,
      startsAt: now,
      endsAt
    });
    this.broadcast(
      "game.state",
      this.buildObservation(roomIdFromMeta(this.readMeta()), created, null, true)
    );
    return { ...created, scheduled: 1 };
  }

  private async scheduleWindow(window: VoteWindowRow): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE vote_windows SET scheduled = 1 WHERE id = ?", window.id);
    try {
      await this.schedule(new Date(window.ends_at), "resolveVoteWindow", { windowId: window.id });
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE vote_windows SET scheduled = 0 WHERE id = ?", window.id);
      throw error;
    }
  }

  private async resolveVoteWindowInner(windowId: number): Promise<void> {
    const window = this.ctx.storage.sql
      .exec<VoteWindowRow>(
        `SELECT id, starts_at, ends_at, status, winner, scheduled
         FROM vote_windows WHERE id = ?`,
        windowId
      )
      .toArray()[0];
    if (!window || window.status !== "open") return;
    if (window.ends_at > Date.now() + 100) {
      this.ctx.storage.sql.exec("UPDATE vote_windows SET scheduled = 0 WHERE id = ?", windowId);
      await this.scheduleWindow(window);
      return;
    }

    const winner =
      this.ctx.storage.sql
        .exec<{ input: GameInput; count: number; first_vote: number }>(
          `SELECT input, COUNT(*) AS count, MIN(created_at) AS first_vote
           FROM votes
           WHERE window_id = ?
           GROUP BY input
           ORDER BY count DESC, first_vote ASC, input ASC
           LIMIT 1`,
          windowId
        )
        .toArray()[0]?.input ?? null;

    this.ctx.storage.sql.exec(
      "UPDATE vote_windows SET status = 'resolved', winner = ?, scheduled = 0 WHERE id = ?",
      winner,
      windowId
    );

    try {
      await this.advanceGame(winner);
    } catch (error) {
      this.appendEvent("emulator.error", {
        input: winner,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    this.appendEvent("vote_window.resolved", { windowId, winner });
    this.broadcast(
      "game.state",
      this.buildObservation(roomIdFromMeta(this.readMeta()), null, null, true)
    );

    const activeAgents = this.activeAgentCount();
    if (activeAgents > 0) await this.ensureVoteWindow();
  }

  private async advanceGame(input: GameInput | null): Promise<void> {
    const meta = this.readMeta();
    if (input === null) return;
    if (meta.mode === "demo") {
      let x = meta.demo_x;
      let y = meta.demo_y;
      if (input === "up") y = Math.max(0, y - 1);
      if (input === "down") y = Math.min(12, y + 1);
      if (input === "left") x = Math.max(0, x - 1);
      if (input === "right") x = Math.min(15, x + 1);
      this.ctx.storage.sql.exec(
        `UPDATE room_meta
         SET demo_x = ?, demo_y = ?, last_input = ?,
             frame_revision = frame_revision + 1, updated_at = ?
         WHERE id = 1`,
        x,
        y,
        input,
        Date.now()
      );
      return;
    }

    await this.ensureEmulatorLoaded(meta);
    const response = await this.containerFetch("http://container/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, frames: 12 })
    });
    await expectContainerJson(response, "apply controller input");
    if (!meta.frame_key || !meta.state_key) throw new Error("emulator storage keys are missing");
    await this.persistEmulatorFrame(meta.frame_key);
    this.ctx.storage.sql.exec(
      `UPDATE room_meta
       SET last_input = COALESCE(?, last_input),
           frame_revision = frame_revision + 1,
           updated_at = ?
       WHERE id = 1`,
      input,
      Date.now()
    );
    this.requestStateCheckpoint(meta.state_key);
  }

  private async ensureEmulatorLoaded(meta: RoomMetaRow): Promise<void> {
    const statusResponse = await this.containerFetch("http://container/status");
    const status = (await expectContainerJson(statusResponse, "read emulator status")) as {
      loaded?: boolean;
      romSha256?: string | null;
    };
    if (status.loaded && status.romSha256 === meta.rom_sha256) return;
    if (!meta.rom_key) throw new Error("ROM storage key is missing");
    const rom = await this.env.PRIVATE_DATA.get(meta.rom_key);
    if (rom === null) throw new Error("ROM object is missing");
    const loadResponse = await this.containerFetch("http://container/load", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(await rom.arrayBuffer())
    });
    await expectContainerJson(loadResponse, "reload ROM");
    if (meta.state_key) {
      const state = await this.env.PRIVATE_DATA.get(meta.state_key);
      if (state !== null) {
        const restoreResponse = await this.containerFetch("http://container/load-state", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(await state.arrayBuffer())
        });
        await expectContainerJson(restoreResponse, "restore emulator state");
      }
    }
  }

  private async persistEmulatorArtifacts(frameKey: string, stateKey: string): Promise<void> {
    const startedAt = Date.now();
    await Promise.all([this.persistEmulatorFrame(frameKey), this.persistEmulatorState(stateKey)]);
    console.log({
      message: "emulator artifacts persisted",
      durationMs: Date.now() - startedAt
    });
  }

  private async persistEmulatorFrame(frameKey: string): Promise<void> {
    const frameResponse = await this.containerFetch("http://container/frame");
    const frame = await expectContainerBytes(frameResponse, "capture frame", FRAME_MAX_BYTES);
    await this.env.PRIVATE_DATA.put(frameKey, frame, {
      httpMetadata: { contentType: "image/png" }
    });
  }

  private async persistEmulatorState(stateKey: string): Promise<void> {
    const stateResponse = await this.containerFetch("http://container/state");
    const state = await expectContainerBytes(stateResponse, "save state", STATE_MAX_BYTES);
    await this.env.PRIVATE_DATA.put(stateKey, state, {
      httpMetadata: { contentType: "application/octet-stream" }
    });
  }

  private requestStateCheckpoint(stateKey: string): void {
    this.stateCheckpointRequested = true;
    if (this.stateCheckpointTask !== null) return;
    const task = this.runStateCheckpoints(stateKey).finally(() => {
      this.stateCheckpointTask = null;
    });
    this.stateCheckpointTask = task;
    this.ctx.waitUntil(task);
  }

  private async runStateCheckpoints(stateKey: string): Promise<void> {
    while (this.stateCheckpointRequested) {
      this.stateCheckpointRequested = false;
      const startedAt = Date.now();
      try {
        await this.persistEmulatorState(stateKey);
        console.log({
          message: "emulator state checkpoint persisted",
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        console.error({
          message: "emulator state checkpoint failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private readMeta(): RoomMetaRow {
    return this.ctx.storage.sql.exec<RoomMetaRow>("SELECT * FROM room_meta WHERE id = 1").one();
  }

  private mergeAgentSummary(
    agentId: string,
    voteCount: number,
    chatCount: number,
    firstAt: number,
    lastAt: number
  ): void {
    const displayName = this.ctx.storage.sql
      .exec<{ display_name: string }>(
        "SELECT display_name FROM game_agent_summaries WHERE agent_id = ?",
        agentId
      )
      .toArray()[0]?.display_name ?? `Agent ${agentId.slice(0, 4)}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO game_agent_summaries
        (agent_id, display_name, vote_count, chat_count, first_recorded_at, last_recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         display_name = excluded.display_name,
         vote_count = game_agent_summaries.vote_count + excluded.vote_count,
         chat_count = game_agent_summaries.chat_count + excluded.chat_count,
         first_recorded_at = CASE
           WHEN game_agent_summaries.first_recorded_at IS NULL THEN excluded.first_recorded_at
           ELSE MIN(game_agent_summaries.first_recorded_at, excluded.first_recorded_at)
         END,
         last_recorded_at = CASE
           WHEN game_agent_summaries.last_recorded_at IS NULL THEN excluded.last_recorded_at
           ELSE MAX(game_agent_summaries.last_recorded_at, excluded.last_recorded_at)
         END`,
      agentId,
      displayName,
      voteCount,
      chatCount,
      firstAt,
      lastAt
    );
  }

  private appendEvent(eventType: string, data: Record<string, unknown>): GameEvent {
    this.recordMetric("gameEvents");
    const row = this.ctx.storage.sql
      .exec<GameEventRow>(
        `INSERT INTO game_events (event_type, data_json, created_at)
         VALUES (?, ?, ?)
         RETURNING sequence, event_type, data_json, created_at`,
        eventType,
        JSON.stringify(data),
        Date.now()
      )
      .one();
    return mapEvent(row);
  }

  private readEvents(limit: number): GameEvent[] {
    return this.ctx.storage.sql
      .exec<GameEventRow>(
        `SELECT sequence, event_type, data_json, created_at
         FROM game_events
         ORDER BY sequence DESC
         LIMIT ?`,
        limit
      )
      .toArray()
      .reverse()
      .map(mapEvent);
  }

  private broadcast(type: string, payload: unknown): void {
    const envelope: SocketEnvelope = { source: "game", type, payload, createdAt: Date.now() };
    const message = JSON.stringify(envelope);
    for (const socket of this.ctx.getWebSockets("game")) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "broadcast failed");
      }
    }
  }

  private recordMetric(name: GameMetricName): void {
    const now = Date.now();
    const durationMs = now - this.metricWindowStartedAt;
    if (durationMs >= 60_000) {
      const seconds = durationMs / 1_000;
      console.log({
        message: "game room request metrics",
        windowMs: durationMs,
        observeRequestsPerSecond: this.metricCounts.observeRequests / seconds,
        chatReadsPerSecond: this.metricCounts.chatReads / seconds,
        votesPerSecond: this.metricCounts.votes / seconds,
        gameEventsPerSecond: this.metricCounts.gameEvents / seconds,
        presenceWritesPerSecond: this.metricCounts.presenceWrites / seconds,
        eventSocketCount: this.ctx.getWebSockets("game").length
      });
      this.metricWindowStartedAt = now;
      this.metricCounts = emptyGameMetrics();
    }
    this.metricCounts[name] += 1;
  }
}

function emptyGameMetrics(): GameMetricCounts {
  return {
    observeRequests: 0,
    chatReads: 0,
    votes: 0,
    gameEvents: 0,
    presenceWrites: 0
  };
}

function mapWindow(row: VoteWindowRow): VoteWindow {
  return {
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    winner: row.winner
  };
}

function roomIdFromMeta(meta: RoomMetaRow): string {
  if (meta.room_id === null) throw new Error("room identity is not initialized");
  return meta.room_id;
}

function mapEvent(row: GameEventRow): GameEvent {
  return {
    sequence: row.sequence,
    eventType: row.event_type,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function mapChat(row: ChatRow): ChatMessage {
  return {
    sequence: row.sequence,
    agentId: row.agent_id,
    displayName: row.display_name,
    message: row.message,
    createdAt: row.created_at
  };
}

function minimumTimestamp(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length === 0 ? null : Math.min(...present);
}

function maximumTimestamp(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length === 0 ? null : Math.max(...present);
}

async function expectContainerJson(response: Response, action: string): Promise<unknown> {
  const body = (await response.json().catch(() => ({ error: "invalid emulator response" }))) as {
    error?: string;
  };
  if (!response.ok) throw new Error(`${action} failed: ${body.error ?? response.status}`);
  return body;
}

async function expectContainerBytes(
  response: Response,
  action: string,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "invalid emulator response" }))) as {
      error?: string;
    };
    throw new Error(`${action} failed: ${body.error ?? response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error(`${action} returned an invalid size`);
  }
  return bytes;
}
