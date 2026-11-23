// THROWAWAY — Story 0.5 device test helpers. Not production code; delete after Epic 0.
//
// Pieces of the device driver that do not need a browser: adb wrapper with
// preflight / Chrome launch / rotation save+restore, and the pure result
// maths (phase summary, defect checks, budgets, full-film request estimate).
// Everything takes its side effects (adb runner, sleep, clock) as arguments so
// `lib.test.mjs` can drive it with fakes.

import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";

export const DEFAULTS = {
  device: "192.168.101.13:5555",
  url: "http://192.168.101.18:4173/?hud=1",
  desktopUrl: "http://127.0.0.1:4173/?hud=1",
  port: 9333,
  chromePackage: "com.android.chrome",
  chromeActivity: "com.google.android.apps.chrome.Main",
  devtoolsSocket: "chrome_devtools_remote",
  socketTimeoutMs: 20_000,
};

export class DriverError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ------------------------------------------------------------------ CLI

export function parseArgs(argv) {
  const o = { desktop: false, record: false, device: process.env.ADB_SERIAL || DEFAULTS.device, url: null, port: DEFAULTS.port, label: null, out: null, idleMs: 10_000, reps: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new DriverError(`missing value for ${a}`, 1);
      return v;
    };
    if (a === "--desktop") o.desktop = true;
    else if (a === "--record") o.record = true;
    else if (a === "--device") o.device = next();
    else if (a === "--url") o.url = next();
    else if (a === "--port") o.port = Number(next());
    else if (a === "--label") o.label = next();
    else if (a === "--out") o.out = next();
    else if (a === "--idle-ms") o.idleMs = Number(next());
    else if (a === "--reps") o.reps = Number(next());
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new DriverError(`unknown option ${a}`, 1);
  }
  if (!o.url) o.url = o.desktop ? DEFAULTS.desktopUrl : DEFAULTS.url;
  if (!Number.isInteger(o.port) || o.port <= 0) throw new DriverError("--port must be a positive integer", 1);
  if (!Number.isInteger(o.reps) || o.reps <= 0) throw new DriverError("--reps must be a positive integer", 1);
  if (!Number.isFinite(o.idleMs) || o.idleMs < 0) throw new DriverError("--idle-ms must be a non-negative number", 1);
  if (o.record && o.desktop) throw new DriverError("--record is Android only (adb screenrecord)", 1);
  return o;
}

// ------------------------------------------------------------------ adb

