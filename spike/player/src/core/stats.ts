// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Small statistics helpers for the perf HUD. Pure functions.

/**
 * Percentile with linear interpolation between closest ranks
 * (p in [0, 100]). Empty input => NaN.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (rank - lo);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

/** Instantaneous fps per frame interval (ms). Non-positive intervals are skipped. */
export function fpsFromIntervals(intervalsMs: readonly number[]): number[] {
  return intervalsMs.filter((d) => d > 0).map((d) => 1000 / d);
}

/** Fixed-capacity ring of recent samples. */
export class RollingSamples {
  private readonly buf: number[] = [];
  private next = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new RangeError("capacity must be positive");
  }

  push(v: number): void {
    if (this.buf.length < this.capacity) this.buf.push(v);
    else this.buf[this.next] = v;
    this.next = (this.next + 1) % this.capacity;
  }

  values(): number[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
    this.next = 0;
  }
}

export interface FpsSummary {
  fpsMedian: number;
  fpsP5: number;
  frameMsMedian: number;
  frameMsP95: number;
}

/** fps median / p5 (the slow tail) and frame-interval median / p95 from rAF intervals. */
export function summarizeFrames(intervalsMs: readonly number[]): FpsSummary {
  const fps = fpsFromIntervals(intervalsMs);
  return {
    fpsMedian: median(fps),
    fpsP5: percentile(fps, 5),
    frameMsMedian: median(intervalsMs),
    frameMsP95: percentile(intervalsMs, 95),
  };
}
