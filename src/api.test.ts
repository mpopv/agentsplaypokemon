import { afterEach, describe, expect, it, vi } from "vitest";

import { observeGame, readPublicAgentProfile, submitVote } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("API request policy", () => {
  it("retries one failed read request", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("failed to fetch"))
      .mockResolvedValueOnce(Response.json({ roomId: "main" }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const request = observeGame("main");
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ roomId: "main" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(
      { error: "temporary failure" },
      { status: 500 }
    ));
    vi.stubGlobal("fetch", fetch);

    await expect(submitVote("main", "a")).rejects.toThrow("temporary failure");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an overloaded read response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(
      { error: "busy" },
      { status: 503, headers: { "retry-after": "1", "x-overloaded": "true" } }
    ));
    vi.stubGlobal("fetch", fetch);

    await expect(observeGame("main")).rejects.toThrow("busy");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries an explicitly retryable read response", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: "temporary transport failure" },
        { status: 503, headers: { "x-retryable": "true" } }
      ))
      .mockResolvedValueOnce(Response.json({ roomId: "main" }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const request = observeGame("main");
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ roomId: "main" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads an agent profile from its room-scoped endpoint", async () => {
    const profile = {
      agentId: "123e4567-e89b-42d3-a456-426614174000",
      displayName: "Agent 1740"
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(profile));
    vi.stubGlobal("fetch", fetch);

    await expect(readPublicAgentProfile("main", profile.agentId)).resolves.toEqual(profile);
    expect(fetch).toHaveBeenCalledWith(
      `/public/rooms/main/agents/${profile.agentId}`,
      expect.objectContaining({ credentials: "omit" })
    );
  });
});
