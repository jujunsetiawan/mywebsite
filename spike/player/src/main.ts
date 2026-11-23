// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Scroll-scrubbed AVIF chunk player for the Story 0.3 shot:
// manifest + frame data first -> whole chunks by manifest-built URLs ->
// decode in a Worker (main-thread fallback) -> byte-bounded look-ahead cache ->
// one cover-cropped canvas + DOM monitor-quad outline -> optional perf HUD.

import { FrameCache, parseCacheMB } from "./core/cache.ts";
import { LoadError, loadFrameData, loadManifest, type FetchLike, type FrameDataShot, type Manifest, type ManifestShot } from "./core/load.ts";
import { chunksFor, lookaheadOrder, windowFrames } from "./core/lookahead.ts";
import { frameIndexFromProgress, frameToDraw, progressFromScroll, scrollForProgress, spacerHeight } from "./core/progress.ts";
import { ScrollActivity, TargetLatency } from "./core/scrub.ts";
import { median, percentile, RollingSamples, summarizeFrames } from "./core/stats.ts";
import { coverTransform, drawRect, quadToStage, type Quad } from "./core/transform.ts";
import { buildChunkUrl } from "./core/url.ts";
import { parseTierOverride, selectAspect, selectTier, type Aspect, type Tier } from "./core/variant.ts";
import { Decoder, type WorkerLike } from "./decoder.ts";

// ------------------------------------------------------------------ Config

const params = new URLSearchParams(location.search);
const HUD = params.get("hud") === "1";
const CACHE_MB = parseCacheMB(params.get("cacheMB"));
const TIER_OVERRIDE = parseTierOverride(params.get("tier"));
const MEDIA_BASE = "./media";
const MAX_INFLIGHT = 2;
const RESIZE_END_MS = 200;

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// ------------------------------------------------------------------ DOM

const stageEl = document.getElementById("stage") as HTMLDivElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
const polygon = document.querySelector("#outline polygon") as SVGPolygonElement;
const spacerEl = document.getElementById("spacer") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;

function showError(msg: string): void {
  errorEl.hidden = false;
  errorEl.textContent = msg;
  console.warn(`[player] ${msg}`);
}

// ------------------------------------------------------------------ Network accounting

const net = { requests: 0, bytes: 0 };

const fetchJsonCounted: FetchLike = async (url) => {
  net.requests++;
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    json: async () => {
      const buf = await res.arrayBuffer();
      net.bytes += buf.byteLength;
      return JSON.parse(new TextDecoder().decode(buf)) as unknown;
    },
  };
};

async function fetchChunk(url: string): Promise<ArrayBuffer> {
  net.requests++;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  net.bytes += buf.byteLength;
  return buf;
}

// ------------------------------------------------------------------ State

let manifest: Manifest | null = null;
let shot: ManifestShot | null = null;
const frameDataByAspect = new Map<Aspect, Promise<FrameDataShot>>();

let aspect: Aspect | null = null;
let tier: Tier | null = null;
let frames: FrameDataShot | null = null;
let tierSize: { width: number; height: number } = { width: 1, height: 1 };
/** Bumped on every variant/tier switch; stale decodes are dropped. */
let gen = 0;

let stageW = 1;
let stageH = 1;
let dpr = 1;
let spacerPx = 1;
let lastInnerW = 0;
let lastInnerH = 0;

let playhead = 0;
let direction = 1;
let lastProgress = 0;
let frozenProgress: number | null = null;
let needsRedraw = false;

/** url -> fetch promise (each chunk fetched at most once while cached). */
const chunkFetches = new Map<string, Promise<ArrayBuffer>>();
const chunkData = new Map<string, ArrayBuffer>();
let chunkBytesHeld = 0;

const inflight = new Set<number>();
const failed = new Set<number>();

interface Current {
  bitmap: ImageBitmap;
  index: number;
  gen: number;
  aspect: Aspect;
  tier: Tier;
  quad: Quad;
  /** Evicted from the cache while on screen: close when replaced. */
  orphaned: boolean;
}
let current: Current | null = null;

