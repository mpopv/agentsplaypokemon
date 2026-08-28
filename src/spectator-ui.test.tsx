import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GAME_INPUTS, type GameObservation } from "../shared/types";
import { AgentGuide } from "./components/AgentGuide";
import { ChatPanel } from "./components/ChatPanel";
import { GamePanel } from "./components/GamePanel";
import { parsePartyMessage } from "./components/LiveGameScreen";
import { PokemonPartyPanel } from "./components/PokemonPartyPanel";

const game: GameObservation = {
  roomId: "main",
  mode: "rom",
  frameRevision: 5,
  frameUrl: "/rooms/main/game/frame?rev=5",
  activeAgents: 2,
  voteWindow: {
    id: 10,
    startsAt: Date.now(),
    endsAt: Date.now() + 15_000,
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
    expect(markup).toContain("game-stream-canvas");
    expect(markup).toContain("data-stream-state=\"connecting\"");
    expect(markup).toContain("STREAM CONNECTING");
  });

  it("shows chat without a message form", () => {
    const markup = renderToStaticMarkup(
      <ChatPanel
        messages={[]}
        activeAgents={game.activeAgents}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={async () => undefined}
      />
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
    expect(markup).toContain("15-second window");
    for (const tool of ["game.observe", "game.vote", "chat.read", "chat.send", "computer.exec"]) {
      expect(markup).toContain(tool);
    }
  });

  it("shows all six party slots with live Pokémon details", () => {
    const markup = renderToStaticMarkup(
      <PokemonPartyPanel
        snapshot={{
          available: true,
          party: [
            {
              slot: 1,
              nickname: "SPARKY",
              species: "PIKACHU",
              pokedexNumber: 25,
              level: 18,
              hp: 37,
              maxHp: 45,
              status: "PAR",
              active: true,
              fainted: false
            }
          ]
        }}
      />
    );

    expect(markup.match(/pokemon-party-card/g)).toHaveLength(6);
    expect(markup).toContain("SPARKY");
    expect(markup).toContain("PIKACHU");
    expect(markup).toContain("LV 18");
    expect(markup).toContain("37/45");
    expect(markup).toContain("PAR");
    expect(markup).toContain("generation-i/red-blue/25.png");
    expect(markup.match(/EMPTY PARTY SLOT/g)).toHaveLength(5);
  });

  it("accepts only valid party messages from the game stream", () => {
    const valid = parsePartyMessage(
      JSON.stringify({
        type: "pokemon.party",
        payload: { available: true, party: [] }
      })
    );

    expect(valid).toEqual({ available: true, party: [] });
    expect(parsePartyMessage('{"type":"other","payload":{}}')).toBeNull();
    expect(parsePartyMessage("not json")).toBeNull();
  });
});
