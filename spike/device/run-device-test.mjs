// THROWAWAY — Story 0.5 real-device test driver. Not production code; delete after Epic 0.
//
// Runs the scripted test against the Story 0.4 player served as a production
// build (`npm --prefix spike/player run build; npm --prefix spike/player run preview -- --host`):
//
//   cold load (fresh tab, HTTP cache disabled via CDP)
//   -> 3 slow forward scrubs -> 3 fast back-and-forth scrubs
//   -> rotation to the other orientation (+ one slow and one fast scrub there)
//   -> rotation back -> 10 s idle
//
// Android (default): attaches to Chrome on the phone over adb + the Chrome
// DevTools Protocol (`adb forward tcp:<port> localabstract:chrome_devtools_remote`),
// scrubs with real touch swipes (`adb shell input swipe`), rotates with
// `settings put system user_rotation` (auto-rotate off) and restores the
// original rotation settings afterwards, also on failure / Ctrl+C.
//
// Desktop (`--desktop`): the installed Microsoft Edge, headed, 1440x900
// viewport, mouse-wheel scrubs, "rotation" = viewport 1440x900 <-> 900x1440.
//
// HUD snapshots (`window.__spike.snapshot()` / `.reset()`) are read after each
// phase; results go to spike/results/<device>-<timestamp>.json (a new file per
// run, never overwritten).
//
//   node spike/device/run-device-test.mjs [--device <serial>] [--url <player url>] [--port 9333]
//   node spike/device/run-device-test.mjs --desktop [--url http://127.0.0.1:4173/?hud=1]
//
// Exit codes: 0 completed (budgets may still fail — see the JSON), 1 usage,
// 2 preview server unreachable / hard timeout, 3 device unreachable / locked /
// adb failure, 4 Chrome DevTools not reachable, 5 run failed or cleanup
// failed (rotation not restored), 130 interrupted.

import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blankDefect,
  centreCropRange,
  chunkBoundaryStalls,
  decodePng,
  createAdb,
  DEFAULTS,
  deviceInfo,
  DriverError,
  ensureChromeDevtools,
  evaluateBudgets,
  foregroundChrome,
  fullFilmEstimate,
  parseArgs,
  preflightDevice,
  readRotation,
  restoreRotation,
  rotationDefects,
  runAdb,
  setRotation,
  summarizePhase,
  timestamp,
  wakeDevice,
  withDeviceSession,
} from "./lib.mjs";

