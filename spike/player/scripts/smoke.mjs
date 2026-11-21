// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Headless smoke check: starts an in-process Vite dev server on a random port,
// drives the installed Microsoft Edge via playwright-core (no browser
// download), and stops both when done. Needs `npm run copy-media` first.
//
//   node scripts/smoke.mjs
//
// Checks: no console errors; decode path `worker`; manifest + frame data
// requested before any chunk; only manifest / <=2 frame-data / whole-chunk
// requests (built from the served manifest), each chunk once; frame 71, frame
// 0 and the post-rotate frame are actually drawn (canvas centre not uniform);
// the drawn frame at one scroll position is the same coming down and going
// up; landscape -> portrait switches to 9x16 keeping the frame; outline shown
// on frame 0; byte-bounded cache (?cacheMB=40) and live bitmaps bounded by
// cache + in-flight + the on-screen frame; missing manifest shows error text
// without a crash.

import { createServer } from "vite";
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE_PATHS = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kills the spawned Edge (set as soon as it is spawned, so every exit path can call it). */
let killEdge = () => {};

/**
 * Launch headless Edge ourselves and attach over CDP. (Playwright's own
 * `channel: "msedge"` pipe launch exits immediately with Edge 158 on this
 * machine; a CDP port connection works.)
 */
async function launchEdge() {
  const exe = EDGE_PATHS.find((p) => existsSync(p));
  if (!exe) throw new Error("Microsoft Edge not found (set EDGE_PATH)");
  const profile = mkdtempSync(join(tmpdir(), "spike-smoke-edge-"));
  const proc = spawn(exe, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  let killed = false;
  killEdge = () => {
    if (killed) return;
    killed = true;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* profile cleanup is best effort */
    }
  };
  let browser;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    const t0 = Date.now();
    while (!existsSync(portFile) || readFileSync(portFile, "utf8").trim() === "") {
      if (Date.now() - t0 > 20_000) throw new Error("Edge did not open a DevTools port");
      await sleep(100);
    }
    const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    killEdge();
    throw e;
  }
  return {
    newPage: async (opts) => (await browser.newContext(opts)).newPage(),
    close: async () => {
      await browser.close().catch(() => {});
      killEdge();
    },
  };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Optional: SMOKE_SHOTS=<existing dir> saves screenshots for a visual check. */
const SHOTS = process.env.SMOKE_SHOTS && existsSync(process.env.SMOKE_SHOTS) ? process.env.SMOKE_SHOTS : null;

let server;
let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  killEdge();
  await server?.close().catch(() => {});
}

const hardStop = setTimeout(() => {
  console.error("[smoke] hard timeout (240 s)");
  cleanup().finally(() => process.exit(2));
}, 240_000);

const failures = [];
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    console.log(`  FAIL ${msg}`);
    failures.push(msg);
  }
}

const snap = (page) => page.evaluate(() => window.__spike.snapshot());

