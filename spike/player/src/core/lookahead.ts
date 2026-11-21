// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Look-ahead planning around the playhead. Pure functions.

/** How many decoded frames fit in the cache, leaving headroom for in-flight decodes + the pinned frame. */
export function windowFrames(limitBytes: number, frameBytes: number, frameCount: number, headroom = 3): number {
  if (frameBytes <= 0) return frameCount;
  return Math.max(1, Math.min(frameCount, Math.floor(limitBytes / frameBytes) - headroom));
}

/**
 * Frame indexes to keep decoded, in priority order: the playhead first, then
 * frames on both sides, biased ~3:1 towards the scroll direction
 * (`direction` >= 0 means forward). At most `count` indexes, all in range.
 */
export function lookaheadOrder(playhead: number, direction: number, frameCount: number, count: number): number[] {
  const out: number[] = [];
  if (frameCount <= 0 || count <= 0) return out;
  const p = Math.min(frameCount - 1, Math.max(0, playhead));
  const step = direction < 0 ? -1 : 1;
  out.push(p);
  let ahead = 1;
  let behind = 1;
  let tick = 0;
  while (out.length < count) {
    const a = p + step * ahead;
    const b = p - step * behind;
    const aOk = a >= 0 && a < frameCount;
    const bOk = b >= 0 && b < frameCount;
    if (!aOk && !bOk) break;
    // Three ahead for every one behind.
    const takeAhead = aOk && (!bOk || tick % 4 !== 3);
    if (takeAhead) {
      out.push(a);
      ahead++;
    } else {
      out.push(b);
      behind++;
    }
    tick++;
  }
  return out;
}

/** Chunk indexes needed for a set of frames (chunk = floor(frame / chunkSize)), first-seen order. */
export function chunksFor(frames: readonly number[], chunkSize: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const f of frames) {
    const c = Math.floor(f / chunkSize);
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}
