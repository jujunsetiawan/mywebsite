// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { clamp01, frameIndexFromProgress, frameToDraw, progressFromScroll, scrollForProgress, spacerHeight } from "./progress.ts";

const FRAMES = 72;

describe("spacer + progress", () => {
  it("spacer is 6 viewport heights", () => {
    expect(spacerHeight(900)).toBe(5400);
    expect(spacerHeight(844)).toBe(5064);
  });

  it("progress = scrollY / (spacer - innerHeight), clamped", () => {
    expect(progressFromScroll(0, 5400, 900)).toBe(0);
    expect(progressFromScroll(2250, 5400, 900)).toBe(0.5);
    expect(progressFromScroll(4500, 5400, 900)).toBe(1);
    expect(progressFromScroll(-50, 5400, 900)).toBe(0); // iOS rubber-band
    expect(progressFromScroll(9999, 5400, 900)).toBe(1);
    expect(progressFromScroll(10, 900, 900)).toBe(0); // degenerate spacer
  });

  it("clamp01 handles NaN", () => {
    expect(clamp01(NaN)).toBe(0);
  });
});

describe("frame index (matrix: progress bounds)", () => {
  it("scrollY 0 => frame 0, scrollY max => frame 71", () => {
    expect(frameIndexFromProgress(progressFromScroll(0, 5400, 900), FRAMES)).toBe(0);
    expect(frameIndexFromProgress(progressFromScroll(4500, 5400, 900), FRAMES)).toBe(71);
    expect(frameIndexFromProgress(1, FRAMES)).toBe(71);
    expect(frameIndexFromProgress(-1, FRAMES)).toBe(0);
    expect(frameIndexFromProgress(2, FRAMES)).toBe(71);
  });

  it("floor(progress x frameCount)", () => {
    expect(frameIndexFromProgress(0.5, FRAMES)).toBe(36);
    expect(frameIndexFromProgress(35.999 / 72, FRAMES)).toBe(35);
    expect(frameIndexFromProgress(36 / 72, FRAMES)).toBe(36);
  });
});

describe("matrix: scrub forward then back", () => {
  it("same progress gives the same frame in both directions", () => {
    const spacer = 5400, ih = 900;
    const forward: number[] = [];
    for (let y = 0; y <= 4500; y += 7) forward.push(frameIndexFromProgress(progressFromScroll(y, spacer, ih), FRAMES));
    const backward: number[] = [];
    for (let y = 4500 - ((4500 % 7) === 0 ? 0 : 4500 % 7); y >= 0; y -= 7) backward.push(frameIndexFromProgress(progressFromScroll(y, spacer, ih), FRAMES));
    expect(backward.reverse()).toEqual(forward);
  });
});

describe("matrix: rotate keeps progress", () => {
  it("scrollForProgress inverts progressFromScroll across viewport sizes", () => {
    // landscape 1440x900 at some scroll -> portrait 390x844
    const p = progressFromScroll(3000, spacerHeight(900), 900);
    const y2 = scrollForProgress(p, spacerHeight(844), 844);
    const p2 = progressFromScroll(y2, spacerHeight(844), 844);
    expect(p2).toBeCloseTo(p, 12);
    expect(frameIndexFromProgress(p2, FRAMES)).toBe(frameIndexFromProgress(p, FRAMES));
  });
});

describe("matrix: frame not decoded", () => {
  it("keeps the last drawn frame (null) when the target is not ready", () => {
    const ready = new Set([3, 4]);
    expect(frameToDraw(4, (i) => ready.has(i))).toBe(4);
    expect(frameToDraw(20, (i) => ready.has(i))).toBeNull();
  });
});
