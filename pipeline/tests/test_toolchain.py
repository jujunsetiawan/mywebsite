"""Unit tests for pipeline/lib/toolchain.py (plain Python, no bpy).

Run: python -m unittest discover -s pipeline/tests -v
"""

from __future__ import annotations

import contextlib
import io
import re
import sys
import tempfile
import unittest
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PIPELINE_DIR.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import toolchain as tc  # noqa: E402

BLENDER = ["blender", "-b", "--factory-startup", "-P", "pipeline/render_test.py"]


class CheckVersionTest(unittest.TestCase):
    def test_match_is_ok_without_message(self):
        self.assertEqual(tc.check_version("5.2.1", "5.2.1", False), (True, ""))

    def test_tuple_running_version_is_normalised(self):
        ok, _ = tc.check_version(tc.format_version((5, 2, 1)), "5.2.1", False)
        self.assertTrue(ok)

    def test_mismatch_without_flag_fails_and_names_both_versions(self):
        ok, message = tc.check_version("5.2.0", "5.2.1", False)
        self.assertFalse(ok)
        self.assertIn("5.2.0", message)
        self.assertIn("5.2.1", message)
        self.assertIn("WARNING", message)

    def test_mismatch_with_flag_warns_but_is_ok(self):
        ok, message = tc.check_version("5.3.0", "5.2.1", True)
        self.assertTrue(ok)
        self.assertIn("5.3.0", message)
        self.assertIn("5.2.1", message)

    def test_exit_codes_are_distinct_and_non_zero_on_failure(self):
        codes = [tc.EXIT_USAGE, tc.EXIT_NO_GPU, tc.EXIT_VERSION_MISMATCH,
                 tc.EXIT_RENDER_FAILED, tc.EXIT_CONFIG]
        self.assertEqual(tc.EXIT_OK, 0)
        self.assertEqual(len(set(codes)), len(codes))
        self.assertNotIn(0, codes)
        self.assertEqual(tc.EXIT_USAGE, 1)
        self.assertEqual(tc.EXIT_NO_GPU, 2)
        self.assertEqual(tc.EXIT_VERSION_MISMATCH, 3)
        self.assertEqual(tc.EXIT_RENDER_FAILED, 4)
        self.assertEqual(tc.EXIT_CONFIG, 5)


class ParseArgsTest(unittest.TestCase):
    def _parse_expecting_exit(self, argv):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as ctx:
            tc.parse_args(argv)
        return ctx.exception.code, stderr.getvalue()

    def test_missing_out_exits_1_with_usage(self):
        code, err = self._parse_expecting_exit(BLENDER + ["--"])
        self.assertEqual(code, tc.EXIT_USAGE)
        self.assertIn("usage:", err)
        self.assertIn("--out", err)

    def test_no_double_dash_means_no_script_args(self):
        code, _ = self._parse_expecting_exit(BLENDER + ["--out", "x"])
        self.assertEqual(code, tc.EXIT_USAGE)

    def test_defaults(self):
        args = tc.parse_args(BLENDER + ["--", "--out", "pipeline/out/test"])
        self.assertEqual(args.out, "pipeline/out/test")
        self.assertEqual(args.samples, 64)
        self.assertFalse(args.allow_version_mismatch)

    def test_flag_and_samples(self):
        args = tc.parse_args(
            BLENDER + ["--", "--out", "o", "--allow-version-mismatch", "--samples", "16"]
        )
        self.assertTrue(args.allow_version_mismatch)
        self.assertEqual(args.samples, 16)

    def test_only_args_after_double_dash_are_parsed(self):
        args = tc.parse_args(["blender", "--samples", "999", "--", "--out", "o"])
        self.assertEqual(args.samples, 64)

    def test_invalid_samples_exit_1(self):
        code, _ = self._parse_expecting_exit(BLENDER + ["--", "--out", "o", "--samples", "0"])
        self.assertEqual(code, tc.EXIT_USAGE)


