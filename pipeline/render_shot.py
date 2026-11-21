"""Render the ``ii-03-clock`` shot (Story 0.3): a first-person turn from the desk
toward the wall clock, as resumable per-frame PNGs plus per-frame monitor quads.

Usage (headless; script arguments go after ``--``):

    $env:JFILM_LIBRARY = "C:\\Users\\Jun\\jfilm-library"
    blender -b pipeline/out/scenes/act2_desk_0307.blend --factory-startup -P pipeline/render_shot.py --
        --aspect 16x9|9x16 [--frames 0-15|0,36,71] [--samples 64]
        [--out pipeline/out/shots] [--quads-only] [--clean] [--allow-version-mismatch]

Pipeline: version gate -> licence gate (``style_frame.run_licence_gate``, same
collector) -> OptiX/CUDA GPU -> copy of ``CAM_16x9`` / ``CAM_9x16`` keyframed
per frame from the spring-eased turn (``lib/shot.py``) -> Film Credit grade
(``style_frame.build_grade``) -> monitor quads for all 72 frames written to
``quads.json`` -> render the requested frames that are not yet valid on disk.

Output (0-based frames): ``<out>/ii-03-clock/<aspect>/frame-NNNN.png``,
``quads.json`` and ``render-log.jsonl`` (one line per rendered frame with its
render time). 16:9 renders 1920x1080, 9:16 renders 720x1280 directly.

Resume: frames with a complete PNG of the right size are skipped. The render
parameters (move, samples, size, grade, scene file) are fingerprinted in
``quads.json``; if they changed while frames exist, the script refuses (exit 1)
unless ``--clean`` deletes the old frames, so one sequence never mixes moves.

Exit codes: 0 ok, 1 usage / fingerprint mismatch, 2 no GPU, 3 version mismatch,
4 render failed / bad output, 5 bad BLENDER_VERSION or scene lacks an object,
6 licence gate refused the scene.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from typing import NoReturn

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import shot  # noqa: E402
from lib import toolchain as tc  # noqa: E402

import bpy  # noqa: E402
from bpy_extras.object_utils import world_to_camera_view  # noqa: E402
from mathutils import Quaternion, Vector  # noqa: E402

import style_frame  # noqa: E402  (licence gate collector + Film Credit grade)

PROG = "render_shot.py"
DEFAULT_OUT = str(PIPELINE_DIR / "out" / "shots")  # resolved from the repo, not the current directory
BLENDER_FRAME_START = 1  # Blender frame of 0-based frame 0
SCREEN_OBJECT = "Monitor_Hero_Screen"
CLOCK_OBJECT = "WallClock_0307"
# The Poly Haven clock's dial face sits ~3-5 cm in front of the instance origin (-Y).
CLOCK_FACE_OFFSET = (0.0, -0.03, 0.0)

# Per-aspect move (scene-specific; metres, world space).
#   start_target: where Jun looks at frame 0 (down at the desk / monitor, a little left)
#   end_offset:   aim point relative to the clock face centre at the last frame
#   loc_delta:    eye drift over the move (sitting up slightly while looking up)
#   lens_scale:   focal push over the move (attention zoom), relative to the camera lens
MOVES = {
    "16x9": {"start_target": (-0.30, 2.0, 0.85), "end_offset": (0.0, 0.0, 0.0), "loc_delta": (0.0, 0.05, 0.03),
             "lens_scale": 1.35},
    # 9:16: start keeps monitor + Kia's note + coffee centred (as the style frame);
    # end aims above the clock and Jun sits up more, so the monitor top drops to
    # a thin strip instead of filling the bottom quarter of the tall frame.
    "9x16": {"start_target": (-0.12, 1.6, 0.82), "end_offset": (0.0, 0.0, 0.22), "loc_delta": (0.0, 0.05, 0.06),
             "lens_scale": 1.35},
}
MOVE_TUNING = {"roll_peak": math.radians(-1.2), "hold": 0.06, "pitch_lag": 0.04,
               "yaw_damping": 0.75, "pitch_damping": 0.7, "omega": 10.0}


def log(message: str) -> None:
    print(f"[render_shot] {message}", flush=True)


def fail(code: int, message: str) -> NoReturn:
    print(f"[render_shot] ERROR: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def add_shot_arguments(parser) -> None:
    tc.add_aspect_argument(parser)
    for action in parser._actions:  # --out is optional here
        if action.dest == "out":
            action.required = False
            action.default = DEFAULT_OUT
            action.help = "output root (default %(default)s); frames go to <out>/ii-03-clock/<aspect>/"
    parser.add_argument("--frames", default=None,
                        help="0-based frames: 'a-b', 'n' or a comma list (default: all 72)")
    parser.add_argument("--quads-only", action="store_true", help="write quads.json, render nothing")
    parser.add_argument("--clean", action="store_true",
                        help="delete existing frames of this aspect if the render parameters changed")


# ================================================================== move


def build_move(aspect: str, camera, clock) -> shot.TurnMove:
    spec = MOVES[aspect]
    loc = tuple(camera.matrix_world.translation)
    clock_face = Vector(clock.matrix_world.translation) + Vector(CLOCK_FACE_OFFSET)
    end_target = tuple(clock_face + Vector(spec["end_offset"]))
    yaw0, pitch0 = shot.aim(loc, spec["start_target"])
    loc_end = tuple(a + d for a, d in zip(loc, spec["loc_delta"]))
    yaw1, pitch1 = shot.aim(loc_end, end_target)
    lens = float(camera.data.lens)
    return shot.TurnMove(loc, loc_end, yaw0, pitch0, yaw1, pitch1, **MOVE_TUNING,
                         lens_start=lens, lens_end=round(lens * spec["lens_scale"], 3))


def pose_quaternion(pose: shot.Pose) -> Quaternion:
    """Look along the pose direction (camera -Z), world-up Y, then roll about the view axis."""
    q = Vector(pose.direction).to_track_quat("-Z", "Y")
    return q @ Quaternion((0.0, 0.0, 1.0), pose.roll)


def make_shot_camera(scene, source, aspect: str, poses: list[shot.Pose]):
    cam = source.copy()
    cam.data = source.data.copy()
    cam.name = cam.data.name = f"SHOT_{shot.SHOT_ID}_{aspect}"
    cam.animation_data_clear()
    cam.parent = None
    scene.collection.objects.link(cam)
    cam.rotation_mode = "QUATERNION"
    previous = None
    for index, pose in enumerate(poses):
        frame = BLENDER_FRAME_START + index
        q = pose_quaternion(pose)
        if previous is not None and previous.dot(q) < 0:  # keep the quaternion path continuous
            q.negate()
        previous = q
        cam.location = pose.location
        cam.rotation_quaternion = q
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_quaternion", frame=frame)
        if pose.lens is not None:
            cam.data.lens = pose.lens
            cam.data.keyframe_insert("lens", frame=frame)
    scene.frame_start = BLENDER_FRAME_START
    scene.frame_end = BLENDER_FRAME_START + len(poses) - 1
    scene.render.fps = shot.AUTHORING_FPS
    scene.camera = cam
    return cam


def compute_quads(scene, cam, screen, frame_count: int) -> list:
    local_corners = shot.face_at_min([tuple(v.co) for v in screen.data.vertices], axis=1)
    quads = []
    for index in range(frame_count):
        scene.frame_set(BLENDER_FRAME_START + index)
        matrix = screen.matrix_world
        projected = [tuple(world_to_camera_view(scene, cam, matrix @ Vector(c))) for c in local_corners]
        quads.append(shot.monitor_quad(projected))
    return quads


# ================================================================== io helpers


def write_json_atomic(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def existing_fingerprint(quads_file: Path) -> str | None:
    try:
        return json.loads(quads_file.read_text(encoding="utf-8")).get("fingerprint")
    except (OSError, ValueError):
        return None


# ================================================================== main


def main(argv: list[str]) -> int:
    args = tc.parse_args(argv, prog=PROG, extend=add_shot_arguments)
    try:
        frames = shot.parse_frame_range(args.frames, shot.FRAME_COUNT)
    except shot.ShotError as exc:
        print(f"{PROG}: error: {exc}", file=sys.stderr)
        return tc.EXIT_USAGE

    try:
        pinned = tc.read_pinned_version()
    except (OSError, ValueError) as exc:
        fail(tc.EXIT_CONFIG, f"cannot read pinned version: {exc}")
    running = tc.format_version(bpy.app.version)
    log(f"Blender version: {bpy.app.version_string} (running {running}, pinned {pinned})")
    ok, message = tc.check_version(running, pinned, args.allow_version_mismatch)
    if message:
        print(f"[render_shot] {message}", file=sys.stderr, flush=True)
    if not ok:
        return tc.EXIT_VERSION_MISMATCH

    if not bpy.data.filepath:
        fail(tc.EXIT_USAGE, "no scene loaded: run as  blender -b <scene>.blend -P pipeline/render_shot.py -- ...")
    log(f"Scene file: {bpy.data.filepath}")

    code = style_frame.run_licence_gate()
    if code != tc.EXIT_OK:
        return code

    scene = bpy.context.scene
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        backend, gpus = tc.enable_gpu_devices(prefs)
    except tc.NoGpuError as exc:
        fail(tc.EXIT_NO_GPU, str(exc))
    log(f"Cycles device type: {backend}; GPU: {', '.join(gpus)}")

    _, _, cam_name = tc.aspect_spec(args.aspect)
    objects = {}
    for name, kind in ((cam_name, "CAMERA"), (CLOCK_OBJECT, None), (SCREEN_OBJECT, "MESH")):
        obj = bpy.data.objects.get(name)
        if obj is None or (kind and obj.type != kind):
            fail(tc.EXIT_CONFIG, f"scene has no {kind or 'object'} {name!r}")
        objects[name] = obj

    width, height = shot.RENDER_SIZES[args.aspect]
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPTIX" if backend == "OPTIX" else "OPENIMAGEDENOISE"
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    scene.render.use_border = False
    scene.render.use_motion_blur = False  # sharp frames for scrubbing
    scene.render.use_persistent_data = True  # keep scene data between frames
    scene.render.use_file_extension = False
    settings = scene.render.image_settings
    settings.file_format, settings.color_mode, settings.color_depth = "PNG", "RGB", "8"
    style_frame.build_grade(scene)

    move = build_move(args.aspect, objects[cam_name], objects[CLOCK_OBJECT])
    poses = shot.turn_poses(move, shot.FRAME_COUNT)
    cam = make_shot_camera(scene, objects[cam_name], args.aspect, poses)
    log("Move: " + json.dumps(move.as_dict()))

    params = {
        "shot": shot.SHOT_ID, "aspect": args.aspect, "size": [width, height], "samples": args.samples,
        "frameCount": shot.FRAME_COUNT, "move": move.as_dict(), "grade": repr(style_frame.GRADE),
        "scene": shot.sha256_file(bpy.data.filepath)[:16],
    }
    fp = shot.fingerprint(params)

    out_dir = tc.ensure_out_dir(Path(args.out) / shot.SHOT_ID / args.aspect)
    quads_file = out_dir / "quads.json"
    existing_frames = sorted(out_dir.glob("frame-*.png"))
    previous = existing_fingerprint(quads_file)
    if existing_frames and previous != fp:
        if not args.clean:
            fail(tc.EXIT_USAGE,
                 f"{len(existing_frames)} frame(s) in {out_dir} were rendered with other parameters "
                 f"(fingerprint {previous} != {fp}); pass --clean to delete them and start over")
        for f in existing_frames:
            f.unlink()
        (out_dir / "render-log.jsonl").unlink(missing_ok=True)
        log(f"--clean: deleted {len(existing_frames)} stale frame(s)")

    quads = compute_quads(scene, cam, objects[SCREEN_OBJECT], shot.FRAME_COUNT)
    stats = shot.quad_stats(quads)
    write_json_atomic(quads_file, {
        "shot": shot.SHOT_ID,
        "aspect": args.aspect,
        "width": width,
        "height": height,
        "frameCount": shot.FRAME_COUNT,
        "authoringFps": shot.AUTHORING_FPS,
        "blenderFrameStart": BLENDER_FRAME_START,
        "screenObject": SCREEN_OBJECT,
        "convention": "normalized top-left frame space; corners TL, TR, BR, BL; may exceed [0,1] when "
                      "partly off-frame; null when a corner is behind the camera",
        "fingerprint": fp,
        "params": params,
        "stats": stats,
        "quads": quads,
        "poses": [
            {"frame": i, "location": [round(v, 6) for v in p.location],
             "yawDeg": round(math.degrees(p.yaw), 4), "pitchDeg": round(math.degrees(p.pitch), 4),
             "rollDeg": round(math.degrees(p.roll), 4),
             "lensMm": None if p.lens is None else round(p.lens, 4)}
            for i, p in enumerate(poses)
        ],
    })
    log(f"Quads: {quads_file} {stats}")
    if args.quads_only:
        return tc.EXIT_OK

    todo = shot.frames_to_render(frames, out_dir, (width, height))
    skipped = len(frames) - len(todo)
    log(f"Frames requested {len(frames)}, already valid {skipped}, to render {len(todo)} "
        f"({args.aspect} {width}x{height}, {args.samples} samples + denoise {scene.cycles.denoiser})")

    log_file = out_dir / "render-log.jsonl"
    times = []
    with tc.VramSampler() as vram:
        batch_start = time.perf_counter()
        for index in todo:
            final = out_dir / shot.frame_filename(index)
            tmp = out_dir / f".{final.stem}.tmp.png"
            tmp.unlink(missing_ok=True)
            scene.frame_set(BLENDER_FRAME_START + index)
            scene.render.filepath = str(tmp)
            start = time.perf_counter()
            result = bpy.ops.render.render(write_still=True)
            elapsed = time.perf_counter() - start
            if "FINISHED" not in result:
                fail(tc.EXIT_RENDER_FAILED, f"frame {index}: render operator returned {sorted(result)}")
            size = shot.png_size(tmp)
            if size != (width, height):
                fail(tc.EXIT_RENDER_FAILED, f"frame {index}: expected {width}x{height} PNG, got {size}")
            os.replace(tmp, final)
            times.append(elapsed)
            with log_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "frame": index, "seconds": round(elapsed, 2), "aspect": args.aspect,
                    "size": [width, height], "samples": args.samples, "backend": backend,
                    "fingerprint": fp, "at": _dt.datetime.now().isoformat(timespec="seconds"),
                }) + "\n")
            log(f"frame {index:2d} -> {final.name}  {elapsed:.1f} s")
        batch = time.perf_counter() - batch_start

    if times:
        log(f"Rendered {len(times)} frame(s) in {batch:.1f} s; per frame avg {sum(times) / len(times):.1f} s, "
            f"min {min(times):.1f} s, max {max(times):.1f} s")
        if vram.error:
            print(f"[render_shot] WARNING: {vram.error}", file=sys.stderr, flush=True)
        log(f"VRAM: {tc.format_vram(vram.result, vram.baseline)}")
    present = len(shot.parse_frame_range(None)) - len(
        shot.frames_to_render(range(shot.FRAME_COUNT), out_dir, (width, height)))
    log(f"Frames present for {args.aspect}: {present}/{shot.FRAME_COUNT}")
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
