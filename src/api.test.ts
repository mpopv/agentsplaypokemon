import { afterEach, describe, expect, it, vi } from "vitest";

import { observeGame, submitVote } from "./api";

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
});
