# spike/player/ — scrub player prototype (Story 0.4)

> **THROWAWAY.** This is Epic 0 spike code, not production code. It exists to
> measure whether scroll-scrubbed AVIF chunk sequences play smoothly (Story
> 0.5 tests it on real phones). Do not import it from `src/`; delete it after
> Epic 0. The only reusable piece of the spike is `../manifest/manifest-schema.ts`
> (types are imported from there).

Plain Vite + TypeScript. No framework, no scroll library, no service worker,
no audio.

## What it does

1. Loads `media/asset-manifest.json`, then `media/<mediaVersion>/frames/II.<aspect>.json`.
2. Fetches **whole chunks** (`chunk-NNNN.bin`) by URLs built from the manifest
   `urlPattern` (media base `./media`). One request = one chunk, never per-frame
   files, each chunk fetched once (kept in memory; they are small).
3. Decodes each frame's slice with `createImageBitmap` in a dedicated Worker
   (`src/decode.worker.ts`), `ImageBitmap` transferred back. If the worker
   cannot be created, fires an error, or has no `createImageBitmap`, it
   switches permanently to main-thread decode (logged once; the HUD shows
   `path main` and the reason). A single bad frame only fails that frame,
   which is retried after about 2 s.
4. Keeps a look-ahead cache bounded in **decoded** bytes (`w × h × 4` per frame,
   default 150 MB), biased towards the scroll direction, evicting
   farthest-from-playhead first and calling `close()`.
5. Scrubs by native scroll: a spacer of 6 × `innerHeight`,
   `progress = scrollY / (spacer − innerHeight)`,
   `frame = min(frameCount − 1, floor(progress × frameCount))`. The scrollbar is
   hidden; wheel/touch are not intercepted. If the needed frame is not decoded
   yet, the last drawn frame stays on screen.
6. Draws on one canvas, cover-cropped at `devicePixelRatio`, and positions an
   SVG outline on the per-frame monitor quad through the same transform (the
   stage clips quads that leave the frame; a `null` quad hides it).
7. Variant: stage height > width ⇒ `9x16`, else `16x9`, re-evaluated at
   resize-end / orientation change keeping progress. Tier: `9x16` always 720;
   `16x9` uses 1080 when stage width × DPR > 1280, else 720.

## Run

```powershell
cd spike/player
npm install
npm run copy-media          # pipeline/out/spike-2026-11-21 -> public/media/ (git-ignored)
npm run dev                 # http://localhost:5173/?hud=1
```

`copy-media` takes an optional mediaVersion: `node scripts/copy-media.mjs spike-2026-11-21`.
It copies the mediaVersion directory to `public/media/<mediaVersion>/` and the
manifest to `public/media/asset-manifest.json` (the entry point).

| Command | What |
|---|---|
| `npm test` | Vitest: pure modules in `src/core/` and the decoder fallback |
| `npm run build` | `tsc` type-check + `vite build` to `dist/` (git-ignored; includes the media) |
| `npm run smoke` | Headless check in the installed Microsoft Edge (see below) |

## Query parameters

| Param | Default | Meaning |
|---|---|---|
| `hud=1` | off | performance HUD + [Copy results] |
| `cacheMB=<n>` | 150 | decoded-frame cache bound in MB |
| `tier=1080\|720` | auto | force a tier where the active variant offers it (9x16 has 720 only) |

## HUD (`?hud=1`)

`path` (worker/main + fallback reason), `variant` (aspect/tier), current and
drawn frame, `missed` (rAF ticks where the target frame was not decoded yet),
fps median and p5 (from rAF intervals over the last ~600 frames), frame
interval median/p95 and draw time p95, decode ms p50/p95 (time inside
`createImageBitmap` on the active path), cache bytes held / limit, **live
decoded bytes** (every open `ImageBitmap`: cache entries plus the on-screen
frame after it was evicted and decode results not yet inserted — this is the
real decoded memory and can exceed the cache limit by a frame or two), chunk
bytes held, `performance.memory` heap where available (Chromium only), request
count and bytes.

Story 0.5 additions (spike-only):

| Field (JSON) | HUD line | Meaning |
|---|---|---|
| `scrubFpsMedian` / `scrubFpsP5` / `scrubSamples` | `scrub` | fps from rAF intervals **only while scrollY changed in the last 150 ms** (idle frames excluded) |
| `scrubLongIntervals`, `scrubLongLog` | – | active intervals > 34 / > 50 ms, and the first 100 > 50 ms with frame / cache context |
| `latencyMsP50` / `P95` / `Max`, `latencySuperseded`, `latencyByFrameMax` | `latency` | target → drawn: from the first tick that asks for a frame to the tick it is on screen (0 = ready in time); targets replaced before being drawn; worst latency per frame (chunk-boundary check) |
| `timeToFirstFrameMs` | `first frame` | `performance.now()` at the first drawn frame (ms since navigation start) |
| `peakLiveDecodedBytes` / `peakLiveDecodedBitmaps` | `live … peak` | peak open-bitmap bytes since the last reset |
| `resizeEvents` / `canvasResizes` | – | resize events, and `measure()` calls (canvas size set), since the last reset (e.g. phone toolbar show/hide) |

