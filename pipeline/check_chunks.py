"""Re-slice every frame from its chunk and verify it is a decodable AVIF of the
expected size (Story 0.3). Plain Python, no Blender.

Usage (from the repository root):

    python pipeline/check_chunks.py [pipeline/out/spike-2026-11-21] [--ffprobe <path>] [--ffmpeg <path>] [--jobs 8]

Reads ``asset-manifest.json`` and ``frames/<act>.<aspect>.json`` in the given
mediaVersion directory (default: ``pipeline/out/spike-2026-11-21`` of this
repository). For every shot, aspect, tier and frame it checks:

- the aspect/tier pair is allowed (16x9: 1080 | 720; 9x16: 720);
- the chunk file exists and its size equals the manifest's ``chunkBytes``;
- the slice has ``offset >= 0``, ``length > 0`` and lies inside the chunk;
- the slice starts with an AVIF ``ftyp`` box;
- ffprobe decodes exactly one AV1 frame of the tier's width x height
  (``-count_frames`` forces a real decode);
- a strict decode with the libaom decoder succeeds without errors. ffmpeg's
  default decoder (dav1d) conceals damaged payloads, so ffprobe alone misses a
  corrupted slice whose header is intact.

Before checking, the resolved ffmpeg must be version 9.1 and list the
libaom-av1 decoder, so a tooling gap is never reported as corrupt media.

The manifest's own shape is validated by ``npm --prefix spike run validate``;
this script checks the bytes. Every failure is printed with frame, tier and
aspect.

Exit codes: 0 all frames OK, 1 usage, 4 one or more frames/chunks failed or no
slice to check, 5 manifest or frame data unreadable/malformed, ffprobe or
ffmpeg missing, wrong ffmpeg version or no libaom-av1 decoder.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import pack  # noqa: E402
from lib import shot  # noqa: E402
from lib import toolchain as tc  # noqa: E402

PROG = "check_chunks.py"
DEFAULT_VERSION_DIR = PIPELINE_DIR / "out" / shot.MEDIA_VERSION


class ConfigError(Exception):
    """Manifest/frame data unreadable or malformed, or tools unusable (exit 5)."""


def log(message: str) -> None:
    print(f"[check_chunks] {message}", flush=True)


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from None


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def check_tools(ffmpeg: str) -> None:
    """ffmpeg must be the pinned version and have the libaom-av1 decoder."""
    try:
        version = pack.parse_ffmpeg_version(_run([ffmpeg, "-hide_banner", "-version"]).stdout)
        decoders = _run([ffmpeg, "-hide_banner", "-decoders"]).stdout
    except OSError as exc:
        raise ConfigError(f"cannot run {ffmpeg}: {exc}") from None
    if version != pack.FFMPEG_VERSION:
        raise ConfigError(f"{ffmpeg} is version {version}, pinned {pack.FFMPEG_VERSION} ({pack.FFMPEG_WINGET_INSTALL})")
    if not pack.has_decoder(decoders, "libaom-av1"):
        raise ConfigError(f"{ffmpeg} has no libaom-av1 decoder; the strict decode check cannot run")


def probe(ffprobe: str, ffmpeg: str, data: bytes, tmp_dir: Path, name: str) -> tuple[pack.ProbeResult, tuple[int, str]]:
    """ffprobe (codec, size, decoded frame count) + strict libaom decode of one slice."""
    path = tmp_dir / f"{name}.avif"
    path.write_bytes(data)
    try:
        info = _run(pack.probe_command(ffprobe, path))
        strict = _run(pack.strict_decode_command(ffmpeg, path))
    finally:
        path.unlink(missing_ok=True)
    return pack.parse_probe(info.stdout, info.stderr, info.returncode), (strict.returncode, strict.stderr)


def _int(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{what} must be an integer, got {value!r}")
    return value


def collect(root: Path, manifest) -> tuple[list[tuple[str, bytes, tuple[int, int]]], list[str], dict[str, int]]:
    """Slices to probe, failures found without probing, slice counts per variant.

    Raises ``ConfigError`` for malformed manifest/frame data (missing key,
    wrong type, unknown or disallowed aspect/tier).
    """
    failures: list[str] = []
    jobs: list[tuple[str, bytes, tuple[int, int]]] = []
    counts: dict[str, int] = {}
    try:
        media_version = manifest["mediaVersion"]
        shots = manifest["shots"]
        if not isinstance(shots, list):
            raise ConfigError("manifest 'shots' must be a list")
        for s in shots:
            shot_id, act = s["id"], s["act"]
            chunk_size = _int(s["chunkSize"], f"shot {shot_id} chunkSize")
            if chunk_size < 1:
                raise ConfigError(f"shot {shot_id}: chunkSize must be >= 1")
            for variant in s["aspects"]:
                aspect = variant["aspect"]
                shot.check_segment(aspect)
                frame_data = load_json(root / shot.frame_data_relpath(act, aspect))
                fd_shot = next((x for x in frame_data["shots"] if x["id"] == shot_id), None)
                if fd_shot is None:
                    failures.append(f"shot {shot_id} {aspect}: missing from {shot.frame_data_relpath(act, aspect)}")
                    continue
                for entry in variant["tiers"]:
                    tier = entry["tier"]
                    shot.check_segment(aspect, tier)
                    if tier not in shot.TIERS_BY_ASPECT[aspect]:
                        raise ConfigError(f"tier {tier} not allowed for aspect {aspect} "
                                          f"(allowed: {' | '.join(shot.TIERS_BY_ASPECT[aspect])})")
                    where = f"shot {shot_id} aspect {aspect} tier {tier}"
                    expected = (_int(entry["width"], f"{where} width"), _int(entry["height"], f"{where} height"))
                    chunks: list[bytes | None] = []
                    for index, size in enumerate(entry["chunkBytes"]):
                        size = _int(size, f"{where} chunkBytes[{index}]")
                        rel = shot.chunk_relpath(media_version, shot_id, aspect, tier, index).split("/", 1)[1]
                        path = root / rel
                        if not path.is_file():
                            failures.append(f"{where}: chunk {index} missing ({path})")
                            chunks.append(None)
                            continue
                        data = path.read_bytes()
                        if len(data) != size:
                            failures.append(f"{where}: chunk {index} is {len(data)} B, manifest says {size} B")
                        chunks.append(data)
                    frames = fd_shot["frames"]
                    if len(frames) != variant["frameCount"]:
                        failures.append(f"{where}: {len(frames)} frames in frame data, manifest says {variant['frameCount']}")
                    for frame in frames:
                        index = _int(frame["index"], f"{where} frame index")
                        label = f"frame {index} tier {tier} aspect {aspect} (shot {shot_id})"
                        sl = next((x for x in frame["slices"] if x["tier"] == tier), None)
                        if sl is None:
                            failures.append(f"{label}: no slice")
                            continue
                        c = _int(sl["chunk"], f"{label} chunk")
                        offset = _int(sl["offset"], f"{label} offset")
                        length = _int(sl["length"], f"{label} length")
                        if offset < 0 or length <= 0:
                            failures.append(f"{label}: invalid slice offset {offset} / length {length} "
                                            "(need offset >= 0, length > 0)")
                            continue
                        if c != index // chunk_size:
                            failures.append(f"{label}: chunk {c}, expected {index // chunk_size}")
                        chunk = chunks[c] if 0 <= c < len(chunks) else None
                        if chunk is None:
                            failures.append(f"{label}: chunk {c} unavailable")
                            continue
                        end = offset + length
                        if end > len(chunk):
                            failures.append(f"{label}: offset {offset} + length {length} = {end} "
                                            f"outside chunk {c} ({len(chunk)} B)")
                            continue
                        jobs.append((label, chunk[offset:end], expected))
                        counts[f"{aspect}/{tier}"] = counts.get(f"{aspect}/{tier}", 0) + 1
    except (KeyError, TypeError, AttributeError) as exc:
        raise ConfigError(f"malformed manifest or frame data: {type(exc).__name__}: {exc}") from None
    except shot.ShotError as exc:
        raise ConfigError(f"malformed manifest or frame data: {exc}") from None
    return jobs, failures, counts


def main(argv: list[str]) -> int:
    p = tc._ArgumentParser(prog=PROG, description="Verify every frame slice of a mediaVersion directory.")
    p.add_argument("version_dir", nargs="?", default=str(DEFAULT_VERSION_DIR),
                   help="mediaVersion directory (default %(default)s)")
    p.add_argument("--ffprobe", default=None, help="path to ffprobe(.exe); default: PATH, then winget Links")
    p.add_argument("--ffmpeg", default=None, help="path to ffmpeg(.exe) for the strict decode; default: next to ffprobe")
    p.add_argument("--jobs", type=int, default=8, help="parallel probe processes (default %(default)s)")
    args = p.parse_args(argv)
    root = Path(args.version_dir)
    try:
        try:
            ffprobe = pack.resolve_tool("ffprobe", args.ffprobe)
            if args.ffmpeg:
                ffmpeg = pack.resolve_tool("ffmpeg", args.ffmpeg)
            else:
                ffmpeg = pack.sibling_tool(ffprobe, "ffmpeg") or pack.resolve_tool("ffmpeg")
        except pack.ToolError as exc:
            raise ConfigError(str(exc)) from None
        check_tools(ffmpeg)
        log(f"ffprobe: {ffprobe}; strict decoder: {ffmpeg} -c:v libaom-av1")
        jobs, failures, counts = collect(root, load_json(root / "asset-manifest.json"))
    except ConfigError as exc:
        print(f"[check_chunks] ERROR: {exc}", file=sys.stderr, flush=True)
        return tc.EXIT_CONFIG

    with tempfile.TemporaryDirectory(prefix="check_chunks_") as tmp:
        tmp_dir = Path(tmp)

        def check(item):
            n, (label, data, expected) = item
            if not pack.is_avif(data):
                return label, pack.slice_problems(data, None, expected)
            result, strict = probe(ffprobe, ffmpeg, data, tmp_dir, f"slice-{n}")
            return label, pack.slice_problems(data, result, expected, strict)

        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            for label, problems in pool.map(check, enumerate(jobs)):
                failures.extend(f"{label}: {problem}" for problem in problems)

    for variant, n in counts.items():
        log(f"{variant}: {n} frame slice(s) checked")
    if not jobs and not failures:
        failures.append("no frame slices to check (empty shots, aspects or tiers)")
    if failures:
        print(f"[check_chunks] FAILED: {len(failures)} problem(s):", file=sys.stderr, flush=True)
        for f in failures:
            print(f"    {f}", file=sys.stderr, flush=True)
        return tc.EXIT_RENDER_FAILED
    log(f"OK: {len(jobs)} frame slices decoded as AV1 at the expected size ({os.path.abspath(root)})")
    return tc.EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
