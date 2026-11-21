"""Render a graded style frame of a saved scene, after a licence gate.

Usage (headless only; script arguments go after ``--``):

    $env:JFILM_LIBRARY = "C:\\Users\\Jun\\jfilm-library"
    blender -b pipeline/out/scenes/act2_desk_0307.blend --factory-startup -P pipeline/style_frame.py --
        --aspect 16x9|9x16 --out pipeline/out/style-frames
        [--samples 512] [--resolution-percentage 100] [--stem act2-desk-0307]
        [--allow-version-mismatch]

Pipeline: version gate -> licence gate (every image, linked library, font,
sound, movie clip, volume, cache file and external IES/script node referenced by
the .blend must lie inside a ``licenses/assets.yaml`` entry; violations are all
listed and the script exits 6 before anything renders) -> OptiX/CUDA GPU ->
camera + resolution by aspect (``CAM_16x9`` 1920x1080, ``CAM_9x16`` 1080x1920)
-> Film Credit grade (compositor + AgX look, inside the render) -> Cycles render
-> 'FINISHED' + output size checks -> pure-white pixel count (warning only) ->
render time + peak VRAM (nvidia-smi sampling).

Output: ``<out>/<stem>_<aspect>.png`` (any stale file is removed first).

Exit codes: 0 ok (also with white pixels: warning), 1 usage, 2 no GPU,
3 version mismatch, 4 render failed / bad output, 5 bad BLENDER_VERSION or
scene lacks the aspect camera, 6 licence gate refused the scene.
"""

from __future__ import annotations

import os
import sys
import time
import traceback
from pathlib import Path
from typing import NoReturn

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import licence_gate as lg  # noqa: E402
from lib import toolchain as tc  # noqa: E402

import bpy  # noqa: E402

PROG = "style_frame.py"
DEFAULT_STEM = "act2-desk-0307"
DEFAULT_SAMPLES = 512  # ~95 s per frame on the RTX 2060 Max-Q (OptiX, adaptive, denoise)

# ------------------------------------------------------------------ Film Credit grade
# All inside the render's compositor:
#   scene-linear  -> ASC-CDL slope (gentle warm balance)
#   -> AgX Base (as a colour-space conversion: soft highlight roll-off)
#   -> display-space finishing: saturation trim, teal-shadow / amber-highlight
#      curves with lifted blacks, masked amber push on the brightest areas
#      (monitor toward #F2D3A8), hard ceiling below #FFFFFF
#   -> back to scene-linear; the file is written with the "Standard" view, so the
#      round trip is exact and AgX is applied once.
GRADE = {
    "cdl_slope": (1.02, 1.0, 0.97),
    "tonemap": "AgX Base sRGB",
    "saturation": 0.88,
    # display-space curves: [(in, out)] per channel; "C" applies after R/G/B.
    "curve_r": [(0.0, 0.0), (0.25, 0.235), (0.75, 0.78), (1.0, 1.0)],
    "curve_g": [(0.0, 0.045), (0.25, 0.265), (0.75, 0.755), (1.0, 1.0)],
    "curve_b": [(0.0, 0.055), (0.25, 0.27), (0.75, 0.71), (1.0, 0.94)],
    "curve_c": [(0.0, 0.03), (0.5, 0.5), (0.85, 0.86), (1.0, 0.975)],
    # amber push for highlights: display luma mask ramp -> multiply.
    "highlight_mask": (0.48, 0.66),
    "highlight_amber": (1.2, 1.17, 1.07),
    "display_ceiling": 0.965,  # max 246/255: never pure white
}


def log(message: str) -> None:
    print(f"[style_frame] {message}", flush=True)


def warn(message: str) -> None:
    print(f"[style_frame] WARNING: {message}", file=sys.stderr, flush=True)


