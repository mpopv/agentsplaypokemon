import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GAME_INPUTS } from "../shared/types";
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

  it("executes the read-only game.observe tool canary", async () => {
    let observeTool: { execute(arguments_: Record<string, unknown>): Promise<unknown> } | undefined;
    const registerTool = vi.fn(async (tool: {
      name: string;
      execute(arguments_: Record<string, unknown>): Promise<unknown>;
    }) => {
      if (tool.name === "game.observe") observeTool = tool;
    });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool }
    });
    const game = {
      roomId: "main",
      mode: "rom",
      frameRevision: 10,
      frameUrl: "/rooms/main/game/frame?rev=10",
      activeAgents: 1,
      voteWindow: {
        id: 2,
        startsAt: Date.now(),
        endsAt: Date.now() + 15_000,
        status: "open",
        winner: null
      },
      votes: GAME_INPUTS.map((input) => ({ input, count: 0 })),
      yourVote: null,
      lastInput: null,
      events: []
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(game));
    vi.stubGlobal("fetch", fetch);

    registerRoomTools("main", vi.fn(), vi.fn());
    await Promise.resolve();
    await Promise.resolve();
    const result = await observeTool?.execute({});

    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify(game) }] });
    expect(fetch).toHaveBeenCalledWith(
      "/rooms/main/game",
      expect.objectContaining({ credentials: "omit" })
    );
  });
});
