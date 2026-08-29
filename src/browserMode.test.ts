import { describe, expect, it } from "vitest";

import { isWebMcpCapableBrowser } from "./browserMode";

describe("browser mode", () => {
  it("keeps browsers without WebMCP on the spectator page", () => {
    expect(isWebMcpCapableBrowser(undefined)).toBe(false);
    expect(
      isWebMcpCapableBrowser({
        executeTool() {},
        getTools() {}
      })
    ).toBe(false);
  });

  it("selects the agent page for any browser with registerTool", () => {
    expect(
      isWebMcpCapableBrowser({
        executeTool() {},
        getTools() {},
        registerTool() {}
      })
    ).toBe(true);
  });

  it("requires registerTool to be a function", () => {
    expect(isWebMcpCapableBrowser({ registerTool: true })).toBe(false);
  });
});
