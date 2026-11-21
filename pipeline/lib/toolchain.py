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
EXIT_LICENCE = 6  # scene references an asset missing from licenses/assets.yaml

# Cycles GPU backends in order of preference. Never includes CPU.
GPU_BACKENDS = ("OPTIX", "CUDA")

DEFAULT_SAMPLES = 64

# Aspect variants: every shot has a dedicated 16:9 and 9:16 composition
# (separate cameras, never a crop). Value: (width, height, camera object name).
ASPECTS = {
    "16x9": (1920, 1080, "CAM_16x9"),
    "9x16": (1080, 1920, "CAM_9x16"),
}

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


ParserHook = Callable[[argparse.ArgumentParser], None]


def build_parser(
    prog: str = "render_test.py", extend: ParserHook | None = None
) -> argparse.ArgumentParser:
    """Common parser (``--out``, ``--samples``, ``--allow-version-mismatch``).

    ``extend(parser)`` lets a script add its own options or change defaults
    (``parser.set_defaults(samples=...)``) without duplicating the common ones.
    """
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
        help="Cycles samples (default %(default)s)",
    )
    if extend is not None:
        extend(parser)
    return parser


def parse_args(
    argv: Sequence[str], prog: str = "render_test.py", extend: ParserHook | None = None
) -> argparse.Namespace:
    """Parse the script arguments found after ``--`` in a full ``sys.argv``.

    Usage errors (e.g. missing ``--out``) exit with ``EXIT_USAGE``.
    """
    parser = build_parser(prog, extend)
    args = parser.parse_args(script_args(argv))
    if args.samples < 1:
        parser.error("--samples must be >= 1")
    return args


def add_aspect_argument(parser: argparse.ArgumentParser) -> None:
    """Parser hook: required ``--aspect 16x9|9x16`` (anything else exits 1)."""
    parser.add_argument(
        "--aspect",
        required=True,
        choices=sorted(ASPECTS),
        help="composition to render: 16x9 (1920x1080) or 9x16 (1080x1920)",
    )


def aspect_spec(aspect: str) -> tuple[int, int, str]:
    """Return ``(width, height, camera name)`` for a valid aspect id."""
    if aspect not in ASPECTS:
        raise ValueError(f"unknown aspect {aspect!r}; expected one of {sorted(ASPECTS)}")
    return ASPECTS[aspect]


def output_size(aspect: str, percentage: int = 100) -> tuple[int, int]:
    """Pixel size Blender writes for ``aspect`` at ``resolution_percentage``."""
    if not 1 <= percentage <= 100:
        raise ValueError(f"percentage must be 1..100, got {percentage}")
    width, height, _ = aspect_spec(aspect)
    return width * percentage // 100, height * percentage // 100


# ------------------------------------------------------------- Output checks


def count_pure_white(pixels: Sequence[float], channels: int = 4) -> int:
    """Count pixels whose RGB all quantise to 255 in an 8-bit output.

    ``pixels`` is a flat float sequence in [0, 1] (``bpy`` ``Image.pixels``
    layout, ``channels`` values per pixel; alpha is ignored).
    """
    threshold = 254.5 / 255.0
    try:  # fast path inside Blender (numpy is bundled there)
        import numpy as np

        arr = np.asarray(pixels, dtype=np.float32).reshape(-1, channels)[:, :3]
        return int(np.count_nonzero(np.all(arr >= threshold, axis=1)))
    except ImportError:
        count = 0
        for i in range(0, len(pixels) - channels + 1, channels):
            if pixels[i] >= threshold and pixels[i + 1] >= threshold and pixels[i + 2] >= threshold:
                count += 1
        return count


def parse_nvidia_smi_memory(lines: Iterable[str]) -> tuple[int, int] | None:
    """Parse ``nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits``
    samples (one ``used, total`` line per sample, first GPU) into ``(peak MiB, total MiB)``.

    Returns ``None`` when no line could be parsed.
    """
    peak, total = None, None
    for line in lines:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue
        try:
            used, tot = int(float(parts[0])), int(float(parts[1]))
        except ValueError:
            continue
        peak = used if peak is None else max(peak, used)
        total = tot
    if peak is None or total is None:
        return None
    return peak, total


NVIDIA_SMI_QUERY = (
    "nvidia-smi",
    "--query-gpu=memory.used,memory.total",
    "--format=csv,noheader,nounits",
    "-lms",
    "250",
)


class VramSampler:
    """Sample GPU memory with a long-running ``nvidia-smi -lms`` loop while rendering.

    ``with VramSampler() as s: render()`` then ``s.result`` is ``(peak MiB, total MiB)``
    or ``None`` (nvidia-smi missing or no parsable output). ``s.baseline`` is the
    first sample (memory already in use before the render). Never raises because
    of nvidia-smi: VRAM logging must not fail a render.
    """

    def __init__(self, command: Sequence[str] = NVIDIA_SMI_QUERY):
        self.command = list(command)
        self.lines: list[str] = []
        self.error: str | None = None
        self._proc = None
        self._thread = None

    def __enter__(self) -> "VramSampler":
        import subprocess
        import threading

        try:
            self._proc = subprocess.Popen(
                self.command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1
            )
        except OSError as exc:
            self.error = f"cannot start {self.command[0]}: {exc}"
            return self

        def pump(stream):
            for line in stream:
                self.lines.append(line.strip())

        self._thread = threading.Thread(target=pump, args=(self._proc.stdout,), daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        if self._proc is not None:
            if self._proc.poll() is None:
                self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                self._proc.kill()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._proc is not None and self._proc.stdout is not None:
            self._proc.stdout.close()

    @property
    def result(self) -> tuple[int, int] | None:
        return parse_nvidia_smi_memory(self.lines)

    @property
    def baseline(self) -> int | None:
        first = parse_nvidia_smi_memory(self.lines[:1])
        return None if first is None else first[0]


def format_vram(result: tuple[int, int] | None, baseline: int | None = None) -> str:
    """Human-readable VRAM line with headroom, e.g. ``peak 4100/6144 MiB (66.7%), headroom 2044 MiB``."""
    if result is None:
        return "peak VRAM unavailable (nvidia-smi not found or no samples)"
    peak, total = result
    text = f"peak {peak}/{total} MiB ({100.0 * peak / total:.1f}%), headroom {total - peak} MiB"
    if baseline is not None:
        text += f", before render {baseline} MiB (render added ~{peak - baseline} MiB)"
    if total and (total - peak) < 0.1 * total:
        text += " -- WARNING: <10% headroom, impractical for production"
    return text


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
