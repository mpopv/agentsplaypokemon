import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RegisteredTool {
  name: string;
  execute(arguments_: Record<string, unknown>): Promise<unknown>;
}

describe("WebMCP registration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("document", {});
  });

  afterEach(() => {
    vi.doUnmock("./api");
    vi.unstubAllGlobals();
  });

  it("registers all five tools before the agent session is ready", async () => {
    let resolveSession:
      | ((value: { agentId: string; displayName: string; roomId: string }) => void)
      | undefined;
    const session = new Promise<{ agentId: string; displayName: string; roomId: string }>(
      (resolve) => {
        resolveSession = resolve;
      }
    );
    const getSession = vi.fn(() => session);
    const observeGame = vi.fn(async () => ({ roomId: "main" }));
    vi.doMock("./api", () => ({
      execComputer: vi.fn(),
      getSession,
      observeGame,
      readChat: vi.fn(),
      sendChat: vi.fn(),
      submitVote: vi.fn()
    }));

    const tools: RegisteredTool[] = [];
    const registerTool = vi.fn(async (tool: RegisteredTool) => {
      tools.push(tool);
    });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool }
    });
    const { getWebMcpStatus, startRoomToolRegistration } = await import("./webmcp");
    startRoomToolRegistration();

    expect(tools.map((tool) => tool.name)).toEqual([
      "game.observe",
      "game.vote",
      "chat.read",
      "chat.send",
      "computer.exec"
    ]);
    expect(getSession).not.toHaveBeenCalled();

    const observeTool = tools.find((tool) => tool.name === "game.observe");
    if (!observeTool) throw new Error("game.observe was not registered");
    const observation = observeTool.execute({});
    expect(getSession).toHaveBeenCalledOnce();
    expect(observeGame).not.toHaveBeenCalled();

    resolveSession?.({ agentId: "agent-1", displayName: "Agent-1", roomId: "main" });
    await expect(observation).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify({ roomId: "main" }) }]
    });
    expect(observeGame).toHaveBeenCalledWith("main");

    await Promise.resolve();
    expect(getWebMcpStatus()).toBe("available");
  });

  it("reports when a browser does not provide WebMCP", async () => {
    const { getWebMcpStatus, startRoomToolRegistration } = await import("./webmcp");
    startRoomToolRegistration();
    expect(getWebMcpStatus()).toBe("unavailable");
  });
});