/** Default runner: `adb <args>` -> { code, stdout, stderr } (never throws). */
export function runAdb(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let proc;
    try {
      proc = spawn("adb", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill();
      resolve({ code: -2, stdout, stderr: `${stderr}\nadb ${args.join(" ")}: timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` });
    });
    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * adb bound to one device serial. `run(args)` is the raw runner (injectable).
 */
export function createAdb(serial, { run = runAdb, sleep = realSleep, now = () => Date.now() } = {}) {
  const adb = {
    serial,
    sleep,
    now,
    /** Raw adb with `-s serial`; throws DriverError naming the device on failure. */
    async cmd(args, what = args.join(" ")) {
      const r = await run(["-s", serial, ...args]);
      if (r.code !== 0) throw new DriverError(`adb ${what} failed on device ${serial}: ${(r.stderr || r.stdout).trim()}`, 3);
      return r.stdout;
    },
    async shell(command) {
      return (await adb.cmd(["shell", command], `shell "${command}"`)).replace(/\r/g, "");
    },
    async getSetting(ns, key) {
      return (await adb.shell(`settings get ${ns} ${key}`)).trim();
    },
    async putSetting(ns, key, value) {
      await adb.shell(`settings put ${ns} ${key} ${value}`);
    },
  };
  return adb;
}

/**
 * Device reachable and online. Network serials (host:port) get one `adb
 * connect` attempt. Throws DriverError (exit 3) naming the device.
 */
export async function preflightDevice(adb, run = runAdb) {
  const state = async () => (await run(["-s", adb.serial, "get-state"])).stdout.trim();
  let s = await state();
  if (s !== "device" && adb.serial.includes(":")) {
    await run(["connect", adb.serial]);
    s = await state();
  }
  if (s !== "device") throw new DriverError(`device ${adb.serial} is not reachable over adb (state: ${s || "absent"}). Check Wi-Fi debugging / \`adb connect ${adb.serial}\`.`, 3);
}

/** Is the Chrome DevTools abstract socket listening? */
export async function hasDevtoolsSocket(adb, socket = DEFAULTS.devtoolsSocket) {
  const unix = await adb.shell("cat /proc/net/unix");
  return unix.split("\n").some((l) => l.trim().endsWith(`@${socket}`));
}

/**
 * Chrome devtools socket present, launching Chrome with `url` via `am start`
 * when it is not. Clear error after `timeoutMs`.
 */
export async function ensureChromeDevtools(adb, url, { timeoutMs = DEFAULTS.socketTimeoutMs, pollMs = 500, socket = DEFAULTS.devtoolsSocket, pkg = DEFAULTS.chromePackage, activity = DEFAULTS.chromeActivity } = {}) {
  if (await hasDevtoolsSocket(adb, socket)) return { launched: false };
  await adb.shell(`am start -a android.intent.action.VIEW -n ${pkg}/${activity} -d '${url}'`);
  const t0 = adb.now();
  while (adb.now() - t0 < timeoutMs) {
    await adb.sleep(pollMs);
    if (await hasDevtoolsSocket(adb, socket)) return { launched: true };
  }
  throw new DriverError(`Chrome DevTools socket @${socket} did not appear on ${adb.serial} within ${Math.round(timeoutMs / 1000)} s after launching Chrome. Is USB/Wi-Fi debugging on and Chrome installed?`, 4);
}

/** Bring Chrome to the foreground (swipes must land in Chrome). */
export async function foregroundChrome(adb, { pkg = DEFAULTS.chromePackage, activity = DEFAULTS.chromeActivity } = {}) {
  await adb.shell(`am start -n ${pkg}/${activity}`);
}

export async function readRotation(adb) {
  return { accelerometer_rotation: await adb.getSetting("system", "accelerometer_rotation"), user_rotation: await adb.getSetting("system", "user_rotation") };
}

/** 0 = portrait, 1 = landscape (90°). Auto-rotate off so the phone stays there. */
export async function setRotation(adb, rotation) {
  await adb.putSetting("system", "accelerometer_rotation", 0);
  await adb.putSetting("system", "user_rotation", rotation);
}

/** A setting that was never written reads back as "null" (or empty). */
const unset = (v) => v === "null" || v === "";

export async function restoreRotation(adb, saved) {
  // Order: user_rotation first, then auto-rotate (which may hand control back to the sensor).
  // A setting that did not exist before the run is deleted again rather than left forced.
  for (const key of ["user_rotation", "accelerometer_rotation"]) {
    if (unset(saved[key])) await adb.shell(`settings delete system ${key}`);
    else await adb.putSetting("system", key, saved[key]);
  }
}

/** Restored = equal to the saved value, or both unset ("null"/""). */
export function sameRotation(now, saved) {
  return ["user_rotation", "accelerometer_rotation"].every((k) => now[k] === saved[k] || (unset(now[k]) && unset(saved[k])));
}

/**
 * Run `body` with rotation settings saved and the port forward set up;
 * whatever happens, restore rotation and remove the forward. The restore
 * outcome is returned (and verified against the saved values). `body(saved,
 * addCleanup)` may register extra cleanup steps (e.g. stop the screen
 * recording and delete it from the phone); they run first, newest first,
 * and their errors land in `cleanup.errors`.
 */
export async function withDeviceSession(adb, port, socket, body) {
  const saved = await readRotation(adb);
  const cleanup = { rotationRestored: false, forwardRemoved: false, restoredRotation: null, hooksRun: 0, errors: [] };
  const hooks = [];
  const addCleanup = (name, fn) => hooks.push({ name, fn });
  let forwarded = false;
  try {
    await adb.cmd(["forward", `tcp:${port}`, `localabstract:${socket}`], `forward tcp:${port}`);
    forwarded = true;
    return { result: await body(saved, addCleanup), saved, cleanup };
  } catch (e) {
    e.cleanup = cleanup;
    e.savedRotation = saved;
    throw e;
  } finally {
    for (const h of hooks.reverse()) {
      try {
        await h.fn();
        cleanup.hooksRun++;
      } catch (e) {
        cleanup.errors.push(`${h.name} failed: ${e.message}`);
      }
    }
    try {
      await restoreRotation(adb, saved);
      const now = await readRotation(adb);
      cleanup.restoredRotation = now;
      cleanup.rotationRestored = sameRotation(now, saved);
      if (!cleanup.rotationRestored) cleanup.errors.push(`rotation now ${JSON.stringify(now)}, expected ${JSON.stringify(saved)}`);
    } catch (e) {
      cleanup.errors.push(`rotation restore failed: ${e.message}`);
    }
    if (forwarded) {
      try {
        await adb.cmd(["forward", "--remove", `tcp:${port}`], `forward --remove tcp:${port}`);
        cleanup.forwardRemoved = true;
      } catch (e) {
        cleanup.errors.push(`forward remove failed: ${e.message}`);
      }
    } else cleanup.forwardRemoved = true;
  }
}

export async function deviceInfo(adb) {
  const prop = async (k) => (await adb.shell(`getprop ${k}`)).trim();
  const size = (await adb.shell("wm size")).match(/(\d+)x(\d+)/);
  const density = (await adb.shell("wm density")).match(/(\d+)/);
  const chrome = (await adb.shell(`dumpsys package ${DEFAULTS.chromePackage} | grep versionName`)).match(/versionName=(\S+)/);
  const mem = (await adb.shell("cat /proc/meminfo")).match(/MemTotal:\s+(\d+) kB/);
  let refresh = null;
  try {
    const d = await adb.shell("dumpsys display | grep -m 5 -i -E 'refreshRate|renderFrameRate'");
    const m = d.match(/(?:renderFrameRate|refreshRate)[ =]+([\d.]+)/i);
    refresh = m ? Number(m[1]) : null;
  } catch {
    /* best effort */
  }
  return {
    manufacturer: await prop("ro.product.manufacturer"),
    model: await prop("ro.product.model"),
    device: await prop("ro.product.device"),
    soc: (await prop("ro.soc.model")) || (await prop("ro.board.platform")),
    android: await prop("ro.build.version.release"),
    chrome: chrome ? chrome[1] : null,
    screen: size ? { width: Number(size[1]), height: Number(size[2]) } : null,
    density: density ? Number(density[1]) : null,
    memTotalKB: mem ? Number(mem[1]) : null,
    displayRefreshHz: refresh,
  };
}

/** Screen on and not on the keyguard (no unlock is attempted beyond dismissing a swipe-only keyguard). */
export async function wakeDevice(adb) {
  await adb.shell("input keyevent KEYCODE_WAKEUP");
  await adb.shell("wm dismiss-keyguard").catch(() => {});
  await adb.sleep(500);
  const w = await adb.shell("dumpsys window | grep -E 'mDreamingLockscreen|isKeyguardShowing|mShowingLockscreen|KeyguardShowing' || true");
  if (/(isKeyguardShowing|mShowingLockscreen|KeyguardShowing)=true/.test(w)) throw new DriverError(`device ${adb.serial} is locked — unlock the screen and re-run`, 3);
}

// ------------------------------------------------------------------ Screen recording (--record)

export const RECORD_DEFAULTS = { remotePath: "/sdcard/spike-run.mp4", bitRate: 20_000_000, timeLimitS: 180 };

/**
 * `adb shell screenrecord` running in the background. Wall-clock marks are
 * ms since `start()` (spawn time); the video's own clock is aligned to them
 * later with the sync flips (see video.mjs findSyncOffset). `spawnFn` is
 * injectable for tests (same signature as child_process.spawn).
 */
export function createScreenRecorder(adb, { spawnFn = spawn, now = () => Date.now(), ...o } = {}) {
  const cfg = { ...RECORD_DEFAULTS, ...o };
  let proc = null;
  let exited = null;
  let startWall = null;
  let state = "idle"; // idle | recording | stopped | removed
  const rec = {
    cfg,
    get state() {
      return state;
    },
    get startWall() {
      return startWall;
    },
    /** ms since the recording was started (wall clock). */
    ms: () => (startWall == null ? null : now() - startWall),
    async start() {
      if (state !== "idle") throw new DriverError(`screen recorder already ${state}`, 5);
      await adb.shell(`rm -f ${cfg.remotePath}`);
      proc = spawnFn("adb", ["-s", adb.serial, "shell", `screenrecord --bit-rate ${cfg.bitRate} --time-limit ${cfg.timeLimitS} ${cfg.remotePath}`], { stdio: "ignore", windowsHide: true });
      exited = new Promise((resolveExit) => {
        proc.on("exit", () => resolveExit());
        proc.on("error", () => resolveExit());
      });
      startWall = now();
      state = "recording";
      // screenrecord needs a moment to create the encoder; make sure it is alive.
      for (let i = 0; i < 20; i++) {
        await adb.sleep(100);
        if ((await adb.shell("pidof screenrecord || true")).trim()) return startWall;
      }
      throw new DriverError(`screenrecord did not start on ${adb.serial}`, 5);
    },
    /** SIGINT lets screenrecord finalize the MP4; wait until the process is gone. */
    async stop({ timeoutMs = 15_000 } = {}) {
      if (state !== "recording") return;
      await adb.shell("pkill -INT screenrecord || true");
      const t0 = now();
      while (now() - t0 < timeoutMs) {
        if (!(await adb.shell("pidof screenrecord || true")).trim()) break;
        await adb.sleep(200);
      }
      if ((await adb.shell("pidof screenrecord || true")).trim()) throw new DriverError(`screenrecord did not exit within ${timeoutMs} ms`, 5);
      await Promise.race([exited, adb.sleep(3000)]);
      await adb.sleep(500); // file close / media scanner
      state = "stopped";
    },
    async pull(localPath) {
      await adb.cmd(["pull", cfg.remotePath, localPath], `pull ${cfg.remotePath}`);
    },
    async remove() {
      await adb.shell(`rm -f ${cfg.remotePath}`);
      state = "removed";
    },
    /** Cleanup path: stop if still recording, then delete from the phone. Idempotent. */
    async abort() {
      if (state === "idle" || state === "removed") return;
      try {
        await rec.stop();
      } finally {
        if (proc && proc.exitCode === null) proc.kill();
        await rec.remove();
      }
    },
  };
  return rec;
}

// ------------------------------------------------------------------ Result maths

export const pct = (n) => (n == null || !Number.isFinite(n) ? null : n);

/** The fields RESULTS.md needs from a HUD snapshot, plus per-phase deltas of cumulative counters. */
export function summarizePhase(name, snap, prev, extra = {}) {
  const d = (k) => (prev ? snap[k] - prev[k] : snap[k]);
  return {
    phase: name,
    variant: `${snap.aspect}/${snap.tier}`,
    drawnVariant: snap.drawnVariant,
    frame: snap.frame,
    drawnFrame: snap.drawnFrame,
    scrubFpsMedian: snap.scrubFpsMedian,
    scrubFpsP5: snap.scrubFpsP5,
    scrubSamples: snap.scrubSamples,
    scrubFrameMsP95: snap.scrubFrameMsP95,
    scrubLongIntervals: snap.scrubLongIntervals,
    scrubLongLog: snap.scrubLongLog,
    resizeEvents: snap.resizeEvents,
    canvasResizes: snap.canvasResizes,
    allFpsMedian: snap.fpsMedian,
    allFpsP5: snap.fpsP5,
    frameMsP95: snap.frameMsP95,
    drawMsP95: snap.drawMsP95,
    tickWorkMsP95: snap.tickWorkMsP95,
    decodeMsP50: snap.decodeMsP50,
    decodeMsP95: snap.decodeMsP95,
    decodeSamples: snap.decodeSamples,
    decodePath: snap.decodePath,
    decodeFallbackReason: snap.decodeFallbackReason,
    latencyMsP50: snap.latencyMsP50,
    latencyMsP95: snap.latencyMsP95,
    latencyMsMax: snap.latencyMsMax,
    latencySamples: snap.latencySamples,
    latencySuperseded: snap.latencySuperseded,
    missedTicks: snap.missedTicks,
    drawnFrames: d("drawnCount"),
    liveDecodedBytes: snap.liveDecodedBytes,
    peakLiveDecodedBytes: snap.peakLiveDecodedBytes,
    peakLiveDecodedBitmaps: snap.peakLiveDecodedBitmaps,
    cacheBytes: snap.decodedBytes,
    cacheLimitBytes: snap.cacheLimitBytes,
    chunkBytesHeld: snap.chunkBytesHeld,
    memory: snap.memory,
    requests: d("requests"),
    requestBytes: d("requestBytes"),
    requestsTotal: snap.requests,
    requestBytesTotal: snap.requestBytes,
    decodeErrors: d("decodeErrors"),
    chunkErrors: d("chunkErrors"),
    timeToFirstFrameMs: snap.timeToFirstFrameMs,
    viewport: snap.viewport,
    ...extra,
  };
}

/**
 * Chunk-boundary stall: a frame that starts a chunk (16, 32, ...) whose worst
 * target->drawn latency is a spike against the median of all frames' worst
 * latency (> 3x the median and > median + 50 ms).
 */
export function chunkBoundaryStalls(byFrameMax, chunkSize, frameCount) {
  const all = Object.values(byFrameMax ?? {}).filter((v) => Number.isFinite(v));
  if (!all.length) return { boundaries: [], median: null, stalls: [] };
  const sorted = [...all].sort((a, b) => a - b);
  const med = sorted[Math.floor((sorted.length - 1) / 2)];
  const threshold = Math.max(med * 3, med + 50);
  const boundaries = [];
  for (let f = chunkSize; f < frameCount; f += chunkSize) boundaries.push({ frame: f, worstMs: byFrameMax[f] ?? null });
  const stalls = boundaries.filter((b) => b.worstMs != null && b.worstMs > threshold);
  return { boundaries, median: med, thresholdMs: threshold, stalls };
}

/** Rotation outcome: expected variant drawn at the same frame. Returns defect strings. */
export function rotationDefects(before, after, expectedVariant) {
  const defects = [];
  if (!after) return [`no snapshot after rotation (expected ${expectedVariant})`];
  if (after.drawnVariant !== expectedVariant) defects.push(`wrong variant after rotation: ${after.drawnVariant} (expected ${expectedVariant})`);
  if (before && after.drawnFrame !== before.frame) defects.push(`frame changed across rotation: ${before.frame} -> ${after.drawnFrame}`);
  return defects;
}

/**
 * Minimal PNG decoder for screenshots: 8-bit, non-interlaced, colour type 2
 * (RGB) or 6 (RGBA). Returns { width, height, channels, data }.
 *
 * Why not canvas getImageData: on Android Chrome two readbacks switch the 2D
 * canvas to software rendering, after which every new frame costs ~66 ms
 * (measured 2026-11-23). The blank check therefore uses a compositor
 * screenshot, which never touches the canvas.
 */
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const ch = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= ch ? up[x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      row[x] = v & 255;
    }
  }
  return { width, height, channels: ch, data: out };
}

