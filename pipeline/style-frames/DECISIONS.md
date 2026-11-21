# Style-frame decisions

One dated entry per reviewed style frame. Facts (files, commands, timings,
sourcing) are filled in by the pipeline work; the verdict, review notes and the
production sourcing decision belong to Jun and stay pending until he
records them. The story completes on any verdict.

Rendered frames live under `pipeline/out/style-frames/` (git-ignored); this file
is the durable record.

---

## 2026-11-20 — Act II hero still: Jun's desk at 03:07 (Story 0.2)

### Verdict

- **Verdict (approved / rejected):** **REJECTED** (Jun)
- **Review date:** 2026-11-20
- **Reviewed on desktop:** yes
- **Reviewed on phone:** yes

### Review notes

- **Desktop:** no notes given; frame does not reach the photoreal AAA bar.
- **Phone (9:16 especially):** no notes given.

### Frames

| Aspect | File | Size | Camera |
|---|---|---|---|
| 16:9 | `pipeline/out/style-frames/act2-desk-0307_16x9.png` | 1920×1080 | `CAM_16x9` (26 mm, seated POV) |
| 9:16 | `pipeline/out/style-frames/act2-desk-0307_9x16.png` | 1080×1920 | `CAM_9x16` (28 mm, portrait sensor, own placement) |

Scene: `pipeline/out/scenes/act2_desk_0307.blend`, built by
`pipeline/build_act2_scene.py` (fully scripted, no manual Blender UI work).

### Commands

```powershell
$env:JFILM_LIBRARY = "C:\Users\Jun\jfilm-library"
$blender = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
python pipeline/fetch_assets.py                     # CC0 assets -> library + licenses/assets.yaml
& $blender -b --factory-startup -P pipeline/build_act2_scene.py -- --out pipeline/out/scenes
& $blender -b pipeline/out/scenes/act2_desk_0307.blend --factory-startup -P pipeline/style_frame.py -- --aspect 16x9 --out pipeline/out/style-frames
& $blender -b pipeline/out/scenes/act2_desk_0307.blend --factory-startup -P pipeline/style_frame.py -- --aspect 9x16 --out pipeline/out/style-frames
```

Settings: Blender 5.2.1, Cycles on the GPU (OptiX), **512 samples** (adaptive
sampling on), OptiX denoiser, compositor grade (see below). Licence gate passed:
75 external file references, all listed in `licenses/assets.yaml`.

### Render time and VRAM (RTX 2060 with Max-Q Design, 6 GB, driver 616.56)

| Aspect | Render time | Peak VRAM | Headroom | Pure-white pixels |
|---|---|---|---|---|
| 16:9 | 100.1 s | 1443 / 6144 MiB (23.5%) | 4701 MiB | 0 |
| 9:16 | 110.7 s | 1943 / 6144 MiB (31.6%) | 4201 MiB | 0 |

Figures are from the re-render after the note lettering switched to Inter (scene
rebuilt; licence gate passed, 75 references). Run-to-run variance on this laptop
is large: the same scene earlier rendered in 95–97 s, and a back-to-back pair
in this session took 190 s each with a 3337 MiB peak. During that pair the
laptop was on mains but still discharging, and the GPU sat at 74–84 °C, i.e.
power- or heat-limited. A 64-sample control render (20.8 s, against 18.8 s
before the font change) confirmed the scene itself had not become heavier.
Treat the timings as roughly ±10% under normal conditions, and up to 2× slower
when the machine is limited.

Render time is the `bpy.ops.render.render` call (scene sync + path tracing +
denoise + compositor); add ~4 s of Blender start-up and file load per run. Peak
VRAM is `nvidia-smi` sampled every 250 ms during the render. On this laptop the
idle GPU reports 0 MiB, so the peak equals what the render itself used.

**Is production rendering practical? (rough extrapolation, not measured)**

At these settings one frame costs about 105 s per aspect.

