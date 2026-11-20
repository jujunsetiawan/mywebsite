"""Pure toolchain helpers shared by every pipeline script.

This module must stay importable without ``bpy`` so it can be unit-tested with
plain Python (``python -m unittest discover -s pipeline/tests``). Anything that
touches Blender lives in the scripts that import this module.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Callable, Iterable, Sequence

PIPELINE_DIR = Path(__file__).resolve().parents[1]
PINNED_VERSION_FILE = PIPELINE_DIR / "BLENDER_VERSION"

# Explicit process exit codes. Every failure path is non-zero.
EXIT_OK = 0
EXIT_USAGE = 1
EXIT_NO_GPU = 2
EXIT_VERSION_MISMATCH = 3
EXIT_RENDER_FAILED = 4
EXIT_CONFIG = 5

# Cycles GPU backends in order of preference. Never includes CPU.
GPU_BACKENDS = ("OPTIX", "CUDA")

DEFAULT_SAMPLES = 64

_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def read_pinned_version(path: Path | str | None = None) -> str:
    """Return the pinned ``x.y.z`` Blender version from ``BLENDER_VERSION``.

    Raises ``OSError`` if the file is unreadable and ``ValueError`` if it does
    not contain exactly one ``x.y.z`` line.
    """
    file_path = Path(path) if path is not None else PINNED_VERSION_FILE
    # utf-8-sig tolerates a BOM (PowerShell 5.1 `Set-Content -Encoding UTF8`).
    lines = [ln.strip() for ln in file_path.read_text(encoding="utf-8-sig").splitlines()]
    lines = [ln for ln in lines if ln]
    if len(lines) != 1 or not _VERSION_RE.match(lines[0]):
        raise ValueError(
            f"{file_path} must contain a single 'x.y.z' version line, got {lines!r}"
        )
    return lines[0]


def format_version(version: Sequence[int] | str) -> str:
    """Normalise ``bpy.app.version`` (a tuple) or a string to ``x.y.z``."""
    if isinstance(version, str):
        return version.strip()
    return ".".join(str(part) for part in version)


def check_version(running: str, pinned: str, allow_mismatch: bool) -> tuple[bool, str]:
    """Compare the running Blender version with the pinned one.

    Returns ``(ok, message)``. ``message`` is empty on an exact match; on a
    mismatch it is a warning naming both versions, and ``ok`` equals
    ``allow_mismatch``.
    """
    running = format_version(running)
    pinned = format_version(pinned)
    if running == pinned:
        return True, ""
    message = (
        f"WARNING: running Blender {running} does not match pinned Blender {pinned} "
        f"(pipeline/BLENDER_VERSION)."
    )
    if allow_mismatch:
        message += " Continuing because --allow-version-mismatch was given."
    else:
        message += " Re-run with the pinned version or pass --allow-version-mismatch."
    return allow_mismatch, message


class _ArgumentParser(argparse.ArgumentParser):
    """ArgumentParser that exits with ``EXIT_USAGE`` (1) instead of argparse's 2.

    Exit code 2 is reserved for "no GPU" so usage errors must not collide.
    """

    def error(self, message: str) -> None:  # type: ignore[override]
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n")


def script_args(argv: Sequence[str]) -> list[str]:
    """Return only the arguments after the first ``--`` (Blender convention)."""
    argv = list(argv)
    if "--" in argv:
        return argv[argv.index("--") + 1 :]
    return []


def build_parser(prog: str = "render_test.py") -> argparse.ArgumentParser:
    parser = _ArgumentParser(
        prog=prog,
        description=(
            "Headless Blender pipeline script. Invoke as: "
            "blender -b --factory-startup -P <script> -- --out <dir> [options]"
        ),
    )
    parser.add_argument("--out", required=True, help="output directory (created if absent)")
    parser.add_argument(
        "--allow-version-mismatch",
        action="store_true",
        help="render even if the running Blender differs from pipeline/BLENDER_VERSION",
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=DEFAULT_SAMPLES,
        help=f"Cycles samples (default {DEFAULT_SAMPLES})",
    )
    return parser


def parse_args(argv: Sequence[str], prog: str = "render_test.py") -> argparse.Namespace:
    """Parse the script arguments found after ``--`` in a full ``sys.argv``.

    Usage errors (e.g. missing ``--out``) exit with ``EXIT_USAGE``.
    """
    parser = build_parser(prog)
    args = parser.parse_args(script_args(argv))
    if args.samples < 1:
        parser.error("--samples must be >= 1")
    return args


def ensure_out_dir(path: Path | str) -> Path:
    """Create the output directory (and parents) if needed; return its absolute path."""
    out = Path(path).resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def pick_gpu_backend(
    probe: Callable[[str], Iterable[tuple[str, str]]],
    backends: Sequence[str] = GPU_BACKENDS,
) -> tuple[str, list[str]] | None:
    """Choose the first GPU backend that exposes at least one GPU device.

    ``probe(backend)`` returns ``(device_type, device_name)`` pairs Cycles
    reports for that backend. CPU entries are ignored. Returns
    ``(backend, [gpu names])`` or ``None`` when no GPU backend is usable.
    """
    for backend in backends:
        names = [name for dev_type, name in probe(backend) if dev_type == backend]
        if names:
            return backend, names
    return None


class NoGpuError(RuntimeError):
    """No OptiX/CUDA device could be enabled; callers map this to EXIT_NO_GPU."""


def _refresh_devices(prefs) -> None:
    if hasattr(prefs, "refresh_devices"):
        prefs.refresh_devices()
    else:  # older Cycles API
        prefs.get_devices()


def enable_gpu_devices(prefs, backends: Sequence[str] = GPU_BACKENDS) -> tuple[str, list[str]]:
    """Select a GPU backend on Cycles add-on prefs and enable only its devices.

    ``prefs`` is duck-typed like ``bpy.context.preferences.addons['cycles'].preferences``:
    settable ``compute_device_type`` (raises ``TypeError`` for a backend absent
    from the build), ``devices`` with ``type``/``name``/``use``, and
    ``refresh_devices()`` (or older ``get_devices()``).

    Returns ``(backend, enabled GPU names)``. Raises ``NoGpuError`` instead of
    ever leaving a CPU-only configuration, because Cycles silently renders on
    the CPU when no GPU device is enabled.
    """

    def probe(backend: str):
        try:
            prefs.compute_device_type = backend
        except TypeError:  # backend not compiled into this build
            return []
        _refresh_devices(prefs)
        return [(d.type, d.name) for d in prefs.devices]

    choice = pick_gpu_backend(probe, backends)
    if choice is None:
        raise NoGpuError(
            "no NVIDIA OptiX or CUDA GPU device found; refusing to fall back to a CPU render"
        )
    backend, _ = choice

    prefs.compute_device_type = backend
    _refresh_devices(prefs)
    for device in prefs.devices:
        device.use = device.type == backend

    enabled = [d.name for d in prefs.devices if d.use and d.type != "CPU"]
    if not enabled:
        raise NoGpuError(f"could not enable any {backend} GPU device; refusing CPU render")
    return backend, enabled
