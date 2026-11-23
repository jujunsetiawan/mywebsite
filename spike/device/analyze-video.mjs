// THROWAWAY — Story 0.5 follow-up: automated visual check of a recorded device run. Not production code; delete after Epic 0.
//
//   node spike/device/analyze-video.mjs <spike/results/<run>.json> [--width 120] [--samples 3] [--max-tears <n>]
//   (every tear candidate is exported unless --max-tears limits it)
//
// Input: a results JSON written by `run-device-test.mjs --record` (its
// `recording` block names the MP4 under spike/device/out/ and holds the sync
// marks, phase and gesture times in ms since the recording started).
//
// 1. ffprobe: per-frame timestamps (screenrecord is variable frame rate and
//    only emits a frame when something on screen changed).
// 2. ffmpeg: decode every frame unchanged in number (-fps_mode passthrough)
//    to a small grayscale image (default 120 px wide); each frame is reduced
//    to 5x5-px cells (mean luminance + mean abs diff to the previous frame).
// 3. Align driver time and video time with the two black/white sync flips.
// 4. Per phase: visible new frames (content-area MAD > noise threshold),
//    active-scroll spans (first..last visible change per gesture), the
//    new-frame rate, the longest interval with no visible change while
//    scrolling, gaps > 50 ms. Tearing heuristic per changed frame (a
//    contiguous still band of >= 15 % of the content height while the rest
//    changes strongly). Landscape phases: screenrecord keeps the starting
//    (portrait) frame, so the content is located from where the picture is
//    not black and the bands run along the content's own vertical axis.
// 5. Exports sample PNGs per phase and every tear candidate (previous frame,
//    frame, amplified difference) to spike/device/out/<run>/ (git-ignored),
//    and writes spike/results/<run>.video.json (small, committable).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { activeSpans, bandMeans, cellRect, CONFIRM_DEFAULTS, confirmTear, contentBox, detectTear, findSyncOffset, frameCells, grayHeightFor, gridShape, rectMean, spanStats, TEAR_DEFAULTS, trimAxis } from "./video.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const log = (m) => console.log(`[video] ${m}`);

/** Visible change: content-area MAD above this (gray levels, 0..255). */
const NOISE_MAD = 0.5;
/** Portrait crop: status bar + Chrome toolbar at the top, gesture bar at the bottom. */
const PORTRAIT_CROP = { top: 0.11, bottom: 0.03 };
/** Landscape: trim this share at both ends of the content's vertical axis (toolbar / bars). */
const LANDSCAPE_TRIM = 0.2;

function parse(argv) {
  const o = { run: null, width: 120, samples: 3, maxTears: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--width") o.width = Number(argv[++i]);
    else if (a === "--samples") o.samples = Number(argv[++i]);
    else if (a === "--max-tears") o.maxTears = Number(argv[++i]);
    else if (!o.run && !a.startsWith("--")) o.run = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.run) throw new Error("usage: node spike/device/analyze-video.mjs <results JSON> [--width 120] [--samples 3] [--max-tears <n>]");
  if (!(o.width >= 40 && o.width % 10 === 0)) throw new Error("--width must be a multiple of 10, >= 40");
  return o;
}

/** ffmpeg / ffprobe: env override, PATH, then the winget Links folder (as pipeline/lib/pack.py). */
function findTool(name) {
  const env = process.env[name.toUpperCase()];
  if (env && existsSync(env)) return env;
  const where = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (where.status === 0) return where.stdout.split(/\r?\n/)[0].trim();
  const links = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", `${name}.exe`);
  if (existsSync(links)) return links;
  throw new Error(`${name} not found (set ${name.toUpperCase()})`);
}