| Shot (~3 s) | Frames | One aspect | Both aspects |
|---|---|---|---|
| 24 fps | 72 | ~2.1 h | ~4.2 h |
| 30 fps | 90 | ~2.6 h | ~5.3 h |

- VRAM is not the constraint: under a third of the 6 GB is used, so heavier
  sets or characters still fit.
- Time is the constraint. A single hero shot renders overnight. A full film of
  many such shots does not fit at 512 samples on one laptop GPU: 60 s at 24 fps
  in both aspects is ~84 h, and up to twice that when the laptop is power- or
  heat-limited.
- Realistic production levers: about 128–256 samples with the denoiser (roughly
  ¼–½ the time; temporal stability needs checking on a sequence), fewer shots
  rendered in both aspects, and a still-plus-camera-move staging for static
  moments.
- Animation adds per-frame scene sync, animated rain and motion blur, none of
  which is measured here.

### Asset sourcing for this frame

CC0 library assets (Poly Haven / ambientCG, files in `$JFILM_LIBRARY`, each with
an `assets:` entry in `licenses/assets.yaml`): metal office desk (hero + colleague
desks, instanced), wall clock (hands set to 03:07:41), desk lamp (switched off,
red paint desaturated), office notepads, binder notebook, stationery supplies,
potted plants 02/04, drawer cabinet, dirty carpet, painted plaster wall, ceiling
interior, Facade009 + Facade005 (city), Wood094 (desk tops tinted to walnut
`#3A2A1C`).

**CC0 gaps and how each was filled (procedural, no files):**

| Gap | Filled with |
|---|---|
| Modern monitor | Procedural slim 24" panel + stand. Screen is an emission-only shader `#F2D3A8`, no UI text, plus an invisible matching area light as the warm key. |
| Keyboard, mouse | Procedural: arrayed bevelled keys; flattened sphere. |
| Mug + cold coffee | Procedural hollow cylinder + torus handle; dark glossy coffee disc `#4A2F1E`. |
| Task chairs | Procedural (seat, back, gas lift, 5-star base, arms), instanced. |
| Low partitions | Procedural fabric panels with a walnut cap. |
| Curtain-wall window | Procedural sill/header walls, aluminium mullions and transoms, glass. |
| Rain on glass | Procedural shader: Voronoi droplets at two scales + noise rivulets, bump on the outer face only (so they refract). |
| Night sky | Procedural world: zenith `#050C12` → horizon `#12232A`, cloud noise, muted warm horizon band. |
| City massing | 65 boxes in three depth bands (70–160 m, 220–480 m, 650–1300 m) carrying the CC0 facades. Lit-window masks are procedural. |
| City haze | Emissive/transparent fog cards between the bands. |
| Mt. Fuji + ridges | Procedural silhouette cards with a dim snow cap, behind a cool haze card. |
| Kia's sticky note | Procedural translucent pink paper. Lettering "jangan lupa / makan :) / — K" is set in **Inter (OFL-1.1)**, the font bundled with Blender 5.2.1 (`<DATAFILES>/fonts/Inter.woff2`, listed in Blender's `license/license.md`), then converted to mesh, so the .blend references no font file. Recorded as `blender-bundled-inter` in `licenses/assets.yaml`. It replaced Blender's built-in "Bfont", whose licence could not be established beyond Blender's GPL. |

**Rejected asset — `polyhaven-kloppenheim_07_puresky` (HDRI).** Evaluated
2026-11-20 and not used. It shows a moon behind thin cloud (peak luminance 14.8
at pixel 1227,294 of 2048×1024) and visible stars in a clear patch. Both break
the "overcast, no stars, no moon" rule, and the sky is far too bright and blue.
The licence entry is kept, marked rejected, with `used-in` set to none.

**Fuji exaggeration (art-directed).** The silhouette sits 9 km out with its peak
6° above eye level. Seen from Tokyo, the real Mt. Fuji rises only about 2°, which
reads as a sliver at a 26–28 mm POV. Accepted as cinematic licence; Jun may
reject it.

