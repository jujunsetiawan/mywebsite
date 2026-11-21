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

## Output

All renders and scenes go under `pipeline/out/` (git-ignored, as are image and
video files anywhere under `pipeline/`):

| Folder | Contents |
|---|---|
| `pipeline/out/test/` | `render_test.py` frame |
| `pipeline/out/scenes/` | built `.blend` scenes |
| `pipeline/out/style-frames/` | graded style frames |

Rendered media and `.blend` files never enter version control; decisions about
them are recorded in [`style-frames/DECISIONS.md`](style-frames/DECISIONS.md).

## Tests

Pure helpers live in `lib/toolchain.py` and `lib/licence_gate.py` (no `bpy`),
so they run with plain Python 3.12:

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
