"""Unit tests for the licence gate (pipeline/lib/licence_gate.py), the
``--aspect`` parsing of pipeline/lib/toolchain.py and the pure helpers of
pipeline/fetch_assets.py. Plain Python, no bpy.

Run: python -m unittest discover -s pipeline/tests -v
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PIPELINE_DIR.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

import fetch_assets as fa  # noqa: E402
from lib import licence_gate as lg  # noqa: E402
from lib import toolchain as tc  # noqa: E402

STYLE_FRAME = ["blender", "-b", "scene.blend", "-P", "pipeline/style_frame.py"]

RECORD = """\
# fixture licence record
assets:
  - id: polyhaven-wall_clock
    source: https://polyhaven.com/a/wall_clock
    licence: CC0-1.0
    proof: https://polyhaven.com/license
    path: polyhaven/wall_clock
    used-in:
      - scene.blend
  - id: kia-handwriting
    source: self-made
    licence: original
    proof: "pipeline/build_act2_scene.py (drawn by script)"
    path: original/handwriting
    used-in: [scene.blend]
  - id: some-font
    source: https://fonts.example/font
    licence: OFL-1.1
    proof: https://fonts.example/font/OFL.txt
    path: fonts/some-font
    used-in: [scene.blend]
  - id: ccby-texture
    source: https://example.com/t
    licence: CC-BY-4.0
    proof: https://example.com/license
    path: other/ccby
    used-in: [scene.blend]
  - id: procedural-ids-only
    source: self-made
    licence: original
    proof: pipeline/build_act2_scene.py
    used-in: [scene.blend]
  - id: blender-builtin-font
    source: Blender
    licence: original
    proof: https://www.blender.org/about/license/
    path: <builtin>
    used-in: [scene.blend]

tools:
  - id: blender
    version: "5.2.1"
"""


class _Fixture(unittest.TestCase):
    """Temporary asset library + licence record."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.lib = self.root / "library"
        for rel in ("polyhaven/wall_clock/textures/wall_clock_diff_2k.jpg",
                    "original/handwriting/note.png",
                    "fonts/some-font/font.ttf",
                    "other/ccby/t.png",
                    "polyhaven/unlisted_texture/textures/rogue_diff_1k.jpg"):
            path = self.lib / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
        self.record = self.root / "assets.yaml"
        self.record.write_text(RECORD, encoding="utf-8")

    def ref(self, rel, kind="image", name=None, asset_id=None):
        path = rel if rel.startswith("<") else str(self.lib / rel)
        return lg.Reference(kind, name or Path(rel).name, path, asset_id)

    def gate(self, refs, library=True):
        return lg.check(refs, self.record, self.lib if library else None)


