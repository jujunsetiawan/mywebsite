// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Decoded-frame cache bounded in bytes. When over the limit it evicts the
// entry farthest from the playhead first and hands it to `dispose` (the
// player calls ImageBitmap.close()). Pure: no DOM.

export interface CacheEntry<V> {
  value: V;
  bytes: number;
}

export const DEFAULT_CACHE_MB = 150;

/** Parse `?cacheMB=`; invalid/absent => default. */
export function parseCacheMB(value: string | null | undefined, fallback = DEFAULT_CACHE_MB): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class FrameCache<V> {
  private readonly entries = new Map<number, CacheEntry<V>>();
  private total = 0;

  constructor(
    public limitBytes: number,
    private readonly dispose: (value: V, index: number) => void,
  ) {}

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  has(index: number): boolean {
    return this.entries.has(index);
  }

  get(index: number): V | undefined {
    return this.entries.get(index)?.value;
  }

  keys(): number[] {
    return [...this.entries.keys()];
  }

  /**
   * Insert (replacing and disposing any previous value at `index`), then
   * evict farthest-from-`playhead` entries until within the limit. `pinned`
   * indexes are never evicted (e.g. the frame currently on screen).
   * Returns the evicted indexes in eviction order.
   */
  set(index: number, value: V, bytes: number, playhead: number, pinned: readonly number[] = []): number[] {
    const prev = this.entries.get(index);
    if (prev) {
      this.total -= prev.bytes;
      if (prev.value !== value) this.dispose(prev.value, index);
    }
    this.entries.set(index, { value, bytes });
    this.total += bytes;
    return this.evict(playhead, pinned);
  }

  /** Evict farthest-from-playhead entries while over the limit. */
  evict(playhead: number, pinned: readonly number[] = []): number[] {
    const evicted: number[] = [];
    while (this.total > this.limitBytes) {
      let victim: number | null = null;
      let worst = -1;
      for (const idx of this.entries.keys()) {
        if (pinned.includes(idx)) continue;
        const d = Math.abs(idx - playhead);
        // Tie-break: evict the higher index (arbitrary but deterministic).
        if (d > worst || (d === worst && victim !== null && idx > victim)) {
          worst = d;
          victim = idx;
        }
      }
      if (victim === null) break; // only pinned entries left
      this.delete(victim);
      evicted.push(victim);
    }
    return evicted;
  }

  delete(index: number): boolean {
    const e = this.entries.get(index);
    if (!e) return false;
    this.entries.delete(index);
    this.total -= e.bytes;
    this.dispose(e.value, index);
    return true;
  }

  /** Dispose everything (variant/tier switch). */
  clear(): void {
    for (const idx of [...this.entries.keys()]) this.delete(idx);
  }
}
