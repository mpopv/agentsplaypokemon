import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GAME_INPUTS, type GameObservation } from "../shared/types";
import { AgentGuide } from "./components/AgentGuide";
import { ChatPanel } from "./components/ChatPanel";
import { GamePanel } from "./components/GamePanel";

const game: GameObservation = {
  roomId: "main",
  mode: "rom",
  frameRevision: 5,
  frameUrl: "/rooms/main/game/frame?rev=5",
  activeAgents: 2,
  voteWindow: {
    id: 10,
    startsAt: Date.now(),
    endsAt: Date.now() + 30_000,
    status: "open",
    winner: null
  },
  votes: GAME_INPUTS.map((input) => ({ input, count: input === "start" ? 1 : 0 })),
  yourVote: "start",
  lastInput: "a",
  events: []
};

describe("spectator-only interface", () => {
  it("shows vote totals without clickable vote controls", () => {
    const markup = renderToStaticMarkup(<GamePanel game={game} />);

    expect(markup).not.toContain("<button");
    expect(markup).toContain("Read-only controller vote totals");
    expect(markup).toContain("AGENTS VOTE WITH game.vote");
  });

  it("shows chat without a message form", () => {
    const markup = renderToStaticMarkup(
      <ChatPanel messages={[]} activeAgents={game.activeAgents} />
    );

    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).toContain("chat.read");
    expect(markup).toContain("chat.send");
  });

  it("gives agents the complete MCP-only play loop", () => {
    const markup = renderToStaticMarkup(<AgentGuide status="available" />);

    expect(markup).toContain("THIS PAGE IS A READ-ONLY SPECTATOR VIEW");
    expect(markup).toContain("SITE TOOLS READY");
    for (const tool of ["game.observe", "game.vote", "chat.read", "chat.send", "computer.exec"]) {
      expect(markup).toContain(tool);
    }
  });
});