// playwright-core lives in the player's node_modules (no browser download).
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../player/package.json"));
const { chromium } = require("playwright-core");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[device] ${m}`);
const HARD_TIMEOUT_MS = 15 * 60_000;

// ------------------------------------------------------------------ Page helpers

const snap = (page) => page.evaluate(() => window.__spike.snapshot());
const resetStats = (page) => page.evaluate(() => window.__spike.reset());

async function waitFor(page, pred, timeout = 20_000, label = "condition") {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) {
    try {
      s = await snap(page);
      if (pred(s)) return s;
    } catch {
      /* page busy (e.g. mid-rotation); retry */
    }
    await sleep(60);
  }
  throw new DriverError(`timeout waiting for ${label}; last snapshot: ${JSON.stringify(s && { frame: s.frame, drawnFrame: s.drawnFrame, drawnVariant: s.drawnVariant, aspect: s.aspect, tier: s.tier })}`, 5);
}

const settled = (page, label, extra = () => true) =>
  waitFor(page, (x) => x.drawnFrame === x.frame && x.drawnVariant === `${x.aspect}/${x.tier}` && extra(x), 20_000, label);

/**
 * Channel range over the central 32x32 CSS px of a full-viewport compositor
 * screenshot; 0 means uniform (blank). Measured pitfalls on Android Chrome
 * 158 (2026-11-23), both of which broke earlier runs:
 * - canvas getImageData: two readbacks demote the 2D canvas to software
 *   rendering, after which every new frame costs ~66 ms;
 * - Page.captureScreenshot with a `clip` (also Playwright's page.screenshot)
 *   leaves an emulation override behind that makes window.scrollTo a no-op.
 * An unclipped raw CDP capture has neither effect.
 */
async function centreRange(page, cdp) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const img = decodePng(Buffer.from(data, "base64"));
  const { w } = await page.evaluate(() => ({ w: innerWidth }));
  return centreCropRange(img, Math.round((32 * img.width) / w));
}

const scrollState = (page) => page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight, dpr: devicePixelRatio }));

/** Programmatic positioning between phases (not measured: stats are reset afterwards). */
async function jumpTo(page, fraction) {
  const target = await page.evaluate((f) => {
    const t = Math.round((document.documentElement.scrollHeight - innerHeight) * f);
    window.scrollTo(0, t);
    return t;
  }, fraction);
  await sleep(150);
  const { y } = await scrollState(page);
  if (Math.abs(y - target) > 4) throw new DriverError(`programmatic scroll to ${fraction} did not take (scrollY ${y}, wanted ${target})`, 5);
  return settled(page, `settle at ${fraction}`);
}

// ------------------------------------------------------------------ Environments

/** Android Chrome over adb + CDP. */
function androidEnv(adb, info, page) {
  let orientation = "portrait";
  const dims = () => {
    const { width, height } = info.screen; // natural (portrait) size
    return orientation === "portrait" ? [width, height] : [height, width];
  };
  /**
   * Finger up = scroll down = forward. A backward drag that reaches scrollY 0
   * while the finger is still down triggers Chrome's pull-to-refresh (reload),
   * so backward drags stop 8 CSS px short of the top; a fling may still carry
   * the page to 0, which does not refresh.
   */
  const swipe = async (dir, durationMs, state) => {
    const [W, H] = dims();
    const x = Math.round(W * 0.62);
    const lo = Math.round(H * 0.78);
    let hi = Math.round(H * 0.3);
    if (dir < 0) {
      // Near the top, a still-running fling would move the page under the
      // planned drag: wait until scrollY is stable, then size the drag.
      if (state.y * state.dpr < 2 * (lo - hi)) {
        let prevY = state.y;
        for (let i = 0; i < 30; i++) {
          await sleep(80);
          const s = await scrollState(page);
          if (s.y === prevY) break;
          prevY = s.y;
        }
        state = { ...state, y: prevY };
      }
      const room = Math.floor((state.y - 8) * state.dpr);
      if (room < 60) return false;
      hi = Math.max(hi, lo - room);
    }
    const [y1, y2] = dir > 0 ? [lo, hi] : [hi, lo];
    await adb.shell(`input swipe ${x} ${y1} ${x} ${y2} ${durationMs}`);
    return true;
  };
  return {
    name: "android",
    base: "portrait",
    alt: "landscape",
    altVariant: null, // decided by the player (tier from width x DPR); read from the snapshot
    /** One gesture. slow: 1.4 s drag (little fling); fast: 100 ms flick. Returns false when there is no room left. */
    async gesture(kind, dir, state) {
      const done = await swipe(dir, kind === "slow" ? 1400 : 100, state);
      await sleep(kind === "slow" ? 250 : 120);
      return done;
    },
    async rotate(to) {
      orientation = to;
      await setRotation(adb, to === "portrait" ? 0 : 1);
    },
    page,
  };
}

/** Desktop Edge (headed) with mouse-wheel scrubs. */
function desktopEnv(page) {
  return {
    name: "desktop",
    base: "landscape",
    alt: "portrait",
    async gesture(kind, dir) {
      await page.mouse.move(720, 450);
      if (kind === "slow") {
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, dir * 40);
          await sleep(40);
        }
      } else {
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, dir * 600);
          await sleep(16);
        }
        await sleep(60);
      }
    },
    async rotate(to) {
      await page.setViewportSize(to === "landscape" ? { width: 1440, height: 900 } : { width: 900, height: 1440 });
    },
    page,
  };
}

/**
 * Gesture repeatedly until the page reaches the end (dir>0) or the top
 * (dir<0). "Top" = inside the first half of frame 0's scroll range, because
 * the phone driver never drags into the top edge (pull-to-refresh).
 */
async function scrubTo(env, kind, dir, maxGestures = 60) {
  for (let i = 0; i < maxGestures; i++) {
    const st = await scrollState(env.page);
    const top = Math.max(2, st.max / (env.frameCount * 2));
    if (dir > 0 ? st.y >= st.max - 2 : st.y <= top) return i;
    if ((await env.gesture(kind, dir, st)) === false) return i + 1;
  }
  const { y, max } = await scrollState(env.page);
  throw new DriverError(`scrub ${kind} ${dir > 0 ? "forward" : "back"} did not reach the ${dir > 0 ? "end" : "top"} after ${maxGestures} gestures (scrollY ${y} / ${max})`, 5);
}

// ------------------------------------------------------------------ Edge launch (desktop)

const EDGE_PATHS = [process.env.EDGE_PATH, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);

async function launchEdgeHeaded() {
  const exe = EDGE_PATHS.find((p) => existsSync(p));
  if (!exe) throw new DriverError("Microsoft Edge not found (set EDGE_PATH)", 4);
  const profile = mkdtempSync(join(tmpdir(), "spike-device-edge-"));
  const proc = spawn(exe, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1480,1040", "--window-position=0,0", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "about:blank"], { stdio: "ignore" });
  const kill = () => {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  };
  try {
    const portFile = join(profile, "DevToolsActivePort");
    const t0 = Date.now();
    while (!existsSync(portFile) || readFileSync(portFile, "utf8").trim() === "") {
      if (Date.now() - t0 > 20_000) throw new DriverError("Edge did not open a DevTools port", 4);
      await sleep(100);
    }
    const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return { browser, kill, version: browser.version() };
  } catch (e) {
    kill();
    throw e;
  }
}

// ------------------------------------------------------------------ The scripted test

async function runPhases(env, opts, manifest, results) {
  const { page } = env;
  const shot = manifest.shots[0];
  env.frameCount = shot.frameCount;
  const phases = results.phases;
  const defects = results.defects;
  let prev = null;
  let phaseName = "cold-load";

  const requestLog = results.requestLog;
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.includes("/media/")) requestLog.push({ phase: phaseName, path: u.pathname, t: Date.now() - results.t0 });
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") results.console.push(`[${phaseName}] ${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => results.console.push(`[${phaseName}] pageerror: ${e.message}`));
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    if (++navigations > 1) {
      log(`UNEXPECTED NAVIGATION during ${phaseName}: ${f.url()} (pull-to-refresh?)`);
      defects.push(`${phaseName}: unexpected navigation (${f.url()}; pull-to-refresh? HUD counters were reset by the reload)`);
    }
  });

  const cdp = await page.context().newCDPSession(page);
  const record = async (name, kind, extra = {}) => {
    const s = await snap(page);
    const range = await centreRange(page, cdp);
    const p = { ...summarizePhase(name, s, prev, extra), kind, centreRange: range };
    const d = blankDefect(range, name);
    if (s.decodeErrors - (prev?.decodeErrors ?? 0) > 0) d.push(`${name}: ${s.decodeErrors - (prev?.decodeErrors ?? 0)} decode error(s)`);
    if (s.chunkErrors - (prev?.chunkErrors ?? 0) > 0) d.push(`${name}: ${s.chunkErrors - (prev?.chunkErrors ?? 0)} chunk error(s)`);
    if (kind === "scrub") {
      const cb = chunkBoundaryStalls(s.latencyByFrameMax, shot.chunkSize, shot.frameCount);
      p.chunkBoundaries = cb;
      p.latencyByFrameMax = s.latencyByFrameMax;
      for (const st of cb.stalls) d.push(`${name}: chunk-boundary stall at frame ${st.frame} (${st.worstMs} ms vs median ${cb.median} ms)`);
    }
    p.defects = d;
    defects.push(...d);
    phases.push(p);
    prev = s;
    log(`${name.padEnd(22)} ${p.variant.padEnd(10)} scrub fps med ${p.scrubFpsMedian ?? "-"} p5 ${p.scrubFpsP5 ?? "-"} (n=${p.scrubSamples})  all fps p5 ${p.allFpsP5 ?? "-"}  decode p50/p95 ${p.decodeMsP50 ?? "-"}/${p.decodeMsP95 ?? "-"} ms  lat p95 ${p.latencyMsP95 ?? "-"} ms  peak live ${(p.peakLiveDecodedBytes / 1048576).toFixed(1)} MB  req +${p.requests}  resize ${p.resizeEvents}/${p.canvasResizes}  long>50ms ${p.scrubLongIntervals?.over50ms ?? "-"}${d.length ? `  DEFECTS: ${d.join("; ")}` : ""}`);
    return { s, p };
  };

  // ---- 1. Cold load: fresh tab, HTTP cache disabled.
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const navStart = Date.now();
  await page.goto(opts.url, { waitUntil: "load", timeout: 60_000 });
  await page.bringToFront().catch(() => {});
  await waitFor(page, (x) => x.drawnFrame === 0 && x.timeToFirstFrameMs != null, 60_000, "first frame");
  const cold = await record("cold-load", "load", { driverFirstFrameMs: Date.now() - navStart });
  results.timeToFirstFrameMs = cold.s.timeToFirstFrameMs;

  // ---- 2. Slow forward scrubs (stats reset before each, so the jump back to the top is never measured).
  for (let r = 1; r <= opts.reps; r++) {
    phaseName = `slow-forward-${r}`;
    await jumpTo(page, 0);
    await resetStats(page);
    const gestures = await scrubTo(env, "slow", +1);
    await settled(page, `${phaseName} end`);
    await record(phaseName, "scrub", { gestures, orientation: env.base });
  }

  // ---- 3. Fast back-and-forth scrubs (top -> end -> top each).
  await jumpTo(page, 0);
  for (let r = 1; r <= opts.reps; r++) {
    phaseName = `fast-back-and-forth-${r}`;
    await resetStats(page);
    const down = await scrubTo(env, "fast", +1);
    const up = await scrubTo(env, "fast", -1);
    await settled(page, `${phaseName} end`);
    await record(phaseName, "scrub", { gestures: down + up, orientation: env.base });
  }

  // ---- 4. Rotation to the other orientation, same frame.
  phaseName = `rotate-to-${env.alt}`;
  const before = await jumpTo(page, 0.437);
  await resetStats(page);
  const baseVariant = before.drawnVariant;
  const t0 = Date.now();
  await env.rotate(env.alt);
  const after = await waitFor(page, (x) => x.drawnVariant !== baseVariant && x.drawnVariant === `${x.aspect}/${x.tier}` && x.drawnFrame === x.frame, 20_000, `variant switch after rotating to ${env.alt}`).catch(async (e) => {
    defects.push(`${phaseName}: ${e.message}`);
    return snap(page);
  });
  const rotMs = Date.now() - t0;
  // Desktop 900x1440 -> 9x16/720; phone landscape (stage width x DPR > 1280) -> 16x9/1080.
  const expectedAlt = env.name === "desktop" ? "9x16/720" : "16x9/1080";
  const rd = rotationDefects(before, after, expectedAlt);
  defects.push(...rd.map((x) => `${phaseName}: ${x}`));
  await record(phaseName, "rotation", { from: baseVariant, to: after.drawnVariant, frameBefore: before.frame, frameAfter: after.drawnFrame, rotationToDrawnMs: rotMs, rotationDefects: rd });

  // ---- 5. One slow + one fast scrub in the other orientation (its own tier).
  phaseName = `${env.alt}-slow-forward`;
  await jumpTo(page, 0);
  await resetStats(page);
  await scrubTo(env, "slow", +1);
  await settled(page, `${env.alt} slow end`);
  await record(phaseName, "scrub", { orientation: env.alt });

  phaseName = `${env.alt}-fast-back-and-forth`;
  await resetStats(page);
  await scrubTo(env, "fast", -1);
  await scrubTo(env, "fast", +1);
  await scrubTo(env, "fast", -1);
  await settled(page, `${env.alt} fast end`);
  await record(phaseName, "scrub", { orientation: env.alt });

  // ---- 6. Rotate back.
  phaseName = `rotate-to-${env.base}`;
  const before2 = await jumpTo(page, 0.437);
  await resetStats(page);
  const t1 = Date.now();
  await env.rotate(env.base);
  const after2 = await waitFor(page, (x) => x.drawnVariant === baseVariant && x.drawnFrame === x.frame, 20_000, `variant ${baseVariant} after rotating back`).catch(async (e) => {
    defects.push(`${phaseName}: ${e.message}`);
    return snap(page);
  });
  const rd2 = rotationDefects(before2, after2, baseVariant);
  defects.push(...rd2.map((x) => `${phaseName}: ${x}`));
  await record(phaseName, "rotation", { from: before2.drawnVariant, to: after2.drawnVariant, frameBefore: before2.frame, frameAfter: after2.drawnFrame, rotationToDrawnMs: Date.now() - t1, rotationDefects: rd2 });

  // ---- 7. Idle 10 s (recorded separately; never mixed into scrub fps).
  phaseName = "idle";
  await resetStats(page);
  await sleep(opts.idleMs);
  await record("idle", "idle", { idleMs: opts.idleMs });

  // Resource timing for throughput / TTFB (seek-latency extrapolation to larger N).
  results.resourceTiming = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/media/"))
      .map((e) => ({ path: new URL(e.name).pathname, startMs: Math.round(e.startTime), ttfbMs: Math.round(e.responseStart - e.requestStart), responseStart: Math.round(e.responseStart * 10) / 10, responseEnd: Math.round(e.responseEnd * 10) / 10, durationMs: Math.round(e.duration), transferSize: e.transferSize, encodedBodySize: e.encodedBodySize })),
  );
  results.finalSnapshot = await snap(page);
}

