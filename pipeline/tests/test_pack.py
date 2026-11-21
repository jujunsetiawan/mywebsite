"""Unit tests for pipeline/lib/pack.py (plain Python, no bpy, no ffmpeg needed).

Run: python -m unittest discover -s pipeline/tests -v
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PIPELINE_DIR.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import pack, shot  # noqa: E402
from lib import toolchain as tc  # noqa: E402


def fake_avif(payload: bytes = b"\x00" * 40) -> bytes:
    ftyp = b"ftyp" + b"avif" + b"\x00\x00\x00\x00" + b"avif" + b"mif1" + b"miaf"
    return (len(ftyp) + 4).to_bytes(4, "big") + ftyp + payload


class ToolLookupTest(unittest.TestCase):
    def test_explicit_path_wins(self):
        got = pack.resolve_tool("ffmpeg", "C:/x/ffmpeg.exe", which=lambda n: "C:/path/ffmpeg.exe",
                                exists=lambda p: str(p).replace("\\", "/") == "C:/x/ffmpeg.exe")
        self.assertEqual(got.replace("\\", "/"), "C:/x/ffmpeg.exe")

    def test_path_then_links(self):
        self.assertEqual(pack.resolve_tool("ffmpeg", which=lambda n: "/usr/bin/ffmpeg"), "/usr/bin/ffmpeg")
        links = Path("C:/L")
        got = pack.resolve_tool("ffmpeg", which=lambda n: None, links_dir=links,
                                exists=lambda p: p == links / "ffmpeg.exe")
        self.assertEqual(Path(got), links / "ffmpeg.exe")

    def test_explicit_missing_path_does_not_fall_back(self):
        with self.assertRaises(pack.ToolError) as ctx:
            pack.resolve_tool("ffmpeg", "nope.exe", which=lambda n: "/usr/bin/ffmpeg", exists=lambda p: False)
        self.assertIn("--ffmpeg nope.exe is not a file", str(ctx.exception))

    def test_not_found_lists_everything_tried(self):
        with self.assertRaises(pack.ToolError) as ctx:
            pack.resolve_tool("ffprobe", which=lambda n: None, links_dir=Path("C:/L"), exists=lambda p: False)
        msg = str(ctx.exception)
        self.assertIn("on PATH", msg)
        self.assertIn("ffprobe.exe", msg)
        self.assertIn("winget install --id Gyan.FFmpeg", msg)

    def test_parse_version_and_encoders(self):
        self.assertEqual(pack.parse_ffmpeg_version("ffmpeg version 9.1-full_build-www.gyan.dev Copyright"), "9.1")
        self.assertEqual(pack.parse_ffmpeg_version("ffmpeg version n7.0.2 Copyright"), "7.0.2")
        self.assertIsNone(pack.parse_ffmpeg_version("garbage"))
        enc = " V....D libaom-av1           libaom AV1 (codec av1)\n V..... libsvtav1  SVT-AV1\n"
        self.assertTrue(pack.has_encoder(enc, "libaom-av1"))
        self.assertTrue(pack.has_encoder(enc, "libsvtav1"))
        self.assertFalse(pack.has_encoder(enc, "librav1e"))

    def test_pinned_version_matches_licence_record(self):
        text = (REPO_ROOT / "licenses" / "assets.yaml").read_text(encoding="utf-8")
        entry = re.search(r"^\s*-\s*id:\s*ffmpeg\s*$(.*?)(?=^\s*-\s*id:|\Z)", text, re.S | re.M)
        self.assertIsNotNone(entry, "ffmpeg tool entry missing from licenses/assets.yaml")
        version = re.search(r"^\s*version:\s*\"?([\d.]+)\"?\s*$", entry.group(1), re.M)
        self.assertEqual(version.group(1), pack.FFMPEG_VERSION)


class EncodeCommandTest(unittest.TestCase):
    def test_grain_off_still_picture_and_colour_tags(self):
        cmd = pack.encode_command("ffmpeg", "in.png", "out.avif", pack.EncodeSettings())
        joined = " ".join(cmd)
        self.assertIn("-c:v libaom-av1", joined)
        self.assertIn("-still-picture 1", joined)
        self.assertIn("-denoise-noise-level 0", joined)
        self.assertIn("film-grain-test=0", joined)
        self.assertIn("-crf 18 -b:v 0", joined)
        self.assertIn("-color_range pc", joined)
        self.assertIn("-colorspace bt709", joined)
        self.assertEqual(cmd[-3:], ["-f", "avif", "out.avif"])
        self.assertIn("format=yuv420p", cmd[cmd.index("-vf") + 1])

    def test_downscale_filter_first(self):
        vf = pack.video_filter(pack.EncodeSettings(), (1280, 720))
        self.assertTrue(vf.startswith("scale=1280:720:flags=lanczos"))
        self.assertIn("out_range=full", vf)
        self.assertNotIn("1280", pack.video_filter(pack.EncodeSettings()))

    def test_chroma_label(self):
        self.assertEqual(pack.EncodeSettings().chroma, "4:2:0")
        self.assertEqual(pack.EncodeSettings(pix_fmt="yuv444p").chroma, "4:4:4")


class AvifSniffTest(unittest.TestCase):
    def test_is_avif(self):
        self.assertTrue(pack.is_avif(fake_avif()))
        self.assertFalse(pack.is_avif(b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1" + b"\x00" * 20))
        self.assertFalse(pack.is_avif(b"XXXX" * 10))
        self.assertFalse(pack.is_avif(b""))


class PackTest(unittest.TestCase):
    def setUp(self):
        self.frames = [fake_avif(bytes([i]) * (10 + i)) for i in range(5)]

    def test_pack_chunks_invariant_is_not_an_assert(self):
        from unittest import mock
        bad = [shot.FrameSlot(0, 0, 5, len(self.frames[0]))]  # offset 5 into an empty chunk
        with mock.patch.object(shot, "plan_chunks", return_value=bad), self.assertRaises(shot.ShotError):
            pack.pack_chunks(self.frames[:1], 2)

    def test_pack_chunks_round_trip(self):
        slots, chunks = pack.pack_chunks(self.frames, 2)
        self.assertEqual(len(chunks), 3)
        for s, data in zip(slots, self.frames):
            self.assertEqual(chunks[s.chunk][s.offset:s.offset + s.length], data)
        self.assertEqual([len(c) for c in chunks], shot.chunk_byte_sizes(slots))

    def test_frame_data_and_manifest_shape(self):
        slots, chunks = pack.pack_chunks(self.frames, 2)
        quads = [[[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]] * 4 + [None]
        fd = pack.build_frame_data("spike-2026-11-21", "II", "9x16", "ii-03-clock", quads, {"720": slots})
        self.assertEqual(set(fd), {"schemaVersion", "mediaVersion", "act", "aspect", "shots"})
        f4 = fd["shots"][0]["frames"][4]
        self.assertEqual(f4, {"index": 4, "quad": None,
                              "slices": [{"tier": "720", "chunk": 2, "offset": 0, "length": len(self.frames[4])}]})
        sizes = [len(c) for c in chunks]
        m = pack.build_manifest("spike-2026-11-21", "ii-03-clock", "II", 5, 24, 2,
                                {"16x9": {"1080": sizes, "720": sizes}, "9x16": {"720": sizes}})
        s = m["shots"][0]
        self.assertEqual(s["chunkCount"], 3)
        self.assertEqual(s["urlPattern"], shot.URL_PATTERN)
        self.assertEqual([a["aspect"] for a in s["aspects"]], ["16x9", "9x16"])
        t = s["aspects"][1]["tiers"][0]
        self.assertEqual((t["tier"], t["width"], t["height"], t["totalBytes"]), ("720", 720, 1280, sum(sizes)))

    def test_frame_data_rejects_mismatched_counts(self):
        slots, _ = pack.pack_chunks(self.frames, 2)
        with self.assertRaises(shot.ShotError):
            pack.build_frame_data("v", "II", "16x9", "s", [None] * 4, {"1080": slots})
        with self.assertRaises(shot.ShotError):
            pack.build_frame_data("v", "II", "16x9", "s", [None] * 5, {"540": slots})

    def test_builders_reproduce_the_zod_valid_fixture(self):
        """Python builders emit exactly the shape the Zod contract accepts (spike/manifest/fixtures/valid)."""
        fixture = REPO_ROOT / "spike" / "manifest" / "fixtures" / "valid"
        manifest = json.loads((fixture / "asset-manifest.json").read_text(encoding="utf-8"))
        frame_files = {a: json.loads((fixture / "frames" / f"II.{a}.json").read_text(encoding="utf-8"))
                       for a in shot.ASPECTS}
        m_shot = manifest["shots"][0]
        n = m_shot["chunkSize"]
        chunk_bytes, rebuilt_fd = {}, {}
        for variant in m_shot["aspects"]:
            aspect = variant["aspect"]
            frames = frame_files[aspect]["shots"][0]["frames"]
            slots_by_tier = {}
            for entry in variant["tiers"]:
                tier = entry["tier"]
                lengths = [next(s["length"] for s in f["slices"] if s["tier"] == tier) for f in frames]
                slots_by_tier[tier] = shot.plan_chunks(lengths, n)
                chunk_bytes.setdefault(aspect, {})[tier] = shot.chunk_byte_sizes(slots_by_tier[tier])
            rebuilt_fd[aspect] = pack.build_frame_data(manifest["mediaVersion"], m_shot["act"], aspect, m_shot["id"],
                                                       [f["quad"] for f in frames], slots_by_tier)
        rebuilt = pack.build_manifest(manifest["mediaVersion"], m_shot["id"], m_shot["act"], m_shot["frameCount"],
                                      m_shot["authoringFps"], n, chunk_bytes)
        self.assertEqual(rebuilt, manifest)
        for aspect in shot.ASPECTS:
            self.assertEqual(rebuilt_fd[aspect], frame_files[aspect])

    def test_json_bytes_deterministic(self):
        a = pack.json_bytes({"b": 1, "a": [1, 2]})
        self.assertEqual(a, pack.json_bytes({"b": 1, "a": [1, 2]}))
        self.assertTrue(a.endswith(b"\n"))
        self.assertEqual(json.loads(a), {"b": 1, "a": [1, 2]})


class ProbeTest(unittest.TestCase):
    OK = json.dumps({"streams": [{"codec_name": "av1", "width": 1280, "height": 720, "nb_read_frames": "1"}]})

    def test_parse_ok(self):
        r = pack.parse_probe(self.OK)
        self.assertEqual((r.codec, r.width, r.height, r.decoded_frames, r.error), ("av1", 1280, 720, 1, None))
        self.assertEqual(pack.slice_problems(fake_avif(), r, (1280, 720), (0, "")), [])

    def test_problems_are_named(self):
        r = pack.parse_probe(self.OK)
        problems = pack.slice_problems(b"junk" * 8, r, (1920, 1080), (1, "Corrupt frame detected"))
        text = " | ".join(problems)
        self.assertIn("not an AVIF", text)
        self.assertIn("1280x720, expected 1920x1080", text)
        self.assertIn("strict libaom decode failed", text)
        self.assertIn("Corrupt frame detected", text)

    def test_no_stream(self):
        r = pack.parse_probe("", "Invalid data found", 1)
        self.assertEqual(r.error, "Invalid data found")
        self.assertTrue(any("decoded None" in p for p in pack.slice_problems(fake_avif(), r, (1, 1))))

    def test_commands(self):
        self.assertIn("-count_frames", pack.probe_command("ffprobe", "x.avif"))
        strict = pack.strict_decode_command("ffmpeg", "x.avif")
        self.assertLess(strict.index("libaom-av1"), strict.index("-i"))  # decoder chosen before input


class RequestMathTest(unittest.TestCase):
    def test_shot_requests(self):
        self.assertEqual(pack.shot_requests(72, 16), 7)  # manifest + frame data + 5 chunks
        self.assertEqual(pack.shot_requests(72, 72), 3)

    def test_film_chunk_bound(self):
        self.assertEqual(pack.film_chunk_requests(7200, 16, 1), 450)
        self.assertEqual(pack.film_chunk_requests(7200, 16, 40), 489)
        # the bound holds for any split of frames into groups
        split = [70, 130, 7000]
        self.assertLessEqual(sum(-(-f // 16) for f in split), pack.film_chunk_requests(sum(split), 16, len(split)))

    def test_min_chunk_size(self):
        n = pack.min_chunk_size(7200, groups=40, fixed=6)
        self.assertLessEqual(pack.film_requests(7200, n, 40, 6), 150)
        self.assertGreater(pack.film_requests(7200, n - 1, 40, 6), 150)
        self.assertIsNone(pack.min_chunk_size(7200, groups=140, fixed=20))


class ExitCodeTest(unittest.TestCase):
    def test_immutable_exit_code_distinct(self):
        codes = [tc.EXIT_USAGE, tc.EXIT_NO_GPU, tc.EXIT_VERSION_MISMATCH, tc.EXIT_RENDER_FAILED,
                 tc.EXIT_CONFIG, tc.EXIT_LICENCE, tc.EXIT_IMMUTABLE]
        self.assertEqual(len(set(codes)), len(codes))
        self.assertEqual(tc.EXIT_IMMUTABLE, 7)


if __name__ == "__main__":
    unittest.main()