class PinnedVersionTest(unittest.TestCase):
    def _write(self, text: str, encoding: str = "utf-8") -> Path:
        tmp = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding=encoding)
        tmp.write(text)
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        return Path(tmp.name)

    def test_reads_single_line(self):
        self.assertEqual(tc.read_pinned_version(self._write("5.2.1\n")), "5.2.1")

    def test_reads_bom_prefixed_file(self):
        path = self._write("5.2.1\r\n", encoding="utf-8-sig")
        self.assertTrue(path.read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertEqual(tc.read_pinned_version(path), "5.2.1")

    def test_rejects_malformed(self):
        for text in ("5.2\n", "v5.2.1\n", "5.2.1\n5.2.2\n", ""):
            with self.subTest(text=text), self.assertRaises(ValueError):
                tc.read_pinned_version(self._write(text))

    def test_repo_pinned_file_is_valid(self):
        self.assertRegex(tc.read_pinned_version(), r"^\d+\.\d+\.\d+$")

    def test_licence_record_matches_pinned_version(self):
        text = (REPO_ROOT / "licenses" / "assets.yaml").read_text(encoding="utf-8")
        entry = re.search(r"^\s*-\s*id:\s*blender\s*$(.*?)(?=^\s*-\s*id:|\Z)", text, re.S | re.M)
        self.assertIsNotNone(entry, "Blender tool entry missing from licenses/assets.yaml")
        match = re.search(r"^\s*version:\s*\"?([\d.]+)\"?\s*$", entry.group(1), re.M)
        self.assertIsNotNone(match, "Blender tool entry has no version in licenses/assets.yaml")
        self.assertEqual(match.group(1), tc.read_pinned_version())


class OutDirTest(unittest.TestCase):
    def test_absent_dir_is_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "a" / "b"
            self.assertFalse(target.exists())
            out = tc.ensure_out_dir(target)
            self.assertTrue(out.is_dir())
            self.assertTrue(out.is_absolute())
            tc.ensure_out_dir(target)  # idempotent


class PickGpuBackendTest(unittest.TestCase):
    @staticmethod
    def _probe(devices_by_backend):
        return lambda backend: devices_by_backend.get(backend, [])

    def test_prefers_optix(self):
        probe = self._probe({
            "OPTIX": [("OPTIX", "RTX 2060"), ("CPU", "cpu")],
            "CUDA": [("CUDA", "RTX 2060"), ("CPU", "cpu")],
        })
        self.assertEqual(tc.pick_gpu_backend(probe), ("OPTIX", ["RTX 2060"]))

    def test_falls_back_to_cuda_when_optix_unavailable(self):
        probe = self._probe({"OPTIX": [("CPU", "cpu")], "CUDA": [("CUDA", "RTX 2060")]})
        self.assertEqual(tc.pick_gpu_backend(probe), ("CUDA", ["RTX 2060"]))

    def test_cpu_only_returns_none(self):
        probe = self._probe({"OPTIX": [("CPU", "cpu")], "CUDA": [("CPU", "cpu")]})
        self.assertIsNone(tc.pick_gpu_backend(probe))

    def test_never_probes_cpu_backend(self):
        seen = []
        tc.pick_gpu_backend(lambda b: seen.append(b) or [])
        self.assertEqual(seen, ["OPTIX", "CUDA"])


class _FakeDevice:
    def __init__(self, dev_type, name, use=True):
        self.type, self.name, self.use = dev_type, name, use


class _FakePrefs:
    """Duck-typed stand-in for the Cycles add-on preferences.

    ``inventory`` maps a backend to the device list Cycles would report after a
    refresh (built fresh each time, like Cycles). Backends missing from
    ``supported`` raise TypeError on assignment, like an absent enum item.
    """

    def __init__(self, inventory, supported=("NONE", "OPTIX", "CUDA"), legacy=False):
        self._inventory = inventory
        self._supported = supported
        self._type = "NONE"
        self.devices = []
        self.refresh_calls = 0
        if legacy:
            self.get_devices = self._refresh
        else:
            self.refresh_devices = self._refresh

    @property
    def compute_device_type(self):
        return self._type

    @compute_device_type.setter
    def compute_device_type(self, value):
        if value not in self._supported:
            raise TypeError(f"enum {value!r} not found")
        self._type = value

    def _refresh(self):
        self.refresh_calls += 1
        entry = self._inventory.get(self._type, [])
        if callable(entry):
            entry = entry(self.refresh_calls)
        self.devices = [_FakeDevice(t, n) for t, n in entry]


class EnableGpuDevicesTest(unittest.TestCase):
    def test_typeerror_backend_is_skipped(self):
        prefs = _FakePrefs(
            {"CUDA": [("CUDA", "RTX 2060"), ("CPU", "cpu")]},
            supported=("NONE", "CUDA"),
        )
        backend, names = tc.enable_gpu_devices(prefs)
        self.assertEqual((backend, names), ("CUDA", ["RTX 2060"]))
        self.assertEqual(prefs.compute_device_type, "CUDA")

    def test_only_chosen_backend_devices_enabled(self):
        prefs = _FakePrefs({
            "OPTIX": [("OPTIX", "RTX 2060"), ("CUDA", "RTX 2060"), ("CPU", "cpu")],
        })
        backend, names = tc.enable_gpu_devices(prefs)
        self.assertEqual((backend, names), ("OPTIX", ["RTX 2060"]))
        self.assertEqual(
            {(d.type, d.use) for d in prefs.devices},
            {("OPTIX", True), ("CUDA", False), ("CPU", False)},
        )

    def test_legacy_get_devices_api(self):
        prefs = _FakePrefs({"OPTIX": [("OPTIX", "RTX 2060")]}, legacy=True)
        self.assertEqual(tc.enable_gpu_devices(prefs), ("OPTIX", ["RTX 2060"]))

    def test_cpu_only_raises_no_gpu(self):
        prefs = _FakePrefs({"OPTIX": [("CPU", "cpu")], "CUDA": [("CPU", "cpu")]})
        with self.assertRaises(tc.NoGpuError):
            tc.enable_gpu_devices(prefs)

    def test_no_backend_supported_raises_no_gpu(self):
        prefs = _FakePrefs({}, supported=("NONE",))
        with self.assertRaises(tc.NoGpuError):
            tc.enable_gpu_devices(prefs)

    def test_none_enabled_after_final_refresh_raises_no_gpu(self):
        # Device is seen while probing but gone on the final refresh.
        prefs = _FakePrefs({
            "OPTIX": lambda n: [("OPTIX", "RTX 2060")] if n == 1 else [("CPU", "cpu")],
        })
        with self.assertRaises(tc.NoGpuError):
            tc.enable_gpu_devices(prefs)
        self.assertFalse(any(d.use and d.type != "CPU" for d in prefs.devices))


if __name__ == "__main__":
    unittest.main()
