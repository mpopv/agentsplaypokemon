import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerRoomTools } from "./webmcp";

describe("WebMCP registration", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers only the five agent tools", async () => {
    const names: string[] = [];
    const registerTool = vi.fn(async (tool: { name: string }) => {
      names.push(tool.name);
    });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool }
    });
    const onStatus = vi.fn();
    const dispose = registerRoomTools("main", onStatus, vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(names).toEqual([
      "game.observe",
      "game.vote",
      "chat.read",
      "chat.send",
      "computer.exec"
    ]);
    expect(onStatus).toHaveBeenLastCalledWith("available");
    dispose();
  });

  it("reports when a browser does not provide WebMCP", () => {
    const onStatus = vi.fn();
    registerRoomTools("main", onStatus, vi.fn());
    expect(onStatus).toHaveBeenCalledWith("unavailable");
  });
});