function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${basename(exe)} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Decode all frames to gray `w x h` and reduce each to cells; returns per-frame cells. */
function decodeCells(ffmpeg, video, w, h, expected) {
  const { gx, gy } = gridShape(w, h);
  const size = w * h;
  const lum = new Uint8Array(expected * gx * gy);
  const mad = new Float32Array(expected * gx * gy);
  return new Promise((resolveDecode, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-i", video, "-map", "0:v:0", "-fps_mode", "passthrough", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    let prev = null;
    let n = 0;
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        const cur = new Uint8Array(buf.subarray(0, size));
        buf = buf.subarray(size);
        if (n < expected) {
          const c = frameCells(cur, prev, w, h);
          lum.set(c.lum, n * gx * gy);
          mad.set(c.mad, n * gx * gy);
        }
        prev = cur;
        n++;
      }
    });
    p.on("close", (code) => (code === 0 ? resolveDecode({ gx, gy, lum, mad, decoded: n }) : reject(new Error(`ffmpeg decode failed (${code}): ${err}`))));
  });
}

function exportFrame(ffmpeg, video, t, out, width = 720) {
  run(ffmpeg, ["-v", "error", "-y", "-ss", Math.max(0, t - 0.001).toFixed(6), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`, out]);
}

function exportDiff(ffmpeg, video, t0, t1, out, width = 720) {
  // Luma difference x8 (blend on YUV would turn chroma differences green).
  run(ffmpeg, ["-v", "error", "-y", "-ss", Math.max(0, t0 - 0.001).toFixed(6), "-i", video, "-ss", Math.max(0, t1 - 0.001).toFixed(6), "-i", video, "-filter_complex", `[0:v]format=gray[a];[1:v]format=gray[b];[a][b]blend=all_mode=difference,lutyuv=y=min(val*8\\,255),scale=${width}:-2`, "-frames:v", "1", out]);
}

const rel = (p) => relative(repoRoot, p).split(sep).join("/");

async function main() {
  const o = parse(process.argv.slice(2));
  const runPath = resolve(o.run);
  const runJson = JSON.parse(readFileSync(runPath, "utf8"));
  const recording = runJson.recording;
  if (!recording?.file) throw new Error(`${o.run} has no recording (run the driver with --record)`);
  const video = resolve(repoRoot, recording.file);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const runBase = basename(runPath, ".json");
  const exportDir = join(here, "out", runBase);
  mkdirSync(exportDir, { recursive: true });

  const ffprobe = findTool("ffprobe");
  const ffmpeg = findTool("ffmpeg");
  const stream = JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "json", video])).streams[0];
  const pts = run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", video])
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => l !== "")
    .map(Number);
  if (pts.some((t) => !Number.isFinite(t))) throw new Error("ffprobe returned frames without timestamps");
  const w = o.width;
  const h = grayHeightFor(stream.width, stream.height, w);
  log(`${rel(video)}: ${stream.codec_name} ${stream.width}x${stream.height}, ${pts.length} frames over ${pts[pts.length - 1].toFixed(1)} s; decoding at ${w}x${h}`);
  const cells = await decodeCells(ffmpeg, video, w, h, pts.length);
  if (cells.decoded !== pts.length) log(`warning: decoded ${cells.decoded} frames, ffprobe listed ${pts.length}; using the first ${Math.min(cells.decoded, pts.length)}`);
  const N = Math.min(cells.decoded, pts.length);
  const { gx, gy } = cells;
  const G = gx * gy;
  const madOf = (i) => cells.mad.subarray(i * G, (i + 1) * G);
  const lumOf = (i) => cells.lum.subarray(i * G, (i + 1) * G);
  const full = cellRect(gx, gy);

  // ---- Sync: driver ms -> video s.
  const frames = Array.from({ length: N }, (_, i) => ({ t: pts[i], mad: rectMean(madOf(i), gx, full) }));
  const sync = findSyncOffset(frames, recording.sync.map((s) => s.ms));
  if (!sync) throw new Error("sync flips not found in the video (two near-full-screen changes spaced like the sync marks)");
  log(`sync: offset ${sync.offsetS.toFixed(3)} s (flips at ${sync.events.map((t) => t.toFixed(3)).join(", ")} s, residual ${sync.residualMs} ms)`);
  const toVideo = (ms) => ms / 1000 + sync.offsetS;
  const videoEnd = pts[N - 1];

  const hudPhase = Object.fromEntries(runJson.phases.map((p) => [p.phase, p]));
  const phases = [];
  const tears = [];
  const exportsList = [];

  for (const ph of recording.phases) {
    const start = toVideo(ph.startMs);
    const end = toVideo(ph.endMs);
    const idx = [];
    for (let i = 1; i < N; i++) if (pts[i] >= start && pts[i] <= end) idx.push(i);
    const out = { phase: ph.phase, kind: ph.kind, orientation: ph.orientation, videoStartS: +start.toFixed(3), videoEndS: +end.toFixed(3), recordedFrames: idx.length };
    if (start > videoEnd) {
      phases.push({ ...out, note: "after the end of the recording" });
      continue;
    }
    // Content area and band axis.
    let rect = cellRect(gx, gy, PORTRAIT_CROP);
    let axis = "y";
    let content = { rect, axis, how: "portrait: full width, top 11 % / bottom 3 % cropped (status bar, toolbar, gesture bar)" };
    if (ph.orientation === "landscape") {
      const maxLum = new Uint8Array(G);
      for (const i of idx) {
        const l = lumOf(i);
        for (let k = 0; k < G; k++) if (l[k] > maxLum[k]) maxLum[k] = l[k];
      }
      const box = contentBox(maxLum, gx, gy);
      if (box) {
        axis = box.axis;
        rect = trimAxis(box.rect, axis, LANDSCAPE_TRIM);
        content = { rect, axis, letterboxed: box.letterboxed, box: box.rect, how: `landscape: non-black content box ${box.letterboxed ? "(upright, letterboxed)" : "(rotated 90 deg)"}, ${LANDSCAPE_TRIM * 100} % trimmed at both ends of its vertical axis` };
      } else content = { rect, axis, how: "landscape: no content box found, portrait crop used" };
    } else if (ph.orientation === "transition") {
      rect = full;
      content = { rect, axis, how: "rotation animation: full frame, no tear check" };
    }
    out.content = content;

    const changed = [];
    let subThreshold = 0;
    for (const i of idx) {
      const m = rectMean(madOf(i), gx, rect);
      if (m > NOISE_MAD) changed.push({ i, t: pts[i], mad: m });
      else if (m > 0.05) subThreshold++;
    }
    out.visibleChanges = changed.length;
    /** recorded frames whose content changed, but by <= the noise threshold (e.g. near-static film frames) */
    out.subThresholdChanges = subThreshold;
    out.contentMadP50 = changed.length ? +[...changed].map((c) => c.mad).sort((a, b) => a - b)[Math.floor((changed.length - 1) / 2)].toFixed(2) : null;

    if (ph.kind === "scrub") {
      const gestures = recording.gestures.filter((g) => g.phase === ph.phase && g.swiped).map((g) => ({ start: toVideo(g.startMs), end: toVideo(g.endMs) }));
      const times = changed.map((c) => c.t);
      const spans = activeSpans(times, gestures, end);
      Object.assign(out, { gestures: gestures.length, spans: spans.length }, spanStats(times, spans));
      const hud = hudPhase[ph.phase];
      if (hud) out.hud = { scrubFpsMedian: hud.scrubFpsMedian, scrubFpsP5: hud.scrubFpsP5, scrubSamples: hud.scrubSamples, drawnFrames: hud.drawnFrames, latencySuperseded: hud.latencySuperseded, missedTicks: hud.missedTicks };
      if (hud?.drawnFrames) out.visibleChangesPerPlayerDraw = +(changed.length / hud.drawnFrames).toFixed(2);
    }

    // Tearing heuristic (not during the rotation animation): raw candidates, then
    // confirmation (textured still band that catches up in the next visible change).
    if (ph.orientation !== "transition") {
      let n = 0;
      let confirmed = 0;
      for (const [k, c] of changed.entries()) {
        const r = detectTear(bandMeans(madOf(c.i), gx, rect, axis));
        if (!r.tear) continue;
        n++;
        const next = changed[k + 1] && changed[k + 1].t - c.t <= 0.1 ? changed[k + 1] : null;
        const conf = confirmTear({ stillBand: r.stillBand, lumPrev: lumOf(c.i - 1), madNext: next ? madOf(next.i) : null, gx, rect, axis });
        if (!next && !conf.confirmed) conf.reason = conf.texture < CONFIRM_DEFAULTS.minTexture ? conf.reason : "no visible change within 100 ms after it";
        if (conf.confirmed) confirmed++;
        tears.push({ phase: ph.phase, frame: c.i, t: +c.t.toFixed(4), prevT: +pts[c.i - 1].toFixed(4), contentMad: +c.mad.toFixed(2), ...r, confirmation: conf });
      }
      out.tearCandidates = n;
      out.tearsConfirmed = confirmed;
    }

    // Sample frames: first, middle and last visible change (or the phase start).
    const picks = changed.length ? [...new Set([0, Math.floor((changed.length - 1) / 2), changed.length - 1].slice(0, o.samples))].map((k) => changed[k]) : idx.length ? [{ i: idx[0], t: pts[idx[0]] }] : [];
    out.samples = [];
    for (const [k, c] of picks.entries()) {
      const file = join(exportDir, `${ph.phase}-sample${k + 1}-t${c.t.toFixed(3)}.png`);
      exportFrame(ffmpeg, video, c.t, file, 540);
      out.samples.push(rel(file));
      exportsList.push(rel(file));
    }
    phases.push(out);
    log(`${ph.phase.padEnd(30)} ${ph.orientation.padEnd(10)} changes ${String(changed.length).padStart(4)}${out.newFrameRate != null ? `  rate ${out.newFrameRate}/s  longest ${out.longestNoChangeMs} ms  >50ms ${out.gapsOver50ms}/${out.gaps}` : ""}  tears ${out.tearCandidates ?? "-"} (confirmed ${out.tearsConfirmed ?? "-"})`);
  }

  // Tear candidate exports (worst first: largest still band).
  tears.sort((a, b) => b.stillBand.frac - a.stillBand.frac || b.othersMedian - a.othersMedian);
  for (const [k, c] of tears.slice(0, o.maxTears).entries()) {
    const stem = join(exportDir, `tear${String(k + 1).padStart(2, "0")}-${c.phase}-t${c.t.toFixed(3)}`);
    exportFrame(ffmpeg, video, c.prevT, `${stem}-a-prev.png`);
    exportFrame(ffmpeg, video, c.t, `${stem}-b-frame.png`);
    exportDiff(ffmpeg, video, c.prevT, c.t, `${stem}-c-diff.png`);
    c.exports = [`${stem}-a-prev.png`, `${stem}-b-frame.png`, `${stem}-c-diff.png`].map(rel);
    exportsList.push(...c.exports);
  }

  const summary = {
    schema: 1,
    story: "0.5",
    tool: "spike/device/analyze-video.mjs",
    run: rel(runPath),
    video: { file: recording.file, codec: stream.codec_name, width: stream.width, height: stream.height, frames: N, durationS: +videoEnd.toFixed(3), bitRate: recording.bitRate },
    analysis: { grayWidth: w, grayHeight: h, cellPx: 5, noiseMad: NOISE_MAD, portraitCrop: PORTRAIT_CROP, landscapeTrim: LANDSCAPE_TRIM, tear: TEAR_DEFAULTS, tearConfirm: CONFIRM_DEFAULTS, activeSpan: "per gesture: first..last visible change between this gesture's start and the next gesture's start (or the phase end)", newFrameRate: "intervals between visible changes per second of active span time" },
    sync: { offsetS: +sync.offsetS.toFixed(4), events: sync.events, residualMs: sync.residualMs },
    phases,
    tearCandidates: { count: tears.length, confirmed: tears.filter((t) => t.confirmation.confirmed).length, exported: Math.min(tears.length, o.maxTears), list: tears },
    exportDir: rel(exportDir),
    exports: exportsList.length,
    analysedAt: new Date().toISOString(),
  };
  const outFile = join(dirname(runPath), `${runBase}.video.json`);
  writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
  log(`summary: ${rel(outFile)}; ${exportsList.length} PNGs in ${rel(exportDir)}; tear candidates ${tears.length}, confirmed ${summary.tearCandidates.confirmed}`);
}

main().catch((e) => {
  console.error(`[video] ${e.message}`);
  process.exit(1);
});
