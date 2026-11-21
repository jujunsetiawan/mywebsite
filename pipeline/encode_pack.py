"""Encode the rendered ii-03-clock frames to AVIF, pack chunks, write frame data
and the v1 asset manifest (Story 0.3). Plain Python, no Blender.

Usage (from the repository root):

    python pipeline/encode_pack.py [--chunk-size 16] [--jobs 4] [--crf 18] [--cpu-used 4]
        [--ffmpeg <path>] [--force] [--encode-only] [--allow-version-mismatch]

Inputs:  pipeline/out/shots/ii-03-clock/<aspect>/frame-NNNN.png + quads.json (render_shot.py)
Work:    pipeline/out/work/<mediaVersion>/avif/<settings-fingerprint>/<aspect>/<tier>/frame-NNNN.avif
         (resumable cache; outside the published directory) and encode-report.json
Output:  pipeline/out/<mediaVersion>/
             asset-manifest.json
             frames/II.16x9.json, frames/II.9x16.json
             ii-03-clock/<aspect>/<tier>/chunk-NNNN.bin

Variants: 16x9/1080 from the 1920x1080 PNGs, 16x9/720 downscaled from them
(Lanczos), 9x16/720 from the 720x1280 PNGs.

Encoder: ffmpeg 9.1 (pinned) + libaom-av1, still-picture AVIF, grain/noise
synthesis off. ffmpeg is found via --ffmpeg, then PATH, then the winget Links
folder; ffprobe next to it (or by the same search).

Immutability: if pipeline/out/<mediaVersion>/ already holds different content,
the script refuses (exit 7) unless --force. An identical re-run succeeds.

Exit codes: 0 ok, 1 usage / missing or invalid inputs, 3 ffmpeg version
mismatch, 4 encode failed, 5 encoder missing or lacks libaom-av1,
7 published mediaVersion would change.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NoReturn

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import pack  # noqa: E402
from lib import shot  # noqa: E402
from lib import toolchain as tc  # noqa: E402

PROG = "encode_pack.py"
REPO_ROOT = PIPELINE_DIR.parent
DEFAULT_OUT = REPO_ROOT / "pipeline" / "out"

# (aspect, tier, source aspect folder, downscale target or None)
VARIANTS = (
    ("16x9", "1080", "16x9", None),
    ("16x9", "720", "16x9", shot.tier_size("16x9", "720")),
    ("9x16", "720", "9x16", None),
)


def log(message: str) -> None:
    print(f"[encode_pack] {message}", flush=True)


def fail(code: int, message: str) -> NoReturn:
    print(f"[encode_pack] ERROR: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = tc._ArgumentParser(prog=PROG, description="Encode + pack ii-03-clock into AVIF chunks with a v1 manifest.")
    p.add_argument("--shots-dir", default=str(DEFAULT_OUT / "shots"), help="render_shot.py output root (default %(default)s)")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="output root; writes <out>/<mediaVersion>/ (default %(default)s)")
    p.add_argument("--work", default=str(DEFAULT_OUT / "work"), help="intermediate AVIF cache root (default %(default)s)")
    p.add_argument("--media-version", default=shot.MEDIA_VERSION, help="default %(default)s")
    p.add_argument("--chunk-size", type=int, default=shot.DEFAULT_CHUNK_FRAMES, help="frames per chunk N (default %(default)s)")
    p.add_argument("--crf", type=int, default=pack.EncodeSettings.crf, help="libaom crf (default %(default)s)")
    p.add_argument("--cpu-used", type=int, default=pack.EncodeSettings.cpu_used, help="libaom speed (default %(default)s)")
    p.add_argument("--jobs", type=int, default=4, help="parallel ffmpeg processes (default %(default)s)")
    p.add_argument("--ffmpeg", default=None, help="path to ffmpeg(.exe); overrides PATH / winget Links lookup")
    p.add_argument("--ffprobe", default=None, help="path to ffprobe(.exe); default: next to ffmpeg")
    p.add_argument("--force", action="store_true", help="overwrite a published mediaVersion whose content differs")
    p.add_argument("--encode-only", action="store_true", help="fill the AVIF cache, do not pack or publish")
    p.add_argument("--allow-version-mismatch", action="store_true", help="accept an ffmpeg other than " + pack.FFMPEG_VERSION)
    args = p.parse_args(argv)
    if args.chunk_size < 1 or args.jobs < 1 or not 0 <= args.crf <= 63 or not 0 <= args.cpu_used <= 9:
        p.error("--chunk-size and --jobs must be >= 1, --crf 0..63, --cpu-used 0..9")
    return args


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def check_encoder(ffmpeg: str, allow_mismatch: bool) -> str:
    try:
        version_out = run([ffmpeg, "-hide_banner", "-version"]).stdout
        encoders_out = run([ffmpeg, "-hide_banner", "-encoders"]).stdout
    except OSError as exc:
        fail(tc.EXIT_CONFIG, f"cannot run {ffmpeg}: {exc}")
    version = pack.parse_ffmpeg_version(version_out)
    log(f"ffmpeg: {ffmpeg} (version {version})")
    if version != pack.FFMPEG_VERSION:
        message = f"ffmpeg {version} does not match pinned {pack.FFMPEG_VERSION} ({pack.FFMPEG_WINGET_INSTALL})"
        if not allow_mismatch:
            fail(tc.EXIT_VERSION_MISMATCH, message + "; pass --allow-version-mismatch to continue")
        print(f"[encode_pack] WARNING: {message}", file=sys.stderr, flush=True)
    if not pack.has_encoder(encoders_out, "libaom-av1"):
        fail(tc.EXIT_CONFIG, f"{ffmpeg} has no libaom-av1 encoder")
    return version or "unknown"


def load_render(shots_dir: Path, aspect: str) -> dict:
    """quads.json of one aspect, after checking all frames exist at the render size."""
    folder = shots_dir / shot.SHOT_ID / aspect
    try:
        data = json.loads((folder / "quads.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(tc.EXIT_USAGE, f"cannot read {folder / 'quads.json'} (run render_shot.py first): {exc}")
    quads = data.get("quads")
    if data.get("frameCount") != shot.FRAME_COUNT or not isinstance(quads, list) or len(quads) != shot.FRAME_COUNT:
        fail(tc.EXIT_USAGE, f"{folder / 'quads.json'}: expected {shot.FRAME_COUNT} quads")
    missing = shot.frames_to_render(range(shot.FRAME_COUNT), folder, shot.RENDER_SIZES[aspect])
    if missing:
        fail(tc.EXIT_USAGE, f"{aspect}: {len(missing)} frame(s) missing or invalid in {folder}: {missing[:10]}")
    return {"folder": folder, "quads": quads, "fingerprint": data.get("fingerprint")}


def encode_variant(ffmpeg: str, settings: pack.EncodeSettings, src_dir: Path, dst_dir: Path,
                   scale_to, jobs: int) -> tuple[list[bytes], float, int]:
    """Encode missing frames of one variant (atomic per frame); return (frame bytes, seconds, encoded count)."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    targets = [(i, src_dir / shot.frame_filename(i), dst_dir / f"frame-{i:04d}.avif") for i in range(shot.FRAME_COUNT)]
    todo = [t for t in targets if not (t[2].is_file() and pack.is_avif(t[2].read_bytes()[:64]))]

    def one(item):
        index, src, dst = item
        tmp = dst.with_name(f".{dst.stem}.tmp.avif")
        result = run(pack.encode_command(ffmpeg, src, tmp, settings, scale_to))
        if result.returncode != 0 or not tmp.is_file() or not pack.is_avif(tmp.read_bytes()[:64]):
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"frame {index}: ffmpeg exit {result.returncode}: {result.stderr.strip()[-400:]}")
        os.replace(tmp, dst)

    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for future in [pool.submit(one, t) for t in todo]:
            future.result()
    elapsed = time.perf_counter() - start
    return [t[2].read_bytes() for t in targets], elapsed, len(todo)


