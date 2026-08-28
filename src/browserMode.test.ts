import { describe, expect, it } from "vitest";

import { isCodexInAppBrowser } from "./browserMode";

describe("browser mode", () => {
  it("keeps normal and native WebMCP browsers on the spectator page", () => {
    expect(isCodexInAppBrowser(undefined)).toBe(false);
    expect(
      isCodexInAppBrowser({
        executeTool() {},
        getTools() {},
        registerTool() {}
      })
    ).toBe(false);
  });

  it("selects the agent page only for the Codex bridge", () => {
    expect(
      isCodexInAppBrowser({
        codexExecuteTool() {},
        codexGetTools() {},
        executeTool() {},
        getTools() {},
        registerTool() {}
      })
    ).toBe(true);
  });

  it("requires both Codex bridge functions", () => {
    expect(isCodexInAppBrowser({ codexGetTools() {} })).toBe(false);
    expect(isCodexInAppBrowser({ codexExecuteTool() {} })).toBe(false);
  });
});
