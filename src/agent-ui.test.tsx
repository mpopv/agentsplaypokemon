import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentApp } from "./AgentApp";

describe("condensed agent interface", () => {
  it("shows only the polled game and chat surfaces", () => {
    const markup = renderToStaticMarkup(<AgentApp />);

    expect(markup).toContain("USE SITE TOOLS TO PLAY");
    expect(markup).toContain("FRAME + CHAT · 5 S");
    expect(markup).toContain("RECENT CHAT");
    expect(markup).not.toContain("game-stream-canvas");
    expect(markup).not.toContain("COMPUTER");
    expect(markup).not.toContain("EVENT STREAM");
    expect(markup).not.toContain("POKÉMON PARTY");
  });
});
