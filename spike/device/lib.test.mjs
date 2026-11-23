// THROWAWAY — Story 0.5 device driver tests. Not production code; delete after Epic 0.
// Run: node --test spike/device/lib.test.mjs   (or `npm --prefix spike/player run test:device`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { EventEmitter } from "node:events";
import {
  createScreenRecorder,
  blankDefect,
  centreCropRange,
  channelRange,
  decodePng,
  chunkBoundaryStalls,
  createAdb,
  DriverError,
  ensureChromeDevtools,
  evaluateBudgets,
  filmRequests,
  fullFilmEstimate,
  parseArgs,
  preflightDevice,
  rotationDefects,
  setRotation,
  smallestChunkSize,
  summarizePhase,
  withDeviceSession,
} from "./lib.mjs";

/** Fake adb: records calls, answers from a handler, keeps `settings` state. */
function fakeAdb({ online = true, socketAfterPolls = 0, failOn = null, initial = { accelerometer_rotation: "1", user_rotation: "0" } } = {}) {
  const calls = [];
  const settings = { ...initial };
  let polls = 0;
  let launched = false;
  let clock = 0;
  const run = async (args) => {
    calls.push(args.join(" "));
    const a = args.slice(2); // drop -s serial
    if (args[0] === "connect") return { code: 0, stdout: "", stderr: "" };
    if (a[0] === "get-state") return online ? { code: 0, stdout: "device\n", stderr: "" } : { code: 1, stdout: "", stderr: "error: device offline" };
    if (failOn && a.join(" ").includes(failOn)) return { code: 1, stdout: "", stderr: `boom: ${failOn}` };
    if (a[0] === "forward") return { code: 0, stdout: "", stderr: "" };
    if (a[0] === "shell") {
      const c = a[1];
      if (c === "cat /proc/net/unix") {
        if (launched) polls++;
        const up = launched && polls > socketAfterPolls;
        return { code: 0, stdout: `0000: 00000002 @other_devtools_remote\n${up ? "0000: 00000002 @chrome_devtools_remote\n" : ""}`, stderr: "" };
      }
      if (c.startsWith("am start")) {
        launched = true;
        return { code: 0, stdout: "Starting: Intent", stderr: "" };
      }
      let m = c.match(/^settings get system (\w+)$/);
      if (m) return { code: 0, stdout: `${settings[m[1]] ?? "null"}\n`, stderr: "" }; // never written => "null"
      m = c.match(/^settings put system (\w+) (\S+)$/);
      if (m) {
        settings[m[1]] = m[2];
        return { code: 0, stdout: "", stderr: "" };
      }
      m = c.match(/^settings delete system (\w+)$/);
      if (m) {
        delete settings[m[1]];
        return { code: 0, stdout: "", stderr: "" };
      }
      if (c === "pidof screenrecord || true") return { code: 0, stdout: device.recording ? "4242\n" : "", stderr: "" };
      if (c === "pkill -INT screenrecord || true") {
        if (device.recording) {
          device.recording = false;
          device.proc?.emit("exit", 0);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      m = c.match(/^rm -f (\S+)$/);
      if (m) {
        device.files.delete(m[1]);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    if (a[0] === "pull") {
      if (!device.files.has(a[1])) return { code: 1, stdout: "", stderr: `remote object '${a[1]}' does not exist` };
      device.pulled.push([a[1], a[2]]);
      return { code: 0, stdout: "1 file pulled", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  /** Fake background `adb shell screenrecord ...` (an EventEmitter like a ChildProcess). */
  const device = { recording: false, files: new Set(), pulled: [], proc: null, spawned: [] };
  const spawnFn = (cmd, args) => {
    device.spawned.push([cmd, ...args].join(" "));
    const p = new EventEmitter();
    p.exitCode = null;
    p.kill = () => {
      device.recording = false;
      p.exitCode = 1;
      p.emit("exit", 1);
    };
    p.on("exit", (code) => (p.exitCode = code));
    device.proc = p;
    device.recording = true;
    device.files.add(args[args.length - 1].split(" ").pop());
    return p;
  };
  const adb = createAdb("10.0.0.9:5555", { run, sleep: async (ms) => void (clock += ms), now: () => clock });
  return { adb, run, calls, settings, device, spawnFn, now: () => clock };
}

test("phone unreachable: preflight fails naming the device (exit 3)", async () => {
  const { adb, run, calls } = fakeAdb({ online: false });
  await assert.rejects(preflightDevice(adb, run), (e) => e instanceof DriverError && e.exitCode === 3 && e.message.includes("10.0.0.9:5555"));
  assert.ok(calls.includes("connect 10.0.0.9:5555"), "tries adb connect once for a network serial");
});

test("phone online: preflight passes", async () => {
  const { adb, run } = fakeAdb();
  await preflightDevice(adb, run);
});

test("devtools socket absent: launches Chrome with the URL, then waits for the socket", async () => {
  const { adb, calls } = fakeAdb({ socketAfterPolls: 3 });
  const r = await ensureChromeDevtools(adb, "http://h:4173/?hud=1", { timeoutMs: 20_000, pollMs: 500 });
  assert.equal(r.launched, true);
  const start = calls.find((c) => c.includes("am start"));
  assert.ok(start && start.includes("com.android.chrome/") && start.includes("http://h:4173/?hud=1"), start);
});

test("devtools socket never appears: clear error after 20 s", async () => {
  const { adb } = fakeAdb({ socketAfterPolls: Infinity });
  await assert.rejects(ensureChromeDevtools(adb, "http://h/", { timeoutMs: 20_000, pollMs: 500 }), (e) => e instanceof DriverError && /within 20 s/.test(e.message) && e.exitCode !== 0);
});

test("script aborts mid-run: rotation restored and port forward removed, error propagates", async () => {
  const { adb, calls, settings } = fakeAdb();
  await assert.rejects(
    withDeviceSession(adb, 9333, "chrome_devtools_remote", async () => {
      settings.accelerometer_rotation = "0";
      settings.user_rotation = "1"; // test rotated the phone...
      throw new Error("phase exploded"); // ...then died
    }),
    (e) => e.message === "phase exploded" && e.cleanup.rotationRestored && e.cleanup.forwardRemoved,
  );
  assert.deepEqual(settings, { accelerometer_rotation: "1", user_rotation: "0" });
  assert.ok(calls.some((c) => c.endsWith("forward --remove tcp:9333")));
});

test("normal run: rotation equals pre-run values afterwards", async () => {
  const { adb, settings } = fakeAdb();
  const { cleanup, saved } = await withDeviceSession(adb, 9333, "chrome_devtools_remote", async () => {
    settings.user_rotation = "1";
    return 42;
  });
  assert.equal(cleanup.rotationRestored, true);
  assert.deepEqual(saved, { accelerometer_rotation: "1", user_rotation: "0" });
  assert.deepEqual(settings, saved);
});

test("setting never written before the run (\"null\"): deleted again, counted as restored", async () => {
  const { adb, calls, settings } = fakeAdb({ initial: { accelerometer_rotation: "1" } }); // user_rotation unset
  const { cleanup, saved } = await withDeviceSession(adb, 9333, "chrome_devtools_remote", async () => {
    await setRotation(adb, 1); // forces user_rotation=1, accelerometer_rotation=0
  });
  assert.equal(saved.user_rotation, "null");
  assert.ok(calls.some((c) => c.endsWith("settings delete system user_rotation")));
  assert.deepEqual(settings, { accelerometer_rotation: "1" });
  assert.equal(cleanup.rotationRestored, true);
  assert.deepEqual(cleanup.errors, []);
});

test("screen recording: start, SIGINT stop, pull, delete from the phone", async () => {
  const { adb, calls, device, spawnFn, now } = fakeAdb();
  const rec = createScreenRecorder(adb, { spawnFn, now });
  await rec.start();
  assert.equal(rec.state, "recording");
  assert.match(device.spawned[0], /-s 10\.0\.0\.9:5555 shell screenrecord --bit-rate 20000000 --time-limit 180 \/sdcard\/spike-run\.mp4$/);
  assert.ok(rec.ms() >= 0);
  await rec.stop();
  assert.ok(calls.some((c) => c.endsWith("pkill -INT screenrecord || true")));
  assert.equal(device.recording, false);
  await rec.pull("out/x.mp4");
  assert.deepEqual(device.pulled, [["/sdcard/spike-run.mp4", "out/x.mp4"]]);
  await rec.remove();
  assert.equal(device.files.size, 0);
  await rec.abort(); // idempotent after removal
});

test("screen recording: run fails mid-way -> cleanup stops and deletes it, rotation restored", async () => {
  const { adb, device, spawnFn, now, settings } = fakeAdb();
  await assert.rejects(
    withDeviceSession(adb, 9333, "chrome_devtools_remote", async (_saved, addCleanup) => {
      const rec = createScreenRecorder(adb, { spawnFn, now });
      addCleanup("screen recording", () => rec.abort());
      await rec.start();
      await setRotation(adb, 1);
      throw new Error("phase exploded");
    }),
    (e) => e.message === "phase exploded" && e.cleanup.hooksRun === 1 && e.cleanup.rotationRestored && e.cleanup.errors.length === 0,
  );
  assert.equal(device.recording, false);
  assert.equal(device.files.size, 0, "recording deleted from the phone");
  assert.deepEqual(settings, { accelerometer_rotation: "1", user_rotation: "0" });
});

test("rotation: wrong variant / changed frame are logged as defects", () => {
  assert.deepEqual(rotationDefects({ frame: 31 }, { drawnVariant: "16x9/1080", drawnFrame: 31 }, "16x9/1080"), []);
  const d = rotationDefects({ frame: 31 }, { drawnVariant: "9x16/720", drawnFrame: 30 }, "16x9/1080");
  assert.equal(d.length, 2);
  assert.match(d[0], /wrong variant/);
  assert.match(d[1], /31 -> 30/);
});

test("idle phase is summarised separately and is not judged as a scrub", () => {
  const snap = { aspect: "9x16", tier: "720", scrubFpsP5: null, scrubSamples: 0, fpsMedian: 120, fpsP5: 118, requests: 9, requestBytes: 100, decodeErrors: 0, chunkErrors: 0, peakLiveDecodedBytes: 10, cacheLimitBytes: 100 };
  const idle = { ...summarizePhase("idle", snap, { requests: 9, requestBytes: 100, decodeErrors: 0, chunkErrors: 0 }), kind: "idle" };
  assert.equal(idle.requests, 0);
  assert.equal(idle.allFpsMedian, 120);
  const budgets = evaluateBudgets([idle], { desktop: false, frameBytes: { "9x16/720": 1 } });
  assert.ok(budgets.every((b) => !/fps/.test(b.budget)), "no fps budget for idle");
});

test("budgets: phone p5 >= 30, desktop 60, memory bound + 2 frames", () => {
  const fb = { "9x16/720": 10, "16x9/1080": 40 };
  const ph = (p5, median, peak, variant = "9x16/720") => ({ phase: "x", kind: "scrub", variant, scrubSamples: 100, scrubFpsP5: p5, scrubFpsMedian: median, peakLiveDecodedBytes: peak, cacheLimitBytes: 100 });
  let b = evaluateBudgets([ph(31, 60, 120)], { desktop: false, frameBytes: fb });
  assert.deepEqual(b.map((x) => x.pass), [true, true]);
  b = evaluateBudgets([ph(29, 60, 121)], { desktop: false, frameBytes: fb });
  assert.deepEqual(b.map((x) => x.pass), [false, false]);
  b = evaluateBudgets([ph(56, 60, 0)], { desktop: true, frameBytes: fb });
  assert.equal(b[0].pass, true);
  b = evaluateBudgets([ph(50, 60, 0)], { desktop: true, frameBytes: fb });
  assert.equal(b[0].pass, false);
});

test("memory bound uses the phase's own variant, not the largest tier", () => {
  const fb = { "9x16/720": 10, "16x9/1080": 40 };
  const ph = (variant, peak) => ({ phase: variant, kind: "scrub", variant, scrubSamples: 0, peakLiveDecodedBytes: peak, cacheLimitBytes: 100 });
  const [p720, p1080, unknown] = evaluateBudgets([ph("9x16/720", 150), ph("16x9/1080", 150), ph("16x9/540", 101)], { desktop: false, frameBytes: fb });
  assert.deepEqual([p720.value.bound, p720.pass], [120, false]); // 1080 slack (180) would have passed it
  assert.deepEqual([p1080.value.bound, p1080.pass], [180, true]);
  assert.deepEqual([unknown.value.bound, unknown.pass], [null, false]);
});

test("chunk-boundary stall = latency spike at a chunk start frame", () => {
  const by = {};
  for (let f = 0; f < 72; f++) by[f] = 16;
  by[32] = 250;
  const r = chunkBoundaryStalls(by, 16, 72);
  assert.deepEqual(r.boundaries.map((b) => b.frame), [16, 32, 48, 64]);
  assert.deepEqual(r.stalls.map((s) => s.frame), [32]);
  assert.deepEqual(chunkBoundaryStalls({}, 16, 72).stalls, []);
});

test("blank canvas centre is a defect", () => {
  assert.deepEqual(blankDefect(40, "x"), []);
  assert.equal(blankDefect(0, "x").length, 1);
});

test("full-film request maths matches pipeline/README (7,200 frames)", () => {
  assert.equal(filmRequests({ frames: 7200, chunkSize: 16, groups: 5 }), 460);
  assert.equal(filmRequests({ frames: 7200, chunkSize: 16, groups: 40, reserve: 40 }), 535);
  assert.equal(smallestChunkSize({ frames: 7200, groups: 5 }), 52);
  assert.equal(smallestChunkSize({ frames: 7200, groups: 40, reserve: 40 }), 111);
  const est = fullFilmEstimate({ measuredChunkRequests: 5, distinctChunks: 5, chunkSize: 16 });
  const n64 = est.rows.find((r) => r.frames === 7200 && r.packing === "per-act" && r.N === 64);
  assert.equal(n64.requests, 6 + 113 + 4);
  assert.equal(n64.pass, true);
  const row = (frames, packing, N) => est.rows.find((r) => r.frames === frames && r.packing === packing && r.N === N);
  assert.equal(row(7200, "per-act", 72).withOneRotationWorstCase, 219);
  assert.equal(row(7200, "per-shot", 72).requests, 145);
  assert.equal(row(5760, "per-shot", 48).withReserve40, filmRequests({ frames: 5760, chunkSize: 48, groups: 40, reserve: 40 }));
  // the measured ratio scales the chunk term, also for the smallest-N search
  assert.equal(filmRequests({ frames: 7200, chunkSize: 72, groups: 5, ratio: 2 }), 6 + 2 * 104);
  assert.ok(smallestChunkSize({ frames: 7200, groups: 5, ratio: 2 }) > 52);
  const est2 = fullFilmEstimate({ measuredChunkRequests: 10, distinctChunks: 5, chunkSize: 16 });
  const s = est2.rows.find((r) => r.frames === 7200 && r.packing === "per-act" && r.smallestNWithinBudget);
  assert.equal(s.smallestNWithinBudget, smallestChunkSize({ frames: 7200, groups: 5, ratio: 2 }));
});

/** Encode raw pixels as a PNG, one filter type per row (mirrors the PNG spec, CRCs zeroed). */
function encodePng(width, height, ch, pixels, filters) {
  const stride = width * ch;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    const out = Buffer.alloc(stride + 1);
    out[0] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= ch ? up[x - ch] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x + 1] = (row[x] - pred) & 255;
    }
    rows.push(out);
  }
  const chunk = (kind, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(kind, "ascii"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("PNG decoder: all filter types, RGB and RGBA; channel range", () => {
  for (const ch of [3, 4]) {
    const w = 7, h = 10;
    const px = Buffer.alloc(w * h * ch);
    for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i % 5) * 91) & 255;
    const img = decodePng(encodePng(w, h, ch, px, [0, 1, 2, 3, 4]));
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    assert.equal(img.channels, ch);
    assert.deepEqual([...img.data], [...px]);
  }
  const flat = decodePng(encodePng(4, 4, 3, Buffer.alloc(48, 42), [1, 2]));
  assert.equal(channelRange(flat), 0);
  // 6x6 grey with one bright pixel in a corner: the centre 2x2 is uniform, the whole image is not.
  const px = Buffer.alloc(6 * 6 * 3, 50);
  px[0] = 200;
  const img = decodePng(encodePng(6, 6, 3, px, [0, 4]));
  assert.equal(centreCropRange(img, 2), 0);
  assert.equal(centreCropRange(img, 6), 150);
  assert.throws(() => decodePng(Buffer.from("nope")), /not a PNG/);
});

test("CLI parsing", () => {
  assert.equal(parseArgs([]).url, "http://192.168.101.18:4173/?hud=1");
  assert.equal(parseArgs(["--desktop"]).url, "http://127.0.0.1:4173/?hud=1");
  assert.equal(parseArgs(["--device", "x:1", "--port", "9400"]).port, 9400);
  assert.throws(() => parseArgs(["--nope"]), DriverError);
  for (const v of ["abc", "-1", "Infinity"]) assert.throws(() => parseArgs(["--idle-ms", v]), (e) => e instanceof DriverError && e.exitCode === 1);
  assert.equal(parseArgs(["--idle-ms", "0"]).idleMs, 0);
  assert.equal(parseArgs(["--record"]).record, true);
  assert.throws(() => parseArgs(["--record", "--desktop"]), (e) => e instanceof DriverError && e.exitCode === 1);
});
