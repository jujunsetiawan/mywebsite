# Story 0.5 — real-device test and go/no-go for pipeline A

> Spike results (Epic 0). The player and driver under `spike/` are
> **THROWAWAY**. This file records the measurements and the decision that
> carries into Epics 3–5.

Date of runs: **2026-11-23**. Media: `spike-2026-11-21`, shot `ii-03-clock`
(72 frames @ 24 fps, chunk size N = 16, 5 chunks per variant), unchanged from
Story 0.3 (no re-render, no re-encode).

## Devices

| | Android (reference) | Desktop | iPhone |
|---|---|---|---|
| Model | Xiaomi **POCO F7** (`25053PC47G`, codename `onyx`) | Laptop: Ryzen 7 4800HS, RTX 2060 Max-Q, 15 GB RAM | **not available** |
| SoC / RAM | Snapdragon 8s Gen 4 (`SM8735`), ~12 GB (MemTotal 11.0 GiB) | – | – |
| OS / browser | Android 16, Chrome **158.0.8127.42** | Windows, Microsoft Edge **158.0.4370.33**, headed | – |
| Screen | 1280×2772 @ density 520 (DPR 3.25); viewport 394×734 CSS px portrait | 1440×900 viewport, DPR 1, 144 Hz panel (rAF median 144.9) | – |
| Refresh during test | 60 Hz (`dumpsys display` 60.000004; rAF median 59.9) | 144 Hz | – |
| Access | `adb` over Wi-Fi at `192.168.101.13:5555` + Chrome DevTools Protocol | CDP to a spawned Edge | – |

**Android baseline replaced (decision by Jun, 2026-11-23).** The POCO F7
replaces the assumed "~2023 4 GB budget Android" as the Android reference.
Low-end Android is **not a target** (Jun has no low-end device), and no
CPU-throttle proxy was run. The Android numbers below are therefore a
flagship-class result. They say nothing about 4 GB phones.

