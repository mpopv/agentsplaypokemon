import { describe, expect, it } from "vitest";

import { mergeBySequence } from "./sequence";

describe("sequence merging", () => {
  it("prepends older items and keeps one item for each sequence", () => {
    const merged = mergeBySequence(
      [{ sequence: 3 }, { sequence: 4 }],
      [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]
    );

    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the same array when there is no new item", () => {
    const current = [{ sequence: 1 }];
    expect(mergeBySequence(current, [])).toBe(current);
  });
});
