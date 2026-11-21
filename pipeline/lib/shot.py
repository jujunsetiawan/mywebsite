"""Pure shot helpers for Story 0.3 (no ``bpy``, plain Python 3.12).

Used by ``render_shot.py`` (inside Blender), ``encode_pack.py`` and
``check_chunks.py`` (plain Python). Everything here is unit-tested in
``pipeline/tests/test_shot.py``.

Contents:

- spring-eased camera curve (damped spring step response, slight overshoot);
- frame renumbering (Blender frame numbers -> 0-based) and ``--frames a-b``;
- resumable rendering (which frames still need rendering; PNG validity check);
- chunk packing plan (frame -> chunk index, byte offset, byte length);
- media paths / URL pattern (aspect ``16x9|9x16``, tier ``1080|720``);
- monitor quad conversion (Blender bottom-left -> normalized top-left,
  corners ordered TL, TR, BR, BL);
- mediaVersion immutability check.
"""

from __future__ import annotations

import hashlib
import math
import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence

# ------------------------------------------------------------------ Constants

SHOT_ID = "ii-03-clock"
ACT = "II"
MEDIA_VERSION = "spike-2026-11-21"
AUTHORING_FPS = 24
FRAME_COUNT = 72  # ~3 s at 24 fps
DEFAULT_CHUNK_FRAMES = 16  # N: frames per chunk file (72 frames -> 5 chunks)

ASPECTS = ("16x9", "9x16")
TIERS = ("1080", "720")
# Spike tiers per aspect: 16:9 at 1080 and 720 (720 downscaled from 1080),
# 9:16 at 720 only.
TIERS_BY_ASPECT: dict[str, tuple[str, ...]] = {"16x9": ("1080", "720"), "9x16": ("720",)}
# Pixel size of every (aspect, tier) pair the v1 contract knows about.
TIER_SIZES: dict[tuple[str, str], tuple[int, int]] = {
    ("16x9", "1080"): (1920, 1080),
    ("16x9", "720"): (1280, 720),
    ("9x16", "1080"): (1080, 1920),
    ("9x16", "720"): (720, 1280),
}

# Render size per aspect: 16:9 renders 1080 (720 is downscaled from it later);
# 9:16 renders its only tier (720) directly.
RENDER_SIZES: dict[str, tuple[int, int]] = {"16x9": (1920, 1080), "9x16": (720, 1280)}

URL_PATTERN = "<media-base>/<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin"
FRAME_DATA_PATTERN = "frames/<act>.<aspect>.json"


class ShotError(ValueError):
    """Invalid shot parameters (bad range, segment, chunk size ...)."""


class ImmutableVersionError(RuntimeError):
    """Published output under a mediaVersion would change without ``--force``."""

    def __init__(self, version_dir: Path, differences: Sequence[str]):
        self.version_dir = Path(version_dir)
        self.differences = list(differences)
        listed = "\n".join(f"    {d}" for d in self.differences)
        super().__init__(
            f"mediaVersion directory {self.version_dir} is published and immutable; "
            f"{len(self.differences)} file(s) would change:\n{listed}\n"
            "Use a new mediaVersion, or pass --force to overwrite."
        )


# --------------------------------------------------------------- Spring curve

DEFAULT_DAMPING = 0.75  # zeta < 1: underdamped -> overshoot ~2.8 %
DEFAULT_OMEGA = 10.0  # natural frequency in "shot durations" (settles by t = 1)


def spring_step(t: float, damping: float = DEFAULT_DAMPING, omega: float = DEFAULT_OMEGA) -> float:
    """Unit step response of a damped spring at normalised time ``t`` (raw, unscaled).

    Starts at rest (value 0, velocity 0) and approaches 1. ``damping`` must be
    in (0, 1) (underdamped, so it overshoots once and settles).
    """
    if not 0.0 < damping < 1.0:
        raise ShotError(f"damping must be in (0, 1) for an overshooting spring, got {damping}")
    if omega <= 0:
        raise ShotError(f"omega must be > 0, got {omega}")
    if t <= 0:
        return 0.0
    wd = omega * math.sqrt(1.0 - damping * damping)
    decay = math.exp(-damping * omega * t)
    return 1.0 - decay * (math.cos(wd * t) + (damping * omega / wd) * math.sin(wd * t))


