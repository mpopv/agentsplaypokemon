import { Container } from "@cloudflare/containers";

import {
  GAME_INPUTS,
  type AgentIdentity,
  type ChatHistoryPage,
  type ChatMessage,
  type GameEvent,
  type GameInput,
  type GameObservation,
  type SocketEnvelope,
  type VoteTally,
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

interface ResolvePayload {
  windowId: number;
}

const PRESENCE_TTL_MS = 120_000;
const CHAT_RATE_LIMIT_MS = 2_000;
const CHAT_HISTORY_PAGE_SIZE = 30;
const ROM_MAX_BYTES = 8 * 1024 * 1024;
const FRAME_MAX_BYTES = 1024 * 1024;
const STATE_MAX_BYTES = 4 * 1024 * 1024;

export class GameRoomDO extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "20m";
  enableInternet = false;
  pingEndpoint = "localhost/health";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  async observe(roomId: string, agent: AgentIdentity): Promise<GameObservation> {
    this.identify(roomId);
    this.touchPresence(agent);
    const window = await this.ensureVoteWindow();
    const meta = this.readMeta();
    const votes = this.ctx.storage.sql
      .exec<VoteTallyRow>(
        `SELECT input, COUNT(*) AS count
         FROM votes
         WHERE window_id = ?
         GROUP BY input`,
        window.id
      )
      .toArray();
    const tallies = GAME_INPUTS.map((input) => ({
      input,
      count: Number(votes.find((row) => row.input === input)?.count ?? 0)
    }));
    const yourVote =
      this.ctx.storage.sql
        .exec<{ input: GameInput }>(
          "SELECT input FROM votes WHERE window_id = ? AND agent_id = ?",
          window.id,
          agent.agentId
        )
        .toArray()[0]?.input ?? null;
    const activeAgents = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM presence WHERE last_seen >= ?",
          Date.now() - PRESENCE_TTL_MS
        )
        .one().count
    );

    return {
      roomId,
      mode: meta.mode,
      frameRevision: meta.frame_revision,
      frameUrl: `/rooms/${roomId}/game/frame?rev=${meta.frame_revision}`,
      activeAgents,
      voteWindow: mapWindow(window),
      votes: tallies,
      yourVote,
      lastInput: meta.last_input,
      events: this.readEvents(40)
    };
  }

  async vote(roomId: string, agent: AgentIdentity, input: GameInput): Promise<GameObservation> {
    this.identify(roomId);
    this.touchPresence(agent);
    const window = await this.ensureVoteWindow();
    if (window.ends_at <= Date.now()) {
      throw new InputError("this vote window is closed", 409);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO votes (window_id, agent_id, input, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(window_id, agent_id)
       DO UPDATE SET input = excluded.input, created_at = excluded.created_at`,
      window.id,
      agent.agentId,
      input,
      Date.now()
    );
    const event = this.appendEvent("vote.submitted", {
      windowId: window.id,
      agentId: agent.agentId,
      displayName: agent.displayName,
      input
    });
    this.broadcast("vote.submitted", event);
    return this.observe(roomId, agent);
  }

  readChat(roomId: string, agent: AgentIdentity, after: number): ChatMessage[] {
    this.identify(roomId);
    this.touchPresence(agent);
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

  readChatHistory(
    roomId: string,
    agent: AgentIdentity,
    before?: number
  ): ChatHistoryPage {
    this.identify(roomId);
    this.touchPresence(agent);
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
      throw new InputError("wait two seconds before you send another chat message", 429);
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
    const event = this.appendEvent("emulator.rom_loaded", { romSha256 });
    this.broadcast("emulator.rom_loaded", event);
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
      return this.openGameStream(request);
    }
    if (url.pathname !== "/internal/game-socket") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const agentId = request.headers.get("x-agent-id");
    const displayName = request.headers.get("x-agent-name");
    if (!agentId || !displayName) return new Response("unauthorized", { status: 401 });
    this.touchPresence({ agentId, displayName });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["game", `agent:${agentId}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async openGameStream(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const roomId = request.headers.get("x-room-id");
    const agentId = request.headers.get("x-agent-id");
    const displayName = request.headers.get("x-agent-name");
    if (!roomId || !agentId || !displayName) {
      return new Response("unauthorized", { status: 401 });
    }

    this.identify(roomId);
    this.touchPresence({ agentId, displayName });
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

      CREATE TABLE IF NOT EXISTS chat_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

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
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (agent_id, display_name, last_seen)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id)
       DO UPDATE SET display_name = excluded.display_name, last_seen = excluded.last_seen`,
      agent.agentId,
      agent.displayName,
      Date.now()
    );
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
    const event = this.appendEvent("vote_window.opened", {
      windowId: created.id,
      startsAt: now,
      endsAt
    });
    this.broadcast("vote_window.opened", event);
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
    const event = this.appendEvent("vote_window.resolved", { windowId, winner });
    this.broadcast("vote_window.resolved", event);

    const activeAgents = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM presence WHERE last_seen >= ?",
          Date.now() - PRESENCE_TTL_MS
        )
        .one().count
    );
    if (activeAgents > 0) await this.ensureVoteWindow();
  }

  private async advanceGame(input: GameInput | null): Promise<void> {
    const meta = this.readMeta();
    if (meta.mode === "demo") {
      if (input === null) return;
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
    if (input !== null) {
      const response = await this.containerFetch("http://container/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, frames: 12 })
      });
      await expectContainerJson(response, "apply controller input");
    }
    if (!meta.frame_key || !meta.state_key) throw new Error("emulator storage keys are missing");
    await this.persistEmulatorArtifacts(meta.frame_key, meta.state_key);
    this.ctx.storage.sql.exec(
      `UPDATE room_meta
       SET last_input = COALESCE(?, last_input),
           frame_revision = frame_revision + 1,
           updated_at = ?
       WHERE id = 1`,
      input,
      Date.now()
    );
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
    const frameResponse = await this.containerFetch("http://container/frame");
    const frame = await expectContainerBytes(frameResponse, "capture frame", FRAME_MAX_BYTES);
    await this.env.PRIVATE_DATA.put(frameKey, frame, {
      httpMetadata: { contentType: "image/png" }
    });
    const stateResponse = await this.containerFetch("http://container/state");
    const state = await expectContainerBytes(stateResponse, "save state", STATE_MAX_BYTES);
    await this.env.PRIVATE_DATA.put(stateKey, state, {
      httpMetadata: { contentType: "application/octet-stream" }
    });
  }

  private readMeta(): RoomMetaRow {
    return this.ctx.storage.sql.exec<RoomMetaRow>("SELECT * FROM room_meta WHERE id = 1").one();
  }

  private appendEvent(eventType: string, data: Record<string, unknown>): GameEvent {
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
