// THROWAWAY — Story 0.5 spike player addition. Not production code; delete after Epic 0.
//
// Scrub-only measurements for the device test: which rAF intervals happened
// while the page was actively scrolling, and how long a newly targeted frame
// takes to reach the screen. Pure (no DOM), unit-tested.

import { median, percentile, RollingSamples } from "./stats.ts";

/** An rAF interval counts as "active scrub" when scrollY changed within this window. */
export const ACTIVE_WINDOW_MS = 150;

/**
 * Tracks scroll activity from one scrollY reading per rAF tick. `update`
 * returns true when the interval ending at `ts` is part of an active scrub
 * (scrollY changed at most `windowMs` before `ts`, including this tick).
 */
export class ScrollActivity {
  private lastY: number | null = null;
  private lastChangeTs = -Infinity;

  constructor(public readonly windowMs = ACTIVE_WINDOW_MS) {}

  update(scrollY: number, ts: number): boolean {
    if (this.lastY !== null && scrollY !== this.lastY) this.lastChangeTs = ts;
    this.lastY = scrollY;
    return ts - this.lastChangeTs <= this.windowMs;
  }

  /** Forget earlier scroll changes (keeps the last scrollY so the next tick compares correctly). */
  reset(): void {
    this.lastChangeTs = -Infinity;
  }
}

export interface LatencySummary {
  p50: number;
  p95: number;
  max: number;
  samples: number;
  /** Targets that were replaced by a newer target before they were drawn. */
  superseded: number;
  /** Worst latency per target frame index (ms). */
  byFrameMax: Record<number, number>;
}

/**
 * Target -> drawn latency: from the first tick that asks for a frame to the
 * first tick on which exactly that frame (of the current variant) is on
 * screen. 0 means it was ready on the same tick.
 */
export class TargetLatency {
  private pending: { target: number; since: number; done: boolean } | null = null;
  private readonly samples: RollingSamples;
  private byFrame = new Map<number, number>();
  private superseded = 0;

  constructor(capacity = 5000) {
    this.samples = new RollingSamples(capacity);
  }

  /** Call once per tick after drawing. `drawn` is the on-screen frame of the current variant, else null. */
  observe(target: number, drawn: number | null, ts: number): void {
    if (!this.pending || this.pending.target !== target) {
      if (this.pending && !this.pending.done) this.superseded++;
      this.pending = { target, since: ts, done: false };
    }
    if (!this.pending.done && drawn === target) {
      const ms = ts - this.pending.since;
      this.samples.push(ms);
      this.byFrame.set(target, Math.max(this.byFrame.get(target) ?? 0, ms));
      this.pending.done = true;
    }
  }

  /** The current target must be drawn again (e.g. variant switch): restart its clock at `ts`. */
  invalidate(ts: number): void {
    if (this.pending) this.pending = { target: this.pending.target, since: ts, done: false };
  }

  reset(): void {
    this.samples.clear();
    this.byFrame.clear();
    this.superseded = 0;
    if (this.pending) this.pending.done = true; // do not count a half-measured target into the new window
  }

  summary(): LatencySummary {
    const v = this.samples.values();
    return {
      p50: median(v),
      p95: percentile(v, 95),
      max: v.length ? Math.max(...v) : NaN,
      samples: v.length,
      superseded: this.superseded,
      byFrameMax: Object.fromEntries(this.byFrame),
    };
  }
}
