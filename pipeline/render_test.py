"""Render one 1920x1080 Cycles GPU test frame to prove the headless toolchain.

Usage (headless only; script arguments go after ``--``):

    blender -b --factory-startup -P pipeline/render_test.py -- --out pipeline/out/test
        [--samples 64] [--allow-version-mismatch]

Exit codes: 0 ok, 1 usage, 2 no GPU (OptiX/CUDA), 3 version mismatch,
4 render failed, 5 bad pipeline/BLENDER_VERSION.
"""

from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path
from typing import NoReturn

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import toolchain as tc  # noqa: E402

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

RES_X, RES_Y = 1920, 1080
OUTPUT_NAME = "test-frame.png"


def log(message: str) -> None:
    print(f"[render_test] {message}", flush=True)


def fail(code: int, message: str) -> NoReturn:
    print(f"[render_test] ERROR: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# --------------------------------------------------------------------------- GPU


def setup_gpu(scene) -> tuple[str, list[str]]:
    """Enable OptiX (else CUDA) devices; exit EXIT_NO_GPU if neither is usable."""
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        backend, enabled_gpus = tc.enable_gpu_devices(prefs)
    except tc.NoGpuError as exc:
        fail(tc.EXIT_NO_GPU, f"{exc} (expected the RTX 2060)")

    scene.cycles.device = "GPU"
    return backend, enabled_gpus


# ------------------------------------------------------------------------- Scene


def _node_tree(idblock):
    if idblock.node_tree is None and hasattr(idblock, "use_nodes"):
        idblock.use_nodes = True
    return idblock.node_tree


def _material(name: str, rgba: tuple[float, float, float, float], roughness: float):
    mat = bpy.data.materials.new(name)
    tree = _node_tree(mat)
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def _look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build_scene(samples: int):
    """Build plane, cube, camera, one area light and a world colour from code."""
    scene = bpy.context.scene

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    bpy.ops.mesh.primitive_plane_add(size=12.0, location=(0.0, 0.0, 0.0))
    plane = bpy.context.active_object
    plane.name = "TestPlane"
    plane.data.materials.append(_material("TestPlaneMat", (0.18, 0.18, 0.18, 1.0), 0.6))

    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 1.0))
    cube = bpy.context.active_object
    cube.name = "TestCube"
    cube.rotation_euler = (0.0, 0.0, 0.6)
    cube.data.materials.append(_material("TestCubeMat", (0.8, 0.45, 0.2, 1.0), 0.35))

    light_data = bpy.data.lights.new("TestAreaLight", type="AREA")
    light_data.energy = 400.0
    light_data.size = 3.0
    light = bpy.data.objects.new("TestAreaLight", light_data)
    scene.collection.objects.link(light)
    light.location = (3.0, -3.0, 5.0)
    _look_at(light, Vector((0.0, 0.0, 0.5)))

    cam_data = bpy.data.cameras.new("TestCamera")
    cam_data.lens = 40.0
    camera = bpy.data.objects.new("TestCamera", cam_data)
    scene.collection.objects.link(camera)
    camera.location = (6.5, -6.5, 4.5)
    _look_at(camera, Vector((0.0, 0.0, 0.8)))
    scene.camera = camera

    world = scene.world or bpy.data.worlds.new("TestWorld")
    scene.world = world
    background = next(n for n in _node_tree(world).nodes if n.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.05, 0.07, 0.1, 1.0)
    background.inputs["Strength"].default_value = 1.0

    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = RES_X
    scene.render.resolution_y = RES_Y
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    return scene


# -------------------------------------------------------------------------- Main


def main(argv: list[str]) -> int:
    args = tc.parse_args(argv)  # exits EXIT_USAGE on bad/missing args

    try:
        pinned = tc.read_pinned_version()
    except (OSError, ValueError) as exc:
        fail(tc.EXIT_CONFIG, f"cannot read pinned version: {exc}")

    running = tc.format_version(bpy.app.version)
    log(f"Blender version: {bpy.app.version_string} (running {running}, pinned {pinned})")
    ok, message = tc.check_version(running, pinned, args.allow_version_mismatch)
    if message:
        print(f"[render_test] {message}", file=sys.stderr, flush=True)
    if not ok:
        sys.exit(tc.EXIT_VERSION_MISMATCH)

    backend, gpus = setup_gpu(bpy.context.scene)
    log(f"Cycles device type: {backend}")
    for name in gpus:
        log(f"GPU: {name}")

    scene = build_scene(args.samples)

    out_dir = tc.ensure_out_dir(args.out)
    out_file = out_dir / OUTPUT_NAME
    out_file.unlink(missing_ok=True)  # a stale frame must not pass the checks below
    scene.render.filepath = str(out_file)
    log(f"Rendering {RES_X}x{RES_Y}, {args.samples} samples -> {out_file}")

    start = time.perf_counter()
    result = bpy.ops.render.render(write_still=True)
    elapsed = time.perf_counter() - start
    if "FINISHED" not in result:
        fail(tc.EXIT_RENDER_FAILED, f"render operator returned {sorted(result)}")

    if not out_file.is_file():
        fail(tc.EXIT_RENDER_FAILED, f"render finished but {out_file} was not written")
    image = bpy.data.images.load(str(out_file), check_existing=False)
    size = tuple(image.size)
    bpy.data.images.remove(image)
    if size != (RES_X, RES_Y):
        fail(tc.EXIT_RENDER_FAILED, f"expected {RES_X}x{RES_Y}, got {size[0]}x{size[1]}")

    log(f"Render time: {elapsed:.2f} s ({backend}: {', '.join(gpus)})")
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