`window.__spike.reset()` clears the rolling stats (fps, scrub fps, frame /
draw / decode times, latency, missed ticks, peaks, resize counters) between
test phases; cumulative counters (requests, bytes, errors) and the time to
first frame are kept.

**[Copy results]** copies a JSON summary (all of the above plus user agent and
viewport) with the Clipboard API. Over plain HTTP (LAN) there is no Clipboard
API: the JSON appears in a selected text box; `document.execCommand("copy")`
is tried, otherwise copy it by hand (long-press → Copy on phones).

Note for Story 0.5: on browsers that defer AVIF decode to `drawImage` (the
open iOS Safari question), decode ms will look tiny and the cost moves into
`draw p95` / fps p5 — compare both.

## Phones on the LAN

```powershell
npm run dev -- --host       # prints a Network URL, e.g. http://192.168.1.20:5173/
```

Open the Network URL with `?hud=1` on the phone (same Wi-Fi). Windows may ask
to allow Node.js through the firewall (allow on private networks).

### HTTPS via a Cloudflare quick tunnel

Some APIs (Clipboard) need a secure context. With `cloudflared` installed
(`winget install --id Cloudflare.cloudflared`):

```powershell
npm run dev -- --host                         # terminal 1
cloudflared tunnel --url http://localhost:5173  # terminal 2: prints https://<random>.trycloudflare.com
```

`vite.config.ts` already allows `*.trycloudflare.com` hosts for `dev` and
`preview`. To test the production build instead: `npm run build; npm run preview -- --host`
and tunnel to port 4173. Quick tunnels are temporary and public; stop them
after testing.

## Headless smoke check

```powershell
npm run smoke
```

Starts an in-process Vite dev server on a random port, launches the installed
Microsoft Edge headless and attaches over CDP via `playwright-core` (no
browser download), then stops both. It checks: no console errors; decode path
`worker`; manifest and frame data requested before any chunk; only manifest /
≤ 2 frame-data / whole-chunk requests, each chunk once; scrub to frame 71 and
back to 0 never blank; same progress ⇒ same frame from both directions;
1440×900 ⇒ 16x9/1080, rotate to 390×844 ⇒ 9x16/720 drawn at the same frame;
outline on frame 0; with `?cacheMB=40` the cache's own entries never exceed
40 MB, and the live decoded bitmaps stay within cache entries + in-flight
decodes + the on-screen frame (so live decoded bytes can exceed the limit by
about one or two frames); a 404 manifest shows error text without an exception.
`EDGE_PATH` overrides the Edge location.

## Device test driver (Story 0.5)

[`../device/run-device-test.mjs`](../device/run-device-test.mjs) runs the
scripted test (cold load, 3 slow forward scrubs, 3 fast back-and-forth
scrubs, rotation + one slow and one fast scrub in the other orientation,
rotation back, 10 s idle) and writes `spike/results/<device>-<timestamp>.json`.
Results and the go/no-go: [`../RESULTS.md`](../RESULTS.md).

```powershell
npm run build; npm run preview -- --host      # terminal 1 (production build on the LAN, port 4173)
npm run device                                # Android over adb + CDP (default device 192.168.101.13:5555)
npm run device -- --device <serial> --url http://<pc-ip>:4173/?hud=1
npm run device:desktop                        # headed Edge, 1440x900, mouse wheel
npm run test:device                           # node:test for the driver helpers (fake adb)
```

- **Android:** the phone must be unlocked. The driver launches Chrome via
  `am start` if its DevTools socket is absent, forwards
  `localabstract:chrome_devtools_remote`, opens a fresh tab with the HTTP
  cache disabled, scrubs with real `adb shell input swipe` gestures, and
  rotates with `settings put system user_rotation` (auto-rotate off). The
  original rotation settings and the port forward are restored afterwards,
  also on errors and Ctrl+C.
- **Exit codes:** `0` completed (budgets may still fail; see the JSON), `1`
  usage, `2` preview server unreachable, `3` device unreachable / locked,
  `4` Chrome DevTools not reachable, `5` run or cleanup failed, `130`
  interrupted.
- **Do not read the canvas back on Android:** two `getImageData` calls
  switch Chrome's 2D canvas to software rendering (every new frame then
  costs ~66 ms), and a clipped CDP screenshot makes `window.scrollTo` a
  no-op. The blank-frame check uses an unclipped CDP screenshot instead.
  The desktop smoke check still uses `getImageData` (harmless there).

## Known limits (spike)

- Chunks stay in memory once fetched (≈ 1–5 MB per variant for this shot); only
  decoded bitmaps are bounded. A full film would need chunk eviction too.
- No tier downgrade logic, no seek-latency optimisation, no prefetch of the
  other aspect.
- Phone toolbar show/hide (small height-only resizes) only resizes the canvas;
  the spacer is kept so scrolling does not jump. Progress can shift by a
  fraction of a frame while the toolbar animates.
- `fps` is measured from all `requestAnimationFrame` intervals, including idle
  time (60 fps when nothing moves). Judge budgets on `scrub fps` (active
  scrolling only, Story 0.5).
