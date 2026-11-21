# pipeline/ — headless Blender toolchain

Offline render scripts for the portfolio film. Every script runs headless from
the command line; nothing here needs the Blender UI.

## Pinned Blender version

**Blender 5.2.1** (LTS, build hash `9e2066aef7ef`).

The single source of truth is [`BLENDER_VERSION`](BLENDER_VERSION) (one line,
`x.y.z`). Scripts read it at runtime and exit with code `3` if the running
Blender differs, unless `--allow-version-mismatch` is passed. When the pin
changes, update `BLENDER_VERSION`, this section and the Blender `tools:` entry
in [`../licenses/assets.yaml`](../licenses/assets.yaml) (a unit test checks
`BLENDER_VERSION` against the `licenses/assets.yaml` Blender entry).

Reinstall the exact version (Windows):

```powershell
winget install --id BlenderFoundation.Blender --exact --version 5.2.1
```

## Locating `blender.exe`

The winget/MSI install puts it at:

```
C:\Program Files\Blender Foundation\Blender 5.2\blender.exe
```

(`Blender <major.minor>` — the folder name has no patch number.) Blender is
not added to `PATH`; either call it by full path or set a variable:

```powershell
$blender = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
& $blender --version   # must print "Blender 5.2.1 ..."
```

If it was installed elsewhere: `Get-ChildItem "C:\Program Files\Blender Foundation"`
or `winget list --id BlenderFoundation.Blender`.

## Headless invocation pattern

```powershell
& $blender -b --factory-startup -P pipeline/<script>.py -- <script args>
```

- `-b` background (no UI), `--factory-startup` ignores user prefs/add-ons so
  runs are reproducible.
- Everything after `--` belongs to the script; Blender ignores it.
- Run from the repository root; relative paths are resolved from the current
  directory.

### Test frame (`render_test.py`)

```powershell
& $blender -b --factory-startup -P pipeline/render_test.py -- --out pipeline/out/test
```

