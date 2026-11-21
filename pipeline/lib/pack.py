"""Pure encode/pack helpers for Story 0.3 (no ``bpy``; plain Python 3.12).

Used by ``encode_pack.py`` and ``check_chunks.py``; unit-tested in
``pipeline/tests/test_pack.py``.

- pinned encoder (ffmpeg 9.1, libaom-av1) resolution and version checks;
- AVIF encode settings and the exact ffmpeg command line;
- AVIF container sniffing (``ftyp`` brand);
- chunk packing into bytes, per-act frame data and the v1 asset manifest
  (shape enforced by ``spike/manifest/manifest-schema.ts``);
- ffprobe output parsing for the chunk check;
- media request math for the ≤ 150 requests/watch budget.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence

from . import shot

FFMPEG_VERSION = "9.1"  # must match the `ffmpeg` tools entry in licenses/assets.yaml
FFMPEG_WINGET_INSTALL = "winget install --id Gyan.FFmpeg --exact --version 9.1"
WINGET_LINKS = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "Microsoft" / "WinGet" / "Links"

REQUEST_BUDGET = 150  # media requests per full watch (NFR3, an assumption to validate)


class ToolError(RuntimeError):
    """Encoder/prober missing, wrong version or lacking an encoder."""


# ------------------------------------------------------------ Tool lookup


def resolve_tool(
    name: str,
    explicit: str | None = None,
    which: Callable[[str], str | None] | None = None,
    links_dir: Path | None = WINGET_LINKS,
    exists: Callable[[Path], bool] = lambda p: p.is_file(),
) -> str:
    """Find ``name`` (``ffmpeg``/``ffprobe``): explicit path, then PATH, then the winget Links folder.

    An explicit path that is not a file raises ``ToolError`` (no silent
    fallback). Otherwise raises ``ToolError`` listing every location tried.
    """
    import shutil

    which = which or shutil.which
    if explicit:
        p = Path(explicit)
        if exists(p):
            return str(p)
        raise ToolError(f"--{name} {explicit} is not a file")
    tried = []
    found = which(name)
    if found:
        return found
    tried.append(f"{name} on PATH (not found)")
    if links_dir is not None:
        for candidate in (links_dir / f"{name}.exe", links_dir / name):
            if exists(candidate):
                return str(candidate)
        tried.append(f"{links_dir / (name + '.exe')} (not found)")
    raise ToolError(f"{name} not found; tried: " + "; ".join(tried) + f". Install with: {FFMPEG_WINGET_INSTALL}")


def sibling_tool(tool_path: str, name: str) -> str | None:
    """``ffprobe`` next to a resolved ``ffmpeg`` (same folder, same extension), if present."""
    p = Path(tool_path)
    candidate = p.with_name(name + p.suffix)
    return str(candidate) if candidate.is_file() else None


_VERSION_RE = re.compile(r"^(?:ffmpeg|ffprobe) version n?(\d+(?:\.\d+)*)")


def parse_ffmpeg_version(text: str) -> str | None:
    """``9.1`` from ``ffmpeg version 9.1-full_build-www.gyan.dev Copyright ...``."""
    first = text.strip().splitlines()[0] if text.strip() else ""
    m = _VERSION_RE.match(first)
    return m.group(1) if m else None


def has_encoder(encoders_text: str, encoder: str) -> bool:
    """Whether ``ffmpeg -encoders`` (or ``-decoders``) output lists ``encoder``."""
    return any(line.split()[1:2] == [encoder] for line in encoders_text.splitlines() if line.strip())


has_decoder = has_encoder  # same `-decoders` line layout: " V....D libaom-av1  ..."


# ------------------------------------------------------------- Encoding


@dataclass(frozen=True)
class EncodeSettings:
    """AVIF still encode via ffmpeg + libaom-av1.

    crf 18 was chosen so the clock numerals (low-contrast detail in a dark
    area, the subject of ii-03-clock) survive; crf >= 24 erased them. 8-bit
    4:2:0 keeps phone decode cheap. Grain/noise synthesis is explicitly off
    (Safari cannot decode AV1 film grain).
    """

    codec: str = "libaom-av1"
    crf: int = 18
    cpu_used: int = 4
    pix_fmt: str = "yuv420p"
    color_matrix: str = "bt709"
    color_primaries: str = "bt709"
    color_trc: str = "iec61966-2-1"  # sRGB transfer
    color_range: str = "pc"  # full range
    still_picture: bool = True
    denoise_noise_level: int = 0  # 0 = no noise estimation -> no film grain synthesis
    aom_params: str = "film-grain-test=0"  # no synthetic film grain table
    downscale_flags: str = "lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
    threads: int = 4

    def as_dict(self) -> dict:
        return asdict(self)

    @property
    def chroma(self) -> str:
        return {"yuv420p": "4:2:0", "yuv422p": "4:2:2", "yuv444p": "4:4:4"}.get(self.pix_fmt.removesuffix("10le"), self.pix_fmt)


def video_filter(settings: EncodeSettings, scale_to: tuple[int, int] | None = None) -> str:
    parts = []
    if scale_to is not None:
        parts.append(f"scale={scale_to[0]}:{scale_to[1]}:flags={settings.downscale_flags}")
    range_name = "full" if settings.color_range == "pc" else "limited"
    parts.append(f"scale=out_color_matrix={settings.color_matrix}:out_range={range_name}")
    parts.append(f"format={settings.pix_fmt}")
    return ",".join(parts)


def encode_command(
    ffmpeg: str,
    src: str | Path,
    dst: str | Path,
    settings: EncodeSettings,
    scale_to: tuple[int, int] | None = None,
) -> list[str]:
    """ffmpeg command encoding one PNG to one still AVIF (overwrites ``dst``)."""
    return [
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(src),
        "-vf", video_filter(settings, scale_to),
        "-frames:v", "1",
        "-c:v", settings.codec,
        "-still-picture", "1" if settings.still_picture else "0",
        "-crf", str(settings.crf), "-b:v", "0",
        "-cpu-used", str(settings.cpu_used),
        "-denoise-noise-level", str(settings.denoise_noise_level),
        "-aom-params", settings.aom_params,
        "-color_primaries", settings.color_primaries,
        "-color_trc", settings.color_trc,
        "-colorspace", settings.color_matrix,
        "-color_range", settings.color_range,
        "-threads", str(settings.threads),
        "-f", "avif", str(dst),
    ]


def is_avif(data: bytes) -> bool:
    """True if ``data`` starts with an ISO-BMFF ``ftyp`` box naming the ``avif`` brand."""
    if len(data) < 16 or data[4:8] != b"ftyp":
        return False
    size = int.from_bytes(data[0:4], "big")
    if size < 16 or size > len(data):
        return False
    brands = [data[8:12]] + [data[i:i + 4] for i in range(16, size, 4)]
    return b"avif" in brands


# ---------------------------------------------------------------- Packing


def pack_chunks(frames: Sequence[bytes], chunk_frames: int = shot.DEFAULT_CHUNK_FRAMES) -> tuple[list[shot.FrameSlot], list[bytes]]:
    """Concatenate encoded frames into chunk payloads; returns ``(slots, chunk bytes)``."""
    slots = shot.plan_chunks([len(f) for f in frames], chunk_frames)
    chunks: list[bytearray] = [bytearray() for _ in range(shot.chunk_count(len(frames), chunk_frames))]
    for s, data in zip(slots, frames):
        if len(chunks[s.chunk]) != s.offset:
            raise shot.ShotError(f"frame {s.frame}: chunk {s.chunk} has {len(chunks[s.chunk])} B, plan offset {s.offset}")
        chunks[s.chunk] += data
    return slots, [bytes(c) for c in chunks]


def build_frame_data(
    media_version: str,
    act: str,
    aspect: str,
    shot_id: str,
    quads: Sequence,
    slots_by_tier: Mapping[str, Sequence[shot.FrameSlot]],
) -> dict:
    """Per-act frame data (``frames/<act>.<aspect>.json``) for one shot."""
    shot.check_segment(aspect)
    frame_count = len(quads)
    for tier, slots in slots_by_tier.items():
        shot.check_segment(aspect, tier)
        if len(slots) != frame_count:
            raise shot.ShotError(f"{aspect}/{tier}: {len(slots)} slots for {frame_count} quads")
    frames = []
    for i in range(frame_count):
        frames.append({
            "index": i,
            "quad": quads[i],
            "slices": [
                {"tier": tier, "chunk": slots[i].chunk, "offset": slots[i].offset, "length": slots[i].length}
                for tier, slots in slots_by_tier.items()
            ],
        })
    return {
        "schemaVersion": 1,
        "mediaVersion": media_version,
        "act": act,
        "aspect": aspect,
        "shots": [{"id": shot_id, "frameCount": frame_count, "frames": frames}],
    }


def build_manifest(
    media_version: str,
    shot_id: str,
    act: str,
    frame_count: int,
    authoring_fps: int,
    chunk_frames: int,
    chunk_bytes: Mapping[str, Mapping[str, Sequence[int]]],
) -> dict:
    """v1 ``asset-manifest.json``; ``chunk_bytes[aspect][tier]`` = byte size of each chunk."""
    aspects = []
    for aspect, tiers in chunk_bytes.items():
        entries = []
        for tier, sizes in tiers.items():
            width, height = shot.tier_size(aspect, tier)
            entries.append({
                "tier": tier, "width": width, "height": height,
                "totalBytes": int(sum(sizes)), "chunkBytes": [int(s) for s in sizes],
            })
        aspects.append({"aspect": aspect, "frameCount": frame_count, "tiers": entries})
    return {
        "schemaVersion": 1,
        "mediaVersion": media_version,
        "shots": [{
            "id": shot_id,
            "act": act,
            "frameCount": frame_count,
            "authoringFps": authoring_fps,
            "chunkSize": chunk_frames,
            "chunkCount": shot.chunk_count(frame_count, chunk_frames),
            "urlPattern": shot.URL_PATTERN,
            "aspects": aspects,
        }],
    }


def json_bytes(data) -> bytes:
    """Deterministic JSON file content (identical input -> identical bytes)."""
    return (json.dumps(data, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


# ------------------------------------------------------------ Chunk check


@dataclass
class ProbeResult:
    codec: str | None
    width: int | None
    height: int | None
    decoded_frames: int | None
    error: str | None = None


def probe_command(ffprobe: str, path: str | Path) -> list[str]:
    """ffprobe decoding every frame (``-count_frames``) and reporting codec and size as JSON."""
    return [str(ffprobe), "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", str(path)]


def strict_decode_command(ffmpeg: str, path: str | Path) -> list[str]:
    """Decode with the libaom AV1 decoder, which reports corrupt tile data.

    ffmpeg's default AV1 decoder (dav1d) conceals bitstream damage and still
    exits 0, so a corrupted payload with an intact header would pass ffprobe.
    """
    return [str(ffmpeg), "-hide_banner", "-v", "error", "-nostdin", "-c:v", "libaom-av1", "-xerror",
            "-err_detect", "explode", "-i", str(path), "-f", "null", "-"]


def parse_probe(stdout: str, stderr: str = "", returncode: int = 0) -> ProbeResult:
    try:
        streams = json.loads(stdout or "{}").get("streams") or []
    except ValueError:
        streams = []
    if not streams:
        return ProbeResult(None, None, None, None, (stderr.strip() or f"ffprobe exit {returncode}, no video stream"))
    s = streams[0]

    def num(key):
        try:
            return int(s.get(key))
        except (TypeError, ValueError):
            return None

    err = stderr.strip() or (f"ffprobe exit {returncode}" if returncode else None)
    return ProbeResult(s.get("codec_name"), num("width"), num("height"), num("nb_read_frames"), err)


def slice_problems(
    data: bytes,
    probe: ProbeResult | None,
    expected: tuple[int, int],
    strict: tuple[int, str] | None = None,
) -> list[str]:
    """Readable problems with one re-sliced frame (empty = OK).

    ``strict`` is ``(returncode, stderr)`` of :func:`strict_decode_command`.
    """
    problems = []
    if not is_avif(data):
        problems.append("slice is not an AVIF file (no ftyp/avif brand at its offset)")
    if strict is not None and (strict[0] != 0 or strict[1].strip()):
        detail = " ".join(strict[1].split())[:200] or f"exit {strict[0]}"
        problems.append(f"strict libaom decode failed (corrupt bitstream): {detail}")
    if probe is None:
        return problems
    if probe.error:
        problems.append(f"ffprobe: {probe.error}")
    if probe.codec != "av1":
        problems.append(f"codec {probe.codec!r}, expected 'av1'")
    if (probe.width, probe.height) != tuple(expected):
        problems.append(f"size {probe.width}x{probe.height}, expected {expected[0]}x{expected[1]}")
    if probe.decoded_frames != 1:
        problems.append(f"decoded {probe.decoded_frames} frame(s), expected 1")
    return problems


# ----------------------------------------------------------- Request math


def shot_requests(frame_count: int, chunk_frames: int, frame_data_files: int = 1, manifest: int = 1) -> int:
    """Media requests to watch one shot in one aspect/tier: manifest + frame data + chunks."""
    return manifest + frame_data_files + shot.chunk_count(frame_count, chunk_frames)


def film_chunk_requests(total_frames: int, chunk_frames: int, groups: int) -> int:
    """Upper bound on chunk requests when ``total_frames`` are chunked separately per
    group (per act, or per shot): ``sum(ceil(f_i/N)) <= ceil(total/N) + groups - 1``."""
    if groups < 1:
        raise ValueError("groups must be >= 1")
    return math.ceil(total_frames / chunk_frames) + groups - 1


def film_requests(total_frames: int, chunk_frames: int, groups: int, fixed: int) -> int:
    """Chunk requests (upper bound) plus ``fixed`` other requests (frame data, plates, audio...)."""
    return film_chunk_requests(total_frames, chunk_frames, groups) + fixed


def min_chunk_size(total_frames: int, groups: int, fixed: int, budget: int = REQUEST_BUDGET) -> int | None:
    """Smallest N with ``film_requests(...) <= budget``; ``None`` if even one chunk per group is too many."""
    if groups + fixed > budget:
        return None
    lo, hi = 1, max(1, total_frames)
    while lo < hi:
        mid = (lo + hi) // 2
        if film_requests(total_frames, mid, groups, fixed) <= budget:
            hi = mid
        else:
            lo = mid + 1
    return lo