def spring_ease(t: float, damping: float = DEFAULT_DAMPING, omega: float = DEFAULT_OMEGA) -> float:
    """Spring easing on ``t`` in [0, 1]: 0 at t=0, exactly 1 at t=1, slight overshoot between.

    The raw step response is rescaled by its value at t=1 so the camera lands
    exactly on the target on the last frame.
    """
    t = min(max(t, 0.0), 1.0)
    end = spring_step(1.0, damping, omega)
    return spring_step(t, damping, omega) / end


def spring_curve(
    frame_count: int = FRAME_COUNT,
    damping: float = DEFAULT_DAMPING,
    omega: float = DEFAULT_OMEGA,
) -> list[float]:
    """Eased progress for each 0-based frame (first 0.0, last exactly 1.0)."""
    if frame_count < 2:
        raise ShotError(f"frame_count must be >= 2, got {frame_count}")
    last = frame_count - 1
    values = [spring_ease(i / last, damping, omega) for i in range(frame_count)]
    values[0], values[-1] = 0.0, 1.0
    return values


def lerp(a: Sequence[float], b: Sequence[float], u: float) -> tuple[float, ...]:
    """Component-wise ``a + (b - a) * u`` (u may exceed 1 for the overshoot)."""
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def delayed_spring(
    t: float, delay: float = 0.0, damping: float = DEFAULT_DAMPING, omega: float = DEFAULT_OMEGA
) -> float:
    """Spring easing that holds at 0 until ``delay`` (fraction of the shot), then runs to 1 at t=1."""
    if not 0.0 <= delay < 1.0:
        raise ShotError(f"delay must be in [0, 1), got {delay}")
    if t <= delay:
        return 0.0
    return spring_ease((t - delay) / (1.0 - delay), damping, omega)


# ------------------------------------------------------------ Camera turn
#
# World convention (Blender scene): X right, Y forward, Z up.
# yaw   = rotation about +Z from +Y; positive turns LEFT (counter-clockwise from above).
# pitch = elevation above the horizon; positive looks UP.
# roll  = rotation about the view axis; positive tilts the image clockwise
#         (camera local +Z rotation in Blender).


def yaw_pitch(direction: Sequence[float]) -> tuple[float, float]:
    """``(yaw, pitch)`` in radians of a view direction vector."""
    dx, dy, dz = (float(v) for v in direction)
    horiz = math.hypot(dx, dy)
    if horiz == 0.0 and dz == 0.0:
        raise ShotError("view direction must be non-zero")
    return math.atan2(-dx, dy), math.atan2(dz, horiz)


def look_direction(yaw: float, pitch: float) -> tuple[float, float, float]:
    """Unit view direction for ``(yaw, pitch)``; inverse of :func:`yaw_pitch`."""
    return (-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch))


def aim(location: Sequence[float], target: Sequence[float]) -> tuple[float, float]:
    """``(yaw, pitch)`` from ``location`` looking at ``target``."""
    return yaw_pitch([t - l for l, t in zip(location, target)])


@dataclass(frozen=True)
class TurnMove:
    """A first-person head turn: from a start aim to an end aim, spring-eased.

    Yaw and pitch run on separate springs (pitch slightly later and a little
    looser) so the path is a gentle arc, not a straight line; the head also
    tilts a little into the turn (``roll_peak``) and the eye drifts from
    ``loc_start`` to ``loc_end`` (sitting up).
    """

    loc_start: tuple[float, float, float]
    loc_end: tuple[float, float, float]
    yaw_start: float
    pitch_start: float
    yaw_end: float
    pitch_end: float
    roll_peak: float = math.radians(-1.2)
    hold: float = 0.06  # fraction of the shot before the head starts moving
    pitch_lag: float = 0.04  # extra delay of the pitch spring (fraction of the shot)
    yaw_damping: float = DEFAULT_DAMPING
    pitch_damping: float = 0.7
    omega: float = DEFAULT_OMEGA
    # Optional focal push ("attention" zoom) in mm; None keeps the camera lens.
    lens_start: float | None = None
    lens_end: float | None = None
    lens_lag: float = 0.12  # extra delay after the hold: the eye settles, then focuses
    lens_damping: float = 0.9  # almost no overshoot on the focal length

    def as_dict(self) -> dict:
        return {
            "lensStart": self.lens_start,
            "lensEnd": self.lens_end,
            "lensLag": self.lens_lag,
            "lensDamping": self.lens_damping,
            "locStart": [round(v, 6) for v in self.loc_start],
            "locEnd": [round(v, 6) for v in self.loc_end],
            "yawStartDeg": round(math.degrees(self.yaw_start), 4),
            "pitchStartDeg": round(math.degrees(self.pitch_start), 4),
            "yawEndDeg": round(math.degrees(self.yaw_end), 4),
            "pitchEndDeg": round(math.degrees(self.pitch_end), 4),
            "rollPeakDeg": round(math.degrees(self.roll_peak), 4),
            "hold": self.hold,
            "pitchLag": self.pitch_lag,
            "yawDamping": self.yaw_damping,
            "pitchDamping": self.pitch_damping,
            "omega": self.omega,
        }