class YamlSubsetTest(unittest.TestCase):
    def test_repo_record_parses_and_is_valid(self):
        data = lg.load_record()
        self.assertIsInstance(data["assets"], list)
        self.assertEqual(lg.validate_entries(data["assets"]), [])
        blender = next(t for t in data["tools"] if t["id"] == "blender")
        self.assertEqual(blender["version"], tc.read_pinned_version())

    def test_repo_record_entries_are_cc0_with_proof(self):
        for entry in lg.load_entries():
            with self.subTest(entry=entry["id"]):
                # Fonts may also be OFL-1.1 (same rule as the gate's ALLOWED_LICENCES_BY_KIND).
                allowed = lg.ALLOWED_LICENCES | lg.ALLOWED_LICENCES_BY_KIND.get(entry.get("kind"), set())
                self.assertIn(entry["licence"], allowed)
                self.assertTrue(str(entry["proof"]).startswith(("https://", "pipeline/")))

    def test_scalars_lists_comments(self):
        data = lg.parse_yaml_subset(
            "a: plain value # comment\n"
            "b: \"quoted # not a comment\"\n"
            "c: 'it''s'\n"
            "d: Jun's desk # trailing comment\n"
            "e: [x, y]\n"
            "f: []\n"
            "g:\n  - one\n  - k: v\n    k2: v2\n"
            "h: \"back\\\\slash \\\"q\\\"\"\n"
            "url: https://example.com/a:b\n"
        )
        self.assertEqual(data, {
            "a": "plain value", "b": "quoted # not a comment", "c": "it's",
            "d": "Jun's desk", "e": ["x", "y"], "f": [],
            "g": ["one", {"k": "v", "k2": "v2"}], "h": 'back\\slash "q"',
            "url": "https://example.com/a:b",
        })

    def test_unsupported_or_broken_input_raises(self):
        for text in ("a: &anchor x\n", "a: {x: 1}\n", "a: 1\na: 2\n", "a:\n\t- x\n",
                     "a: 1\n   b: 2\n", "just text\n"):
            with self.subTest(text=text), self.assertRaises(lg.LicenceRecordError):
                lg.parse_yaml_subset(text)

    def test_dump_round_trip_and_block_replacement_keeps_tools(self):
        entries = [{"id": "x", "source": "https://s/x", "licence": "CC0-1.0",
                    "proof": "https://s/license", "path": "src/x",
                    "purpose": "a, b: c # d", "used-in": ["scene.blend (story 0.2)"]}]
        new_text = lg.replace_assets_block(RECORD, entries)
        data = lg.parse_yaml_subset(new_text)
        self.assertEqual(data["assets"], entries)
        self.assertEqual(data["tools"][0]["version"], "5.2.1")
        self.assertTrue(new_text.startswith("# fixture licence record\n"))
        self.assertEqual(lg.parse_yaml_subset(lg.replace_assets_block(RECORD, []))["assets"], [])

    def test_validate_flags_missing_fields_and_duplicates(self):
        problems = lg.validate_entries([
            {"id": "a", "source": "s", "licence": "CC0-1.0", "proof": "p", "used-in": []},
            {"id": "a", "source": "s", "licence": "CC0-1.0", "proof": "p", "used-in": ["x"]},
            {"source": "s"},
        ])
        text = "\n".join(problems)
        self.assertIn("a: missing 'used-in'", text)
        self.assertIn("a: duplicate id", text)
        self.assertIn("assets[3]: missing 'id'", text)
        self.assertIn("assets[3]: missing 'proof'", text)