/** Max - min over the RGB channels of a decoded image; 0 means uniform. */
export function channelRange(img) {
  let lo = 255, hi = 0;
  for (let i = 0; i < img.data.length; i += img.channels) {
    for (let k = 0; k < 3; k++) {
      const v = img.data[i + k];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return hi - lo;
}

/** RGB channel range of the centred `box` x `box` pixel square of a decoded image. */
export function centreCropRange(img, box) {
  const n = Math.max(1, Math.min(box, img.width, img.height));
  const x0 = Math.floor((img.width - n) / 2);
  const y0 = Math.floor((img.height - n) / 2);
  const data = Buffer.alloc(n * n * img.channels);
  for (let y = 0; y < n; y++) {
    const s = ((y0 + y) * img.width + x0) * img.channels;
    img.data.copy(data, y * n * img.channels, s, s + n * img.channels);
  }
  return channelRange({ width: n, height: n, channels: img.channels, data });
}

/** Canvas-centre channel range: 0 means uniform (blank frame). */
export function blankDefect(range, label) {
  return range > 4 ? [] : [`${label}: canvas centre uniform (channel range ${range}) — blank frame`];
}

/**
 * Chunk requests over a whole film: ceil(frames/N) + groups - 1 (a group is a
 * separately packed set of frames: 5 acts, or ~40 shots), + fixed requests
 * (1 manifest + 5 per-act frame-data files). A rotation adds the other
 * aspect's frame data and, worst case, all its chunks again. `ratio`
 * (measured chunk requests / distinct chunks) scales the chunk term.
 */
export function filmRequests({ frames, chunkSize, groups, fixed = 6, reserve = 0, rotations = 0, frameDataPerAspect = 5, ratio = 1 }) {
  const chunks = (Math.ceil(frames / chunkSize) + groups - 1) * ratio;
  return fixed + reserve + chunks + rotations * (frameDataPerAspect + chunks);
}

/** Smallest N that fits `budget` (opts as filmRequests, incl. `ratio`), or null. */
export function smallestChunkSize(opts, budget = 150, maxN = 512) {
  for (let n = 1; n <= maxN; n++) if (filmRequests({ ...opts, chunkSize: n }) <= budget) return n;
  return null;
}

/**
 * Full-film estimate from the measured run: the measured chunk-request ratio
 * (chunk requests / distinct chunks — 1.0 when every chunk is fetched once)
 * scales the chunk term. Rows for the current N and the candidates.
 */
export function fullFilmEstimate({ measuredChunkRequests, distinctChunks, chunkSize, filmFrames = [5760, 7200], candidates = [16, 48, 64, 72, 96], budget = 150 }) {
  const ratio = distinctChunks ? measuredChunkRequests / distinctChunks : 1;
  const rows = [];
  for (const frames of filmFrames) {
    for (const [packing, groups] of [["per-act", 5], ["per-shot", 40]]) {
      for (const N of [...new Set([chunkSize, ...candidates])].sort((a, b) => a - b)) {
        const base = { frames, chunkSize: N, groups, ratio };
        const watch = Math.round(filmRequests(base));
        const withRotation = Math.round(filmRequests({ ...base, rotations: 1 }));
        const withReserve = Math.round(filmRequests({ ...base, reserve: 40 }));
        rows.push({ frames, packing, N, requests: watch, withOneRotationWorstCase: withRotation, withReserve40: withReserve, pass: watch <= budget });
      }
      rows.push({ frames, packing, smallestNWithinBudget: smallestChunkSize({ frames, groups, ratio }, budget), smallestNWithReserve40: smallestChunkSize({ frames, groups, ratio, reserve: 40 }, budget) });
    }
  }
  return { measuredChunkRequestRatio: Math.round(ratio * 100) / 100, budget, rows };
}

/**
 * Budgets per phase. Phone: scrub fps p5 >= 30. Desktop: scrub fps median >=
 * 58 and p5 >= 55 (a 60 Hz display holding 60 with at most an occasional
 * dropped frame). Memory: peak live decoded bytes <= cache limit + 2 frames
 * of the phase's own variant; `frameBytes` maps "aspect/tier" -> w*h*4.
 */
export function evaluateBudgets(phases, { desktop, frameBytes }) {
  const out = [];
  for (const p of phases) {
    if (p.scrubSamples > 0 && p.kind === "scrub") {
      const pass = desktop ? p.scrubFpsMedian >= 58 && p.scrubFpsP5 >= 55 : p.scrubFpsP5 >= 30;
      out.push({ phase: p.phase, budget: desktop ? "scrub fps 60 (median >= 58, p5 >= 55)" : "scrub fps p5 >= 30", value: { median: p.scrubFpsMedian, p5: p.scrubFpsP5, n: p.scrubSamples }, pass });
    }
    if (p.peakLiveDecodedBytes != null && p.cacheLimitBytes != null) {
      const fb = frameBytes?.[p.variant];
      const bound = fb == null ? null : p.cacheLimitBytes + 2 * fb;
      out.push({ phase: p.phase, budget: `peak live decoded bytes <= cache limit + 2 frames of ${p.variant}`, value: { peak: p.peakLiveDecodedBytes, bound }, pass: bound != null && p.peakLiveDecodedBytes <= bound });
    }
  }
  return out;
}

export function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}