/**
 * Every decoded ImageBitmap that is still open (cache entries + an orphaned
 * on-screen frame + results not yet inserted). Incremented on decode arrival,
 * decremented on close().
 */
const live = { count: 0, bytes: 0, peakCount: 0, peakBytes: 0 };

function trackBitmap(bmp: ImageBitmap): void {
  live.count++;
  live.bytes += bmp.width * bmp.height * 4;
  // Story 0.5: peak since the last __spike.reset() (memory budget per phase).
  live.peakCount = Math.max(live.peakCount, live.count);
  live.peakBytes = Math.max(live.peakBytes, live.bytes);
}

function closeBitmap(bmp: ImageBitmap): void {
  live.count--;
  live.bytes -= bmp.width * bmp.height * 4; // read the size before close() zeroes it
  bmp.close();
}

const cache = new FrameCache<ImageBitmap>(CACHE_MB * 1024 * 1024, (bmp) => {
  if (current && bmp === current.bitmap) current.orphaned = true;
  else closeBitmap(bmp);
});

const decoder = new Decoder<ImageBitmap>({
  createWorker: () =>
    typeof Worker === "undefined"
      ? null
      : (new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike),
  mainDecode: (bytes, type) => createImageBitmap(new Blob([bytes], { type })),
  now: () => performance.now(),
  log: (m) => console.warn(m),
});

// Stats
const intervals = new RollingSamples(600);
const workMs = new RollingSamples(600);
const drawMs = new RollingSamples(600);
const decodeMs = new RollingSamples(300);
let missedTicks = 0;
let drawnCount = 0;
// Story 0.5 (spike-only): scrub-only fps, target->drawn latency, time to first frame.
const activity = new ScrollActivity();
const activeIntervals = new RollingSamples(20000);
const latency = new TargetLatency();
/** ms since navigation start (performance.now) when the first frame was drawn. */
let timeToFirstFrameMs: number | null = null;
/** resize/orientationchange events, and measure() calls (canvas size set), since reset. */
let resizeEvents = 0;
let canvasResizes = 0;
/** First 100 active-scrub rAF intervals > 50 ms since reset, with context (diagnostics). */
const longLog: Array<Record<string, number | null>> = [];
let decodeErrors = 0;
let chunkErrors = 0;

// ------------------------------------------------------------------ Layout

function measure(): void {
  canvasResizes++;
  stageW = Math.max(1, stageEl.clientWidth);
  stageH = Math.max(1, stageEl.clientHeight);
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(stageW * dpr));
  canvas.height = Math.max(1, Math.round(stageH * dpr));
  needsRedraw = true;
}

function measureSpacer(): void {
  spacerPx = spacerHeight(innerHeight);
  spacerEl.style.height = `${spacerPx}px`;
  lastInnerW = innerWidth;
  lastInnerH = innerHeight;
}

function readProgress(): number {
  return progressFromScroll(scrollY, spacerPx, innerHeight);
}

// ------------------------------------------------------------------ Variant

function getFrameData(a: Aspect): Promise<FrameDataShot> {
  let p = frameDataByAspect.get(a);
  if (!p) {
    p = loadFrameData(fetchJsonCounted, MEDIA_BASE, manifest!, shot!, a);
    frameDataByAspect.set(a, p);
    p.catch(() => frameDataByAspect.delete(a));
  }
  return p;
}

async function applyVariant(): Promise<void> {
  if (!shot) return;
  const a = selectAspect(stageW, stageH);
  const variant = shot.aspects.find((v) => v.aspect === a);
  if (!variant) {
    showError(`manifest has no ${a} variant`);
    return;
  }
  const t = selectTier(a, stageW, dpr, variant.tiers.map((x) => x.tier), TIER_OVERRIDE);
  if (a === aspect && t === tier && frames) return;

  const myGen = ++gen;
  aspect = a;
  tier = t;
  const entry = variant.tiers.find((x) => x.tier === t)!;
  tierSize = { width: entry.width, height: entry.height };
  frames = null;
  latency.invalidate(performance.now()); // the new variant must draw the target again
  inflight.clear();
  failed.clear();
  cache.clear(); // the on-screen bitmap survives (orphaned) until replaced

  const fd = await getFrameData(a);
  if (myGen !== gen) return;
  frames = fd;
  errorEl.hidden = true; // a later successful load clears an earlier error
}

