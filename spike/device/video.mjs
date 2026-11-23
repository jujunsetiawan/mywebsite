// THROWAWAY — Story 0.5 follow-up: screen-recording analysis helpers. Not production code; delete after Epic 0.
//
// Pure functions (no I/O) used by analyze-video.mjs. A decoded video frame is a
// small grayscale image (e.g. 120 px wide). Each frame is reduced to a grid of
// CELL x CELL pixel cells holding the cell's mean luminance and the cell's mean
// absolute difference (MAD) to the previous frame. Every later question (did
// the picture change? which band stayed still? where is the content after a
// rotation?) is answered from those grids. Tested on synthetic frames in
// video.test.mjs.

export const CELL = 5;

/** Even output height for a `targetW`-wide downscale of a w x h video. */
export function grayHeightFor(w, h, targetW = 120) {
  return Math.max(2, 2 * Math.round((targetW * h) / w / 2));
}

/** Grid shape for a width x height gray frame. Partial edge cells are ignored. */
export function gridShape(width, height, cell = CELL) {
  return { gx: Math.floor(width / cell), gy: Math.floor(height / cell), cell };
}

/**
 * One frame -> { lum: Uint8Array(gx*gy), mad: Float32Array(gx*gy) } (row-major
 * cells). `prev` is the previous frame's pixels (or null: mad all 0).
 */
export function frameCells(cur, prev, width, height, cell = CELL) {
  const { gx, gy } = gridShape(width, height, cell);
  const lum = new Uint8Array(gx * gy);
  const mad = new Float32Array(gx * gy);
  const n = cell * cell;
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      let s = 0;
      let d = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        const row = y * width;
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          const v = cur[row + x];
          s += v;
          if (prev) d += Math.abs(v - prev[row + x]);
        }
      }
      lum[cy * gx + cx] = Math.round(s / n);
      mad[cy * gx + cx] = d / n;
    }
  }
  return { lum, mad };
}

/** A rectangle in grid cells: { x0, x1, y0, y1 } (half-open). */
export function cellRect(gx, gy, { top = 0, bottom = 0, left = 0, right = 0 } = {}) {
  return { x0: Math.floor(gx * left), x1: Math.ceil(gx * (1 - right)), y0: Math.floor(gy * top), y1: Math.ceil(gy * (1 - bottom)) };
}

/** Mean of `mad` cells inside `rect`. */
export function rectMean(values, gx, rect) {
  let s = 0;
  let n = 0;
  for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) { s += values[y * gx + x]; n++; }
  return n ? s / n : 0;
}

/**
 * Bands across the content: axis "y" = horizontal stripes stacked top->bottom
 * (one per cell row), axis "x" = vertical stripes left->right (for content
 * that appears rotated in the recording). Returns the mean MAD per band.
 */
export function bandMeans(mad, gx, rect, axis = "y") {
  const out = [];
  if (axis === "y") {
    for (let y = rect.y0; y < rect.y1; y++) {
      let s = 0;
      for (let x = rect.x0; x < rect.x1; x++) s += mad[y * gx + x];
      out.push(s / (rect.x1 - rect.x0));
    }
  } else {
    for (let x = rect.x0; x < rect.x1; x++) {
      let s = 0;
      for (let y = rect.y0; y < rect.y1; y++) s += mad[y * gx + x];
      out.push(s / (rect.y1 - rect.y0));
    }
  }
  return out;
}

const median = (v) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

export const TEAR_DEFAULTS = { staticMax: 0.5, strongMin: 2.0, strongShare: 0.8, minFrac: 0.15 };

/**
 * Tearing heuristic for one changed frame. A whole-frame camera move changes
 * every band; a torn frame shows a contiguous run of bands that stayed
 * (essentially) unchanged while the rest changed strongly. Flags when the
 * longest run of bands with MAD < staticMax covers >= minFrac of the bands AND
 * the bands outside the run have median >= strongMin with >= strongShare of
 * them above 2 x staticMax.
 */
