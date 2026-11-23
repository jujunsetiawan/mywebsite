// THROWAWAY — Story 0.5 follow-up tests (synthetic frames). Not production code; delete after Epic 0.
// Run: node --test spike/device/video.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSpans, bandMeans, cellRect, confirmTear, contentBox, detectTear, findSyncOffset, frameCells, grayHeightFor, gridShape, rectMean, spanStats, trimAxis } from "./video.mjs";

const W = 40;
const H = 60; // 8 x 12 cells of 5 px

/** Synthetic frame: a diagonal gradient shifted by `shift` px (a "camera move"). */
function gradient(shift, w = W, h = H) {
  const f = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = ((x + y + shift) * 9) & 255;
  return f;
}

/** `b` for rows < tearRow, `a` below: the lower part still shows the old frame (torn). */
function torn(a, b, tearRow, w = W) {
  const f = new Uint8Array(a);
  f.set(b.subarray(0, tearRow * w), 0);
  return f;
}

test("grid shape and cells: lum and mad per 5x5 cell", () => {
  assert.equal(grayHeightFor(1280, 2772), 260);
  assert.equal(grayHeightFor(2772, 1280), 56);
  assert.deepEqual(gridShape(W, H), { gx: 8, gy: 12, cell: 5 });
  const flat = new Uint8Array(W * H).fill(100);
  const brighter = new Uint8Array(W * H).fill(110);
  const { lum, mad } = frameCells(brighter, flat, W, H);
  assert.equal(lum.length, 96);
  assert.ok(lum.every((v) => v === 110));
  assert.ok(mad.every((v) => v === 10));
  assert.ok(frameCells(flat, null, W, H).mad.every((v) => v === 0));
});

test("whole-frame camera move: every band changes, no tear", () => {
  const { mad } = frameCells(gradient(3), gradient(0), W, H);
  const rect = cellRect(8, 12);
  assert.ok(rectMean(mad, 8, rect) > 5);
  const bands = bandMeans(mad, 8, rect, "y");
  assert.equal(bands.length, 12);
  const r = detectTear(bands);
  assert.equal(r.tear, false);
  assert.equal(r.stillBand, null);
});

test("torn frame: lower 40 % unchanged while the rest moves -> tear", () => {
  const prev = gradient(0);
  const next = gradient(3);
  const { mad } = frameCells(torn(prev, next, 36), prev, W, H); // rows 36..59 = old frame
  const r = detectTear(bandMeans(mad, 8, cellRect(8, 12), "y"));
  assert.equal(r.tear, true);
  // cell row 7 (y 35..39) still has one new pixel row, so the still run is rows 8..11
  assert.deepEqual([r.stillBand.start, r.stillBand.end], [8, 12]);
  assert.equal(r.stillBand.frac, 0.333);
});

test("small static band (< 15 %) or a weakly changing rest is not a tear", () => {
  const prev = gradient(0);
  const next = gradient(3);
  const { mad } = frameCells(torn(prev, next, 55), prev, W, H); // 1 of 12 bands still (8 %)
  assert.equal(detectTear(bandMeans(mad, 8, cellRect(8, 12), "y")).tear, false);
  // nearly static camera (slow push at the end of the shot): everything changes a little
  const weak = Array(12).fill(0.8);
  weak[10] = weak[11] = weak[9] = 0.1;
  assert.equal(detectTear(weak).tear, false);
});

test("confirmTear: a transient torn band is confirmed; flat or persistently still bands are content", () => {
  const prev = gradient(0);
  const next = gradient(3);
  const tornFrame = torn(prev, next, 36);
  const rect = cellRect(8, 12);
  const cand = detectTear(bandMeans(frameCells(tornFrame, prev, W, H).mad, 8, rect, "y"));
  assert.equal(cand.tear, true);
  const base = { stillBand: cand.stillBand, lumPrev: frameCells(prev, null, W, H).lum, gx: 8, rect, axis: "y" };
  // the frame after the torn one completes the move: the still band changes strongly then
  const caughtUp = confirmTear({ ...base, madNext: frameCells(next, tornFrame, W, H).mad });
  assert.equal(caughtUp.confirmed, true, JSON.stringify(caughtUp));
  // static content: the band stays still in the next frame too
  const still = confirmTear({ ...base, madNext: new Float32Array(96) });
  assert.equal(still.confirmed, false);
  assert.match(still.reason, /stays still/);
  // flat region (e.g. a lit monitor face): no texture, so its stillness proves nothing
  const flatPrev = new Uint8Array(prev);
  flatPrev.fill(200, 36 * W);
  const flat = confirmTear({ ...base, lumPrev: frameCells(flatPrev, null, W, H).lum, madNext: frameCells(next, tornFrame, W, H).mad });
  assert.equal(flat.confirmed, false);
  assert.match(flat.reason, /flat/);
});