@dataclass(frozen=True)
class Pose:
    location: tuple[float, float, float]
    yaw: float
    pitch: float
    roll: float
    lens: float | None = None

    @property
    def direction(self) -> tuple[float, float, float]:
        return look_direction(self.yaw, self.pitch)


def turn_poses(move: TurnMove, frame_count: int = FRAME_COUNT) -> list[Pose]:
    """Per-frame camera pose (0-based frames); first = start aim, last = end aim exactly."""
    if frame_count < 2:
        raise ShotError(f"frame_count must be >= 2, got {frame_count}")
    last = frame_count - 1
    poses = []
    for i in range(frame_count):
        t = i / last
        u_yaw = delayed_spring(t, move.hold, move.yaw_damping, move.omega)
        u_pitch = delayed_spring(t, min(move.hold + move.pitch_lag, 0.5), move.pitch_damping, move.omega)
        yaw = move.yaw_start + (move.yaw_end - move.yaw_start) * u_yaw
        pitch = move.pitch_start + (move.pitch_end - move.pitch_start) * u_pitch
        # Tilt into the turn and back; the overshoot (u > 1) gives a tiny counter-tilt.
        roll = move.roll_peak * math.sin(math.pi * min(max(u_yaw, 0.0), 1.25))
        location = lerp(move.loc_start, move.loc_end, u_pitch)
        lens = None
        if move.lens_start is not None and move.lens_end is not None:
            u_lens = delayed_spring(t, min(move.hold + move.lens_lag, 0.6), move.lens_damping, move.omega)
            lens = move.lens_start + (move.lens_end - move.lens_start) * u_lens
        poses.append(Pose(tuple(location), yaw, pitch, roll, lens))  # type: ignore[arg-type]
    return poses


def fingerprint(data: Mapping) -> str:
    """Stable short hash of JSON-able render parameters (resume must not mix moves)."""
    import json

    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------- Frame numbering


def renumber(blender_start: int, frame_count: int) -> list[tuple[int, int]]:
    """``(blender frame, 0-based frame)`` pairs for ``frame_count`` frames from ``blender_start``."""
    if frame_count < 1:
        raise ShotError(f"frame_count must be >= 1, got {frame_count}")
    return [(blender_start + i, i) for i in range(frame_count)]


def to_zero_based(blender_frame: int, blender_start: int) -> int:
    """0-based index of a Blender frame number."""
    index = blender_frame - blender_start
    if index < 0:
        raise ShotError(f"Blender frame {blender_frame} is before the shot start {blender_start}")
    return index


def parse_frame_range(text: str | None, frame_count: int = FRAME_COUNT) -> list[int]:
    """Parse ``--frames``: ``a-b`` (inclusive, 0-based), ``n``, or a comma list of
    those (``0,36,71`` / ``0-15,40``). ``None`` or empty = all frames.

    Returns sorted unique 0-based frame indices.
    """
    if text is None or text.strip() == "":
        return list(range(frame_count))
    frames: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        try:
            if "-" in part:
                first_s, last_s = part.split("-", 1)
                first, last = int(first_s), int(last_s)
            else:
                first = last = int(part)
        except ValueError:
            raise ShotError(f"--frames must look like 'a-b', 'n' or a comma list, got {text!r}") from None
        if not 0 <= first <= last < frame_count:
            raise ShotError(
                f"--frames {part!r} out of bounds: need 0 <= a <= b <= {frame_count - 1}"
            )
        frames.update(range(first, last + 1))
    return sorted(frames)