**iPhone (decision by Jun, 2026-11-23).** No iPhone is available. The iPhone
budget and AD-14 are recorded as **not measured** (see [AD-14](#ad-14-ios-safari-avif-decode-in-a-worker)
and [iPhone procedure](#manual-hud-procedure-for-a-later-iphone-run)).

## Method

- **Server:** production build (`npm --prefix spike/player run build`) served
  by `vite preview --host` on the PC (`http://192.168.101.18:4173/?hud=1`,
  LAN Wi-Fi). The desktop run uses `http://127.0.0.1:4173/?hud=1`.
- **Driver:** [`device/run-device-test.mjs`](device/run-device-test.mjs)
  (helpers and tests in [`device/lib.mjs`](device/lib.mjs) /
  [`device/lib.test.mjs`](device/lib.test.mjs)). For each run it:
  1. opens a fresh tab, clears the HTTP cache and disables it over CDP
     (`Network.setCacheDisabled`), and does one cold load;
  2. **slow forward scrubs ×3**: from the top to the end. Phone: 1.4 s touch
     swipes (`adb shell input swipe`); desktop: 40 px wheel steps every 40 ms.
     Stats are reset before each repetition;
  3. **fast back-and-forth scrubs ×3**: top → end → top with 100 ms flicks
     (phone) or 600 px wheel bursts (desktop);
  4. **rotation** at 43.7 % progress (frame 31): phone
     `settings put system user_rotation 1` with auto-rotate off; desktop
     viewport 1440×900 → 900×1440;
  5. one slow and one fast scrub in the other orientation (its own tier),
     then rotation back at frame 31;
  6. **10 s idle**, recorded as its own phase.
- **Metrics:** HUD snapshots (`window.__spike.snapshot()`), reset between
  phases (`window.__spike.reset()`).
  - **Scrub fps** counts only rAF intervals while `scrollY` changed in the
    last 150 ms.
  - **Latency** is target → drawn: from the first tick that asks for a frame
    to the tick it is on screen (0 = ready in time).
  - Requests come from the CDP request log; throughput from Resource Timing.
- **Rotation settings** are restored on every exit path; before and after are
  recorded in each JSON (`rotationBefore` / `rotationAfter`). Both runs:
  `accelerometer_rotation 0, user_rotation 0` before and after. The port
  forward was removed (`adb forward --list` empty afterwards).
- **Raw data:**
  - [`results/POCO-F7-2026-11-23T09-49-41Z.json`](results/POCO-F7-2026-11-23T09-49-41Z.json) (phone run 1)
  - [`results/POCO-F7-2026-11-23T09-51-42Z.json`](results/POCO-F7-2026-11-23T09-51-42Z.json) (phone run 2)
  - [`results/desktop-edge-2026-11-23T09-52-36Z.json`](results/desktop-edge-2026-11-23T09-52-36Z.json) (desktop)
  - [`results/POCO-F7-rec-2026-11-23T12-32-30Z.json`](results/POCO-F7-rec-2026-11-23T12-32-30Z.json)
    (phone run 3, screen-recorded, no HUD), analysed in
    [`results/POCO-F7-rec-2026-11-23T12-32-30Z.video.json`](results/POCO-F7-rec-2026-11-23T12-32-30Z.video.json).
    See [Visual observation](#visual-observation-automated-screenrecord). The
    MP4 and the exported frames are under `spike/device/out/` (git-ignored).

### Measurement pitfalls found (and fixed in the driver)

Three earlier runs were discarded because the **test harness** distorted
them. They matter for the production player too:

1. **Canvas readback demotes the canvas on Android Chrome.** After the second
   `getImageData` on the film canvas, Chrome switched it to software
   rendering. From then on every new frame cost a 66 ms interval (4 vsyncs),
   and scrub fps p5 fell from 59.9 to 15. Reproduced in isolation: fresh
   canvas → p5 59.9; 1 readback → 59.9; 2 → 20; 5 → 15. **Epics 3–5: never
   read pixels back from the film canvas.**
2. **A clipped CDP screenshot** (`Page.captureScreenshot` with `clip`, also
   Playwright's `page.screenshot({clip})`) leaves an emulation override
   behind. After it, `window.scrollTo` is a no-op on Android Chrome. The
   driver now uses an unclipped capture and crops in Node, and every
   programmatic jump verifies its scroll position.
3. **Pull-to-refresh.** A backward drag that reaches `scrollY 0` while the
   finger is down reloads the page. The driver stops drags short of the top.
   **Epics 3–5:** consider `overscroll-behavior-y: none` on the film page, so a
   visitor scrubbing back to the start does not reload the film.

## Results per device × tier × aspect

Numbers are given as `run 1 / run 2` for the phone. fps are rAF-based
(capped by the display: 60 Hz phone, 144 Hz desktop). The decode path was
**`worker`** in every phase on both devices.

### Android — POCO F7, Chrome 158

**Portrait, 9x16 / 720** (720×1280 frames, 3,686,400 decoded B/frame):

| Phase | Scrub fps median | Scrub fps p5 | Samples | Intervals > 34 ms | Decode ms p50 / p95 | Latency p50 / p95 / max ms | Held ticks (missed) |
|---|---|---|---|---|---|---|---|
| slow-forward-1 | 59.9 / 59.9 | 59.9 / 59.9 | 888 / 858 | 0 / 0 | 24.0/33.5 · 23.2/29.2 | 0/0/0 · 0/0/0 | 0 / 0 |
| slow-forward-2 | 59.9 / 59.9 | 59.9 / 59.9 | 867 / 860 | 0 / 0 | 24.4/29.0 · 24.9/28.3 | 0/0/0 · 0/0/0 | 0 / 0 |
| slow-forward-3 | 59.9 / 59.9 | 59.9 / 59.9 | 873 / 872 | 0 / 0 | 25.7/29.7 · 26.0/29.4 | 0/0/0 · 0/0/0 | 0 / 0 |
| fast-back-and-forth-1 | 59.9 / 59.9 | 59.8 / 59.9 | 116 / 125 | 0 / 0 | 15.3/26.2 · 15.6/26.2 | 0/0/0 · 0/0/0 | 0 / 0 |
| fast-back-and-forth-2 | 60.2 / 59.9 | 59.5 / **30.0** | 112 / 113 | 0 / 0 | 15.3/25.3 · 19.6/34.2 | 0/0/0 · 0/0/50 | 0 / 15 |
| fast-back-and-forth-3 | 59.9 / 59.9 | 59.9 / 59.9 | 122 / 117 | 0 / 0 | 15.4/35.8 · 16.5/20.9 | 0/0/0 · 0/0/33.3 | 0 / 5 |

The one p5 of 30.0 (run 2, fast rep 2): at least 6 of 113 intervals were
33 ms (one dropped vsync each). No interval was longer than 34 ms.

**Landscape, 16x9 / 1080** (1920×1080 frames, 8,294,400 decoded B/frame). The
tier rule picks 1080 because stage width × DPR = 2772 > 1280:

| Phase | Scrub fps median | Scrub fps p5 | Samples | Decode ms p50 / p95 | Latency p50 / p95 / max ms | Superseded targets | Held ticks |
|---|---|---|---|---|---|---|---|
| landscape-slow-forward | 59.9 / 59.9 | 59.9 / 59.9 | 703 / 697 | 39.2/48.4 · 44.1/70.9 | 0/0/0 · 0/0/0 | 0 / 0 | 0 / 0 |
| landscape-fast-back-and-forth | 60.2 / 59.9 | 59.5 / 59.9 | 160 / 164 | 29.9/38.4 · 29.5/44.6 | 0/3.3/50 · 0/6.6/33.3 | 50 / 63 | 58 / 71 |

In fast 1080 flicks the frame rate stays at 60, but the picture skips frames:
50–63 targets were replaced before they were drawn, and the previous frame
was held for 58–71 ticks. Decode (~30–44 ms per 1080 frame, 2 in flight)
cannot follow a flick through 72 frames in under a second. A slow 1080 scrub
never held a frame.

**Main thread:** draw p95 0.1–0.4 ms; tick work p95 ≤ 0.7 ms.

### Desktop — Edge 158, 1440×900, 144 Hz

| Phase | Variant | Scrub fps median | Scrub fps p5 | Samples | Decode ms p50 / p95 | Latency p95 / max ms | Superseded |
|---|---|---|---|---|---|---|---|
| slow-forward-1 | 16x9/1080 | 144.9 | 138.9 | 914 | 22.8 / 27.1 | 0 / 0 | 0 |
| slow-forward-2 | 16x9/1080 | 144.9 | 137.0 | 930 | 23.3 / 25.9 | 0 / 0 | 0 |
| slow-forward-3 | 16x9/1080 | 144.9 | 138.9 | 917 | 23.3 / 26.2 | 0 / 0 | 0 |
| fast-back-and-forth-1 | 16x9/1080 | 144.9 | 140.8 | 112 | 21.4 / 23.9 | 44.1 / 48.6 | 4 |
| fast-back-and-forth-2 | 16x9/1080 | 143.9 | 140.8 | 110 | 21.6 / 25.3 | 43.0 / 48.5 | 8 |
| fast-back-and-forth-3 | 16x9/1080 | 144.9 | 138.9 | 109 | 21.8 / 25.2 | 41.7 / 41.7 | 5 |
| portrait-slow-forward (900×1440) | 9x16/720 | 144.9 | 137.0 | 1451 | 10.2 / 11.5 | 0 / 0 | 0 |
| portrait-fast-back-and-forth | 9x16/720 | 144.9 | 137.0 | 256 | 9.8 / 11.9 | 0 / 0 | 0 |

### Load, memory, requests (all runs)

| Metric | POCO F7 (run 1 / run 2) | Desktop |
|---|---|---|
| Time to first frame (HUD, `performance.now()` at first draw) | **546 / 410 ms** | **234 ms** |
| Time to first frame (driver, navigation → frame 0 drawn) | 591 / 521 ms | 252 ms |
| Cold-load requests before first frame | 5: manifest, frame data, chunks 0–2 (1,192 KiB) | 3 (884 KiB) |
| Peak live decoded bytes, 9x16/720 | 158,515,200 B = **151.2 MiB** (43 bitmaps) | 151.2 MiB (43) |
| Peak live decoded bytes, 16x9/1080 | 157,593,600 B = **150.3 MiB** (19 bitmaps) | 150.3 MiB (19) |
| Cache limit | 157,286,400 B (150 MiB) | same |
| Overshoot past the limit | +0.33 frame (720) / +0.04 frame (1080) | same |
| `performance.memory.usedJSHeapSize` | 9.5 MB in every phase (Chrome Android reports a coarse, constant value; bitmaps are not on the JS heap) | 2.6–10.0 MB |
| Requests, whole run | **13** = 1 manifest + 2 frame data + 10 chunks (5 per variant, each fetched once) | 13 (same) |
| Bytes, whole run (HUD, JSON uncompressed) | 6,965,713 B | 6,965,713 B |
| Requests, portrait only | 7 (1 + 1 + 5), ≈ 1.75 MB | – |
| Requests added by the rotation | 6 (frame data + 5 1080 chunks, 5.05 MB) | 6 |
| Frame-data size (raw / gzip on the wire) | `II.9x16.json` 27,652 B / 3,596 B; `II.16x9.json` 35,273 B / 4,388 B | same |
| Chunk throughput (LAN Wi-Fi, body bytes / body time) | 1.76 / 1.94 MB/s, TTFB median 16 / 18 ms. **Conservative lower bound:** these runs computed body time as duration − TTFB, which still includes queueing / connection time. The N = 72 time estimates derived from it are therefore upper bounds. The driver now uses `responseEnd − responseStart`. | 141 MB/s (loopback) |
| Idle 10 s: fps (all intervals) median / p5 | 59.9 / 59.9, 0 requests | 144.9 / 138.9, 0 requests |

### Rotation

| | POCO F7 (run 1 / run 2) | Desktop |
|---|---|---|
| Portrait → landscape | 9x16/720 → **16x9/1080**, frame 31 → **31** | 16x9/1080 → 9x16/720 (900×1440), frame 31 → 31 |
| Driver time, command → new variant drawn | 1,443 / 1,453 ms | 290 ms |
| Player latency, variant switch → drawn | 745 / 786 ms | 41 ms |
| Back | 16x9/1080 → **9x16/720**, frame 31 → **31** | 9x16/720 → 16x9/1080, frame 31 → 31 |
| Driver time / player latency (back) | 689 / 703 ms · 46 / 46 ms | 309 ms · 42 ms |

Breakdown of the 1.45 s on the phone:

- the Android rotation animation;
- the 200 ms resize debounce;
- the 16x9 frame data, plus 1080 chunks 1 and 2 (1.1 + 1.3 MB, 603–912 ms over
  Wi-Fi);
- one 1080 decode.

Rotating back reuses the 9x16 chunks already in memory. That path costs only
the animation, the debounce and one decode.

### Visual defects

| Defect | How checked | Result |
|---|---|---|
| Blank frames | After every phase: an unclipped CDP screenshot, cropped to the central 32×32 CSS px. The channel range must be > 4 (0 = uniform). The player never clears the canvas; a frame not yet decoded keeps the previous one. | **None.** Range 10–222 on the phone, 9–79 on desktop. |
| Wrong variant after rotation | `drawnVariant` vs the expected aspect/tier, and `drawnFrame` vs the frame before rotating | **None.** All four phone rotations and both desktop rotations drew the expected variant at frame 31. |
| Stutter at chunk boundaries | Worst target→drawn latency at frames 16/32/48/64 vs 3× the median of all frames' worst latency (and > median + 50 ms) | **None.** 0 ms at every boundary in all slow scrubs; ≤ 50 ms max in fast scrubs, not at boundaries. **Caveat:** only the latency of *drawn* frames at the *forward* chunk starts (16/32/48/64) is checked. Superseded (never drawn) frames and the backward boundaries (15/31/47/63) are not covered. |
| Tearing | Screen recording of phone run 3 plus a tearing heuristic, every candidate inspected by eye ([Visual observation](#visual-observation-automated-screenrecord)) | **None found.** 23 raw candidates; 3 passed the automatic confirmation; all 23 were film content (flat monitor face, dark low-contrast ceiling, letterboxed landscape strip), with coherent whole-frame motion and no seam. Limit: screenrecord captures the composited frames, not the panel scan-out. |
| Skipped frames in fast flicks | `latencySuperseded`, `missedTicks` | Phone 16x9/1080 fast: 50–63 frames skipped, 58–71 held ticks (see above). Portrait 720 fast: 0–10 / 0–15. |

**Observation of a phone run:** replaced by the automated screen-recording
check below (Jun approved the follow-up, 2026-11-23). It found no blank
frame, no wrong variant after rotation, no tearing, and no player stall. The
longest still intervals while scrolling are explained by still film content.

## Visual observation (automated, screenrecord)

**Run.** Phone run 3 (`POCO-F7-rec-2026-11-23T12-32-30Z`), same script as
runs 1–2:

- **Command:**
  `node spike/device/run-device-test.mjs --record --url http://192.168.101.18:4173/`.
- **No HUD** (no `?hud=1`), so HUD text never caused screen changes; the
  `__spike` hook still provides the stats.
- **Recording:** `adb shell screenrecord --bit-rate 20000000 --time-limit 180`
  produced an H.264 file at 1280×2772: 4,116 frames over 115.5 s, 29.0 MB. It
  was pulled to `spike/device/out/` and deleted from the phone.
- **Phone state:** rotation settings before and after were
  `accelerometer_rotation 0, user_rotation 0`; cleanup reported no errors.

**Method** ([`device/analyze-video.mjs`](device/analyze-video.mjs), helpers
in [`device/video.mjs`](device/video.mjs), tested on synthetic frames):

1. **Timestamps:** ffprobe gives one timestamp per recorded frame.
   screenrecord is variable frame rate and only emits a frame when the screen
   changes.
2. **Decoding:** ffmpeg decodes every frame without dropping or duplicating
   (`-fps_mode passthrough`) to 120×260 grayscale. Each frame is reduced to
   5×5-px cells: mean luminance, and mean absolute difference (MAD) to the
   previous frame.
3. **Alignment:** right after the recording starts, the blank tab flips
   black, then white. Matching the two flips aligns the driver clock with
   the video clock: offset −0.609 s, residual 18 ms.
4. **Visible change:** content-area MAD > 0.5 gray levels.
   - Portrait content area: full width, top 11 % (status bar, toolbar) and
     bottom 3 % (gesture bar) cropped.
   - The idle phase recorded **0 visible changes**, so the threshold sits
     above the noise floor.
   - Recorded frames below the threshold are mostly H.264 re-encode noise:
     the status bar's network-speed counter triggers a frame every second,
     and each frame carries tiny differences over the whole picture.
5. **Active scrolling:** per gesture, from the first to the last visible
   change before the next gesture starts. This counts touch plus fling and
   excludes the driver's pauses. The new-frame rate is the number of
   intervals between visible changes per second of active time.
6. **Tearing heuristic:**
   - **Raw candidate:** a contiguous band of ≥ 15 % of the content height has
     MAD < 0.5 while the other bands' median MAD ≥ 2 (≥ 80 % of them
     > 1.0).
   - **Confirmed:** the still band is also textured (cell-luminance mean
     deviation ≥ 4; a flat area cannot show motion) and catches up in the
     next visible change (band MAD ≥ 2; a torn frame is transient, static
     content stays still).
   - Every raw candidate is exported (previous frame, frame, ×8 luma diff)
     and was looked at.
7. **Landscape:** screenrecord keeps the starting portrait frame, so landscape
   content appears upright and letterboxed: a 1280×591 strip, with the
   display cutout at the left. The content box is found from cells that are
   not black over the phase, and 20 % is trimmed at both ends of its vertical
   axis (status bar, toolbar). At 120-px analysis width the strip is only
   ~27 px tall (8 bands), so landscape numbers are coarser.

**Per phase:**

| Phase | Visible changes | Player draws (HUD) | Visible / draw | New-frame rate (active) | Longest no-change while scrolling | Median gap | Gaps > 50 ms | Tear candidates (confirmed) |
|---|---|---|---|---|---|---|---|---|
| slow-forward-1 | 66 | 71 | 0.94 | 6.6 /s | 516 ms | 167 ms | 48 / 59 | 2 (0) |
| slow-forward-2 | 53 | 72 | 0.74 | 5.9 /s | 185 ms | 167 ms | 46 / 46 | 2 (0) |
| slow-forward-3 | 53 | 72 | 0.74 | 5.8 /s | 186 ms | 167 ms | 46 / 46 | 2 (0) |
| fast-back-and-forth-1 | 112 | 78 | 1.44 | 51.3 /s | 216 ms | 16.6 ms | 2 / 107 | 4 (1) |
| fast-back-and-forth-2 | 112 | 77 | 1.45 | 51.2 /s | 217 ms | 16.7 ms | 2 / 107 | 1 (0) |
| fast-back-and-forth-3 | 111 | 75 | 1.48 | 50.2 /s | 212 ms | 16.6 ms | 3 / 106 | 1 (1) |
| landscape-slow-forward (16x9/1080) | 62 | 76 | 0.82 | 9.1 /s | 342 ms | 133 ms | 42 / 56 | 5 (0) |
| landscape-fast-back-and-forth (16x9/1080) | 58 | 64 | 0.91 | 30.6 /s | 200 ms | 16.8 ms | 7 / 52 | 6 (1) |
| rotations / cold load / idle | 24 / 32 / 2 / 0 | – | – | – | – | – | – | idle 0 |

**Reading the numbers:**

- **Slow scrubs are content-limited, not frame-rate-limited.**
  - The canvas only changes when the scroll position crosses into the next
    film frame. At this scrub speed that happens about every 167 ms (the
    median gap), so "gaps > 50 ms" is nearly every interval by design.
  - Visible changes are 0.74–0.94 per player draw because the shot's second
    half (frames ~36–71, a near-static hold with a slow push) changes by less
    than the threshold between neighbouring frames.
  - **The 516 ms gap** comes during the first swipe of the run, 0.95 s into
    slow-forward-1. The exported frames on both sides show the shot's still
    opening hold (frames 0–4, "holds still for 6 % of the shot",
    `pipeline/README.md`), with the toolbar already hidden. The HUD shows
    0 missed ticks and 0 ms latency for that phase: no stall.
- **Fast scrubs:** the screen produced new pictures ~51 times per second at a
  median 16.6 ms gap, close to the 60 Hz cadence. Only 2–3 gaps per rep
  exceeded 50 ms, at most 217 ms. These lie in the near-static part of the
  shot or at a turn-around. More visible changes than player draws
  (×1.45) come from real screen changes besides film frames: the Chrome
  toolbar showing/hiding, and the overscroll stretch at the ends.
- **Landscape 16x9/1080, fast flicks:** the picture changed only 30.6 times
  per second, while the HUD counted 45 superseded targets and 53 held ticks.
  The recording confirms the [visible-smoothness caveat](#budgets): the frame
  rate holds, but the picture skips frames during fast flicks in phone
  landscape.
- **Tear candidates, verdict after inspecting every exported frame:**
  **no tearing.**
  - Portrait: 12 raw candidates. The 10 unconfirmed ones are the flat,
    emissive monitor face at the bottom of the frame. It shows almost no
    difference when it moves, while the room above moves; the confirmation
    rejects all 10 as "flat".
  - Portrait confirmed candidates (2): the same film transition in two reps,
    identical metrics. The still band is the dark, low-contrast ceiling at
    the top (texture 4.1, just above the threshold). The frame is intact:
    monitor top 727 → 741 px and clock 490 → 497 px move together, and the
    diff shows coherent motion over the whole frame.
  - Landscape (11 raw, 1 confirmed): the still band is the smooth ceiling
    (plus the edge of the toolbar) above a changing window and city-lights
    strip. The 10 unconfirmed ones were rejected as flat, as staying still in
    the next frame, or as having no visible change within 100 ms after them.
    Coherent small motion, no seam.
  - Files: `spike/device/out/POCO-F7-rec-2026-11-23T12-32-30Z/tearNN-*-{a-prev,b-frame,c-diff}.png`.
- **Rotation and blank frames:** the samples
  `rotate-to-landscape-sample3-t78.102.png` and
  `rotate-to-portrait-sample*.png` show the 16x9 and 9x16 variants drawn
  after each rotation. No sample or candidate frame was blank.
- **Recording cost:** screenrecord encodes 1280×2772 at 20 Mbps on the phone
  and costs some performance, so **this run does not replace the fps budget
  numbers** (runs 1–2). For comparison, the recorded run's HUD scrub fps was:
  - portrait slow: median 59.9–60.2, p5 59.9;
  - portrait fast: p5 59.9, vs 59.5–59.9 and one 30.0 in runs 1–2;
  - landscape: p5 59.9 / 59.5.

  No drop was measurable on this phone at 60 Hz.
- **Limits:**
  - screenrecord captures SurfaceFlinger's composited frames, not the panel
    scan-out. Panel-level (vsync) tearing is invisible to it; only an
    external camera could show that.
  - The heuristic and its thresholds were tuned on this run, and validated
    only by looking at its candidates.
  - Alignment error is about ±20–50 ms at phase edges.

**Exported samples** (first, middle and last visible change per phase,
540 px wide), all in `spike/device/out/POCO-F7-rec-2026-11-23T12-32-30Z/`.
Examples: `slow-forward-1-sample{1,2,3}-t*.png`,
`fast-back-and-forth-1-sample{1,2,3}-t*.png`,
`landscape-fast-back-and-forth-sample{1,2,3}-t*.png`,
`rotate-to-landscape-sample{1,2,3}-t*.png`. There are 33 samples and 69
tear-candidate files (23 × prev / frame / diff).

## Budgets

| Budget | Device | Evidence | Verdict |
|---|---|---|---|
| Scrub fps p5 ≥ 30 | POCO F7, 9x16/720 | lowest p5 over 12 scrub phases (2 runs) = **30.0** (one fast rep); all others 59.5–59.9 | **PASS** (narrow on the one rep at 30.0) |
| Scrub fps p5 ≥ 30 | POCO F7, 16x9/1080 | p5 59.5–59.9 over 4 phases | **PASS** |
| Scrub fps p5 ≥ 30 | iPhone | – | **NOT MEASURED** (no device) |
| 60 fps on desktop (judged as median ≥ 58 and p5 ≥ 55) | Edge, 16x9/1080 and 9x16/720 | median 143.9–144.9, p5 ≥ **137.0** on a 144 Hz display | **PASS** |
| Decoded memory within the look-ahead bound (+ ≤ 2 frames, as documented in 0.4) | all | peak live = limit + 0.33 frame (720) / + 0.04 frame (1080) | **PASS** |
| Full film ≤ 150 requests per watch | estimate | N = 16 (current): 370–495 → **FAIL**; N = 72 per act: 90–110 → **PASS** (table below) | **FAIL at N = 16, PASS at N = 72 per act** (extrapolated, see below) |

**What "scrub fps" measures.** Scrub fps is the cadence of
`requestAnimationFrame` while scrolling, **not** the number of new film
frames shown. The budget is met when the page keeps animating, even if the
picture holds the previous frame. On the phone in 16x9/1080, fast flicks
skipped **50–63 of 72 frames** (held frames; `latencySuperseded` /
`missedTicks`). The fps budget passes there, but this is a
**visible-smoothness caveat**: the picture jumps during fast flicks in phone
landscape.

**N = 72 is an extrapolation.** Every run used N = 16 (the published
`spike-2026-11-21` media). The N = 72 request counts are computed, and its
time-to-first-frame / seek cost was never measured. They depend on
streaming decode of slices as chunk bytes arrive, which is **not yet
prototyped**. Both must be validated in the Epic 4 player (Story 4.2).

### Full-film request estimate

Measured per watch:

- every chunk was requested exactly once (10 requests for 10 distinct
  chunks, ratio **1.00**);
- frame data: 1 request per aspect.

Extrapolation (functions in `device/lib.mjs`, same maths as
`pipeline/lib/pack.py`):

```
requests = 6 fixed (1 manifest + 5 per-act frame data)
         + (ceil(frames / N) + groups − 1) × 1.00
```

Film length: 5,760–7,200 frames (4–5 min @ 24 fps), see `pipeline/README.md`.

| Frames | Packing | N = 16 | N = 48 | N = 64 | N = 72 | N = 96 | Smallest N ≤ 150 | … with 40 reserved (plates/loops/audio) |
|---|---|---|---|---|---|---|---|---|
| 5,760 | per act (5) | 370 | 130 | 100 | **90** | 70 | 42 | 58 |
| 7,200 | per act (5) | 460 | 160 | 123 | **110** | 85 | 52 | **72** |
| 5,760 | per shot (~40) | 405 | 165 | 135 | 125 | 105 | 55 | 89 |
| 7,200 | per shot (~40) | 495 | 195 | 158 | 145 | 120 | 69 | 111 |

**Rotation.** A watch with one rotation re-fetches the other aspect from the
rotation point onwards. That is +1 frame-data request per remaining act, plus
the remaining chunks. The measured cost for this shot was +6 requests.

- **Worst case**, rotation at the start (7,200 frames, per act, N = 72):
  219 requests. This exceeds 150.
- **Mid-film rotation:** about 165.

So the ≤ 150 budget holds for a watch **without rotation**. Treating a
rotation as an allowed overrun was **accepted by Jun at sign-off
(2026-11-23)**. This settles the deferred 0.3 item "request budget incl.
rotation".

**Frame-data size, full film.** Per aspect: about 2.8–3.5 MB raw, or about
0.36–0.44 MB gzip (measured 3,596 B and 4,388 B gzip per 72 frames).

## AD-14: iOS Safari AVIF decode in a worker

**Not measured.** No iPhone was available (decision by Jun, 2026-11-23). It
remains open whether iOS Safari decodes AVIF eagerly in a worker's
`createImageBitmap`, or defers the decode to `drawImage` on the main thread.
**It must be re-verified on iOS Safari before Epic 4 (Stories 4.7 / 10.1).**

For comparison, Chromium on Android does decode eagerly in the worker:

- decode time inside the worker's `createImageBitmap`: 15–44 ms p50;
- main-thread `drawImage` p95: ≤ 0.4 ms;
- scrub frames stayed at 60 fps with zero held frames on slow scrubs.

### Manual HUD procedure for a later iPhone run

1. On the PC: `npm --prefix spike/player run build`, then
   `npm --prefix spike/player run preview -- --host`. For a secure context
   (Clipboard API), also run `cloudflared tunnel --url http://localhost:4173`
   and use the `https://…trycloudflare.com` URL.
2. On the iPhone (Safari, record the iOS version and model): open
   `http://<pc-ip>:4173/?hud=1` once in a **new private tab** (cold load). The
   HUD must show `path worker`; otherwise note the fallback reason.
3. **Cold load:** wait for frame 0, then press **[Copy results]**. Paste the
   JSON into `spike/results/iphone-<model>-<date>-cold.json`. Over plain
   HTTP, long-press the text box → Select All → Copy.
4. **Slow forward ×3:** slow drags from the top to the end. After each one,
   [Copy results] → `…-slow-<n>.json`. Reload in between to reset the stats,
   or note that the values are cumulative.
5. **Fast back-and-forth ×3:** flick to the end and back to the top (stop
   short of the very top to avoid a reload) → `…-fast-<n>.json`.
6. **Rotation:** scrub to about 40 %, rotate to landscape. Check that the HUD
   variant is `16x9/…` at the same frame → copy. Then rotate back and check
   for `9x16/720` → copy.
7. **Idle:** 10 s without touching → copy.
8. **Read and record:**
   - `scrubFpsP5` (budget ≥ 30); `decodeMsP50/P95` vs `drawMsP95`;
   - **AD-14:** if decode ms is tiny (≈ 0–2 ms) while `drawMsP95` or the scrub
     fps p5 is bad, Safari defers the decode to `drawImage` on the main thread.
     If decode ms is ~10–50 ms with `drawMsP95` < 1 ms, Safari decodes eagerly
     in the worker;
   - `peakLiveDecodedBytes`, `requests`, `timeToFirstFrameMs`, and any
     visual defects.
9. Add a table to this file and fill in the iPhone rows under Budgets and
   AD-14.

## Fallback options

| Option | Expected effect | Cost |
|---|---|---|
| **540 tier on phones** | About half the bytes and decode pixels of 720, a quarter of 1080. Much faster decode, so fewer skipped frames in fast flicks; smaller chunks, so faster first frame and rotation | Visibly softer on DPR 3 phone screens; one more encode variant (storage, encode time); the manifest union already allows `540` |
| **Larger chunk size N** (64–96, per act) | 85–123 requests in total at 7,200 frames, inside 150 (table above) | Bigger chunks before the first frame or after a seek: 9x16/720 ≈ 1.77 MB, 16x9/1080 ≈ 5.1 MB at N = 72. Measured LAN Wi-Fi (≈ 1.85 MB/s, a lower bound) gives at most ≈ 1.0 s and ≈ 2.8 s for a whole chunk. Needs streaming decode of slices as bytes arrive. More compressed bytes held in memory |
| **Lower authoring fps** (e.g. 18 or 12) | Frames, bytes, requests and render time ×0.75 / ×0.5 (render: ~40–50 GPU-h → 30–37 or 20–25 GPU-h for 16:9 1080) | Coarser steps when scrubbing slowly; camera motion reads less smooth; affects the authoring and timing of every shot |
| **Lite layered plates as the phone default** | Few stills plus DOM/CSS parallax: minimal decode, few requests, tiny memory | Loses the photoreal camera move on phones (the main asset of the film); extra authoring per shot; two experiences to keep in sync |
| **Video / WebCodecs scrub path** | Inter-frame compression (several times smaller), one file per act (requests far below 150) | Seeking needs a keyframe-dependent decode (GOP, all-intra = no saving); WebCodecs support on iOS Safari unverified; frame-accurate quads must be re-mapped; **needs an architecture decision update** (AD) |

**Chosen: conditional go** (see [Decision](#decision-recommendation)). No fallback is adopted now. If the iPhone run fails the
fps budget, try **540 on phones** first (smallest change, no architecture
change), then Lite plates.

## Decision (signed off by Jun, 2026-11-23)

**Conditional GO for pipeline A** (offline renders → AVIF frame chunks →
worker decode → scroll-scrubbed canvas).

- **Android reference (POCO F7) and desktop meet every fps and memory budget**,
  with no blank frames, no wrong variants and no chunk-boundary stalls (within
  the checks' coverage, see Visual defects).
  - Scrub fps measures rAF cadence, not new frames shown.
  - On the phone in 16x9/1080, fast flicks skip 50–63 of 72 frames (held
    frames). This is a visible-smoothness caveat, although the fps budget
    passes.
- **The request budget holds only with larger, per-act chunks** (not at
  today's N = 16). N = 72 is an extrapolation and was never measured. It
  depends on streaming slice decode, which is not yet prototyped. Validate
  both in the Epic 4 player (Story 4.2).
- **Conditions:**
  1. iOS Safari (iPhone) re-verification of the ≥ 30 fps p5 budget and AD-14
     before Epic 4 (Stories 4.7 / 10.1).
  2. Low-end Android is out of scope (Jun, 2026-11-23).
  3. Network numbers (time to first frame, rotation time, chunk throughput)
     are LAN Wi-Fi only. Re-measure them over the CDN / cellular once the media
     is hosted (Epic 1.2 / 4.2).

  The earlier condition "Jun's manual observation of one phone run" is
  covered by the automated screen-recording check (no tearing, no blank
  frame, no wrong variant, no player stall). That check cannot see
  panel-level tearing (see its Limits). **Jun's sign-off below is the
  remaining human step.**

### Parameters carried into Epics 3–5

| Parameter | Value | Why |
|---|---|---|
| Chunk packing | **per act** (5 groups, as AD-14 / AR14) | per shot needs N ≥ 55–111 for the same budget |
| Chunk size N | **72 frames** (3 s @ 24 fps) | Smallest round N that fits ≤ 150 at 7,200 frames **including** the 40-request reserve (150). Without the reserve: 110 requests (7,200 frames), 90 (5,760). Settles the deferred 0.3 item "chunk size N and per-act packing" |
| Encoder | unchanged from `pipeline/README.md`: FFmpeg 9.1 libaom-av1, still-picture AVIF, `-crf 18 -b:v 0`, `-cpu-used 4`, 4:2:0 8-bit, full range BT.709 / sRGB, **grain synthesis off** | Decoded on Chrome Android in 15–44 ms (p50) per frame; no decode errors; no visible artefacts in the recorded run's sample and candidate frames (automated screen-recording check) |
| Look-ahead bound | **150 MiB decoded bytes** (`w × h × 4`); live bitmaps may exceed it by ≤ 2 frames | Measured peak: limit + 0.33 frame. 60 fps held on a 12 GB phone. Unverified below that; revisit with the iPhone run |
| Player rules | Decode in a worker. **Never read back the film canvas** (getImageData demotes it to software on Android). Stream chunk bodies and decode slices as they arrive, so N = 72 does not delay the first frame by a whole chunk. Consider `overscroll-behavior-y: none` (pull-to-refresh) | Measured pitfalls above |
| Tier rule (spike) | 16x9: 1080 when stage width × DPR > 1280, else 720; 9x16: 720 | Phone landscape ran 1080 at 60 fps p5, but skips frames on fast flicks; 540 / 720 for phone landscape is a candidate |

## Sign-off

Recommendation written by the implementing agent on 2026-11-23. The story is
done only after Jun signs below.

- Decision: ☑ GO (conditional, as above) ☐ GO with fallback: ______ ☐ NO-GO
- Signed: Jujun Setiawan (Jun)  Date: 2026-11-23
- Accepted with this sign-off: the rotation request overrun above 150 per
  watch, chunk size N = 72 (per act, to be validated in Story 4.2), and the
  desktop "60 fps" reading (median ≥ 58, p5 ≥ 55). Conditions in the Decision
  section stay open: iOS Safari re-verification before Epic 4, network
  re-measurement over the CDN / cellular, low-end Android out of scope.
