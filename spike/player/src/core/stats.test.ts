// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { fpsFromIntervals, median, percentile, RollingSamples, summarizeFrames } from "./stats.ts";

describe("percentiles", () => {
  it("median / p50 / p5 / p95 with interpolation", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(median(v)).toBe(5.5);
    expect(percentile(v, 50)).toBe(5.5);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 100)).toBe(10);
    expect(percentile(v, 5)).toBeCloseTo(1.45);
    expect(percentile(v, 95)).toBeCloseTo(9.55);
    expect(median([3, 1, 2])).toBe(2);
    expect(percentile([], 50)).toBeNaN();
  });

  it("fps from rAF intervals, p5 is the slow tail", () => {
    const intervals = [...Array(90).fill(1000 / 60), ...Array(10).fill(50)];
    const s = summarizeFrames(intervals);
    expect(s.fpsMedian).toBeCloseTo(60);
    expect(s.fpsP5).toBeLessThan(30);
    expect(s.frameMsP95).toBeGreaterThan(16);
    expect(fpsFromIntervals([0, -1, 20])).toEqual([50]);
  });
});

describe("RollingSamples", () => {
  it("keeps only the newest `capacity` samples", () => {
    const r = new RollingSamples(3);
    [1, 2, 3, 4, 5].forEach((x) => r.push(x));
    expect(r.values().sort()).toEqual([3, 4, 5]);
    expect(r.length).toBe(3);
    r.clear();
    expect(r.length).toBe(0);
    expect(() => new RollingSamples(0)).toThrow();
  });
});