Builds a plane, cube, camera, one area light and a world colour in code and
renders one 1920×1080 Cycles frame to `<out>/test-frame.png` on the GPU
(OptiX, else CUDA). It logs the Blender version, Cycles device type, GPU
name(s) and render time.

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>` | required | output directory, created if absent |
| `--samples <n>` | 64 | Cycles samples (denoiser on) |
| `--allow-version-mismatch` | off | warn instead of failing on a version mismatch |

Exit codes: see [Exit codes](#exit-codes).

### Measured test-frame render (2026-11-20)

| Machine | Device | Samples | Render time |
|---|---|---|---|
| RTX 2060 with Max-Q Design 6 GB, driver 616.56 | `OPTIX` | 64 + denoise | **10.7–10.9 s** (first run after install: 12.5 s) |

Render time is a toolchain sanity figure (includes scene sync and denoising),
not a production benchmark.

## Asset library (`JFILM_LIBRARY`)

Downloaded CC0 source files (Poly Haven, ambientCG) live **outside git** in an
asset library folder named by the environment variable `JFILM_LIBRARY`:

```powershell
$env:JFILM_LIBRARY = "C:\Users\Jun\jfilm-library"
```

Layout: `<library>/<source>/<asset id>/...` (e.g.
`polyhaven/wall_clock/wall_clock_2k.blend`). Every asset folder has an
`assets:` entry in [`../licenses/assets.yaml`](../licenses/assets.yaml) whose
`path` is relative to the library. `fetch_assets.py` and `build_act2_scene.py`
refuse to run without the variable (exit `1`). `style_frame.py` fails its
licence gate without it (exit `6`), because library-relative entries cannot be
resolved. Never copy library files into the repository.

### Fetch assets (`fetch_assets.py`)

Plain Python, no Blender needed:

```powershell
python pipeline/fetch_assets.py                         # fetch the whole catalogue
python pipeline/fetch_assets.py --only wall_clock Wood094
python pipeline/fetch_assets.py --dry-run               # list downloads, change nothing
python pipeline/fetch_assets.py --check                 # compare record vs. library, change nothing
```

- **Sources and verification:** downloads the `CATALOGUE` (Poly Haven
  `.blend`/HDRI, ambientCG material zips) from sources with a public CC0
  licence page only, and verifies each download (Poly Haven md5, ambientCG
  byte size). Already-present files are skipped.
- **Licence record:** writes or refreshes each asset's `licenses/assets.yaml`
  entry (id, source, licence, proof, path, purpose, used-in), keeping other
  entries and existing `used-in` values.
- **Options:**
  - `--only <id> ...` restricts the run to source ids, e.g. `wall_clock`.
  - `--dry-run` lists what would be downloaded.
  - `--check` reports entries whose folder is missing and library folders
    without an entry.

Exit codes: `0` ok, `1` usage / `JFILM_LIBRARY` unset / unknown id, `4` download
failed, `5` licence record unreadable, `6` record and library disagree.

### Build the Act II scene (`build_act2_scene.py`)

```powershell
& $blender -b --factory-startup -P pipeline/build_act2_scene.py -- --out pipeline/out/scenes
```

Builds the Act II night office fully by script and saves
`<out>/act2_desk_0307.blend` (about 3 s):

- **Library assets:** desk, clock at 03:07, lamp switched off, desk props,
  plants, cabinet, carpet, plaster, ceiling, city facades, and the walnut-tinted
  wood. They are appended with absolute paths into the library.
- **Procedural parts:** emissive-only monitor with a matching key light,
  keyboard, mouse, cold-coffee mug, chairs, partitions, curtain wall with rain
  on the glass, layered city, haze, Mt. Fuji, overcast night sky, and Kia's
  sticky note (text converted to mesh, so no font file).
- **Cameras:** `CAM_16x9` and `CAM_9x16`.
- **Self-check:** before saving, it runs the licence gate as a pre-check and
  warns about any unlisted file.

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>` | required | output directory, created if absent |
| `--name <file>.blend` | `act2_desk_0307.blend` | output file name |
| `--samples <n>` | 64 | Cycles samples stored in the scene (renders override it) |
| `--allow-version-mismatch` | off | warn instead of failing on a version mismatch |

### Render a style frame (`style_frame.py`)

```powershell
& $blender -b pipeline/out/scenes/act2_desk_0307.blend --factory-startup -P pipeline/style_frame.py -- --aspect 16x9 --out pipeline/out/style-frames
& $blender -b pipeline/out/scenes/act2_desk_0307.blend --factory-startup -P pipeline/style_frame.py -- --aspect 9x16 --out pipeline/out/style-frames
```

Order of operations:

1. Version gate.
2. **Licence gate** (below).
3. OptiX (else CUDA) GPU; never the CPU.
4. Camera and resolution by aspect (`16x9` → `CAM_16x9` 1920×1080, `9x16` →
   `CAM_9x16` 1080×1920; each aspect is its own camera, never a crop).
5. Film Credit grade.
6. Cycles render with the denoiser. Any stale output is deleted first; the
   script checks for `'FINISHED'` and the exact output size.
7. Pure-white pixel count.
8. Logs the render time and peak VRAM (`nvidia-smi` sampled every 250 ms; the
   log shows headroom and flags under 10%).

Output: `<out>/<stem>_<aspect>.png`, i.e. `act2-desk-0307_16x9.png` and
`act2-desk-0307_9x16.png`. Pure-white (`#FFFFFF`) pixels only produce a warning
with their count; the render is kept and the exit code stays `0`.

| Option | Default | Meaning |
|---|---|---|
| `--aspect 16x9\|9x16` | required | composition to render (anything else exits `1`) |
| `--out <dir>` | required | output directory, created if absent |
| `--samples <n>` | 512 | Cycles samples (adaptive, OptiX denoiser) |
| `--resolution-percentage <n>` | 100 | 1–100; for quick previews only |
| `--stem <name>` | `act2-desk-0307` | output file stem |
| `--allow-version-mismatch` | off | warn instead of failing on a version mismatch |