export function detectTear(bands, opts = {}) {
  const o = { ...TEAR_DEFAULTS, ...opts };
  let best = { start: -1, end: -1 };
  let start = -1;
  for (let i = 0; i <= bands.length; i++) {
    const still = i < bands.length && bands[i] < o.staticMax;
    if (still && start < 0) start = i;
    if (!still && start >= 0) {
      if (i - start > best.end - best.start) best = { start, end: i };
      start = -1;
    }
  }
  const runLen = best.end - best.start;
  const frac = bands.length ? runLen / bands.length : 0;
  const others = bands.filter((_, i) => i < best.start || i >= best.end);
  const othersMedian = median(others);
  const strongShare = others.length ? others.filter((v) => v > 2 * o.staticMax).length / others.length : 0;
  const tear = runLen > 0 && frac >= o.minFrac && others.length > 0 && othersMedian >= o.strongMin && strongShare >= o.strongShare;
  return { tear, stillBand: runLen > 0 ? { start: best.start, end: best.end, frac: Math.round(frac * 1000) / 1000 } : null, othersMedian: Number.isFinite(othersMedian) ? Math.round(othersMedian * 100) / 100 : null, strongShare: Math.round(strongShare * 100) / 100 };
}

/** Cell indices of bands [start, end) along `axis` inside `rect`. */
function bandCells(gx, rect, axis, start, end) {
  const out = [];
  if (axis === "y") for (let y = rect.y0 + start; y < rect.y0 + end; y++) for (let x = rect.x0; x < rect.x1; x++) out.push(y * gx + x);
  else for (let x = rect.x0 + start; x < rect.x0 + end; x++) for (let y = rect.y0; y < rect.y1; y++) out.push(y * gx + x);
  return out;
}

export const CONFIRM_DEFAULTS = { minTexture: 4, catchUpMin: 2.0 };

/**
 * Second stage for a raw tear candidate (detectTear found a still band):
 * - texture: mean abs deviation of the still band's cell luminance in the
 *   previous frame. A flat area (a lit monitor face, a smooth ceiling) shows
 *   almost no difference when it moves, so a still band without texture is
 *   no evidence of tearing.
 * - catchUp: mean MAD of the still band in the NEXT frame. A torn frame is
 *   transient: the next frame delivers the part that was missing, so the band
 *   changes strongly then. A static region stays still.
 * Confirmed tearing needs both.
 */
export function confirmTear({ stillBand, lumPrev, madNext, gx, rect, axis }, opts = {}) {
  const o = { ...CONFIRM_DEFAULTS, ...opts };
  const cells = bandCells(gx, rect, axis, stillBand.start, stillBand.end);
  const lum = cells.map((k) => lumPrev[k]);
  const mean = lum.reduce((a, v) => a + v, 0) / lum.length;
  const texture = lum.reduce((a, v) => a + Math.abs(v - mean), 0) / lum.length;
  const catchUp = madNext ? cells.reduce((a, k) => a + madNext[k], 0) / cells.length : null;
  const confirmed = texture >= o.minTexture && catchUp != null && catchUp >= o.catchUpMin;
  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  return { confirmed, texture: r2(texture), catchUp: r2(catchUp), reason: confirmed ? "textured still band that catches up in the next frame" : texture < o.minTexture ? "still band is flat (no texture to show motion)" : "still band stays still in the next frame (static content)" };
}

/**
 * Align driver wall-clock marks (ms since the recorder started) with video
 * time. The driver flips the blank page black then white at `syncMs[0]`,
 * `syncMs[1]`; each flip is a near-full-screen change (MAD >= bigMad). Picks
 * the pair of big changes whose spacing best matches the marks' spacing
 * (within `toleranceS`; ties -> earliest) and returns offsetS so that
 * videoT = ms/1000 + offsetS.
 */
