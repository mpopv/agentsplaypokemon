import { afterEach, describe, expect, it, vi } from "vitest";

import { pollAgentRoom } from "./useAgentRoomData";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent room polling", () => {
  it("uses public routes for the initial background refresh", async () => {
    const fetch = stubRoomFetch();

    const [game, chat] = await pollAgentRoom("main", null);

    expect(game.status).toBe("fulfilled");
    expect(chat.status).toBe("fulfilled");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/public/rooms/main/game",
      expect.objectContaining({ credentials: "omit" })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/public/rooms/main/chat/history",
      expect.objectContaining({ credentials: "omit" })
    );
    expectRequestsAreUnauthenticated(fetch);
  });

  it("uses the public cursor route for later background refreshes", async () => {
    const fetch = stubRoomFetch();

    await pollAgentRoom("main", 42);

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/public/rooms/main/chat?after=42",
      expect.objectContaining({ credentials: "omit" })
    );
    expectRequestsAreUnauthenticated(fetch);
  });
});

function stubRoomFetch() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/game")) {
      return Response.json({ roomId: "main", frameRevision: 1 });
    }
    return Response.json({ messages: [], cursor: 42, hasMore: false, nextBefore: null });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function expectRequestsAreUnauthenticated(fetch: ReturnType<typeof vi.fn>): void {
  for (const [, init] of fetch.mock.calls) {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  }
}