class GateTest(_Fixture):
    def test_listed_assets_pass(self):
        refs = [
            self.ref("polyhaven/wall_clock/textures/wall_clock_diff_2k.jpg"),
            self.ref("original/handwriting/note.png"),
            self.ref("fonts/some-font/font.ttf", kind="font"),
            self.ref("<builtin>", kind="font", name="Bfont"),
            lg.Reference("image", "proc", "", "procedural-ids-only"),
        ]
        self.assertEqual(self.gate(refs), [])

    def test_no_references_pass(self):
        self.assertEqual(self.gate([]), [])

    def test_deliberately_unlisted_texture_is_named(self):
        rogue = self.lib / "polyhaven/unlisted_texture/textures/rogue_diff_1k.jpg"
        problems = self.gate([
            self.ref("polyhaven/wall_clock/textures/wall_clock_diff_2k.jpg"),
            self.ref("polyhaven/unlisted_texture/textures/rogue_diff_1k.jpg", name="rogue"),
        ])
        self.assertEqual(len(problems), 1)
        self.assertIn(str(rogue), problems[0])
        self.assertIn("rogue", problems[0])
        self.assertIn("not listed", problems[0])

    def test_every_missing_reference_is_listed(self):
        outside = str(self.root / "Downloads" / "random.hdr")
        problems = self.gate([
            self.ref("polyhaven/unlisted_texture/textures/rogue_diff_1k.jpg"),
            lg.Reference("library", "lib.blend", outside),
            lg.Reference("image", "unnamed", ""),
            lg.Reference("image", "spoof", "", "no-such-id"),
        ])
        self.assertEqual(len(problems), 4)
        self.assertTrue(any(outside in p for p in problems))
        self.assertTrue(any("(no path)" in p for p in problems))

    def test_sibling_prefix_is_not_inside_entry(self):
        sibling = self.lib / "polyhaven" / "wall_clock_evil" / "x.jpg"
        problems = self.gate([lg.Reference("image", "x", str(sibling))])
        self.assertEqual(len(problems), 1)

    def test_dotdot_escape_is_not_inside_entry(self):
        sneaky = str(self.lib / "polyhaven/wall_clock/../unlisted_texture/textures/rogue_diff_1k.jpg")
        self.assertEqual(len(self.gate([lg.Reference("image", "x", sneaky)])), 1)

    def test_asset_id_cannot_override_a_path_entry(self):
        outside = str(self.root / "elsewhere" / "clock.jpg")
        problems = self.gate([lg.Reference("image", "x", outside, "polyhaven-wall_clock")])
        self.assertEqual(len(problems), 1)

    def test_asset_id_of_pathless_entry_cannot_whitelist_a_file(self):
        outside = str(self.root / "Downloads" / "anything.png")
        problems = self.gate([lg.Reference("image", "tagged", outside, "procedural-ids-only")])
        self.assertEqual(len(problems), 1)
        self.assertIn("not listed", problems[0])
        # Without a file path the same tag still matches the path-less entry.
        self.assertEqual(self.gate([lg.Reference("image", "proc", "", "procedural-ids-only")]), [])

    def test_disallowed_licence_is_refused(self):
        problems = self.gate([self.ref("other/ccby/t.png")])
        self.assertEqual(len(problems), 1)
        self.assertIn("CC-BY-4.0", problems[0])

    def test_ofl_only_allowed_for_fonts(self):
        self.assertEqual(self.gate([self.ref("fonts/some-font/font.ttf", kind="font")]), [])
        self.assertEqual(len(self.gate([self.ref("fonts/some-font/font.ttf", kind="image")])), 1)

    def test_library_unset_refuses_library_relative_entries(self):
        problems = self.gate(
            [self.ref("polyhaven/wall_clock/textures/wall_clock_diff_2k.jpg")], library=False
        )
        self.assertEqual(len(problems), 1)
        self.assertIn(lg.LIBRARY_ENV, problems[0])

    def test_absolute_entry_path(self):
        record = lg.replace_assets_block(RECORD, [{
            "id": "abs", "source": "https://s", "licence": "CC0-1.0", "proof": "https://p",
            "path": str(self.lib / "polyhaven" / "wall_clock"), "used-in": ["s"]}])
        self.record.write_text(record, encoding="utf-8")
        refs = [self.ref("polyhaven/wall_clock/textures/wall_clock_diff_2k.jpg")]
        self.assertEqual(lg.check(refs, self.record, None), [])

    @unittest.skipUnless(os.name == "nt", "Windows paths are case-insensitive")
    def test_windows_case_and_separators(self):
        path = str(self.lib / "POLYHAVEN/Wall_Clock/textures/x.jpg").replace("\\", "/")
        self.assertEqual(self.gate([lg.Reference("image", "x", path)]), [])

    def test_invalid_record_fails_closed(self):
        self.record.write_text("assets:\n  - id: a\n    source: s\n", encoding="utf-8")
        problems = self.gate([])
        self.assertTrue(problems)
        self.assertTrue(all(p.startswith("licence record invalid") for p in problems))
        self.record.write_text("tools: []\n", encoding="utf-8")
        self.assertIn("missing top-level 'assets:'", self.gate([])[0])
        missing = self.root / "nope.yaml"
        self.assertIn("cannot read", lg.check([], missing, self.lib)[0])


class LibraryTest(_Fixture):
    def test_library_root_from_env(self):
        self.assertIsNone(lg.library_root({}))
        self.assertIsNone(lg.library_root({lg.LIBRARY_ENV: "  "}))
        self.assertEqual(lg.library_root({lg.LIBRARY_ENV: str(self.lib)}), self.lib)

    def test_consistency_reports_missing_and_orphans(self):
        entries = lg.load_entries(self.record) + [{"id": "gone", "path": "polyhaven/gone"}]
        missing, orphans = lg.library_consistency(entries, self.lib)
        self.assertEqual(missing, ["gone"])
        self.assertEqual(orphans, ["polyhaven/unlisted_texture"])

    def test_fetch_check_exits_licence_on_mismatch(self):
        with contextlib.redirect_stdout(io.StringIO()):
            code = fa.check_library(lg.load_entries(self.record), self.lib)
        self.assertEqual(code, tc.EXIT_LICENCE)

    @unittest.skipUnless(lg.library_root() and lg.library_root().is_dir(),
                         "JFILM_LIBRARY not set on this machine")
    def test_real_library_matches_repo_record(self):
        self.assertEqual(lg.library_consistency(lg.load_entries(), lg.library_root()), ([], []))