async function waitFor(page, pred, timeout = 15_000, label = "condition") {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) {
    s = await snap(page);
    if (pred(s)) return s;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}; last snapshot: ${JSON.stringify(s)}`);
}

/** Scroll, then wait two animation frames so the player's playhead reflects the new position. */
async function scrollToY(page, y) {
  await page.evaluate(
    (v) =>
      new Promise((done) => {
        window.scrollTo(0, v);
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
    y,
  );
}

async function maxScroll(page) {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
}

/** Scroll step for `n` steps over `max`, never 0 (a 0 step would loop forever). */
const stepOf = (max, n) => Math.max(1, Math.ceil(max / n));

/** Wait until the target frame is the drawn frame (current variant), then return the snapshot. */
const waitDrawn = (page, label, extra = () => true) =>
  waitFor(page, (x) => x.drawnFrame === x.frame && x.drawnVariant === `${x.aspect}/${x.tier}` && extra(x), 15_000, label);

/** Channel range over a 32x32 canvas region at the stage centre; 0 means uniform (blank). */
async function centreRange(page) {
  return page.evaluate(() => {
    const c = document.getElementById("canvas");
    const ctx = c.getContext("2d");
    const n = 32;
    const x = Math.max(0, Math.floor(c.width / 2 - n / 2));
    const y = Math.max(0, Math.floor(c.height / 2 - n / 2));
    const d = ctx.getImageData(x, y, n, n).data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        lo = Math.min(lo, d[i + k]);
        hi = Math.max(hi, d[i + k]);
      }
    }
    return hi - lo;
  });
}

async function checkPainted(page, label) {
  const range = await centreRange(page);
  check(range > 4, `${label}: canvas centre not uniform (channel range ${range})`);
}

function checkLive(s, label) {
  const bound = s.decodedFrames + s.inflight + 1;
  check(s.liveDecodedBitmaps <= bound, `${label}: live bitmaps ${s.liveDecodedBitmaps} <= cache ${s.decodedFrames} + inflight ${s.inflight} + 1 (live ${(s.liveDecodedBytes / 1048576).toFixed(1)} MB)`);
}

function watch(page) {
  const requests = [];
  const errors = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return { requests, errors };
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

try {
  server = await createServer({ root, logLevel: "warn", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  console.log(`[smoke] dev server ${base}`);

  // Allow-list built from the served manifest (no hard-coded mediaVersion / shot id).
  const served = await fetch(new URL("media/asset-manifest.json", base)).then((r) => r.json());
  const mv = reEscape(served.mediaVersion);
  const shotId = reEscape(served.shots[0].id);
  const act = reEscape(served.shots[0].act);
  const allowed = new RegExp(
    `^/media/(asset-manifest\\.json|${mv}/frames/${act}\\.(16x9|9x16)\\.json|${mv}/${shotId}/(16x9|9x16)/(1080|720)/chunk-\\d{4}\\.bin)$`,
  );
  const lastFrame = served.shots[0].frameCount - 1;

  browser = await launchEdge();

  // ------------------------------------------------ Desktop 1440x900
  console.log("[smoke] desktop 1440x900 ?hud=1");
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const { requests, errors } = watch(page);
    await page.goto(`${base}?hud=1`);
    let s = await waitFor(page, (x) => x.drawnFrame === 0, 20_000, "first frame");
    check(s.aspect === "16x9" && s.tier === "1080", `variant 16x9/1080 (got ${s.aspect}/${s.tier})`);
    check(await page.locator("#hud").isVisible(), "HUD visible");
    const outline = await page.evaluate(() => {
      const p = document.querySelector("#outline polygon");
      return { display: p.style.display, points: p.getAttribute("points") };
    });
    check(outline.display !== "none" && outline.points.split(" ").length === 4, `outline drawn on frame 0 (${outline.points})`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "1440x900-frame0.png") });

    // Scrub down to the bottom, then back up.
    const max = await maxScroll(page);
    const step = stepOf(max, 60);
    for (let y = 0; y <= max; y += step) {
      await scrollToY(page, y);
      await sleep(30);
    }
    await scrollToY(page, max);
    s = await waitDrawn(page, `frame ${lastFrame}`, (x) => x.frame === lastFrame);
    check(s.drawnFrame === lastFrame, `scrollY max => frame ${lastFrame} drawn`);
    await checkPainted(page, `frame ${lastFrame}`);
    for (let y = max; y >= 0; y -= step) {
      await scrollToY(page, y);
      await sleep(30);
    }
    await scrollToY(page, 0);
    s = await waitDrawn(page, "frame 0", (x) => x.frame === 0);
    check(s.drawnFrame === 0, "scrollY 0 => frame 0 drawn");
    await checkPainted(page, "frame 0");
    check(s.decodePath === "worker", `decode path worker (got ${s.decodePath}${s.decodeFallbackReason ? `: ${s.decodeFallbackReason}` : ""})`);
    check(s.decodeErrors === 0 && s.chunkErrors === 0, "no decode/chunk errors");
    check(s.decodedBytes <= s.cacheLimitBytes, `cache bytes ${s.decodedBytes} <= limit ${s.cacheLimitBytes}`);

    // Same scroll position coming down vs going up => same drawn frame.
    const y = Math.round(max * 0.437);
    await scrollToY(page, Math.round(max * 0.2));
    await sleep(80);
    await scrollToY(page, y);
    const down = (await waitDrawn(page, "drawn frame going down")).drawnFrame;
    await scrollToY(page, Math.round(max * 0.8));
    await sleep(80);
    await scrollToY(page, y);
    const up = (await waitDrawn(page, "drawn frame going up")).drawnFrame;
    check(down === up, `same scroll position => same drawn frame down/up (${down} / ${up})`);

    // Rotate: landscape -> portrait keeps progress.
    const before = await snap(page);
    await page.setViewportSize({ width: 390, height: 844 });
    s = await waitFor(page, (x) => x.drawnVariant === "9x16/720" && x.drawnFrame === before.frame, 15_000, "9x16 frame drawn after rotate");
    check(s.aspect === "9x16" && s.tier === "720" && s.drawnVariant === "9x16/720", `rotate => 9x16/720 drawn (got ${s.drawnVariant})`);
    check(s.frame === before.frame, `rotate keeps the frame (${before.frame} -> ${s.frame}; progress ${before.progress} -> ${s.progress})`);
    await checkPainted(page, "after rotate");
    checkLive(await snap(page), "after rotate");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `390x844-frame${s.frame}.png`) });

    // Request log.
    const media = requests.filter((p) => p.includes("/media/"));
    const firstChunk = media.findIndex((p) => p.endsWith(".bin"));
    const manifestIdx = media.indexOf("/media/asset-manifest.json");
    const fdIdx = media.findIndex((p) => /\/frames\/[^/]+\.16x9\.json$/.test(p));
    check(manifestIdx === 0 && fdIdx > manifestIdx && firstChunk > fdIdx, "manifest, then frame data, before any chunk");
    const bad = media.filter((p) => !allowed.test(p));
    check(bad.length === 0, `only manifest / frame data / chunk requests${bad.length ? `: ${bad.join(", ")}` : ""}`);
    const fdCount = media.filter((p) => p.includes("/frames/")).length;
    check(fdCount <= 2, `frame-data requests <= 2 (got ${fdCount})`);
    const chunks = media.filter((p) => p.endsWith(".bin"));
    const dup = chunks.filter((p, i) => chunks.indexOf(p) !== i);
    check(dup.length === 0, `each chunk fetched once (${chunks.length} chunk requests${dup.length ? `; dup ${dup.join(", ")}` : ""})`);
    check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    console.log(`[smoke] HUD summary: ${JSON.stringify({ fpsMedian: s.fpsMedian, fpsP5: s.fpsP5, decodeMsP50: s.decodeMsP50, decodeMsP95: s.decodeMsP95, requests: s.requests, requestBytes: s.requestBytes, decodedBytes: s.decodedBytes, liveDecodedBytes: s.liveDecodedBytes })}`);
    await page.close();
  }

  // ------------------------------------------------ Small cache bound
  console.log("[smoke] ?cacheMB=40 at 1440x900 (1080 tier)");
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const { errors } = watch(page);
    await page.goto(`${base}?hud=1&cacheMB=40`);
    await waitFor(page, (x) => x.drawnFrame === 0, 20_000, "first frame");
    const max = await maxScroll(page);
    let worst = 0;
    for (let y = 0; y <= max; y += stepOf(max, 40)) {
      await scrollToY(page, y);
      await sleep(40);
      const s = await snap(page);
      worst = Math.max(worst, s.decodedBytes);
    }
    const s = await snap(page);
    check(worst <= s.cacheLimitBytes, `cache bytes never above 40 MB (peak ${(worst / 1048576).toFixed(1)} MB)`);
    checkLive(s, "after cacheMB=40 scrub");
    check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.close();
  }

  // ------------------------------------------------ Missing manifest
  console.log("[smoke] missing manifest (404)");
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const { errors } = watch(page);
    await page.route("**/media/asset-manifest.json", (r) => r.fulfill({ status: 404, body: "not found" }));
    await page.goto(`${base}?hud=1`);
    await page.locator("#error").waitFor({ state: "visible", timeout: 10_000 });
    const text = await page.locator("#error").textContent();
    check(/asset manifest/.test(text ?? ""), `visible error text: "${text}"`);
    check(!errors.some((e) => e.startsWith("pageerror")), "no uncaught exception");
    await page.close();
  }
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.error(e);
} finally {
  await cleanup();
  clearTimeout(hardStop);
}

if (failures.length) {
  console.log(`[smoke] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("[smoke] all checks passed");
