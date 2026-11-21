"""Unit tests for pipeline/lib/shot.py (plain Python, no bpy).

Run: python -m unittest discover -s pipeline/tests -v
"""

from __future__ import annotations

import math
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import shot  # noqa: E402


def _png_bytes(width: int, height: int) -> bytes:
    """Minimal valid 8-bit grey PNG."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = b"".join(b"\x00" + b"\x80" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class SpringCurveTest(unittest.TestCase):
    def test_endpoints_and_length(self):
        curve = shot.spring_curve(72)
        self.assertEqual(len(curve), 72)
        self.assertEqual(curve[0], 0.0)
        self.assertEqual(curve[-1], 1.0)

    def test_starts_from_rest(self):
        curve = shot.spring_curve(72)
        # Spring step response has zero initial velocity: the first step is tiny
        # compared with the steepest step.
        steps = [b - a for a, b in zip(curve, curve[1:])]
        self.assertLess(steps[0], 0.25 * max(steps))

    def test_slight_overshoot_then_settles(self):
        curve = shot.spring_curve(72)
        peak = max(curve)
        self.assertGreater(peak, 1.005, "expected a humanized overshoot")
        self.assertLess(peak, 1.06, "overshoot must stay slight")
        self.assertLess(curve.index(peak), 71)
        self.assertAlmostEqual(curve[-2], 1.0, delta=0.01)

    def test_ease_is_clamped_and_exact_at_end(self):
        self.assertEqual(shot.spring_ease(-1.0), 0.0)
        self.assertAlmostEqual(shot.spring_ease(1.0), 1.0, places=12)
        self.assertAlmostEqual(shot.spring_ease(2.0), 1.0, places=12)

    def test_invalid_parameters(self):
        for kwargs in ({"damping": 1.0}, {"damping": 0.0}, {"omega": 0.0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(shot.ShotError):
                shot.spring_step(0.5, **kwargs)
        with self.assertRaises(shot.ShotError):
            shot.spring_curve(1)

    def test_lerp_supports_overshoot(self):
        self.assertEqual(shot.lerp((0.0, 10.0), (10.0, 20.0), 1.1), (11.0, 21.0))


class CameraTurnTest(unittest.TestCase):
    def _move(self, **kw):
        loc = (0.03, -0.55, 1.22)
        yaw0, pitch0 = shot.aim(loc, (-0.30, 2.0, 0.85))
        yaw1, pitch1 = shot.aim(loc, (-0.05, 2.25, 1.78))
        return shot.TurnMove(loc, (0.03, -0.50, 1.25), yaw0, pitch0, yaw1, pitch1, **kw)

    def test_yaw_pitch_convention_and_inverse(self):
        self.assertAlmostEqual(shot.yaw_pitch((0, 1, 0))[0], 0.0)
        self.assertGreater(shot.yaw_pitch((-1, 1, 0))[0], 0)  # target to the left -> positive yaw
        self.assertGreater(shot.yaw_pitch((0, 1, 1))[1], 0)  # up -> positive pitch
        for yaw, pitch in ((0.3, -0.2), (-1.0, 0.5), (2.5, 0.1)):
            d = shot.look_direction(yaw, pitch)
            back = shot.yaw_pitch(d)
            self.assertAlmostEqual(back[0], yaw)
            self.assertAlmostEqual(back[1], pitch)
        with self.assertRaises(shot.ShotError):
            shot.yaw_pitch((0, 0, 0))

    def test_turn_is_right_and_up(self):
        move = self._move()
        self.assertLess(move.yaw_end, move.yaw_start)  # right
        self.assertGreater(move.pitch_end, move.pitch_start)  # up

    def test_poses_start_and_end_exactly(self):
        move = self._move()
        poses = shot.turn_poses(move, 72)
        self.assertEqual(len(poses), 72)
        self.assertAlmostEqual(poses[0].yaw, move.yaw_start)
        self.assertAlmostEqual(poses[0].pitch, move.pitch_start)
        self.assertEqual(poses[0].location, move.loc_start)
        self.assertAlmostEqual(poses[-1].yaw, move.yaw_end)
        self.assertAlmostEqual(poses[-1].pitch, move.pitch_end)
        for a, b in zip(poses[-1].location, move.loc_end):
            self.assertAlmostEqual(a, b)
        self.assertAlmostEqual(poses[-1].roll, 0.0, places=6)

    def test_hold_then_overshoot(self):
        move = self._move(hold=0.06)
        poses = shot.turn_poses(move, 72)
        # Held still for the first frames (t <= 0.06 -> frames 0..4).
        self.assertEqual({round(p.pitch, 12) for p in poses[:5]}, {round(move.pitch_start, 12)})
        # Pitch overshoots the target slightly, then settles.
        peak = max(p.pitch for p in poses)
        span = move.pitch_end - move.pitch_start
        self.assertGreater(peak, move.pitch_end)
        self.assertLess((peak - move.pitch_end) / span, 0.08)

    def test_pitch_lags_yaw(self):
        poses = shot.turn_poses(self._move(), 72)
        move = self._move()
        u_yaw = (poses[10].yaw - move.yaw_start) / (move.yaw_end - move.yaw_start)
        u_pitch = (poses[10].pitch - move.pitch_start) / (move.pitch_end - move.pitch_start)
        self.assertGreater(u_yaw, u_pitch)

    def test_roll_stays_small(self):
        poses = shot.turn_poses(self._move(), 72)
        self.assertLessEqual(max(abs(p.roll) for p in poses), math.radians(1.21))

    def test_lens_push_optional_and_lagging(self):
        self.assertTrue(all(p.lens is None for p in shot.turn_poses(self._move(), 72)))
        move = self._move(lens_start=26.0, lens_end=34.0)
        poses = shot.turn_poses(move, 72)
        self.assertEqual(poses[0].lens, 26.0)
        self.assertAlmostEqual(poses[-1].lens, 34.0)
        self.assertLess(max(p.lens for p in poses), 34.0 + 0.05)  # negligible overshoot
        u_lens = (poses[15].lens - 26.0) / 8.0
        u_pitch = (poses[15].pitch - move.pitch_start) / (move.pitch_end - move.pitch_start)
        self.assertLess(u_lens, u_pitch)  # focus follows the look

    def test_delayed_spring(self):
        self.assertEqual(shot.delayed_spring(0.05, 0.1), 0.0)
        self.assertAlmostEqual(shot.delayed_spring(1.0, 0.1), 1.0)
        with self.assertRaises(shot.ShotError):
            shot.delayed_spring(0.5, 1.0)

    def test_fingerprint_is_stable_and_sensitive(self):
        a = shot.fingerprint({"move": self._move().as_dict(), "samples": 64})
        b = shot.fingerprint({"samples": 64, "move": self._move().as_dict()})
        c = shot.fingerprint({"move": self._move().as_dict(), "samples": 32})
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


class RenumberTest(unittest.TestCase):
    def test_renumber_from_blender_start(self):
        pairs = shot.renumber(101, 72)
        self.assertEqual(pairs[0], (101, 0))
        self.assertEqual(pairs[-1], (172, 71))
        self.assertEqual(len(pairs), 72)

    def test_to_zero_based(self):
        self.assertEqual(shot.to_zero_based(101, 101), 0)
        self.assertEqual(shot.to_zero_based(172, 101), 71)
        with self.assertRaises(shot.ShotError):
            shot.to_zero_based(100, 101)

    def test_parse_frame_range(self):
        self.assertEqual(shot.parse_frame_range(None), list(range(72)))
        self.assertEqual(shot.parse_frame_range("0-39"), list(range(0, 40)))
        self.assertEqual(shot.parse_frame_range("71"), [71])
        self.assertEqual(shot.parse_frame_range("71,0,36"), [0, 36, 71])
        self.assertEqual(shot.parse_frame_range("0-2, 1-3,10"), [0, 1, 2, 3, 10])
        for bad in ("40-10", "0-72", "-3", "a-b", "1-2-3", "0,,1", "0,72"):
            with self.subTest(bad=bad), self.assertRaises(shot.ShotError):
                shot.parse_frame_range(bad)

    def test_frame_filename(self):
        self.assertEqual(shot.frame_filename(7), "frame-0007.png")


class ResumeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_png_size_valid_truncated_and_missing(self):
        good = self.dir / "good.png"
        good.write_bytes(_png_bytes(4, 3))
        self.assertEqual(shot.png_size(good), (4, 3))
        cut = self.dir / "cut.png"
        cut.write_bytes(_png_bytes(4, 3)[:-6])
        self.assertIsNone(shot.png_size(cut))
        junk = self.dir / "junk.png"
        junk.write_bytes(b"not a png" * 10)
        self.assertIsNone(shot.png_size(junk))
        self.assertIsNone(shot.png_size(self.dir / "missing.png"))

    def test_resume_renders_only_missing_frames(self):
        # 40 of 72 frames exist and are valid.
        for i in range(40):
            (self.dir / shot.frame_filename(i)).write_bytes(_png_bytes(4, 3))
        todo = shot.frames_to_render(range(72), self.dir, (4, 3))
        self.assertEqual(todo, list(range(40, 72)))

    def test_wrong_size_or_truncated_frames_are_rerendered(self):
        (self.dir / shot.frame_filename(0)).write_bytes(_png_bytes(4, 3))
        (self.dir / shot.frame_filename(1)).write_bytes(_png_bytes(3, 4))
        (self.dir / shot.frame_filename(2)).write_bytes(_png_bytes(4, 3)[:-1])
        self.assertEqual(shot.frames_to_render(range(3), self.dir, (4, 3)), [1, 2])


class ChunkPlanTest(unittest.TestCase):
    def test_partial_last_chunk(self):
        sizes = [100 + i for i in range(72)]
        slots = shot.plan_chunks(sizes, 16)
        self.assertEqual(shot.chunk_count(72, 16), 5)
        members = shot.chunk_members(slots)
        self.assertEqual([len(m) for m in members], [16, 16, 16, 16, 8])
        self.assertEqual(members[4], list(range(64, 72)))

    def test_offsets_are_contiguous_and_reset_per_chunk(self):
        sizes = [10, 20, 30, 40, 50]
        slots = shot.plan_chunks(sizes, 2)
        self.assertEqual(
            [(s.frame, s.chunk, s.offset, s.length) for s in slots],
            [(0, 0, 0, 10), (1, 0, 10, 20), (2, 1, 0, 30), (3, 1, 30, 40), (4, 2, 0, 50)],
        )
        self.assertEqual(shot.chunk_byte_sizes(slots), [30, 70, 50])

    def test_every_slot_lies_inside_its_chunk(self):
        slots = shot.plan_chunks([7 * (i % 5 + 1) for i in range(72)], 16)
        sizes = shot.chunk_byte_sizes(slots)
        self.assertEqual(sum(sizes), sum(s.length for s in slots))
        for s in slots:
            self.assertLessEqual(s.offset + s.length, sizes[s.chunk])

    def test_invalid_inputs(self):
        with self.assertRaises(shot.ShotError):
            shot.plan_chunks([], 16)
        with self.assertRaises(shot.ShotError):
            shot.plan_chunks([10], 0)
        with self.assertRaises(shot.ShotError):
            shot.plan_chunks([10, 0], 16)

    def test_default_chunk_size(self):
        self.assertEqual(shot.DEFAULT_CHUNK_FRAMES, 16)


class MediaPathTest(unittest.TestCase):
    def test_chunk_paths_and_url(self):
        self.assertEqual(shot.chunk_filename(3), "chunk-0003.bin")
        self.assertEqual(
            shot.chunk_relpath("spike-2026-11-21", "ii-03-clock", "9x16", "720", 4),
            "spike-2026-11-21/ii-03-clock/9x16/720/chunk-0004.bin",
        )
        self.assertEqual(
            shot.chunk_url("https://m.example/", "v1", "ii-03-clock", "16x9", "1080", 0),
            "https://m.example/v1/ii-03-clock/16x9/1080/chunk-0000.bin",
        )
        self.assertEqual(shot.frame_data_relpath("II", "16x9"), "frames/II.16x9.json")

    def test_bad_segments_name_value_and_union(self):
        with self.assertRaises(shot.ShotError) as ctx:
            shot.chunk_relpath("v", "s", "4x3", "720", 0)
        self.assertIn("'4x3'", str(ctx.exception))
        self.assertIn("16x9 | 9x16", str(ctx.exception))
        with self.assertRaises(shot.ShotError) as ctx:
            shot.tier_size("16x9", "540")
        self.assertIn("'540'", str(ctx.exception))
        self.assertIn("1080 | 720", str(ctx.exception))
        with self.assertRaises(shot.ShotError):
            shot.chunk_filename(10000)

    def test_spike_tiers(self):
        self.assertEqual(shot.TIERS_BY_ASPECT, {"16x9": ("1080", "720"), "9x16": ("720",)})
        self.assertEqual(shot.tier_size("16x9", "720"), (1280, 720))
        self.assertEqual(shot.tier_size("9x16", "720"), (720, 1280))


class QuadTest(unittest.TestCase):
    def test_bottom_left_to_top_left(self):
        self.assertEqual(shot.to_top_left((0.25, 0.8, 3.0)), (0.25, 0.19999999999999996))

    def test_monitor_quad_orders_tl_tr_br_bl(self):
        # Blender camera-view corners (bottom-left origin), scrambled order.
        corners = [
            (0.7, 0.3, 2.0),  # bottom-right
            (0.3, 0.7, 2.0),  # top-left
            (0.3, 0.3, 2.0),  # bottom-left
            (0.7, 0.7, 2.0),  # top-right
        ]
        self.assertEqual(
            shot.monitor_quad(corners),
            [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]],
        )

    def test_perspective_skewed_quad(self):
        tl, tr, br, bl = (0.2, 0.1), (0.9, 0.25), (0.85, 0.7), (0.15, 0.95)
        for order in ([br, tl, bl, tr], [bl, br, tr, tl], [tr, bl, tl, br]):
            with self.subTest(order=order):
                self.assertEqual(shot.order_quad(order), [tl, tr, br, bl])

    def test_off_frame_coordinates_are_kept(self):
        quad = shot.monitor_quad([(-0.2, 1.1, 1), (0.4, 1.1, 1), (0.4, 0.5, 1), (-0.2, 0.5, 1)])
        self.assertEqual(quad[0], [-0.2, -0.1])

    def test_corner_behind_camera_gives_none(self):
        self.assertIsNone(
            shot.monitor_quad([(0.1, 0.1, 1), (0.9, 0.1, 1), (0.9, 0.9, -0.5), (0.1, 0.9, 1)])
        )

    def test_wrong_corner_count(self):
        with self.assertRaises(shot.ShotError):
            shot.monitor_quad([(0, 0, 1)] * 3)

    def test_degenerate_quad_gives_none(self):
        # Screen seen edge-on: all four corners collinear -> zero area.
        self.assertIsNone(shot.monitor_quad([(0.1, 0.5, 1), (0.3, 0.5, 1), (0.6, 0.5, 1), (0.9, 0.5, 1)]))
        self.assertIsNone(shot.monitor_quad([(0.5, 0.5, 1)] * 4))
        self.assertIsNotNone(shot.monitor_quad([(0.1, 0.1, 1), (0.9, 0.1, 1), (0.9, 0.9, 1), (0.1, 0.9, 1)]))

    def test_face_at_min_picks_screen_front(self):
        box = [(x, y, z) for x in (-0.27, 0.27) for y in (-0.0005, 0.0005) for z in (-0.15, 0.15)]
        face = shot.face_at_min(box, axis=1)
        self.assertEqual(len(face), 4)
        self.assertTrue(all(p[1] == -0.0005 for p in face))
        with self.assertRaises(shot.ShotError):
            shot.face_at_min([(0, 0, 0), (1, 0, 0)], axis=1)

    def test_quad_stats(self):
        inside = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
        partly = [[-0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [-0.1, 0.5]]
        below = [[0.1, 1.2], [0.5, 1.2], [0.5, 1.5], [0.1, 1.5]]
        self.assertEqual(
            shot.quad_stats([inside, partly, below, None]),
            {"total": 4, "null": 1, "outOfRange": 2, "offFrame": 1, "inside": 1},
        )

    def test_render_sizes(self):
        self.assertEqual(shot.RENDER_SIZES, {"16x9": (1920, 1080), "9x16": (720, 1280)})


class ImmutabilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / shot.MEDIA_VERSION
        self.plan = {
            "asset-manifest.json": b'{"schemaVersion":1}',
            "ii-03-clock/16x9/720/chunk-0000.bin": b"\x00\x01",
        }

    def _publish(self, plan):
        for rel, data in plan.items():
            target = self.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    def test_new_version_is_publishable(self):
        self.assertEqual(shot.ensure_publishable(self.root, self.plan), [])

    def test_identical_rerun_is_allowed(self):
        self._publish(self.plan)
        self.assertEqual(shot.ensure_publishable(self.root, self.plan), [])

    def test_different_content_refuses_without_force(self):
        self._publish(self.plan)
        changed = dict(self.plan, **{"asset-manifest.json": b'{"schemaVersion":2}'})
        with self.assertRaises(shot.ImmutableVersionError) as ctx:
            shot.ensure_publishable(self.root, changed)
        self.assertEqual(ctx.exception.differences, ["changed: asset-manifest.json"])
        self.assertIn("--force", str(ctx.exception))

    def test_unexpected_existing_file_refuses(self):
        self._publish(dict(self.plan, **{"frames/II.4x3.json": b"{}"}))
        with self.assertRaises(shot.ImmutableVersionError) as ctx:
            shot.ensure_publishable(self.root, self.plan)
        self.assertEqual(ctx.exception.differences, ["unexpected: frames/II.4x3.json"])

    def test_leftover_temp_file_does_not_block_identical_resume(self):
        self._publish(self.plan)
        leftover = self.root / "ii-03-clock/16x9/720/.chunk-0001.bin.tmp"
        leftover.write_bytes(b"partial")
        self.assertEqual(shot.ensure_publishable(self.root, self.plan), [])
        result = shot.publish(self.root, self.plan)
        self.assertEqual((result["written"], result["unchanged"]), (0, 2))
        self.assertFalse(leftover.exists())

    def test_publish_without_force_refuses_and_writes_nothing(self):
        self._publish(self.plan)
        changed = dict(self.plan, **{"asset-manifest.json": b"new"})
        with self.assertRaises(shot.ImmutableVersionError):
            shot.publish(self.root, changed)
        self.assertEqual((self.root / "asset-manifest.json").read_bytes(), b'{"schemaVersion":1}')

    def test_publish_with_force_removes_stale_and_rewrites_changed(self):
        stale = "ii-03-clock/16x9/720/chunk-0005.bin"
        self._publish(dict(self.plan, **{stale: b"old"}))
        changed = dict(self.plan, **{"asset-manifest.json": b"new"})
        result = shot.publish(self.root, changed, force=True)
        self.assertFalse((self.root / stale).exists())
        self.assertEqual((self.root / "asset-manifest.json").read_bytes(), b"new")
        self.assertEqual(result["differences"], ["changed: asset-manifest.json", f"unexpected: {stale}"])
        self.assertEqual((result["written"], result["unchanged"]), (1, 1))

    def test_publish_new_version_writes_everything(self):
        result = shot.publish(self.root, self.plan)
        self.assertEqual(result["written"], 2)
        self.assertEqual((self.root / "ii-03-clock/16x9/720/chunk-0000.bin").read_bytes(), b"\x00\x01")

    def test_force_returns_differences(self):
        self._publish(self.plan)
        changed = dict(self.plan, **{"asset-manifest.json": b"x"})
        self.assertEqual(
            shot.ensure_publishable(self.root, changed, force=True), ["changed: asset-manifest.json"]
        )


if __name__ == "__main__":
    unittest.main()
