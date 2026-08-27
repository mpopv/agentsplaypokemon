import { describe, expect, it } from "vitest";

import { makeHistoryPage } from "./history-page";

describe("history pages", () => {
  it("returns an ascending page from descending database rows", () => {
    const page = makeHistoryPage(
      [5, 4, 3, 2, 1].map((sequence) => ({ sequence })),
      4
    );

    expect(page.items.map((item) => item.sequence)).toEqual([2, 3, 4, 5]);
    expect(page.nextBefore).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("ends the cursor when no older row exists", () => {
    expect(makeHistoryPage([{ sequence: 1 }], 4)).toEqual({
      items: [{ sequence: 1 }],
      nextBefore: null,
      hasMore: false
    });
    expect(makeHistoryPage([], 4)).toEqual({
      items: [],
      nextBefore: null,
      hasMore: false
    });
  });
});
