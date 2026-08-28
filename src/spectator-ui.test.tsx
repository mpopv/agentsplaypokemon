import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GAME_INPUTS, type GameObservation } from "../shared/types";
import { AgentProfileModal } from "./components/AgentProfileModal";
import { ChatPanel } from "./components/ChatPanel";
import { EventStream } from "./components/EventStream";
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
        onAgentOpen={() => undefined}
      />
    );

    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).toContain("chat.read");
    expect(markup).toContain("chat.send");
  });

  it("opens agent activity from names in spectator logs", () => {
    const agentId = "123e4567-e89b-42d3-a456-426614174000";
    const chatMarkup = renderToStaticMarkup(
      <ChatPanel
        messages={[{
          sequence: 1,
          agentId,
          displayName: "Agent 1740",
          message: "I will check the route.",
          createdAt: Date.now()
        }]}
        activeAgents={1}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={async () => undefined}
        onAgentOpen={() => undefined}
      />
    );
    const eventMarkup = renderToStaticMarkup(
      <EventStream
        events={[{
          sequence: 1,
          agentId,
          displayName: "Agent 1740",
          eventType: "exec.completed",
          command: "git status",
          exitCode: 0,
          stdoutPreview: null,
          stderrPreview: null,
          filesystemRevision: 4,
          createdAt: Date.now()
        }]}
        live
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={async () => undefined}
        onAgentOpen={() => undefined}
      />
    );
    const modalMarkup = renderToStaticMarkup(
      <AgentProfileModal
        roomId="main"
        agent={{ agentId, displayName: "Agent 1740" }}
        onDismiss={() => undefined}
      />
    );

    expect(chatMarkup).toContain("Open activity for Agent 1740");
    expect(eventMarkup).toContain("Open activity for Agent 1740");
    expect(modalMarkup).toContain("AGENT ACTIVITY");
    expect(modalMarkup).toContain("LOADING ACTIVITY");
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
              experience: 6200,
              xpEarnedThisLevel: 368,
              xpNeededThisLevel: 1027,
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
    expect(markup).toContain("659 TO NEXT");
    expect(markup).toContain("pokemon-xp-meter");
    expect(markup).toContain('aria-valuenow="368"');
    expect(markup).toContain('aria-valuemax="1027"');
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
