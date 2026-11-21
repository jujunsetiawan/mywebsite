// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_MB, FrameCache, parseCacheMB } from "./cache.ts";

function bitmapLike(id: number) {
  return { id, closed: false, close() { this.closed = true; } };
}
type B = ReturnType<typeof bitmapLike>;

function makeCache(limit: number) {
  const disposed: number[] = [];
  const cache = new FrameCache<B>(limit, (v, idx) => {
    v.close();
    disposed.push(idx);
  });
  return { cache, disposed };
}

describe("matrix: cache full", () => {
  it("evicts the farthest-from-playhead frames first and closes them", () => {
    const { cache, disposed } = makeCache(100);
    const bmps = new Map<number, B>();
    for (const i of [10, 11, 12, 13, 14]) {
      const b = bitmapLike(i);
      bmps.set(i, b);
      cache.set(i, b, 20, 12);
    }
    expect(cache.bytes).toBe(100);
    expect(disposed).toEqual([]);

    // A far frame (d=8) inserted over the limit is itself the farthest => evicted alone.
    expect(cache.set(20, bitmapLike(20), 40, 12)).toEqual([20]);
    expect(cache.bytes).toBe(100);

    // Insert 15 (40 B) with the playhead at 13: 140 B > 100 B. Farthest is 10 (d=3),
    // then 11 and 15 tie at d=2 -> the higher index (15) goes.
    const evicted = cache.set(15, bitmapLike(15), 40, 13);
    expect(evicted).toEqual([10, 15]);
    expect(cache.bytes).toBeLessThanOrEqual(100);
    expect(bmps.get(10)!.closed).toBe(true);
    expect(bmps.get(12)!.closed).toBe(false);
    expect(bmps.get(13)!.closed).toBe(false);
  });

  it("drops frames behind a moving playhead", () => {
    const { cache } = makeCache(60);
    cache.set(0, bitmapLike(0), 20, 0);
    cache.set(1, bitmapLike(1), 20, 1);
    cache.set(2, bitmapLike(2), 20, 2);
    cache.set(3, bitmapLike(3), 20, 3);
    expect(cache.keys().sort()).toEqual([1, 2, 3]);
  });

  it("never evicts pinned frames", () => {
    const { cache } = makeCache(40);
    cache.set(0, bitmapLike(0), 20, 0);
    cache.set(50, bitmapLike(50), 20, 50, [0]);
    cache.set(51, bitmapLike(51), 20, 50, [0]);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(51)).toBe(false); // was the only non-pinned candidate with max distance? 50 d=0, 51 d=1
    expect(cache.has(50)).toBe(true);
  });

  it("stops when only pinned entries remain", () => {
    const { cache } = makeCache(10);
    cache.set(0, bitmapLike(0), 20, 0, [0]);
    expect(cache.has(0)).toBe(true);
    expect(cache.bytes).toBe(20);
  });

  it("replacing an index disposes the old value and keeps byte accounting right", () => {
    const { cache, disposed } = makeCache(100);
    const a = bitmapLike(1);
    cache.set(1, a, 30, 1);
    cache.set(1, bitmapLike(1), 10, 1);
    expect(a.closed).toBe(true);
    expect(disposed).toEqual([1]);
    expect(cache.bytes).toBe(10);
  });

  it("clear() closes everything", () => {
    const { cache } = makeCache(100);
    const a = bitmapLike(1), b = bitmapLike(2);
    cache.set(1, a, 10, 0);
    cache.set(2, b, 10, 0);
    cache.clear();
    expect([a.closed, b.closed, cache.size, cache.bytes]).toEqual([true, true, 0, 0]);
  });
});

describe("?cacheMB=", () => {
  it("defaults to 150 MB and accepts positive numbers", () => {
    expect(DEFAULT_CACHE_MB).toBe(150);
    expect(parseCacheMB(null)).toBe(150);
    expect(parseCacheMB("")).toBe(150);
    expect(parseCacheMB("64")).toBe(64);
    expect(parseCacheMB("-5")).toBe(150);
    expect(parseCacheMB("abc")).toBe(150);
  });
});