class FetchHelpersTest(unittest.TestCase):
    def test_catalogue_entries_are_complete_and_cc0(self):
        entries = [fa.entry_for(a) for a in fa.CATALOGUE]
        self.assertEqual(lg.validate_entries(entries), [])
        self.assertEqual(len({e["id"] for e in entries}), len(entries))
        for entry in entries:
            self.assertEqual(entry["licence"], "CC0-1.0")

    def test_catalogue_is_recorded_in_repo_record(self):
        recorded = {e["id"]: e for e in lg.load_entries()}
        for asset in fa.CATALOGUE:
            with self.subTest(asset=asset.entry_id):
                self.assertIn(asset.entry_id, recorded)
                self.assertEqual(recorded[asset.entry_id]["path"], asset.rel_path)

    def test_merge_refreshes_and_keeps_used_in(self):
        old = [{"id": "a", "licence": "CC0-1.0", "used-in": ["other.blend"]},
               {"id": "keep", "used-in": ["x"]}]
        new = [{"id": "a", "licence": "CC0-1.0", "path": "p/a", "used-in": ["scene.blend"]},
               {"id": "b", "used-in": ["scene.blend"]}]
        merged = fa.merge_entries(old, new)
        self.assertEqual([e["id"] for e in merged], ["a", "keep", "b"])
        self.assertEqual(merged[0]["used-in"], ["other.blend", "scene.blend"])
        self.assertEqual(merged[0]["path"], "p/a")

    def test_safe_member_path_rejects_traversal(self):
        target = Path("lib") / "x"
        self.assertEqual(fa.safe_member_path(target, "textures/a.jpg"), target / "textures" / "a.jpg")
        for bad in ("../a.jpg", "textures/../../a", "/etc/passwd", "C:/x", "", "C:evil.jpg", "\\evil.jpg"):
            with self.subTest(bad=bad), self.assertRaises(IOError):
                fa.safe_member_path(target, bad)


class AspectParsingTest(unittest.TestCase):
    def parse(self, *script_args):
        return tc.parse_args(STYLE_FRAME + ["--", *script_args], "style_frame.py",
                             tc.add_aspect_argument)

    def expect_usage_error(self, *script_args):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
            self.parse(*script_args)
        self.assertEqual(ctx.exception.code, tc.EXIT_USAGE)

    def test_16x9_and_9x16(self):
        for aspect, expected in (("16x9", (1920, 1080, "CAM_16x9")),
                                 ("9x16", (1080, 1920, "CAM_9x16"))):
            with self.subTest(aspect=aspect):
                args = self.parse("--aspect", aspect, "--out", "o")
                self.assertEqual(args.aspect, aspect)
                self.assertEqual(tc.aspect_spec(args.aspect), expected)

    def test_bad_aspect_exits_1(self):
        for bad in ("4x3", "16:9", "1080x1920", ""):
            with self.subTest(bad=bad):
                self.expect_usage_error("--aspect", bad, "--out", "o")

    def test_missing_aspect_exits_1(self):
        self.expect_usage_error("--out", "o")

    def test_extension_hook_keeps_common_options(self):
        def hook(parser):
            tc.add_aspect_argument(parser)
            parser.set_defaults(samples=256)

        args = tc.parse_args(STYLE_FRAME + ["--", "--aspect", "9x16", "--out", "o",
                                            "--allow-version-mismatch"], "style_frame.py", hook)
        self.assertEqual(args.samples, 256)
        self.assertTrue(args.allow_version_mismatch)
        # Without a hook the original parser is unchanged (render_test.py).
        self.assertFalse(hasattr(tc.parse_args(STYLE_FRAME + ["--", "--out", "o"]), "aspect"))

    def test_aspect_spec_rejects_unknown(self):
        with self.assertRaises(ValueError):
            tc.aspect_spec("4x3")

    def test_exit_licence_is_6_and_distinct(self):
        self.assertEqual(tc.EXIT_LICENCE, 6)
        codes = [tc.EXIT_USAGE, tc.EXIT_NO_GPU, tc.EXIT_VERSION_MISMATCH,
                 tc.EXIT_RENDER_FAILED, tc.EXIT_CONFIG, tc.EXIT_LICENCE]
        self.assertEqual(len(set(codes)), len(codes))


