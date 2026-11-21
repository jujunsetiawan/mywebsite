// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { chunksFor, lookaheadOrder, windowFrames } from "./lookahead.ts";

describe("look-ahead window", () => {
  it("fits the byte budget with headroom", () => {
    const mb = 1024 * 1024;
    expect(windowFrames(150 * mb, 1920 * 1080 * 4, 72)).toBe(15); // 18 fit - 3
    expect(windowFrames(150 * mb, 1280 * 720 * 4, 72)).toBe(39); // 42 fit - 3
    expect(windowFrames(1 * mb, 1920 * 1080 * 4, 72)).toBe(1);
    expect(windowFrames(10_000 * mb, 1280 * 720 * 4, 72)).toBe(72);
  });

  it("starts at the playhead and biases towards the scroll direction", () => {
    const fwd = lookaheadOrder(10, 1, 72, 9);
    expect(fwd[0]).toBe(10);
    expect(fwd.filter((i) => i > 10).length).toBeGreaterThan(fwd.filter((i) => i < 10).length);
    const back = lookaheadOrder(10, -1, 72, 9);
    expect(back.filter((i) => i < 10).length).toBeGreaterThan(back.filter((i) => i > 10).length);
  });

  it("stays in range and has no duplicates at the ends", () => {
    for (const [p, d] of [[0, -1], [0, 1], [71, 1], [71, -1]] as const) {
      const o = lookaheadOrder(p, d, 72, 20);
      expect(o.length).toBe(20);
      expect(new Set(o).size).toBe(20);
      expect(o.every((i) => i >= 0 && i < 72)).toBe(true);
    }
    expect(lookaheadOrder(5, 1, 8, 100).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("maps frames to chunk indexes (N=16)", () => {
    expect(chunksFor([14, 15, 16, 17, 13], 16)).toEqual([0, 1]);
    expect(chunksFor([71, 64, 63], 16)).toEqual([4, 3]);
  });
});
