// THROWAWAY — Story 0.5 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { ScrollActivity, TargetLatency } from "./scrub.ts";

describe("ScrollActivity", () => {
  it("is active only within the window after a scrollY change", () => {
    const a = new ScrollActivity(150);
    expect(a.update(0, 0)).toBe(false); // first reading: no change yet
    expect(a.update(0, 16)).toBe(false);
    expect(a.update(10, 33)).toBe(true); // changed this tick
    expect(a.update(10, 50)).toBe(true);
    expect(a.update(10, 183)).toBe(true); // exactly 150 ms after the change
    expect(a.update(10, 200)).toBe(false); // idle
    expect(a.update(5, 216)).toBe(true); // scrolling back counts too
  });

  it("reset forgets earlier changes but keeps comparing against the last scrollY", () => {
    const a = new ScrollActivity(150);
    a.update(0, 0);
    expect(a.update(100, 16)).toBe(true);
    a.reset();
    expect(a.update(100, 33)).toBe(false); // same scrollY as before the reset
    expect(a.update(120, 50)).toBe(true);
  });
});

describe("TargetLatency", () => {
  it("measures ticks from first request of a frame to it being drawn", () => {
    const l = new TargetLatency();
    l.observe(0, 0, 0); // ready on the same tick
    l.observe(5, 0, 100); // asked for 5, still showing 0
    l.observe(5, 0, 116);
    l.observe(5, 5, 133); // drawn 33 ms later
    l.observe(5, 5, 150); // already measured: no second sample
    const s = l.summary();
    expect(s.samples).toBe(2);
    expect(s.max).toBe(33);
    expect(s.p50).toBeCloseTo(16.5);
    expect(s.byFrameMax).toEqual({ 0: 0, 5: 33 });
    expect(s.superseded).toBe(0);
  });

  it("counts targets replaced before they were drawn and keeps the worst per frame", () => {
    const l = new TargetLatency();
    l.observe(1, null, 0);
    l.observe(2, null, 16); // 1 superseded
    l.observe(2, 2, 32); // 16 ms
    l.observe(16, 2, 48);
    l.observe(16, 16, 248); // chunk-boundary stall: 200 ms
    l.observe(2, 2, 264); // 0 ms (frame 2 worst stays 16)
    const s = l.summary();
    expect(s.superseded).toBe(1);
    expect(s.byFrameMax).toEqual({ 2: 16, 16: 200 });
    expect(s.p95).toBeGreaterThan(100);
  });

  it("invalidate restarts the clock for the current target (variant switch)", () => {
    const l = new TargetLatency();
    l.observe(30, 30, 0);
    l.invalidate(1000);
    l.observe(30, null, 1016); // old variant no longer counts as drawn
    l.observe(30, 30, 1100);
    expect(l.summary().byFrameMax[30]).toBe(100);
  });

  it("reset clears samples and does not measure a half-finished target", () => {
    const l = new TargetLatency();
    l.observe(3, null, 0);
    l.reset();
    l.observe(3, 3, 500);
    let s = l.summary();
    expect(s.samples).toBe(0);
    expect(s.superseded).toBe(0);
    expect(s.max).toBeNaN();
    l.observe(4, 4, 516);
    s = l.summary();
    expect(s.samples).toBe(1);
  });
});