function analyse(results, manifest, opts) {
  const shot = manifest.shots[0];
  // Requests per variant / chunk (each chunk once?).
  const chunkReqs = results.requestLog.filter((r) => r.path.endsWith(".bin"));
  const byVariant = {};
  for (const r of chunkReqs) {
    const m = r.path.match(/\/(16x9|9x16)\/(\d+)\/chunk-(\d{4})\.bin$/);
    if (!m) continue;
    const k = `${m[1]}/${m[2]}`;
    (byVariant[k] ??= { requests: 0, distinct: new Set() }).requests++;
    byVariant[k].distinct.add(m[3]);
  }
  const variants = Object.fromEntries(Object.entries(byVariant).map(([k, v]) => [k, { requests: v.requests, distinctChunks: v.distinct.size, chunksInManifest: shot.chunkCount }]));
  const totalChunkReq = chunkReqs.length;
  const distinct = Object.values(byVariant).reduce((a, v) => a + v.distinct.size, 0);
  const frameData = results.requestLog.filter((r) => r.path.includes("/frames/")).length;
  const manifestReq = results.requestLog.filter((r) => r.path.endsWith("asset-manifest.json")).length;
  results.requests = { total: results.requestLog.length, manifest: manifestReq, frameData, chunks: totalChunkReq, byVariant: variants, bytesHud: results.finalSnapshot?.requestBytes ?? null, requestsHud: results.finalSnapshot?.requests ?? null };
  results.requestEstimate = fullFilmEstimate({ measuredChunkRequests: totalChunkReq, distinctChunks: distinct, chunkSize: shot.chunkSize });

  // Throughput for chunks (bytes / ms of the response body) and TTFB.
  const chunks = (results.resourceTiming ?? []).filter((r) => r.path.endsWith(".bin") && r.durationMs > 0);
  if (chunks.length) {
    const bytes = chunks.reduce((a, c) => a + (c.encodedBodySize || 0), 0);
    // Body time only (first byte -> last byte); excludes queueing / connection / TTFB.
    const ms = chunks.reduce((a, c) => a + Math.max(1, c.responseEnd - c.responseStart), 0);
    const ttfb = chunks.map((c) => c.ttfbMs).sort((a, b) => a - b);
    results.chunkNetwork = { samples: chunks.length, avgBodyKBps: Math.round(bytes / ms), ttfbMedianMs: ttfb[Math.floor((ttfb.length - 1) / 2)], durationsMs: chunks.map((c) => c.durationMs) };
  }

  const frameBytes = Object.fromEntries(shot.aspects.flatMap((a) => a.tiers.map((t) => [`${a.aspect}/${t.tier}`, t.width * t.height * 4])));
  results.budgets = evaluateBudgets(results.phases, { desktop: opts.desktop, frameBytes });
  results.visualChecks = {
    blankFrames: "32x32 CSS-px compositor screenshot (CDP) at the viewport centre after every phase: channel range > 4 (0 = uniform/blank). No canvas readback (it demotes the canvas to software on Android). The player never clears the canvas; a not-yet-decoded frame keeps the last one (counted as missedTicks)",
    wrongVariantAfterRotation: "drawnVariant after each rotation vs expected aspect, drawnFrame vs the frame before rotating",
    chunkBoundaryStutter: "worst target->drawn latency at frames 16/32/48/64 vs 3x the median of all frames' worst latency (and > median + 50 ms)",
    tearing: "not detectable from the page; manual observation during the run (RESULTS.md)",
  };
}

