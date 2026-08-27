import { describe, expect, it } from "vitest";

import type { RuntimeEnv } from "./runtime-env";
import { createSession, requireSession } from "./auth";

const env = {
  SESSION_SIGNING_SECRET: "a-test-session-secret-that-is-longer-than-32-characters",
  DEFAULT_ROOM_ID: "main"
} as RuntimeEnv;

describe("signed tab sessions", () => {
  it("creates a server-owned agent identity and accepts its bearer token", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    expect(created.session.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.session.displayName).toMatch(/^Agent-[0-9A-F]{8}$/);
    expect(created.session.roomId).toBe("main");

    const accepted = await requireSession(
      new Request("https://agentsplaypokemon.com/rooms/main/game", {
        headers: { authorization: `Bearer ${created.token}` }
      }),
      env
    );
    expect(accepted.agentId).toBe(created.session.agentId);
  });

  it("reuses a valid token in the same tab", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    const reused = await createSession(
      new Request("https://agentsplaypokemon.com/api/session", {
        headers: { authorization: `Bearer ${created.token}` }
      }),
      env
    );
    expect(reused).toEqual(created);
  });

  it("creates different identities without an existing tab token", async () => {
    const [first, second] = await Promise.all([
      createSession(new Request("https://agentsplaypokemon.com/api/session"), env),
      createSession(new Request("https://agentsplaypokemon.com/api/session"), env)
    ]);
    expect(first.session.agentId).not.toBe(second.session.agentId);
    expect(first.session.displayName).not.toBe(second.session.displayName);
  });

  it("accepts a signed token in the WebSocket subprotocol", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    const accepted = await requireSession(
      new Request("https://agentsplaypokemon.com/rooms/main/game-socket", {
        headers: {
          "sec-websocket-protocol": `agents-play-session.${created.token}`,
          upgrade: "websocket"
        }
      }),
      env
    );
    expect(accepted.agentId).toBe(created.session.agentId);
  });

  it("rejects an ambiguous WebSocket subprotocol list", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    await expect(
      requireSession(
        new Request("https://agentsplaypokemon.com/rooms/main/game-socket", {
          headers: {
            "sec-websocket-protocol": `other, agents-play-session.${created.token}`,
            upgrade: "websocket"
          }
        }),
        env
      )
    ).rejects.toThrow("a signed tab session is required");
  });

  it("rejects a changed token", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    const changed = `${created.token.slice(0, -1)}x`;
    await expect(
      requireSession(
        new Request("https://agentsplaypokemon.com/rooms/main/game", {
          headers: { authorization: `Bearer ${changed}` }
        }),
        env
      )
    ).rejects.toThrow("a signed tab session is required");
  });

  it("rejects malformed token encoding as an authentication error", async () => {
    await expect(
      requireSession(
        new Request("https://agentsplaypokemon.com/rooms/main/game", {
          headers: { authorization: "Bearer payload.!not-base64url" }
        }),
        env
      )
    ).rejects.toThrow("a signed tab session is required");
  });

  it("rejects the obsolete browser cookie", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    await expect(
      requireSession(
        new Request("https://agentsplaypokemon.com/rooms/main/game", {
          headers: { cookie: `agents_play_session=${created.token}` }
        }),
        env
      )
    ).rejects.toThrow("a signed tab session is required");
  });
});
