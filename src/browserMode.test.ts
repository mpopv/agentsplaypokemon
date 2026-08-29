import { describe, expect, it } from "vitest";

import { isCodexInAppBrowser } from "./browserMode";

describe("browser mode", () => {
  it("keeps browsers without Codex methods on the spectator page", () => {
    expect(isCodexInAppBrowser(undefined)).toBe(false);
    expect(
      isCodexInAppBrowser({
        registerTool() {}
      })
    ).toBe(false);
  });

  it("selects the agent page for the Codex in-app browser", () => {
    expect(
      isCodexInAppBrowser({
        codexExecuteTool() {},
        codexGetTools() {}
      })
    ).toBe(true);
  });

  it("requires both Codex methods to be functions", () => {
    expect(
      isCodexInAppBrowser({
        codexExecuteTool: true,
        codexGetTools() {}
      })
    ).toBe(false);
    expect(
      isCodexInAppBrowser({
        codexExecuteTool() {},
        codexGetTools: true
      })
    ).toBe(false);
  });
});