**Grade.** The grade is applied inside the render as a compositor node group;
there is no external post step and no grain:

1. A gentle warm ASC-CDL slope in scene-linear.
2. AgX as a colour-space conversion, for the soft highlight roll-off.
3. Display-space finishing:
   - saturation 0.88;
   - per-channel curves: teal shadows, amber highlights, lifted blacks, soft
     shoulder;
   - an amber push masked to the brightest areas, which brings the monitor to
     about `#F1D3A4` (measured; target `#F2D3A8`);
   - a hard ceiling at 0.965, so no pixel reaches `#FFFFFF`.
4. Back to linear. The file is written with the **Standard** view, so AgX is
   applied exactly once.

All values are in `GRADE` at the top of `style_frame.py`. Measured times and
VRAM are recorded in
[`style-frames/DECISIONS.md`](style-frames/DECISIONS.md): about 100–110 s per
frame at 512 samples on the RTX 2060 Max-Q, peak ≈ 1.9 GB of 6 GB.

### Licence gate

Before anything renders, `style_frame.py` collects every external file the
`.blend` references:

- images (including packed ones);
- linked libraries;
- fonts, sounds, movie clips, volumes, cache files;
- external IES and OSL script nodes.

Each path is resolved to an absolute, normalised path (`//` paths relative to
the owning `.blend` or linked library). Every reference must lie inside the
`path` of an `assets:` entry in `licenses/assets.yaml`, and that entry must:

- have all required fields (`id`, `source`, `licence`, `proof`, `used-in`);
- carry an allowed licence: `CC0-1.0`, `original` for self-made files, or
  additionally `OFL-1.1` for fonts.

Procedural parts reference no file and need no entry. If anything is missing,
the gate lists **every** offending reference and the script exits **`6`**
without rendering or creating the output directory. Example (negative run,
2026-11-20, a scene copy with one self-made texture not in the record):

```
[style_frame] LICENCE GATE FAILED: 1 unlisted/invalid reference(s):
    image 'UNLISTED_texture': C:\Users\Jun\portfolio\pipeline\out\gate-test\unlisted_texture.png -- not listed in licenses/assets.yaml
[style_frame] Add licensed entries to licenses/assets.yaml or remove the assets. Nothing rendered.
```

To fix it, add a licensed entry (`fetch_assets.py` for catalogue assets; a
hand-written `licence: original` entry for self-made files, stored in the
library) or remove the asset. The gate logic lives in `lib/licence_gate.py`; it
does not use `bpy` and is unit-tested.

## Shot pipeline: frames → AVIF chunks → manifest (Story 0.3)

One spike shot, `ii-03-clock`: a ~3 s first-person turn from the desk toward
the wall clock, at 24 fps (72 frames, 0-based), in 16:9 and 9:16. The full run
is four commands, from the repository root:

```powershell
$env:JFILM_LIBRARY = "C:\Users\Jun\jfilm-library"
$blender = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
$scene = "pipeline/out/scenes/act2_desk_0307.blend"

# 1. Render (resumable; keep each command under ~5 min with --frames batches)
& $blender -b $scene --factory-startup -P pipeline/render_shot.py -- --aspect 16x9 --frames 0-9
& $blender -b $scene --factory-startup -P pipeline/render_shot.py -- --aspect 9x16 --frames 0-24
#    ...repeat with further ranges; a run without --frames fills any gaps.

# 2. Encode + pack + manifest
python pipeline/encode_pack.py

# 3. Verify the bytes (every frame re-sliced and decoded)
python pipeline/check_chunks.py pipeline/out/spike-2026-11-21

# 4. Validate the manifest + frame data against the v1 Zod schema
npm --prefix spike run validate -- pipeline/out/spike-2026-11-21/asset-manifest.json
```

### Render the shot (`render_shot.py`)

Order of operations:

1. Version gate.
2. Licence gate: `style_frame.run_licence_gate`, the same collector.
3. OptiX GPU.
4. A copy of `CAM_16x9` / `CAM_9x16`, keyframed on every frame from the
   spring-eased turn in `lib/shot.py`.
5. Film Credit grade (`style_frame.build_grade`).
6. Monitor quads for all 72 frames → `quads.json`.
7. Render each requested frame that is not already a valid PNG.

| Option | Default | Meaning |
|---|---|---|
| `--aspect 16x9\|9x16` | required | 16:9 renders 1920×1080, 9:16 renders 720×1280 directly |
| `--frames a-b\|n\|list` | all 72 | 0-based frames, e.g. `0-9` or `0,36,71` |
| `--samples <n>` | 64 | Cycles samples, OptiX denoiser on |
| `--out <dir>` | `pipeline/out/shots` | frames go to `<out>/ii-03-clock/<aspect>/` |
| `--quads-only` | off | write `quads.json` only |
| `--clean` | off | delete frames rendered with other parameters |
| `--allow-version-mismatch` | off | warn instead of failing on a version mismatch |

Output per aspect:

- `frame-NNNN.png`: written to a temporary file, size-checked, then renamed.
- `render-log.jsonl`: render time per frame.
- `quads.json`: per-frame monitor quad and camera pose, plus a fingerprint of
  the move, samples, size, grade and scene file.

**Resume.** Frames with a complete PNG of the right size are skipped. If the
fingerprint changed while frames exist, the script refuses (exit `1`) unless
`--clean` is given, so one sequence never mixes two moves.

**Quads.** The front face of `Monitor_Hero_Screen` is projected with
`world_to_camera_view`, then:

- converted from Blender's bottom-left origin to normalized top-left;
- ordered TL, TR, BR, BL.

Coordinates may fall outside [0, 1] while the monitor is partly off-frame (the
player clips). A quad is `null` when any corner is behind the camera.

**Camera move** (`MOVES` and `MOVE_TUNING` in `render_shot.py`, curve in
`lib/shot.py`):

- **Timing:** holds still for 6% of the shot. Yaw and pitch then follow
  separate damped springs (frequency 10; damping 0.75 for yaw, 0.7 for pitch),
  with pitch starting 4% later.
- **Humanising:** the head tilts up to −1.2° into the turn, and the eye rises
  slightly (Jun sits up).
- **Focal push:** a slow, almost overshoot-free "attention" push of ×1.35
  starts 12% after the hold, so the clock ends readable.

| | 16:9 | 9:16 |
|---|---|---|
| Yaw (right turn) | 7.37° → 1.65° | 6.50° → 3.47° |
| Pitch (up) | −8.19° → +10.83° (peak +11.73°) | −11.94° → +14.62° (peak +15.88°) |
| Lens | 26 → 35.1 mm | 28 → 37.8 mm |
| End aim | clock face centre | 0.22 m above the clock (keeps the monitor top to a thin strip) |

**Quads summary (both aspects):** 72 quads, 0 `null`. Frames 0–18 are fully
inside the frame; in frames 19–71 the monitor runs off the bottom edge.

### Encode and pack (`encode_pack.py`)

Plain Python, no Blender. Steps:

1. Checks that all 72 PNGs and `quads.json` exist for both aspects.
2. Encodes three variants to AVIF:
   - `16x9/1080` from the 1920×1080 PNGs;
   - `16x9/720` downscaled from the same PNGs (Lanczos, accurate rounding,
     full chroma);
   - `9x16/720` from the 720×1280 PNGs.
3. Packs the frames into chunks.
4. Writes the frame data and the manifest.

**Intermediate AVIFs** are a resumable cache outside the published directory:
`pipeline/out/work/<mediaVersion>/avif/<settings-fingerprint>/<aspect>/<tier>/`.
Each frame is written atomically, and changing a setting starts a new cache
folder. A report of settings, bytes and timings goes to
`pipeline/out/work/<mediaVersion>/encode-report.json`.

**Published output:** `pipeline/out/<mediaVersion>/`, contract files only:

```
asset-manifest.json
frames/II.16x9.json
frames/II.9x16.json
ii-03-clock/<aspect>/<tier>/chunk-NNNN.bin
```

**Immutability.** Before writing, `lib/shot.ensure_publishable` compares the
planned files with what is already published:

- An identical re-run succeeds and writes nothing ("18 unchanged").
- Any changed or unexpected file is refused with exit **`7`**, listing every
  differing file.
- `--force` overwrites (and deletes unexpected files).

Verified on a copy: re-running with `--chunk-size 12` was refused with exit 7;
with `--force` it succeeded.

| Option | Default | Meaning |
|---|---|---|
| `--chunk-size <N>` | **16** | frames per chunk (72 frames → 5 chunks; the last holds 8) |
| `--crf <n>` / `--cpu-used <n>` | 18 / 4 | libaom quality / speed |
| `--jobs <n>` | 4 | parallel ffmpeg processes (each uses 4 threads) |
| `--ffmpeg <path>` / `--ffprobe <path>` | auto | override the encoder lookup |
| `--media-version <v>` | `spike-2026-11-21` | output directory name |
| `--force` | off | overwrite a published mediaVersion whose content differs |
| `--encode-only` | off | fill the AVIF cache only |
| `--allow-version-mismatch` | off | accept an ffmpeg other than 9.1 |

### Pinned AVIF encoder

**FFmpeg 9.1** (gyan.dev full build; `ffmpeg version 9.1-full_build-www.gyan.dev`),
libaom-av1 encoder. It also ships `libsvtav1` (unused) and ffprobe 9.1.
Recorded as the `ffmpeg` `tools:` entry in
[`../licenses/assets.yaml`](../licenses/assets.yaml). A unit test checks that
entry against `FFMPEG_VERSION` in `lib/pack.py`.

```powershell
winget install --id Gyan.FFmpeg --exact --version 9.1
```