/** applyVariant with any thrown error shown as visible error text. */
async function applyVariantSafe(): Promise<void> {
  try {
    await applyVariant();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------ Fetch + decode scheduling

function sliceFor(index: number) {
  return frames!.frames[index]!.slices.find((s) => s.tier === tier);
}

function chunkUrlFor(chunk: number): string {
  return buildChunkUrl(shot!.urlPattern, {
    mediaBase: MEDIA_BASE,
    mediaVersion: manifest!.mediaVersion,
    shotId: shot!.id,
    aspect: aspect!,
    tier: tier!,
    chunk,
  });
}

function ensureChunk(chunk: number): void {
  const url = chunkUrlFor(chunk);
  if (chunkFetches.has(url)) return;
  const p = fetchChunk(url);
  chunkFetches.set(url, p);
  p.then(
    (buf) => {
      chunkData.set(url, buf);
      chunkBytesHeld += buf.byteLength;
    },
    (e) => {
      chunkErrors++;
      console.warn(`[player] chunk fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => chunkFetches.delete(url), 2000); // allow a retry later
    },
  );
}

function pinned(): number[] {
  return current && current.gen === gen ? [current.index] : [];
}

/**
 * Admit a decode only if it would not itself be the eviction victim (prevents
 * thrash). The playhead frame is always admitted, so a tiny `?cacheMB` still draws.
 */
function canAdmit(index: number, frameBytes: number): boolean {
  if (index === playhead) return true;
  if (cache.bytes + (inflight.size + 1) * frameBytes <= cache.limitBytes) return true;
  const d = Math.abs(index - playhead);
  const pins = pinned();
  return cache.keys().some((k) => !pins.includes(k) && Math.abs(k - playhead) > d);
}

/** Skip a frame; `retry` frames become eligible again after ~2 s (same gen only). */
function markFailed(index: number, why: string, retry: boolean): void {
  const myGen = gen;
  failed.add(index);
  decodeErrors++;
  console.warn(`[player] frame ${index}: ${why}`);
  if (retry) setTimeout(() => myGen === gen && failed.delete(index), 2000);
}

function startDecode(index: number, buf: ArrayBuffer, offset: number, length: number): void {
  const myGen = gen;
  inflight.add(index);
  // One copy of the slice; the decoder transfers it to the worker as is.
  const bytes = buf.slice(offset, offset + length);
  decoder.decode(bytes, "image/avif").then(
    (r) => {
      trackBitmap(r.bitmap);
      if (myGen !== gen) {
        closeBitmap(r.bitmap);
        return;
      }
      inflight.delete(index);
      decodeMs.push(r.ms);
      // Pin the playhead frame too, so it survives a cache smaller than one frame.
      const pins = index === playhead ? [...pinned(), index] : pinned();
      cache.set(index, r.bitmap, r.bitmap.width * r.bitmap.height * 4, playhead, pins);
    },
    (e) => {
      if (myGen !== gen) return;
      inflight.delete(index);
      markFailed(index, `decode failed: ${e instanceof Error ? e.message : String(e)}`, true);
    },
  );
}

function pump(): void {
  if (!frames || !shot) return;
  const frameBytes = tierSize.width * tierSize.height * 4;
  const count = windowFrames(cache.limitBytes, frameBytes, shot.frameCount);
  const order = lookaheadOrder(playhead, direction, shot.frameCount, count);
  for (const c of chunksFor(order, shot.chunkSize)) ensureChunk(c);

  for (const i of order) {
    if (inflight.size >= MAX_INFLIGHT) break;
    if (cache.has(i) || inflight.has(i) || failed.has(i)) continue;
    const slice = sliceFor(i);
    if (!slice) continue;
    const buf = chunkData.get(chunkUrlFor(slice.chunk));
    if (!buf) continue;
    if (slice.offset + slice.length > buf.byteLength) {
      markFailed(i, `slice ${slice.offset}+${slice.length} past end of chunk ${slice.chunk} (${buf.byteLength} bytes)`, false);
      continue;
    }
    if (!canAdmit(i, frameBytes)) continue;
    startDecode(i, buf, slice.offset, slice.length);
  }
}

// ------------------------------------------------------------------ Draw

function paint(): void {
  if (!current) return;
  const t0 = performance.now();
  const bmp = current.bitmap;
  const tf = coverTransform(bmp.width, bmp.height, stageW, stageH);
  const [x, y, w, h] = drawRect(tf, dpr);
  ctx.drawImage(bmp, x, y, w, h);
  const pts = quadToStage(tf, current.quad);
  if (pts) {
    polygon.setAttribute("points", pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" "));
    polygon.style.display = "";
  } else {
    polygon.style.display = "none";
  }
  drawMs.push(performance.now() - t0);
  needsRedraw = false;
}

function show(index: number): void {
  const bitmap = cache.get(index)!;
  if (current && current.gen !== gen) lastHud = 0; // variant switched: refresh the HUD now
  if (current && current.bitmap !== bitmap && current.orphaned) closeBitmap(current.bitmap);
  current = { bitmap, index, gen, aspect: aspect!, tier: tier!, quad: (frames!.frames[index]!.quad as Quad) ?? null, orphaned: false };
  drawnCount++;
  paint();
  if (timeToFirstFrameMs === null) timeToFirstFrameMs = performance.now();
  cache.evict(playhead, pinned()); // the previous on-screen frame may now be over the limit
}

// ------------------------------------------------------------------ Loop

let lastTs = 0;
let lastHud = 0;

function tick(ts: number): void {
  requestAnimationFrame(tick);
  const t0 = performance.now();
  const active = activity.update(scrollY, ts);
  if (lastTs) {
    intervals.push(ts - lastTs);
    if (active) {
      activeIntervals.push(ts - lastTs);
      if (ts - lastTs > 50 && longLog.length < 100) {
        longLog.push({ atMs: Math.round(ts), ms: round(ts - lastTs, 1), frame: playhead, drawn: current?.index ?? null, cacheFrames: cache.size, inflight: inflight.size, scrollY: Math.round(scrollY) });
      }
    }
  }
  lastTs = ts;

  const progress = frozenProgress ?? readProgress();
  lastProgress = progress;

  if (frames && shot) {
    const target = frameIndexFromProgress(progress, shot.frameCount);
    if (target !== playhead) direction = target > playhead ? 1 : -1;
    playhead = target;
    const idx = frameToDraw(target, (i) => cache.has(i));
    const onScreen = current !== null && current.gen === gen && current.index === target;
    if (idx !== null && !onScreen) show(idx);
    else if (needsRedraw) paint();
    if (idx === null && !onScreen) missedTicks++;
    latency.observe(target, current && current.gen === gen ? current.index : null, ts);
    pump();
  } else if (needsRedraw) {
    paint();
  }

  workMs.push(performance.now() - t0);
  if (HUD && ts - lastHud > 250) {
    lastHud = ts;
    renderHud();
  }
}

// ------------------------------------------------------------------ Resize / rotation

let resizeTimer: number | undefined;
let majorPending = false;

function onResize(): void {
  resizeEvents++;
  // Phone toolbars change only the height a little while scrolling: just
  // resize the canvas, keep the spacer (no progress freeze, no jump).
  const minor = innerWidth === lastInnerW && Math.abs(innerHeight - lastInnerH) < lastInnerH * 0.25;
  if (!minor) {
    // Sticky for the whole debounce window: rotating and rotating back can end
    // on an event that looks minor, but the spacer/scroll must still be restored.
    majorPending = true;
    if (frozenProgress === null) frozenProgress = lastProgress;
  }
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void resizeEnd(), RESIZE_END_MS);
}

async function resizeEnd(): Promise<void> {
  const major = majorPending;
  majorPending = false;
  const p = frozenProgress ?? lastProgress;
  measure();
  if (major) {
    measureSpacer();
    window.scrollTo(0, scrollForProgress(p, spacerPx, innerHeight));
  }
  // Release the freeze on the next frame, after the scroll position settled.
  requestAnimationFrame(() => {
    frozenProgress = null;
  });
  await applyVariantSafe();
}

window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", onResize);

// ------------------------------------------------------------------ HUD

interface Snapshot {
  [k: string]: unknown;
}

function round(n: number, d = 1): number | null {
  return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null;
}

function snapshot(): Snapshot {
  const f = summarizeFrames(intervals.values());
  const dec = decodeMs.values();
  const draw = drawMs.values();
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const act = summarizeFrames(activeIntervals.values());
  const lat = latency.summary();
  return {
    fpsMedian: round(f.fpsMedian),
    fpsP5: round(f.fpsP5),
    frameMsMedian: round(f.frameMsMedian, 2),
    frameMsP95: round(f.frameMsP95, 2),
    // Story 0.5: only rAF intervals while scrollY changed in the last 150 ms.
    scrubFpsMedian: round(act.fpsMedian),
    scrubFpsP5: round(act.fpsP5),
    scrubFrameMsP95: round(act.frameMsP95, 2),
    scrubSamples: activeIntervals.length,
    scrubLongIntervals: (() => {
      const v = activeIntervals.values();
      return { over34ms: v.filter((x) => x > 34).length, over50ms: v.filter((x) => x > 50).length, maxMs: v.length ? round(Math.max(...v), 1) : null };
    })(),
    latencyMsP50: round(lat.p50, 1),
    latencyMsP95: round(lat.p95, 1),
    latencyMsMax: round(lat.max, 1),
    latencySamples: lat.samples,
    latencySuperseded: lat.superseded,
    latencyByFrameMax: Object.fromEntries(Object.entries(lat.byFrameMax).map(([k, v]) => [k, round(v, 1)])),
    timeToFirstFrameMs: timeToFirstFrameMs === null ? null : round(timeToFirstFrameMs, 0),
    peakLiveDecodedBitmaps: live.peakCount,
    peakLiveDecodedBytes: live.peakBytes,
    resizeEvents,
    canvasResizes,
    scrubLongLog: longLog.slice(),
    tickWorkMsP95: round(percentile(workMs.values(), 95), 2),
    drawMsP50: round(median(draw), 2),
    drawMsP95: round(percentile(draw, 95), 2),
    decodeMsP50: round(median(dec), 1),
    decodeMsP95: round(percentile(dec, 95), 1),
    decodeSamples: dec.length,
    decodedBytes: cache.bytes,
    decodedFrames: cache.size,
    cacheLimitBytes: cache.limitBytes,
    /** All open bitmaps: cache + orphaned on-screen frame + results not yet inserted. */
    liveDecodedBitmaps: live.count,
    liveDecodedBytes: live.bytes,
    inflight: inflight.size,
    chunkBytesHeld,
    memory: mem ? { usedJSHeapSize: mem.usedJSHeapSize, totalJSHeapSize: mem.totalJSHeapSize, jsHeapSizeLimit: mem.jsHeapSizeLimit } : null,
    requests: net.requests,
    requestBytes: net.bytes,
    decodePath: decoder.path,
    decodeFallbackReason: decoder.fallbackReason,
    aspect,
    tier,
    tierOverride: TIER_OVERRIDE,
    frame: playhead,
    drawnFrame: current?.index ?? null,
    drawnVariant: current ? `${current.aspect}/${current.tier}` : null,
    frameCount: shot?.frameCount ?? null,
    progress: round(lastProgress, 4),
    missedTicks,
    drawnCount,
    decodeErrors,
    chunkErrors,
    mediaVersion: manifest?.mediaVersion ?? null,
    userAgent: navigator.userAgent,
    viewport: { innerWidth, innerHeight, devicePixelRatio: dpr, stageW, stageH, canvasW: canvas.width, canvasH: canvas.height },
    at: new Date().toISOString(),
  };
}

let hudText: HTMLDivElement | null = null;
let hudFallback: HTMLTextAreaElement | null = null;

function mb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setupHud(): void {
  const hud = document.createElement("div");
  hud.id = "hud";
  hudText = document.createElement("div");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Copy results";
  btn.addEventListener("click", () => void copyResults(btn));
  hud.append(hudText, btn);
  document.body.append(hud);
}

function renderHud(): void {
  if (!hudText) return;
  const s = snapshot();
  const memo = s.memory as { usedJSHeapSize: number } | null;
  hudText.textContent = [
    `path    ${s.decodePath}${s.decodeFallbackReason ? ` (${String(s.decodeFallbackReason)})` : ""}`,
    `variant ${s.aspect} / ${s.tier}${TIER_OVERRIDE ? " (override)" : ""}`,
    `frame   ${s.frame} / ${(s.frameCount as number | null) ?? "?"}  drawn ${s.drawnFrame ?? "-"}  missed ${missedTicks}`,
    `fps     med ${s.fpsMedian ?? "-"}  p5 ${s.fpsP5 ?? "-"}`,
    `scrub   fps med ${s.scrubFpsMedian ?? "-"}  p5 ${s.scrubFpsP5 ?? "-"}  (n=${s.scrubSamples})`,
    `latency p50 ${s.latencyMsP50 ?? "-"}  p95 ${s.latencyMsP95 ?? "-"}  max ${s.latencyMsMax ?? "-"} ms  first frame ${s.timeToFirstFrameMs ?? "-"} ms`,
    `frameMs med ${s.frameMsMedian ?? "-"}  p95 ${s.frameMsP95 ?? "-"}  draw p95 ${s.drawMsP95 ?? "-"}`,
    `decode  p50 ${s.decodeMsP50 ?? "-"} ms  p95 ${s.decodeMsP95 ?? "-"} ms  (n=${s.decodeSamples})`,
    `cache   ${mb(cache.bytes)} / ${mb(cache.limitBytes)}  (${cache.size} frames)  chunks ${mb(chunkBytesHeld)}`,
    `live    ${mb(live.bytes)} decoded (${live.count} bitmaps, peak ${mb(live.peakBytes)})  inflight ${inflight.size}`,
    `heap    ${memo ? mb(memo.usedJSHeapSize) : "n/a"}`,
    `net     ${net.requests} req  ${mb(net.bytes)}`,
  ].join("\n");
}

async function copyResults(btn: HTMLButtonElement): Promise<void> {
  const text = JSON.stringify(snapshot(), null, 2);
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied ✓";
      setTimeout(() => (btn.textContent = "Copy results"), 1500);
      return;
    } catch {
      /* fall through to the select-text fallback */
    }
  }
  // Plain HTTP on the LAN has no clipboard API: show the JSON selected.
  if (!hudFallback) {
    hudFallback = document.createElement("textarea");
    hudFallback.readOnly = true;
    btn.after(hudFallback);
  }
  hudFallback.value = text;
  hudFallback.focus();
  hudFallback.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  btn.textContent = copied ? "Copied ✓ (fallback)" : "Select + copy below";
}

/**
 * Story 0.5: clear the rolling stats between test phases (fps, scrub fps,
 * frame/draw/decode times, latency, missed ticks, live-bitmap peaks).
 * Cumulative counters (requests, bytes, errors, drawn count) and the time to
 * first frame are kept; the device driver diffs them per phase.
 */
function reset(): void {
  intervals.clear();
  activeIntervals.clear();
  workMs.clear();
  drawMs.clear();
  decodeMs.clear();
  latency.reset();
  activity.reset();
  missedTicks = 0;
  resizeEvents = 0;
  canvasResizes = 0;
  longLog.length = 0;
  live.peakCount = live.count;
  live.peakBytes = live.bytes;
  lastHud = 0;
}

// Test/debug hook for the headless smoke check and the device driver.
(window as unknown as { __spike: unknown }).__spike = { snapshot, reset };

// ------------------------------------------------------------------ Boot

async function init(): Promise<void> {
  if (HUD) setupHud();
  measure();
  measureSpacer();
  try {
    const loaded = await loadManifest(fetchJsonCounted, MEDIA_BASE);
    manifest = loaded.manifest;
    shot = loaded.shot;
  } catch (e) {
    showError(e instanceof LoadError ? e.message : `Could not start: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  await applyVariantSafe();
  requestAnimationFrame(tick);
}

init().catch((e: unknown) => showError(`Could not start: ${e instanceof Error ? e.message : String(e)}`));
