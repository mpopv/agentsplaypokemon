import { describe, expect, it } from "vitest";

import {
  enforceSameOrigin,
  InputError,
  parseChatMessage,
  parseCommand,
  parseCursor,
  parseGameInput,
  parseOptionalCursor,
  parseRoomId,
  parseWorkspacePath,
  readJsonObject
} from "./validation";

describe("request validation", () => {
  it("accepts valid room names and controller inputs", () => {
    expect(parseRoomId("main-room-2")).toBe("main-room-2");
    expect(parseGameInput("start")).toBe("start");
  });

  it("rejects room names and controller inputs outside the public contract", () => {
    expect(() => parseRoomId("Main Room")).toThrow(InputError);
    expect(() => parseGameInput("turbo")).toThrow(InputError);
  });

  it("keeps all spectator paths inside the shared workspace", () => {
    expect(parseWorkspacePath(undefined)).toBe("/workspace");
    expect(parseWorkspacePath("/workspace/maps/route.txt")).toBe(
      "/workspace/maps/route.txt"
    );
    expect(() => parseWorkspacePath("/workspace/../control-plane")).toThrow(
      "path must not contain '..'"
    );
    expect(() => parseWorkspacePath("/etc/passwd")).toThrow("path must be inside /workspace");
    expect(() => parseWorkspacePath("/workspace\\secret")).toThrow(
      "path contains an invalid character"
    );
  });

  it("bounds chat, commands, and cursors", () => {
    expect(parseChatMessage("  move north  ")).toBe("move north");
    expect(parseCommand("printf 'ok\\n'")).toBe("printf 'ok\\n'");
    expect(parseCursor("42")).toBe(42);
    expect(parseOptionalCursor(undefined)).toBeUndefined();
    expect(parseOptionalCursor("42")).toBe(42);
    expect(() => parseChatMessage(" ")).toThrow(InputError);
    expect(() => parseCommand("\u0000")).toThrow(InputError);
    expect(() => parseCursor("-1")).toThrow(InputError);
  });

  it("rejects cross-site mutation requests", () => {
    const request = new Request("https://agentsplaypokemon.com/rooms/main/votes", {
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
    });
    expect(() => enforceSameOrigin(request)).toThrowError(
      expect.objectContaining({ status: 403 })
    );
  });

  it("reads only bounded JSON objects", async () => {
    await expect(
      readJsonObject(new Request("https://example.test", { method: "POST", body: '{"input":"a"}' }))
    ).resolves.toEqual({ input: "a" });
    await expect(
      readJsonObject(new Request("https://example.test", { method: "POST", body: "[]" }))
    ).rejects.toThrow("request body must be a JSON object");
  });
});