def frame_filename(index: int) -> str:
    """Rendered frame file name for a 0-based index, e.g. ``frame-0007.png``."""
    if index < 0:
        raise ShotError(f"frame index must be >= 0, got {index}")
    return f"frame-{index:04d}.png"


# ------------------------------------------------------------- Resume support

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_IEND = b"\x00\x00\x00\x00IEND\xaeB`\x82"


def png_size(path: Path | str) -> tuple[int, int] | None:
    """``(width, height)`` of a complete PNG, or ``None`` if missing/truncated/not a PNG.

    "Complete" means a valid signature, an IHDR header and the file ends with
    the IEND chunk (an interrupted write usually lacks it).
    """
    p = Path(path)
    try:
        size = p.stat().st_size
        if size < len(_PNG_SIGNATURE) + 25 + len(_PNG_IEND):
            return None
        with p.open("rb") as fh:
            head = fh.read(24)
            fh.seek(-len(_PNG_IEND), 2)
            tail = fh.read()
    except OSError:
        return None
    if head[:8] != _PNG_SIGNATURE or head[12:16] != b"IHDR" or tail != _PNG_IEND:
        return None
    width, height = struct.unpack(">II", head[16:24])
    return width, height


def frames_to_render(
    requested: Iterable[int], frame_dir: Path | str, expected_size: tuple[int, int]
) -> list[int]:
    """Requested 0-based frames that lack a valid PNG of ``expected_size`` in ``frame_dir``."""
    directory = Path(frame_dir)
    return [i for i in requested if png_size(directory / frame_filename(i)) != tuple(expected_size)]


# ------------------------------------------------------------- Chunk packing


@dataclass(frozen=True)
class FrameSlot:
    frame: int  # 0-based frame index
    chunk: int  # chunk file index
    offset: int  # byte offset inside the chunk file
    length: int  # byte length of the encoded AVIF


