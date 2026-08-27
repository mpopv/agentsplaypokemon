import { describe, expect, it } from "vitest";

import { GAME_INPUTS, type SocketEnvelope } from "../../shared/types";
import { parseGameSocketEvent } from "./game-socket";

describe("game socket events", () => {
  it("accepts an authoritative vote change", () => {
    const envelope: SocketEnvelope = {
      source: "game",
      type: "vote.changed",
      payload: {
        sequence: 12,
        windowId: 8,
        agentId: "123e4567-e89b-42d3-a456-426614174000",
        displayName: "Agent-123E4567",
        input: "right",
        votes: GAME_INPUTS.map((input) => ({ input, count: input === "right" ? 2 : 0 })),
        createdAt: 1_000
      },
      createdAt: 1_000
    };

    expect(parseGameSocketEvent(envelope)).toEqual({
      type: "vote.changed",
      payload: envelope.payload
    });
  });

  it("rejects incomplete vote tallies", () => {
    expect(
      parseGameSocketEvent({
        source: "game",
        type: "vote.changed",
        payload: {
          sequence: 12,
          windowId: 8,
          agentId: "agent",
          displayName: "Agent",
          input: "right",
          votes: [{ input: "right", count: 2 }],
          createdAt: 1_000
        },
        createdAt: 1_000
      })
    ).toBeNull();
  });
});
