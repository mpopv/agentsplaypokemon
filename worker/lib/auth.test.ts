import { describe, expect, it } from "vitest";

import type { RuntimeEnv } from "./runtime-env";
import { createSession, requireSession } from "./auth";

const env = {
  SESSION_SIGNING_SECRET: "a-test-session-secret-that-is-longer-than-32-characters",
  DEFAULT_ROOM_ID: "main"
} as RuntimeEnv;

describe("signed browser sessions", () => {
  it("creates a server-owned agent identity and accepts its cookie", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    expect(created.session.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.session.displayName).toMatch(/^Agent-[0-9A-F]{4}$/);
    expect(created.session.roomId).toBe("main");
    expect(created.setCookie).toContain("HttpOnly");
    expect(created.setCookie).toContain("SameSite=Strict");
    expect(created.setCookie).toContain("Secure");

    const cookie = created.setCookie?.split(";")[0];
    const accepted = await requireSession(
      new Request("https://agentsplaypokemon.com/rooms/main/game", {
        headers: { cookie: cookie ?? "" }
      }),
      env
    );
    expect(accepted.agentId).toBe(created.session.agentId);
  });

  it("rejects a changed token", async () => {
    const created = await createSession(new Request("https://agentsplaypokemon.com/api/session"), env);
    const cookie = created.setCookie?.split(";")[0] ?? "";
    const changed = `${cookie.slice(0, -1)}x`;
    await expect(
      requireSession(
        new Request("https://agentsplaypokemon.com/rooms/main/game", {
          headers: { cookie: changed }
        }),
        env
      )
    ).rejects.toThrow("a signed browser session is required");
  });

  it("rejects malformed token encoding as an authentication error", async () => {
    await expect(
      requireSession(
        new Request("https://agentsplaypokemon.com/rooms/main/game", {
          headers: { cookie: "agents_play_session=payload.!not-base64url" }
        }),
        env
      )
    ).rejects.toThrow("a signed browser session is required");
  });
});