def chunk_count(frame_count: int, chunk_frames: int) -> int:
    if frame_count < 1:
        raise ShotError(f"frame_count must be >= 1, got {frame_count}")
    if chunk_frames < 1:
        raise ShotError(f"chunk size N must be >= 1, got {chunk_frames}")
    return -(-frame_count // chunk_frames)


def plan_chunks(frame_sizes: Sequence[int], chunk_frames: int = DEFAULT_CHUNK_FRAMES) -> list[FrameSlot]:
    """Pack frames in order into chunks of ``chunk_frames`` frames (last may be partial).

    ``frame_sizes[i]`` is the encoded byte length of frame ``i``. Frame ``i``
    goes to chunk ``i // N`` at the running byte offset within that chunk.
    """
    chunk_count(len(frame_sizes), chunk_frames)  # validates both arguments
    slots: list[FrameSlot] = []
    offset = 0
    for index, length in enumerate(frame_sizes):
        if length < 1:
            raise ShotError(f"frame {index} has invalid encoded size {length}")
        if index % chunk_frames == 0:
            offset = 0
        slots.append(FrameSlot(index, index // chunk_frames, offset, length))
        offset += length
    return slots


def chunk_byte_sizes(slots: Sequence[FrameSlot]) -> list[int]:
    """Byte size of each chunk file implied by a packing plan."""
    if not slots:
        return []
    sizes = [0] * (max(s.chunk for s in slots) + 1)
    for s in slots:
        sizes[s.chunk] = max(sizes[s.chunk], s.offset + s.length)
    return sizes


def chunk_members(slots: Sequence[FrameSlot]) -> list[list[int]]:
    """0-based frame indices per chunk, in byte order."""
    members: list[list[int]] = [[] for _ in chunk_byte_sizes(slots)]
    for s in sorted(slots, key=lambda s: (s.chunk, s.offset)):
        members[s.chunk].append(s.frame)
    return members


# ------------------------------------------------------------- Media paths


def check_segment(aspect: str, tier: str | None = None) -> None:
    """Raise ``ShotError`` naming the value and the allowed union for a bad aspect/tier."""
    if aspect not in ASPECTS:
        raise ShotError(f"aspect {aspect!r} not in allowed union {' | '.join(ASPECTS)}")
    if tier is not None and tier not in TIERS:
        raise ShotError(f"tier {tier!r} not in allowed union {' | '.join(TIERS)}")


def tier_size(aspect: str, tier: str) -> tuple[int, int]:
    check_segment(aspect, tier)
    return TIER_SIZES[(aspect, tier)]


def chunk_filename(index: int) -> str:
    """``chunk-NNNN.bin`` with a 4-digit zero pad."""
    if not 0 <= index <= 9999:
        raise ShotError(f"chunk index must be 0..9999, got {index}")
    return f"chunk-{index:04d}.bin"


def chunk_relpath(media_version: str, shot_id: str, aspect: str, tier: str, index: int) -> str:
    """``<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin`` (forward slashes)."""
    check_segment(aspect, tier)
    return f"{media_version}/{shot_id}/{aspect}/{tier}/{chunk_filename(index)}"


def chunk_url(media_base: str, media_version: str, shot_id: str, aspect: str, tier: str, index: int) -> str:
    """Expand ``URL_PATTERN`` for one chunk."""
    return f"{media_base.rstrip('/')}/{chunk_relpath(media_version, shot_id, aspect, tier, index)}"


def frame_data_relpath(act: str, aspect: str) -> str:
    """``frames/<act>.<aspect>.json`` relative to the mediaVersion directory."""
    check_segment(aspect)
    return f"frames/{act}.{aspect}.json"


# -------------------------------------------------------------- Monitor quad


def to_top_left(point_bl: Sequence[float]) -> tuple[float, float]:
    """Blender camera-view ``(x, y[, depth])`` (bottom-left origin) -> top-left ``(x, 1 - y)``."""
    return float(point_bl[0]), 1.0 - float(point_bl[1])


def order_quad(points_tl: Sequence[Sequence[float]]) -> list[tuple[float, float]]:
    """Order 4 top-left-normalised corners as TL, TR, BR, BL.

    Corners are sorted clockwise on screen (angle around the centroid, y down)
    and rotated so the corner with the smallest ``x + y`` (top-left) is first.
    """
    if len(points_tl) != 4:
        raise ShotError(f"a quad needs exactly 4 corners, got {len(points_tl)}")
    pts = [(float(p[0]), float(p[1])) for p in points_tl]
    cx = sum(p[0] for p in pts) / 4.0
    cy = sum(p[1] for p in pts) / 4.0
    clockwise = sorted(pts, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    start = min(range(4), key=lambda i: (clockwise[i][0] + clockwise[i][1], clockwise[i][0]))
    return clockwise[start:] + clockwise[:start]


def face_at_min(points: Sequence[Sequence[float]], axis: int = 1, tolerance: float = 1e-5) -> list[tuple[float, ...]]:
    """The 4 points of a box mesh lying on its minimum-``axis`` face (e.g. the screen front, -Y)."""
    if not points:
        raise ShotError("no points given")
    low = min(float(p[axis]) for p in points)
    face = [tuple(float(v) for v in p) for p in points if float(p[axis]) - low <= tolerance]
    unique = list(dict.fromkeys(face))
    if len(unique) != 4:
        raise ShotError(f"expected 4 corners on the min-{'xyz'[axis]} face, found {len(unique)}")
    return unique


def quad_stats(quads: Sequence[Sequence[Sequence[float]] | None]) -> dict[str, int]:
    """Counts: ``total``, ``null`` (behind camera), ``outOfRange`` (some corner outside
    [0, 1], monitor partly off-frame), ``offFrame`` (all corners outside on one side),
    ``inside`` (fully in frame)."""
    stats = {"total": len(quads), "null": 0, "outOfRange": 0, "offFrame": 0, "inside": 0}
    for q in quads:
        if q is None:
            stats["null"] += 1
            continue
        xs, ys = [p[0] for p in q], [p[1] for p in q]
        if all(0.0 <= v <= 1.0 for v in xs + ys):
            stats["inside"] += 1
        else:
            stats["outOfRange"] += 1
            if max(xs) < 0 or min(xs) > 1 or max(ys) < 0 or min(ys) > 1:
                stats["offFrame"] += 1
    return stats


def monitor_quad(
    corners_camera_view: Sequence[Sequence[float]], digits: int = 6
) -> list[list[float]] | None:
    """Convert projected screen corners to the frame-data quad.

    ``corners_camera_view`` are 4 ``world_to_camera_view`` results ``(x, y, depth)``
    in any order. Returns ``[[x, y] * 4]`` normalised top-left, ordered TL, TR,
    BR, BL, rounded to ``digits``. Coordinates may lie outside [0, 1] while the
    monitor is partly off-frame. Returns ``None`` if any corner is behind the
    camera (depth <= 0), where the projection is meaningless.
    """
    if len(corners_camera_view) != 4:
        raise ShotError(f"a quad needs exactly 4 corners, got {len(corners_camera_view)}")
    for c in corners_camera_view:
        if len(c) >= 3 and float(c[2]) <= 0.0:
            return None
    ordered = order_quad([to_top_left(c) for c in corners_camera_view])
    if abs(quad_area(ordered)) < 1e-9:  # degenerate (edge-on / collinear): no usable quad
        return None
    return [[round(x, digits), round(y, digits)] for x, y in ordered]


def quad_area(points: Sequence[Sequence[float]]) -> float:
    """Shoelace area in top-left space (positive for TL, TR, BR, BL order)."""
    n = len(points)
    return sum(points[i][0] * points[(i + 1) % n][1] - points[(i + 1) % n][0] * points[i][1] for i in range(n)) / 2.0


# ----------------------------------------------------------- Immutability


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path | str) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def published_differences(version_dir: Path | str, planned: Mapping[str, bytes]) -> list[str]:
    """Differences between an existing mediaVersion directory and planned output.

    ``planned`` maps forward-slash paths relative to ``version_dir`` to their
    bytes. Returns readable entries (sorted): ``changed: <path>`` for existing
    files with other content and ``unexpected: <path>`` for existing files the
    plan does not contain. Files that do not exist yet are not differences, so
    an identical re-run (or completing an interrupted one) is allowed.
    """
    root = Path(version_dir)
    if not root.is_dir():
        return []
    diffs = []
    for rel, data in planned.items():
        target = root / rel
        if target.is_file() and sha256_file(target) != sha256_bytes(data):
            diffs.append(f"changed: {rel}")
    planned_set = {rel.replace("\\", "/") for rel in planned}
    for path in root.rglob("*"):
        if path.is_file() and not is_temp_name(path.name):
            rel = path.relative_to(root).as_posix()
            if rel not in planned_set:
                diffs.append(f"unexpected: {rel}")
    return sorted(diffs)


def is_temp_name(name: str) -> bool:
    """Leftover of an interrupted :func:`write_atomic` (``.<name>.tmp``); never published content."""
    return name.startswith(".") and name.endswith(".tmp")


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def publish(version_dir: Path | str, planned: Mapping[str, bytes], force: bool = False) -> dict:
    """Write ``planned`` into ``version_dir`` respecting immutability.

    Raises ``ImmutableVersionError`` if published files would change and
    ``force`` is false. With ``force``, unexpected files are deleted and changed
    files rewritten. Leftover temp files are removed. Returns
    ``{"differences", "written", "unchanged"}``.
    """
    root = Path(version_dir)
    diffs = ensure_publishable(root, planned, force=force)
    for d in diffs:
        if d.startswith("unexpected: "):
            (root / d.removeprefix("unexpected: ")).unlink()
    if root.is_dir():
        for leftover in [p for p in root.rglob("*") if p.is_file() and is_temp_name(p.name)]:
            leftover.unlink()
    written = 0
    for rel, payload in planned.items():
        target = root / rel
        if target.is_file() and sha256_file(target) == sha256_bytes(payload):
            continue
        write_atomic(target, payload)
        written += 1
    return {"differences": diffs, "written": written, "unchanged": len(planned) - written}


def ensure_publishable(version_dir: Path | str, planned: Mapping[str, bytes], force: bool = False) -> list[str]:
    """Raise ``ImmutableVersionError`` if writing ``planned`` would change published files.

    With ``force`` the differences are returned (for logging) instead of raising.
    """
    diffs = published_differences(version_dir, planned)
    if diffs and not force:
        raise ImmutableVersionError(Path(version_dir), diffs)
    return diffs