// ------------------------------------------------------------------ Main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return 0;
  }
  const outDir = resolve(opts.out ?? join(here, "..", "results"));

  // Preview server reachable from this machine (the phone uses the same LAN URL).
  const manifestUrl = new URL("media/asset-manifest.json", opts.url).href;
  let manifest;
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    throw new DriverError(`preview server not reachable at ${manifestUrl} (${e.message}). Start it: npm --prefix spike/player run build; npm --prefix spike/player run preview -- --host`, 2);
  }

  const results = { schema: 1, story: "0.5", tool: "spike/device/run-device-test.mjs", mode: opts.desktop ? "desktop" : "android", url: opts.url, startedAt: new Date().toISOString(), t0: Date.now(), mediaVersion: manifest.mediaVersion, shot: { id: manifest.shots[0].id, frameCount: manifest.shots[0].frameCount, chunkSize: manifest.shots[0].chunkSize, chunkCount: manifest.shots[0].chunkCount }, device: null, browser: null, phases: [], defects: [], requestLog: [], console: [] };

  const hardStop = setTimeout(() => {
    console.error("[device] hard timeout");
    void emergency().finally(() => process.exit(2));
  }, HARD_TIMEOUT_MS);
  let emergency = async () => {};
  process.once("SIGINT", () => {
    console.error("[device] interrupted — restoring device state");
    void emergency().finally(() => process.exit(130));
  });

  let label;
  let cleanup = null;
  try {
    if (opts.desktop) {
      const edge = await launchEdgeHeaded();
      emergency = async () => edge.kill();
      try {
        results.browser = { name: "Microsoft Edge", version: edge.version };
        results.device = { kind: "desktop", host: process.env.COMPUTERNAME ?? null, viewport: "1440x900 (landscape) / 900x1440 (portrait)", deviceScaleFactor: 1 };
        const context = await edge.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.bringToFront();
        await runPhases(desktopEnv(page), opts, manifest, results);
      } finally {
        await edge.browser.close().catch(() => {});
        edge.kill();
      }
      label = opts.label ?? `desktop-edge-${(process.env.COMPUTERNAME ?? "pc").toLowerCase()}`;
    } else {
      const adb = createAdb(opts.device);
      await preflightDevice(adb, runAdb);
      results.device = await deviceInfo(adb);
      log(`device ${opts.device}: ${results.device.manufacturer} ${results.device.model}, Android ${results.device.android}, Chrome ${results.device.chrome}`);
      await wakeDevice(adb);
      const session = await withDeviceSession(adb, opts.port, DEFAULTS.devtoolsSocket, async (saved) => {
        results.rotationBefore = saved;
        emergency = async () => {
          await restoreRotation(adb, saved).catch(() => {});
          await adb.cmd(["forward", "--remove", `tcp:${opts.port}`]).catch(() => {});
        };
        const launched = await ensureChromeDevtools(adb, opts.url);
        await foregroundChrome(adb);
        await setRotation(adb, 0); // start in portrait, auto-rotate off (restored afterwards)
        await sleep(800);
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`, { timeout: 20_000 });
        try {
          results.browser = { name: "Chrome (Android)", version: browser.version(), launchedByDriver: launched.launched };
          const context = browser.contexts()[0];
          const page = await context.newPage();
          // Close earlier player tabs (e.g. the one `am start` opened) so only the test tab runs.
          const origin = new URL(opts.url).origin;
          for (const p of context.pages()) if (p !== page && p.url().startsWith(origin)) await p.close().catch(() => {});
          await runPhases(androidEnv(adb, results.device, page), opts, manifest, results);
          await page.close().catch(() => {});
        } finally {
          await browser.close().catch(() => {}); // disconnects; Chrome keeps running
        }
      });
      cleanup = session.cleanup;
      results.rotationAfter = await readRotation(adb);
      results.cleanup = cleanup;
      label = opts.label ?? `${results.device.model}`.replace(/[^\w.-]+/g, "_");
    }
  } catch (e) {
    if (e.cleanup) results.cleanup = e.cleanup;
    results.error = e.message;
    console.error(`[device] ${e.message}`);
    if (e.cleanup) console.error(`[device] cleanup: rotation restored ${e.cleanup.rotationRestored}, forward removed ${e.cleanup.forwardRemoved}${e.cleanup.errors.length ? ` (${e.cleanup.errors.join("; ")})` : ""}`);
    // Partial results are not written (RESULTS.md only cites complete runs).
    clearTimeout(hardStop);
    return e instanceof DriverError ? e.exitCode : 5;
  }
  clearTimeout(hardStop);

  analyse(results, manifest, opts);
  results.finishedAt = new Date().toISOString();
  delete results.t0;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${label}-${timestamp()}.json`);
  if (existsSync(file)) throw new DriverError(`refusing to overwrite ${file}`, 5);
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
  log(`results: ${file}`);
  for (const b of results.budgets) log(`budget ${b.pass ? "PASS" : "FAIL"}  ${b.phase.padEnd(26)} ${b.budget}  ${JSON.stringify(b.value)}`);
  log(`defects: ${results.defects.length ? results.defects.join(" | ") : "none"}`);
  if (cleanup && (!cleanup.rotationRestored || !cleanup.forwardRemoved)) {
    console.error(`[device] cleanup incomplete: ${cleanup.errors.join("; ")}`);
    return 5;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[device] ${e?.stack ?? e}`);
    process.exit(e instanceof DriverError ? e.exitCode : 5);
  },
);