**Where the exe is.** winget extracts the build to
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.1-full_build\bin\ffmpeg.exe`
and adds shortcuts in `%LOCALAPPDATA%\Microsoft\WinGet\Links\` (`ffmpeg.exe`,
`ffprobe.exe`). The PATH change only reaches new shells. The scripts look for
ffmpeg in this order:

1. `--ffmpeg <path>`;
2. `PATH`;
3. the winget Links folder.

ffprobe is taken from the same folder as ffmpeg when possible. A version
other than 9.1 exits `3` unless `--allow-version-mismatch` is given.

**Encode settings** (`EncodeSettings` in `lib/pack.py`):

| Setting | Value |
|---|---|
| Codec | `libaom-av1`, `-still-picture 1`, output muxer `avif` (still-image AVIF, `ftyp` brand `avif`) |
| Quality | `-crf 18 -b:v 0` (constant quality) |
| Speed | `-cpu-used 4` |
| Chroma / depth | 4:2:0, 8-bit (`yuv420p`) |
| Colour | full range, BT.709 matrix and primaries, sRGB transfer, tagged in the `colr nclx` box. A decoded frame's mean RGB matches the source PNG within 1 level. |
| Grain / noise synthesis | **off**: `-denoise-noise-level 0` and `-aom-params film-grain-test=0` (Safari cannot decode AV1 film grain) |
| 720 downscale | `scale=1280:720:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp` (in sRGB, before the YUV conversion) |

**Why crf 18.** Trials on the last frame (clock in a dark area):

- crf 30: ~35 KB per 1080 frame; crf 24: ~56 KB. Both erased the clock
  numerals.
- crf 18: ~78 KB; the numerals stay legible.
- crf 12: ~114 KB; close to the source.
- 10-bit and 4:4:4 at the same crf did not help.

SSIM against the source is 0.968–0.983 (1080), 0.963–0.982 (16:9 720) and
0.973–0.982 (9:16 720) on frames 0, 36 and 71.

**Encode time** for all 216 frames, 4 parallel jobs on a Ryzen 7 4800HS:
154 s in total (1080: 77 s; 16:9 720: 42 s; 9:16 720: 34 s).

### Check the chunks (`check_chunks.py`)

```powershell
python pipeline/check_chunks.py pipeline/out/spike-2026-11-21 [--ffprobe <path>] [--ffmpeg <path>] [--jobs 8]
```

For every shot, aspect, tier and frame it checks:

1. Chunk file size equals the manifest's `chunkBytes`.
2. The slice lies inside its chunk.
3. The slice starts with an AVIF `ftyp` box.
4. `ffprobe -count_frames` decodes exactly one AV1 frame of the tier's size.
5. A **strict decode with the libaom decoder** succeeds.

Step 5 is needed because ffmpeg's default AV1 decoder (dav1d) hides bitstream
damage and still exits 0. A slice with an intact header but a corrupted
payload passed ffprobe but failed libaom ("Corrupt frame detected").

Every failure names frame, tier and aspect. Exit `0` OK, `1` usage, `4`
failures, `5` unreadable manifest / frame data or no ffprobe. A full run on
the spike takes about 3 s.

Negative runs on copies (2026-11-21), all exit `4` with the frame named:

- overwritten `ftyp` box;
- 2,000 bytes overwritten mid-payload;
- truncated last chunk.

### Manifest schema check (`spike/`)

```powershell
npm --prefix spike run validate -- pipeline/out/spike-2026-11-21/asset-manifest.json
npm --prefix spike test     # fixtures: one valid, three invalid
```

`spike/manifest/manifest-schema.ts` holds the reusable v1 contract (Zod 4).
It checks the manifest, the frame data, and the rules across both files:

- equal frame counts across aspects;
- tier and aspect values inside their allowed sets;
- offsets inside their chunk;
- corners in clockwise order.

### Measured results (`spike-2026-11-21`, 2026-11-21)

**Render time per frame** (from `render-log.jsonl`; RTX 2060 Max-Q, OptiX,
64 samples + denoiser):

| Variant | Mean | Median | Min–max | Total (72 frames) |
|---|---|---|---|---|
| 16:9, 1920×1080 | **23.3 s** | 24.0 s | 16.6–26.7 s | 1674 s (27.9 min) |
| 9:16, 720×1280 | **9.7 s** | 10.0 s | 7.0–11.6 s | 696 s (11.6 min) |

The GPU reached 86 °C and per-frame time rose from about 17 s to 25 s during
long runs. Plan for 8–10 frames per 5-minute batch at 1080 and 20–25 at 9:16
720. Peak VRAM was 2.0 GB of 6 GB (16:9) and 1.6 GB (9:16).

**Encoded size per tier and aspect** (N = 16, 5 chunks each):

| Aspect / tier | Total bytes | Avg bytes/frame | Min–max bytes/frame | Chunk sizes (bytes) |
|---|---|---|---|---|
| 16x9 / 1080 | **5,134,815** (4.9 MiB) | **71,317** | 47,097–80,409 | 868,628 · 1,102,474 · 1,276,646 · 1,257,625 · 629,442 |
| 16x9 / 720 | **2,609,815** (2.5 MiB) | **36,247** | 25,158–40,105 | 486,304 · 548,115 · 636,081 · 625,453 · 313,862 |
| 9x16 / 720 | **1,766,816** (1.7 MiB) | **24,539** | 19,729–32,180 | 466,779 · 343,552 · 381,871 · 383,191 · 191,423 |

Supporting files: `asset-manifest.json` is 1,157 B, `frames/II.16x9.json`
35,273 B and `frames/II.9x16.json` 27,652 B (uncompressed; the quads make up
most of it).

### Request count: this shot and the full film

**This shot, one aspect and tier, at N = 16:**
1 manifest + 1 frame-data file + 5 chunks = **7 media requests** (3 at N = 72).

**Full-film estimate.** There is no authoritative frame count. The planning
artifacts give two pointers:

- "The film runs about 4–5 minutes at authored speed" (sprint change proposal,
  `_bmad-output/planning-artifacts/sprint-change-proposal-2026-11-19.md`
  lines 146/159; UX memlog decision "Story duration target 4-5 minutes").
  The fixed-speed playback requirement was later dropped (UX `.memlog.md`
  lines 90/93, `EXPERIENCE.md` line 462), but 4–5 minutes remains the only
  estimate of how much film there is.
- About 40 beats and 12 key camera shots (`epics.md` AR37, AR34).

At 24 fps this gives **5,760–7,200 frames**. The figures below use 7,200 as
the worst case.

**How the count is computed** (functions in `lib/pack.py`): chunk requests are
bounded by `ceil(frames/N) + groups − 1`, where a group is a set of frames
packed separately. That means 5 groups when packed per act, as AD-14 / AR14
specify, or about 40 when packed per shot, as this spike's URL pattern does.
On top of that come 6 fixed requests: 1 manifest + 5 per-act frame-data files.

| Frames | Packing | Other media counted | Requests at N = 16 | Smallest N within ≤ 150 | 1080 chunk size at that N |
|---|---|---|---|---|---|
| 7,200 | per act (5) | frame data only | **460** | **52** | 3.7 MB |
| 7,200 | per act (5) | + 40 reserved for plates/loops/audio | 500 | 72 | 5.1 MB |
| 7,200 | per shot (~40) | frame data only | 495 | 69 | 4.9 MB |
| 7,200 | per shot (~40) | + 40 reserved | 535 | **111** | 7.9 MB |
| 5,760 | per act (5) | frame data only | 370 | 42 | 3.0 MB |
| 5,760 | per shot (~40) | + 40 reserved | 445 | 89 | 6.4 MB |

**Conclusions:**

- **N = 16 does not fit the ≤ 150 requests/watch budget:** about 3× over
  (370–535 requests).
- To fit, N must be roughly **52–72 with per-act packing** (as AD-14
  specifies) or **69–111 with per-shot packing**. This argues for per-act
  chunk files and N ≈ 64–72.
- The cost is bigger chunks: about 4–5 MB at 1080, 2–2.6 MB at 16:9 720 and
  1.3–1.8 MB at 9:16 720. That affects time to the first frame after a seek,
  and the decoded look-ahead must hold whole chunks.
- Whole-film media per tier at these sizes: about 411–513 MB (16:9 1080),
  209–261 MB (16:9 720), 141–177 MB (9:16 720).
- Story 0.5 should measure seek latency at N ≈ 64 on the phones before
  committing. The 40-request reserve for plates/loops/audio is an assumption,
  not a measurement.

### Known weaknesses (spike)

- **The camera spring settles by about frame 36.** The second half of the shot
  (36–71) is a near-static hold on the clock with only the last of the
  overshoot and the slow focal push. Scrolling through it shows little motion,
  and those frames cost almost as many bytes as the turn.
- **Ceiling-heavy end frame.** The clock sits high on the column, so about
  half the final frame is the textured ceiling (more so in 9:16).
- **Lens push.** A focal change is not a pure head turn. It is accepted for the
  spike; `lens_scale = 1.0` in `MOVES` disables it (new fingerprint, re-render
  with `--clean`).
- **The denoiser runs on each frame separately** (no temporal denoising).
  Expect slight shimmer on the textured ceiling while scrubbing; check it in
  the 0.4 player.
- **crf 18 is driven by one detail** (the clock numerals). Shots without fine
  low-contrast detail could use crf 24–30, roughly half the bytes; a per-shot
  crf is a candidate for Epic 5.
- **8-bit 4:2:0** keeps phone decode cheap but may band on dark gradients.
  10-bit gave no visible gain on the clock test.
- **The 720 downscale is done in sRGB (gamma) space**, not linear light.
- **Browsers decode AV1 with dav1d or the OS decoder**, which conceal
  corruption. A damaged chunk would show garbage, not an error. Integrity
  rests on `check_chunks.py` before upload, and on immutable mediaVersions.
- **Render time on this laptop** (about 25 s per 1080 frame when hot) makes a
  5,760–7,200-frame film about 40–50 GPU-hours for 16:9 1080 alone at
  64 samples. 9:16 adds about 16–20 h.

## Exit codes

Shared by every pipeline script (`lib/toolchain.py`); every failure is non-zero.

| Code | Name | Meaning |
|---|---|---|
| `0` | `EXIT_OK` | success (also when pure-white pixels were only warned about) |
| `1` | `EXIT_USAGE` | usage error (bad/missing option, e.g. `--aspect 4x3`), `JFILM_LIBRARY` unset, library asset missing, no scene loaded |
| `2` | `EXIT_NO_GPU` | no OptiX/CUDA GPU; never falls back to CPU |
| `3` | `EXIT_VERSION_MISMATCH` | running Blender differs from `BLENDER_VERSION` |
| `4` | `EXIT_RENDER_FAILED` | render/build/save failed, output missing or wrong size, download failed |
| `5` | `EXIT_CONFIG` | invalid `BLENDER_VERSION`, unreadable licence record, scene lacks the aspect camera |
| `6` | `EXIT_LICENCE` | licence gate refused the scene (unlisted/invalid asset), or `fetch_assets.py --check` mismatch |
| `7` | `EXIT_IMMUTABLE` | `encode_pack.py`: the published `pipeline/out/<mediaVersion>/` would change (re-run with a new mediaVersion or `--force`) |

Script-specific uses:

- `render_shot.py`:
  - `1`: usage error, or existing frames have another fingerprint (fix with
    `--clean`);
  - `2`: no OptiX/CUDA GPU;
  - `3`: Blender version mismatch;
  - `4`: render failed or wrong output size;
  - `5`: bad `BLENDER_VERSION`, or the scene lacks the camera, clock or
    screen object;
  - `6`: licence gate refused the scene.
- `encode_pack.py`:
  - `1`: usage error, or missing/invalid render inputs;
  - `3`: ffmpeg other than 9.1;
  - `4`: an encode failed;
  - `5`: ffmpeg missing (or `--ffmpeg` not a file), or no libaom-av1 encoder;
  - `7`: the published mediaVersion would change.
- `check_chunks.py`:
  - `1`: usage error;
  - `4`: a frame or chunk failed, or there was no slice to check;
  - `5`: manifest or frame data unreadable or malformed (missing key, wrong
    type, unknown aspect/tier, or a tier not allowed for its aspect), ffprobe
    or ffmpeg missing, ffmpeg not 9.1, or no libaom-av1 decoder.

## Output

All renders and scenes go under `pipeline/out/` (git-ignored, as are image and
video files anywhere under `pipeline/`):

| Folder | Contents |
|---|---|
| `pipeline/out/test/` | `render_test.py` frame |
| `pipeline/out/scenes/` | built `.blend` scenes |
| `pipeline/out/style-frames/` | graded style frames |
| `pipeline/out/shots/ii-03-clock/<aspect>/` | shot PNGs, `quads.json`, `render-log.jsonl` |
| `pipeline/out/work/<mediaVersion>/` | AVIF cache and `encode-report.json` (not published) |
| `pipeline/out/<mediaVersion>/` | published, immutable: manifest, frame data, chunks |

Rendered media and `.blend` files never enter version control; decisions about
them are recorded in [`style-frames/DECISIONS.md`](style-frames/DECISIONS.md).

## Tests

Pure helpers live in `lib/toolchain.py`, `lib/licence_gate.py`, `lib/shot.py`
(spring curve, camera turn, frame numbering, resume, chunk plan, quads,
immutability) and `lib/pack.py` (encoder lookup and command, AVIF sniffing,
frame data and manifest builders, probe parsing, request math). None of them
use `bpy`, so they run with plain Python 3.12:

```powershell
python -m unittest discover -s pipeline/tests -v
```

One test compares the real asset library with the licence record. It is
skipped when `JFILM_LIBRARY` is not set.

Later scripts should import the same helpers:

```python
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import toolchain as tc
```