class OutputCheckHelpersTest(unittest.TestCase):
    def test_count_pure_white(self):
        white, near, black = [1.0, 1.0, 1.0, 1.0], [254.4 / 255, 1.0, 1.0, 1.0], [0.0, 0.0, 0.0, 1.0]
        self.assertEqual(tc.count_pure_white(white + near + black + white), 2)
        self.assertEqual(tc.count_pure_white([1.0, 1.0, 1.0] * 3, channels=3), 3)
        self.assertEqual(tc.count_pure_white([]), 0)

    def test_parse_nvidia_smi_memory(self):
        self.assertEqual(tc.parse_nvidia_smi_memory(["512, 6144", "4096, 6144", "garbage", ""]),
                         (4096, 6144))
        self.assertIsNone(tc.parse_nvidia_smi_memory(["[N/A], [N/A]"]))

    def test_output_size(self):
        self.assertEqual(tc.output_size("16x9"), (1920, 1080))
        self.assertEqual(tc.output_size("9x16", 50), (540, 960))
        for bad in (0, 101):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                tc.output_size("16x9", bad)

    def test_vram_sampler_collects_peak_and_baseline(self):
        script = "import time\nfor u in (900, 3100, 2500):\n    print(f'{u}, 6144', flush=True)\ntime.sleep(30)\n"
        with tc.VramSampler([sys.executable, "-c", script]) as sampler:
            for _ in range(600):  # up to ~30 s (cold Windows start); exits as soon as 3 samples arrive
                if len(sampler.lines) >= 3:
                    break
                import time
                time.sleep(0.05)
        self.assertEqual(sampler.result, (3100, 6144))
        self.assertEqual(sampler.baseline, 900)
        self.assertIn("headroom 3044 MiB", tc.format_vram(sampler.result, sampler.baseline))

    def test_vram_sampler_missing_tool_is_not_fatal(self):
        with tc.VramSampler(["definitely-not-nvidia-smi-xyz"]) as sampler:
            pass
        self.assertIsNone(sampler.result)
        self.assertIsNotNone(sampler.error)
        self.assertIn("unavailable", tc.format_vram(None))

    def test_format_vram_flags_low_headroom(self):
        self.assertIn("WARNING", tc.format_vram((5800, 6144)))
        self.assertNotIn("WARNING", tc.format_vram((3000, 6144)))


class ResolveReferencePathTest(unittest.TestCase):
    def test_blend_relative_and_plain_relative(self):
        base = os.path.abspath(os.path.join("x", "scenes"))
        self.assertEqual(lg.resolve_reference_path("//tex/a.png", base),
                         os.path.normpath(os.path.join(base, "tex", "a.png")))
        self.assertEqual(lg.resolve_reference_path("//../lib/a.png", base),
                         os.path.normpath(os.path.join(base, "..", "lib", "a.png")))
        self.assertEqual(lg.resolve_reference_path("tex/a.png", base),
                         os.path.normpath(os.path.join(base, "tex", "a.png")))

    def test_absolute_pseudo_and_empty(self):
        absolute = os.path.abspath(os.path.join("lib", "a.png"))
        self.assertEqual(lg.resolve_reference_path(absolute, None), os.path.normpath(absolute))
        self.assertEqual(lg.resolve_reference_path("<builtin>", None), "<builtin>")
        self.assertEqual(lg.resolve_reference_path("", None), "")
        self.assertEqual(lg.resolve_reference_path(None, None), "")

    def test_relative_without_base_fails_closed(self):
        for raw in ("//a.png", "a.png"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                lg.resolve_reference_path(raw, None)

    def test_resolved_relative_texture_still_hits_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "library"
            entries = [{"id": "a", "source": "s", "licence": "CC0-1.0", "proof": "p", "used-in": ["x"],
                        "path": "polyhaven/a"}]
            blend_dir = lib / "polyhaven" / "a"
            inside = lg.Reference("image", "a", lg.resolve_reference_path("//textures/a.jpg", blend_dir))
            escaped = lg.Reference("image", "b", lg.resolve_reference_path("//../../../evil.png", blend_dir))
            violations = lg.find_violations([inside, escaped], entries, lib)
            self.assertEqual([v.reference.name for v in violations], ["b"])


if __name__ == "__main__":
    unittest.main()
