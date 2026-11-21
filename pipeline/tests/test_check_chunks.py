"""Orchestration tests for pipeline/check_chunks.py with a stubbed ffmpeg/ffprobe layer.

Run: python -m unittest discover -s pipeline/tests -v
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

import check_chunks  # noqa: E402
from lib import pack, shot  # noqa: E402
from lib import toolchain as tc  # noqa: E402

MV = "spike-test"
FRAMES = 3
N = 2


def fake_slice(size: tuple[int, int], tag: str) -> bytes:
    ftyp = b"ftyp" + b"avif" + b"\x00\x00\x00\x00" + b"avif" + b"mif1"
    return (len(ftyp) + 4).to_bytes(4, "big") + ftyp + f"SIZE={size[0]}x{size[1]};{tag};".encode()


def fake_run(decoders: str = " V....D libaom-av1           libaom AV1\n", version: str = "9.1"):
    """Stand-in for check_chunks._run: answers -version, -decoders, ffprobe and the strict decode."""

    def run(cmd):
        if "-version" in cmd:
            return SimpleNamespace(stdout=f"ffmpeg version {version}-full_build Copyright\n", stderr="", returncode=0)
        if "-decoders" in cmd:
            return SimpleNamespace(stdout=decoders, stderr="", returncode=0)
        if "-count_frames" in cmd:
            data = Path(cmd[-1]).read_bytes()
            w, h = map(int, re.search(rb"SIZE=(\d+)x(\d+)", data).groups())
            out = {"streams": [{"codec_name": "av1", "width": w, "height": h, "nb_read_frames": "1"}]}
            return SimpleNamespace(stdout=json.dumps(out), stderr="", returncode=0)
        if "-xerror" in cmd:
            data = Path(cmd[cmd.index("-i") + 1]).read_bytes()
            if b";BAD;" in data:
                return SimpleNamespace(stdout="", stderr="[libaom-av1] Corrupt frame detected", returncode=1)
            return SimpleNamespace(stdout="", stderr="", returncode=0)
        raise AssertionError(f"unexpected command {cmd}")

    return run


class CheckChunksMainTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.root = self.base / MV
        self.tools = []
        for name in ("ffprobe.exe", "ffmpeg.exe"):
            (self.base / name).write_bytes(b"")
            self.tools.append(str(self.base / name))
        self.build()

    def build(self, bad: tuple[str, str, int] | None = None):
        chunk_bytes, slots = {}, {}
        for aspect in shot.ASPECTS:
            for tier in shot.TIERS_BY_ASPECT[aspect]:
                size = shot.tier_size(aspect, tier)
                frames = [fake_slice(size, "BAD" if bad == (aspect, tier, i) else f"f{i}") for i in range(FRAMES)]
                tier_slots, chunks = pack.pack_chunks(frames, N)
                slots.setdefault(aspect, {})[tier] = tier_slots
                chunk_bytes.setdefault(aspect, {})[tier] = [len(c) for c in chunks]
                for index, payload in enumerate(chunks):
                    rel = shot.chunk_relpath(MV, shot.SHOT_ID, aspect, tier, index).split("/", 1)[1]
                    shot.write_atomic(self.root / rel, payload)
        for aspect in shot.ASPECTS:
            fd = pack.build_frame_data(MV, shot.ACT, aspect, shot.SHOT_ID, [None] * FRAMES, slots[aspect])
            shot.write_atomic(self.root / shot.frame_data_relpath(shot.ACT, aspect), pack.json_bytes(fd))
        manifest = pack.build_manifest(MV, shot.SHOT_ID, shot.ACT, FRAMES, 24, N, chunk_bytes)
        shot.write_atomic(self.root / "asset-manifest.json", pack.json_bytes(manifest))

    def edit_json(self, rel: str, change):
        path = self.root / rel
        data = json.loads(path.read_text(encoding="utf-8"))
        change(data)
        path.write_text(json.dumps(data), encoding="utf-8")

    def run_main(self, run=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(check_chunks, "_run", run or fake_run()), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check_chunks.main([str(self.root), "--ffprobe", self.tools[0], "--ffmpeg", self.tools[1], "--jobs", "2"])
        return code, out.getvalue() + err.getvalue()

    def test_clean_directory_passes(self):
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_OK, text)
        self.assertIn(f"OK: {FRAMES * 3} frame slices", text)

    def test_strict_decode_failure_names_frame_tier_aspect(self):
        self.build(bad=("9x16", "720", 1))
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_RENDER_FAILED)
        self.assertIn("frame 1 tier 720 aspect 9x16", text)
        self.assertIn("strict libaom decode failed", text)

    def test_truncated_chunk_fails(self):
        chunk = self.root / shot.SHOT_ID / "16x9" / "1080" / "chunk-0001.bin"
        chunk.write_bytes(chunk.read_bytes()[:-5])
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_RENDER_FAILED)
        self.assertIn("chunk 1 is", text)
        self.assertIn("frame 2 tier 1080 aspect 16x9", text)

    def test_malformed_manifest_exits_config(self):
        self.edit_json("asset-manifest.json", lambda m: m["shots"][0].pop("chunkSize"))
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_CONFIG)
        self.assertIn("malformed manifest or frame data", text)
        self.assertNotIn("Traceback", text)

    def test_unknown_or_disallowed_tier_exits_config(self):
        self.edit_json("asset-manifest.json", lambda m: m["shots"][0]["aspects"][1]["tiers"][0].update(tier="1080"))
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_CONFIG)
        self.assertIn("tier 1080 not allowed for aspect 9x16", text)
        self.edit_json("asset-manifest.json", lambda m: m["shots"][0]["aspects"][0].update(aspect="4x3"))
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_CONFIG)
        self.assertIn("'4x3'", text)

    def test_unreadable_manifest_exits_config(self):
        (self.root / "asset-manifest.json").write_text("{not json", encoding="utf-8")
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_CONFIG)

    def test_empty_shots_is_a_failure(self):
        self.edit_json("asset-manifest.json", lambda m: m.update(shots=[]))
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_RENDER_FAILED)
        self.assertIn("no frame slices to check", text)

    def test_negative_offset_or_zero_length_is_a_named_failure(self):
        rel = shot.frame_data_relpath(shot.ACT, "16x9")
        self.edit_json(rel, lambda d: d["shots"][0]["frames"][1]["slices"][0].update(offset=-10))
        self.edit_json(rel, lambda d: d["shots"][0]["frames"][2]["slices"][1].update(length=0))
        code, text = self.run_main()
        self.assertEqual(code, tc.EXIT_RENDER_FAILED)
        self.assertIn("frame 1 tier 1080 aspect 16x9 (shot ii-03-clock): invalid slice offset -10", text)
        self.assertIn("frame 2 tier 720 aspect 16x9 (shot ii-03-clock): invalid slice offset 0 / length 0", text)

    def test_missing_libaom_decoder_or_wrong_version_exits_config(self):
        code, text = self.run_main(fake_run(decoders=" V....D libdav1d   dav1d AV1\n"))
        self.assertEqual(code, tc.EXIT_CONFIG)
        self.assertIn("no libaom-av1 decoder", text)
        code, text = self.run_main(fake_run(version="8.0"))
        self.assertEqual(code, tc.EXIT_CONFIG)
        self.assertIn("pinned 9.1", text)

    def test_explicit_missing_tool_exits_config(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = check_chunks.main([str(self.root), "--ffprobe", str(self.base / "nope.exe")])
        self.assertEqual(code, tc.EXIT_CONFIG)
        self.assertIn("is not a file", err.getvalue())


if __name__ == "__main__":
    unittest.main()