### Grade implementation (Film Credit)

Built inside the render by `pipeline/style_frame.py` (compositor node group; no
external post step, no grain, no baked lightning):

1. Scene-linear ASC-CDL slope `(1.02, 1.0, 0.97)` (gentle warm balance).
2. AgX applied as a colour-space conversion (`AgX Base sRGB`) for the soft
   highlight roll-off.
3. Display-space finishing:
   - Saturation 0.88.
   - Per-channel curves: teal shadows (G/B lifted at black), amber highlights
     (R up / B down at the top), lifted blacks, soft shoulder.
   - Amber push masked to the brightest areas (display luma 0.48–0.66), which
     moves the monitor to about `#F1D3A4` against the `#F2D3A8` anchor.
   - Hard ceiling at 0.965, so no output pixel can reach `#FFFFFF`.
4. Back to scene-linear; the file is written with the Standard view, so the
   round trip is exact and AgX is applied once.

Measured (16:9 preview): black floor about `#071315` (lifted, teal); sky near the
horizon about `#1B3339`; desk under the key about `#AD906D`. Grading before AgX
was tried first and rejected: AgX's own desaturation pulled the screen back to
beige (`#CAB094`).

### Known weaknesses

- **Screen:** a flat amber field with no falloff or vignette, about half of the
  16:9 frame.
- **Note text:** slanted Inter (OFL-1.1), a clean sans-serif rather than real
  handwriting. In 9:16 the last "a" of "lupa" just touches the note's right
  edge.
- **Colleague desks:** mostly silhouettes behind the partitions; their personal
  props barely read.
- **Rain:** convincing up close, but at 8–9 m from the eye it reads only as faint
  streaks and specks.
- **City:** the near tower shows a visibly repeating Facade009 tile, and the
  ambientCG tile sizes (56 m / 30 m) are estimates. Haze is flat cards: no
  volumetrics, no glow around lights.
- **Fuji:** exaggerated (see above), and small and partly hidden behind the
  clock column in 9:16.
- **Grade:** the sky sits brighter than the `#12232A` horizon anchor. The lifted
  blacks may read slightly milky on phone OLED screens.
- **Other:** the ceiling texture is rough stucco rather than office tile; the
  16:9 lens is still fairly wide (26 mm).
- **Overall:** fully scripted assembly with no hand modelling. It is a credible
  look test, short of the Ghost of Tsushima / GTA 6 bar (accepted trade-off,
  spec decision 2026-11-20).

### Production hero-prop / character sourcing decision

- **Decision:** **CC0 only** (Jun, 2026-11-20)
- **Options:**
  1. **CC0 only.** Library assets plus procedural modelling, as in this frame.
     No cost and fully scripted, but the quality ceiling is visible on hero props
     and there are no suitable CC0 characters.
  2. **Commission a 3D artist.** Bespoke hero props (monitor, note, mug) and
     characters, delivered under a written licence recorded in
     `licenses/assets.yaml`. Costs money and lead time; raises the quality bar.
  3. **Simplified staging.** Keep CC0 + procedural, but stage around the gaps:
     POV framing, silhouettes, shallow depth of field, no on-screen characters.
- **Rationale / budget / timeline:** no budget for commissioned assets. Consequence: assets CC0 libraries cannot provide (modern monitor, keyboard, mouse, mug, ergonomic chair, partitions, curtain-wall window, characters/hands) must be modelled procedurally or left out of frame.

### Follow-up (open)

- The look is rejected while sourcing stays CC0-only, so the quality gap must close through modelling, lighting, materials and grade rather than bought assets. No story currently owns revising the Act II frame after a rejection (implementation-readiness C34); Epic 5 (5.3, 5.7) assumes an approved frame. Resolve via `bmad-correct-course` before Epic 5 starts.