export function findSyncOffset(frames, syncMs, { bigMad = 60, toleranceS = 0.1 } = {}) {
  const big = frames.filter((f) => f.mad >= bigMad).map((f) => f.t);
  const want = (syncMs[1] - syncMs[0]) / 1000;
  let best = null;
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length && big[j] - big[i] <= want + toleranceS; j++) {
      const err = Math.abs(big[j] - big[i] - want);
      if (err <= toleranceS && (!best || err < best.err - 1e-9)) best = { i, j, err };
    }
  }
  if (!best) return null;
  const o1 = big[best.i] - syncMs[0] / 1000;
  const o2 = big[best.j] - syncMs[1] / 1000;
  return { offsetS: (o1 + o2) / 2, events: [big[best.i], big[best.j]], residualMs: Math.round(Math.abs(o1 - o2) * 1000) };
}

/**
 * Active-scrolling spans of one phase: for each gesture, from the first
 * visible change at/after the gesture start to the last visible change before
 * the next gesture starts (or the phase ends). This counts the touch and any
 * fling, and excludes the driver's dead time between gestures. Times in s.
 */
export function activeSpans(changeTimes, gestures, phaseEnd) {
  const spans = [];
  for (let k = 0; k < gestures.length; k++) {
    const from = gestures[k].start;
    const to = k + 1 < gestures.length ? gestures[k + 1].start : phaseEnd;
    const inside = changeTimes.filter((t) => t >= from && t < to);
    if (inside.length >= 2) spans.push({ start: inside[0], end: inside[inside.length - 1], changes: inside.length });
  }
  return spans;
}

/**
 * New-frame rate and gaps inside active spans. rate = intervals between
 * consecutive visible changes per second of active span time; gaps are those
 * intervals.
 */
export function spanStats(changeTimes, spans, gapMs = 50) {
  const gaps = [];
  let seconds = 0;
  let changes = 0;
  let longestAt = null;
  let longest = -1;
  for (const s of spans) {
    seconds += s.end - s.start;
    const inside = changeTimes.filter((t) => t >= s.start && t <= s.end);
    changes += inside.length;
    for (let i = 1; i < inside.length; i++) {
      const g = (inside[i] - inside[i - 1]) * 1000;
      gaps.push(g);
      if (g > longest) {
        longest = g;
        longestAt = inside[i - 1];
      }
    }
  }
  const r = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
  return {
    activeSeconds: r(seconds, 3),
    visibleChanges: changes,
    // intervals per second (n changes in a span = n - 1 intervals)
    newFrameRate: seconds > 0 ? r(gaps.length / seconds) : null,
    longestNoChangeMs: gaps.length ? r(Math.max(...gaps)) : null,
    /** video time (s) of the last change before the longest gap */
    longestNoChangeAtS: longestAt == null ? null : r(longestAt, 3),
    medianGapMs: r(median(gaps)),
    gapsOver50ms: gaps.filter((g) => g > gapMs).length,
    gaps: gaps.length,
  };
}

/**
 * Content area of a landscape phase inside the portrait-shaped recording:
 * cells whose maximum luminance over the phase exceeds `blackMax` (the
 * letterbox is pure black). Returns the bounding cell rect and the band axis:
 * a wide box = upright, letterboxed content (bands along y); a box filling
 * the frame = content rotated by 90 deg (bands along x).
 */
export function contentBox(maxLum, gx, gy, { blackMax = 12 } = {}) {
  let x0 = gx, x1 = 0, y0 = gy, y1 = 0;
  for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) if (maxLum[y * gx + x] > blackMax) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
  if (x1 <= x0 || y1 <= y0) return null;
  const rect = { x0, x1, y0, y1 };
  const wide = x1 - x0 > y1 - y0;
  return { rect, axis: wide ? "y" : "x", letterboxed: wide };
}

/** Shrink a cell rect by `frac` at both ends of the band axis (system bars). */
export function trimAxis(rect, axis, frac) {
  if (axis === "y") {
    const d = Math.round((rect.y1 - rect.y0) * frac);
    return { ...rect, y0: rect.y0 + d, y1: rect.y1 - d };
  }
  const d = Math.round((rect.x1 - rect.x0) * frac);
  return { ...rect, x0: rect.x0 + d, x1: rect.x1 - d };
}