def fail(code: int, message: str) -> NoReturn:
    print(f"[style_frame] ERROR: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def add_style_arguments(parser) -> None:
    """Parser ``extend`` hook: --aspect plus style-frame options."""
    tc.add_aspect_argument(parser)
    parser.set_defaults(samples=DEFAULT_SAMPLES)
    parser.add_argument(
        "--resolution-percentage",
        type=int,
        default=100,
        help="render at N%% of the aspect resolution (previews only; default %(default)s)",
    )
    parser.add_argument("--stem", default=DEFAULT_STEM, help="output file stem (default %(default)s)")


# ================================================================== licence gate


def _base_dir(idblock, blend_dir: str | None) -> str | None:
    """Directory that ``//`` paths of ``idblock`` are relative to (its library or the .blend)."""
    lib = getattr(idblock, "library", None)
    if lib is None:
        return blend_dir
    return os.path.dirname(_library_path(lib, blend_dir))


def _library_path(lib, blend_dir: str | None) -> str:
    parent = getattr(lib, "parent", None)
    base = blend_dir if parent is None else os.path.dirname(_library_path(parent, blend_dir))
    return lg.resolve_reference_path(lib.filepath, base)


def collect_references() -> list[lg.Reference]:
    """Every external file the open .blend depends on, as absolute normalised paths."""
    blend_dir = os.path.dirname(bpy.data.filepath) or None
    refs: list[lg.Reference] = []

    def add(kind, idblock, raw):
        try:
            path = lg.resolve_reference_path(raw, _base_dir(idblock, blend_dir))
        except ValueError:
            path = str(raw)  # unsaved file + relative path: report it verbatim (fails closed)
        refs.append(lg.Reference(kind, idblock.name, path, idblock.get("jfilm_asset_id")))

    for lib in bpy.data.libraries:
        refs.append(lg.Reference("library", lib.name, _library_path(lib, blend_dir)))
    for img in bpy.data.images:
        if img.source in {"FILE", "SEQUENCE", "TILED", "MOVIE"}:
            add("image", img, img.filepath)  # packed images too: the embedded file still needs a licence
    for kind, collection in (("font", bpy.data.fonts), ("sound", bpy.data.sounds),
                             ("movieclip", bpy.data.movieclips), ("volume", bpy.data.volumes),
                             ("cache_file", bpy.data.cache_files)):
        for idblock in collection:
            add(kind, idblock, idblock.filepath)
    # External files referenced from node trees (IES light profiles, OSL scripts).
    owners = [*bpy.data.materials, *bpy.data.worlds, *bpy.data.lights, *bpy.data.node_groups]
    for owner in owners:
        tree = owner if isinstance(owner, bpy.types.NodeTree) else getattr(owner, "node_tree", None)
        if tree is None:
            continue
        for node in tree.nodes:
            if node.type in {"TEX_IES", "SCRIPT"} and getattr(node, "mode", "") == "EXTERNAL":
                add("ies" if node.type == "TEX_IES" else "script", owner, node.filepath)
    return refs


def run_licence_gate() -> int:
    refs = collect_references()
    root = lg.library_root()
    log(f"Licence gate: {len(refs)} external file reference(s); library {root or '(JFILM_LIBRARY unset)'}")
    problems = lg.check(refs, library_root=root)
    if problems:
        print(f"[style_frame] LICENCE GATE FAILED: {len(problems)} unlisted/invalid reference(s):",
              file=sys.stderr, flush=True)
        for problem in problems:
            print(f"    {problem}", file=sys.stderr, flush=True)
        if root is None:
            print(f"    hint: {lg.LIBRARY_MISSING_HINT}", file=sys.stderr, flush=True)
        print("[style_frame] Add licensed entries to licenses/assets.yaml or remove the assets. Nothing rendered.",
              file=sys.stderr, flush=True)
        return tc.EXIT_LICENCE
    log("Licence gate: all references listed in licenses/assets.yaml")
    return tc.EXIT_OK


# ================================================================== grade


def _socket(sockets, name, socket_type):
    return next(s for s in sockets if s.name == name and s.type == socket_type)


def _set_curve(curve, points) -> None:
    pts = curve.points
    while len(pts) < len(points):
        pts.new(0.5, 0.5)
    for point, (x, y) in zip(pts, points):
        point.location = (x, y)


def build_grade(scene) -> None:
    """Film Credit grade inside the render (compositor); see GRADE for the chain."""
    tree = bpy.data.node_groups.new("FilmCredit_Grade", "CompositorNodeTree")
    tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    nodes, links = tree.nodes, tree.links

    render = nodes.new("CompositorNodeRLayers")

    cdl = nodes.new("CompositorNodeColorBalance")
    cdl.inputs["Type"].default_value = "Offset/Power/Slope (ASC-CDL)"
    _socket(cdl.inputs, "Slope", "RGBA").default_value = (*GRADE["cdl_slope"], 1.0)
    links.new(render.outputs["Image"], cdl.inputs["Image"])

    to_display = nodes.new("CompositorNodeConvertColorSpace")
    to_display.from_color_space, to_display.to_color_space = "scene_linear", GRADE["tonemap"]
    links.new(cdl.outputs["Image"], to_display.inputs["Image"])

    sat = nodes.new("CompositorNodeHueSat")
    sat.inputs["Saturation"].default_value = GRADE["saturation"]
    links.new(to_display.outputs["Image"], sat.inputs["Image"])

    curves = nodes.new("CompositorNodeCurveRGB")
    mapping = curves.mapping
    for index, key in enumerate(("curve_r", "curve_g", "curve_b", "curve_c")):  # CurveMapping order
        _set_curve(mapping.curves[index], GRADE[key])
    mapping.update()
    links.new(sat.outputs["Image"], curves.inputs["Image"])

    # Amber push on the brightest areas (display luma mask) -> monitor toward #F2D3A8.
    luma = nodes.new("CompositorNodeRGBToBW")
    links.new(curves.outputs["Image"], luma.inputs["Image"])
    mask = nodes.new("ShaderNodeMapRange")
    mask.clamp = True
    lo, hi = GRADE["highlight_mask"]
    mask.inputs["From Min"].default_value, mask.inputs["From Max"].default_value = lo, hi
    links.new(luma.outputs["Val"], mask.inputs["Value"])
    amber = nodes.new("ShaderNodeMix")
    amber.data_type, amber.blend_type = "RGBA", "MULTIPLY"
    links.new(_socket(mask.outputs, "Result", "VALUE"), _socket(amber.inputs, "Factor", "VALUE"))
    links.new(curves.outputs["Image"], _socket(amber.inputs, "A", "RGBA"))
    _socket(amber.inputs, "B", "RGBA").default_value = (*GRADE["highlight_amber"], 1.0)

    cap = nodes.new("ShaderNodeMix")
    cap.data_type, cap.blend_type = "RGBA", "DARKEN"
    _socket(cap.inputs, "Factor", "VALUE").default_value = 1.0
    links.new(_socket(amber.outputs, "Result", "RGBA"), _socket(cap.inputs, "A", "RGBA"))
    c = GRADE["display_ceiling"]
    _socket(cap.inputs, "B", "RGBA").default_value = (c, c, c, 1.0)

    to_linear = nodes.new("CompositorNodeConvertColorSpace")
    to_linear.from_color_space, to_linear.to_color_space = "sRGB", "scene_linear"
    links.new(_socket(cap.outputs, "Result", "RGBA"), to_linear.inputs["Image"])

    out = nodes.new("NodeGroupOutput")
    links.new(to_linear.outputs["Image"], out.inputs[0])

    scene.compositing_node_group = tree
    scene.render.use_compositing = True
    scene.display_settings.display_device = "sRGB"
    vs = scene.view_settings
    vs.view_transform, vs.look = "Standard", "None"  # exact inverse of the sRGB step above
    vs.exposure, vs.gamma, vs.use_curve_mapping = 0.0, 1.0, False
    scene.render.film_transparent = False
    log("Grade: " + "; ".join(f"{k}={v}" for k, v in GRADE.items()))


# ================================================================== main


def main(argv: list[str]) -> int:
    args = tc.parse_args(argv, prog=PROG, extend=add_style_arguments)
    if not 1 <= args.resolution_percentage <= 100:
        print(f"{PROG}: error: --resolution-percentage must be 1..100", file=sys.stderr)
        return tc.EXIT_USAGE

    try:
        pinned = tc.read_pinned_version()
    except (OSError, ValueError) as exc:
        fail(tc.EXIT_CONFIG, f"cannot read pinned version: {exc}")
    running = tc.format_version(bpy.app.version)
    log(f"Blender version: {bpy.app.version_string} (running {running}, pinned {pinned})")
    ok, message = tc.check_version(running, pinned, args.allow_version_mismatch)
    if message:
        print(f"[style_frame] {message}", file=sys.stderr, flush=True)
    if not ok:
        return tc.EXIT_VERSION_MISMATCH

    if not bpy.data.filepath:
        fail(tc.EXIT_USAGE, "no scene loaded: run as  blender -b <scene>.blend -P pipeline/style_frame.py -- ...")
    log(f"Scene file: {bpy.data.filepath}")

    code = run_licence_gate()
    if code != tc.EXIT_OK:
        return code

    scene = bpy.context.scene
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        backend, gpus = tc.enable_gpu_devices(prefs)
    except tc.NoGpuError as exc:
        fail(tc.EXIT_NO_GPU, str(exc))
    log(f"Cycles device type: {backend}; GPU: {', '.join(gpus)}")

    width, height, cam_name = tc.aspect_spec(args.aspect)
    camera = bpy.data.objects.get(cam_name)
    if camera is None or camera.type != "CAMERA":
        fail(tc.EXIT_CONFIG, f"scene has no camera object {cam_name!r} for aspect {args.aspect}")
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPTIX" if backend == "OPTIX" else "OPENIMAGEDENOISE"
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = args.resolution_percentage
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    scene.render.use_border = False
    settings = scene.render.image_settings
    settings.file_format, settings.color_mode, settings.color_depth = "PNG", "RGB", "8"
    build_grade(scene)

    out_dir = tc.ensure_out_dir(args.out)
    out_file = out_dir / f"{args.stem}_{args.aspect}.png"
    out_file.unlink(missing_ok=True)  # a stale frame must not pass the checks below
    scene.render.filepath = str(out_file)
    expected = tc.output_size(args.aspect, args.resolution_percentage)
    log(f"Rendering {args.aspect} {expected[0]}x{expected[1]} with {cam_name}, {args.samples} samples "
        f"+ denoise ({scene.cycles.denoiser}) -> {out_file}")

    with tc.VramSampler() as vram:
        start = time.perf_counter()
        result = bpy.ops.render.render(write_still=True)
        elapsed = time.perf_counter() - start
    if "FINISHED" not in result:
        fail(tc.EXIT_RENDER_FAILED, f"render operator returned {sorted(result)}")
    if not out_file.is_file():
        fail(tc.EXIT_RENDER_FAILED, f"render finished but {out_file} was not written")

    image = bpy.data.images.load(str(out_file), check_existing=False)
    try:
        size = tuple(image.size)
        white = tc.count_pure_white(image.pixels[:], channels=image.channels)
    finally:
        bpy.data.images.remove(image)
    if size != expected:
        fail(tc.EXIT_RENDER_FAILED, f"expected {expected[0]}x{expected[1]}, got {size[0]}x{size[1]}")
    if white:
        warn(f"{white} pure-white (#FFFFFF) pixel(s) in {out_file.name}; render kept for review")
    else:
        log("Pure-white pixels: 0")

    log(f"Render time: {elapsed:.1f} s ({backend}: {', '.join(gpus)})")
    if vram.error:
        warn(vram.error)
    log(f"VRAM: {tc.format_vram(vram.result, vram.baseline)}")
    log(f"Wrote {out_file} ({size[0]}x{size[1]})")
    return tc.EXIT_OK


if __name__ == "__main__":
    try:
        code = main(sys.argv)
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - any unexpected failure must be non-zero
        traceback.print_exc()
        code = tc.EXIT_RENDER_FAILED
    sys.exit(code)