write_atomic = shot.write_atomic


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        ffmpeg = pack.resolve_tool("ffmpeg", args.ffmpeg)
        ffprobe = args.ffprobe or pack.sibling_tool(ffmpeg, "ffprobe") or pack.resolve_tool("ffprobe")
    except pack.ToolError as exc:
        fail(tc.EXIT_CONFIG, str(exc))
    version = check_encoder(ffmpeg, args.allow_version_mismatch)
    settings = pack.EncodeSettings(crf=args.crf, cpu_used=args.cpu_used)
    log(f"Settings: {settings.codec} crf {settings.crf}, cpu-used {settings.cpu_used}, {settings.pix_fmt} "
        f"({settings.chroma}), still-picture, denoise-noise-level 0, {settings.aom_params}")

    shots_dir = Path(args.shots_dir)
    renders = {aspect: load_render(shots_dir, aspect) for aspect in shot.ASPECTS}
    work_root = Path(args.work) / args.media_version

    frames: dict[tuple[str, str], list[bytes]] = {}
    report_variants = {}
    for aspect, tier, src_aspect, scale_to in VARIANTS:
        render = renders[src_aspect]
        enc_fp = shot.fingerprint({"settings": settings.as_dict(), "ffmpeg": version,
                                   "render": render["fingerprint"], "aspect": aspect, "tier": tier})
        dst = work_root / "avif" / enc_fp / aspect / tier
        try:
            data, seconds, encoded = encode_variant(ffmpeg, settings, render["folder"], dst, scale_to, args.jobs)
        except RuntimeError as exc:
            fail(tc.EXIT_RENDER_FAILED, f"{aspect}/{tier}: {exc}")
        sizes = [len(d) for d in data]
        frames[(aspect, tier)] = data
        report_variants[f"{aspect}/{tier}"] = {
            "cache": str(dst), "encoded": encoded, "encodeSeconds": round(seconds, 1),
            "totalBytes": sum(sizes), "avgBytesPerFrame": round(sum(sizes) / len(sizes)),
            "minBytes": min(sizes), "maxBytes": max(sizes),
        }
        log(f"{aspect}/{tier}: {encoded} encoded in {seconds:.1f} s, {len(data) - encoded} cached; "
            f"{sum(sizes):,} B total, avg {sum(sizes) // len(sizes):,} B/frame")
    if args.encode_only:
        log("--encode-only: cache filled, nothing published")
        return tc.EXIT_OK

    # ------------------------------------------------------------ pack + publish
    planned: dict[str, bytes] = {}
    chunk_bytes: dict[str, dict[str, list[int]]] = {}
    slots: dict[str, dict[str, list[shot.FrameSlot]]] = {}
    for (aspect, tier), data in frames.items():
        tier_slots, chunks = pack.pack_chunks(data, args.chunk_size)
        slots.setdefault(aspect, {})[tier] = tier_slots
        chunk_bytes.setdefault(aspect, {})[tier] = [len(c) for c in chunks]
        for index, payload in enumerate(chunks):
            rel = shot.chunk_relpath(args.media_version, shot.SHOT_ID, aspect, tier, index)
            planned[rel.split("/", 1)[1]] = payload  # relative to the mediaVersion directory
    for aspect in shot.ASPECTS:
        fd = pack.build_frame_data(args.media_version, shot.ACT, aspect, shot.SHOT_ID,
                                   renders[aspect]["quads"], slots[aspect])
        planned[shot.frame_data_relpath(shot.ACT, aspect)] = pack.json_bytes(fd)
    manifest = pack.build_manifest(args.media_version, shot.SHOT_ID, shot.ACT, shot.FRAME_COUNT,
                                   shot.AUTHORING_FPS, args.chunk_size, chunk_bytes)
    planned["asset-manifest.json"] = pack.json_bytes(manifest)

    version_dir = Path(args.out) / args.media_version
    try:
        result = shot.publish(version_dir, planned, force=args.force)
    except shot.ImmutableVersionError as exc:
        fail(tc.EXIT_IMMUTABLE, str(exc))
    if result["differences"]:
        log(f"--force: overwrote {len(result['differences'])} differing file(s) in {version_dir}")
    log(f"Published {version_dir}: {len(planned)} file(s), {result['written']} written, "
        f"{result['unchanged']} unchanged")

    # ------------------------------------------------------------ report
    n_chunks = shot.chunk_count(shot.FRAME_COUNT, args.chunk_size)
    report = {
        "mediaVersion": args.media_version,
        "ffmpeg": {"path": ffmpeg, "ffprobe": ffprobe, "version": version},
        "settings": settings.as_dict(),
        "chunkSize": args.chunk_size,
        "chunkCount": n_chunks,
        "variants": report_variants,
        "shotRequestsPerAspectTier": pack.shot_requests(shot.FRAME_COUNT, args.chunk_size),
        "manifestBytes": len(planned["asset-manifest.json"]),
        "frameDataBytes": {a: len(planned[shot.frame_data_relpath(shot.ACT, a)]) for a in shot.ASPECTS},
    }
    report["publishedTo"] = str(version_dir.resolve())
    # One report per published directory, so a run into another --out never overwrites it.
    report_file = work_root / f"encode-report.{shot.fingerprint({'out': str(version_dir.resolve())})[:8]}.json"
    if version_dir.resolve() == (DEFAULT_OUT / args.media_version).resolve():
        report_file = work_root / "encode-report.json"
    write_atomic(report_file, pack.json_bytes(report))
    log(f"Report: {report_file}")
    log(f"Requests for this shot per aspect/tier at N={args.chunk_size}: {report['shotRequestsPerAspectTier']} "
        f"(1 manifest + 1 frame data + {n_chunks} chunks)")
    return tc.EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