test("rotated content: bands along x find a torn column block", () => {
  const prev = gradient(0);
  const next = gradient(3);
  const f = new Uint8Array(next);
  for (let y = 0; y < H; y++) for (let x = 25; x < W; x++) f[y * W + x] = prev[y * W + x]; // right 3 of 8 columns old
  const { mad } = frameCells(f, prev, W, H);
  const r = detectTear(bandMeans(mad, 8, cellRect(8, 12), "x"));
  assert.equal(r.tear, true);
  assert.deepEqual([r.stillBand.start, r.stillBand.end], [5, 8]);
});

test("landscape content box: letterboxed wide content vs rotated full content", () => {
  const gx = 8, gy = 12;
  const lb = new Uint8Array(gx * gy);
  for (let y = 4; y < 8; y++) for (let x = 0; x < gx; x++) lb[y * gx + x] = 60; // wide band in the middle
  assert.deepEqual(contentBox(lb, gx, gy), { rect: { x0: 0, x1: 8, y0: 4, y1: 8 }, axis: "y", letterboxed: true });
  const full = new Uint8Array(gx * gy).fill(60);
  assert.equal(contentBox(full, gx, gy).axis, "x");
  assert.equal(contentBox(new Uint8Array(gx * gy), gx, gy), null);
  assert.deepEqual(trimAxis({ x0: 0, x1: 8, y0: 0, y1: 20 }, "y", 0.1), { x0: 0, x1: 8, y0: 2, y1: 18 });
});

test("sync: two flips matched by spacing give the wall->video offset", () => {
  // marks at 1000 ms and 1700 ms; video shows the flips at 1.33 s and 2.04 s, plus a tab
  // switch at 0.6 s (0.73 s before the first flip: close to 0.7 but worse than the real pair).
  const frames = [{ t: 0, mad: 0 }, { t: 0.6, mad: 80 }, { t: 1.33, mad: 190 }, { t: 1.5, mad: 3 }, { t: 2.04, mad: 185 }, { t: 3, mad: 70 }];
  const s = findSyncOffset(frames, [1000, 1700]);
  assert.ok(Math.abs(s.offsetS - 0.335) < 1e-9);
  assert.deepEqual(s.events, [1.33, 2.04]);
  assert.equal(s.residualMs, 10);
  assert.equal(findSyncOffset([{ t: 1, mad: 200 }], [0, 700]), null);
});

test("active spans skip dead time between gestures; gaps and rate inside spans", () => {
  // gesture 1 at 0 s: changes every 40 ms from 0.2 to 0.6 s, then a 400 ms stall, then 1.0 s;
  // driver pause; gesture 2 at 2.0 s: changes at 2.3, 2.316, 2.333.
  const changes = [0.2, 0.24, 0.28, 0.32, 0.36, 0.4, 0.44, 0.48, 0.52, 0.56, 0.6, 1.0, 2.3, 2.316, 2.333];
  const spans = activeSpans(changes, [{ start: 0 }, { start: 2 }], 3);
  assert.deepEqual(spans.map((s) => [s.start, s.end, s.changes]), [[0.2, 1.0, 12], [2.3, 2.333, 3]]);
  const st = spanStats(changes, spans);
  assert.equal(Math.round(st.longestNoChangeMs), 400);
  assert.equal(st.longestNoChangeAtS, 0.6);
  assert.equal(st.gapsOver50ms, 1);
  assert.equal(st.gaps, 13);
  assert.equal(st.activeSeconds, 0.833);
  assert.equal(st.newFrameRate, Math.round((13 / 0.833) * 10) / 10);
  assert.equal(spanStats([], []).newFrameRate, null);
});
