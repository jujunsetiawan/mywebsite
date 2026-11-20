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

Exit codes: `0` ok, `1` usage error, `2` no OptiX/CUDA GPU (never falls back to
CPU), `3` Blender version mismatch, `4` render failed, `5` invalid
`BLENDER_VERSION`.

### Measured test-frame render (2026-11-20)

| Machine | Device | Samples | Render time |
|---|---|---|---|
| RTX 2060 with Max-Q Design 6 GB, driver 616.56 | `OPTIX` | 64 + denoise | **10.7–10.9 s** (first run after install: 12.5 s) |

Render time is a toolchain sanity figure (includes scene sync and denoising),
not a production benchmark.

## Output

All renders go under `pipeline/out/` (git-ignored, as are image/video files
anywhere under `pipeline/`). Rendered media never enters version control.

## Tests

Pure helpers live in `lib/toolchain.py` (no `bpy`), so they run with plain
Python 3.12:

```powershell
python -m unittest discover -s pipeline/tests -v
```

Later scripts should import the same helpers:

```python
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import toolchain as tc
```
