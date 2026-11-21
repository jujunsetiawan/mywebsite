"""Download the CC0 assets of the Act II scene into the asset library.

Plain Python 3 (no Blender needed), run from the repository root:

    $env:JFILM_LIBRARY = "C:\\Users\\Jun\\jfilm-library"
    python pipeline/fetch_assets.py [--only <id> ...] [--dry-run]
    python pipeline/fetch_assets.py --check

Files land in ``$JFILM_LIBRARY/<source>/<asset id>/`` (outside git). Every
fetched asset is written to (or refreshed in) ``licenses/assets.yaml`` with
id, source, licence, proof, path, purpose and used-in, so the licence gate in
``style_frame.py`` accepts files under that folder. Downloads are verified
(md5 from Poly Haven, byte size from ambientCG) and skipped when already
present. ``--check`` only compares the licence record with the library on
disk (missing folders, unlisted folders) and changes nothing.

Only sources with a public CC0 licence page are allowed (``SOURCES``).

Exit codes: 0 ok, 1 usage / JFILM_LIBRARY unset, 4 download failed,
5 licence record unreadable, 6 record and library disagree (``--check``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import licence_gate as lg  # noqa: E402
from lib import toolchain as tc  # noqa: E402

USER_AGENT = "jfilm-pipeline/0.2 (portfolio film asset fetch)"
POLYHAVEN_API = "https://api.polyhaven.com"
AMBIENTCG_API = "https://ambientcg.com/api/v2/full_json"
SCENE_USE = "pipeline/out/scenes/act2_desk_0307.blend (story 0.2 style frame)"

# Allowed sources: every asset is CC0 and the proof URL states it.
SOURCES = {
    "polyhaven": {"licence": "CC0-1.0", "proof": "https://polyhaven.com/license",
                  "page": "https://polyhaven.com/a/{id}"},
    "ambientcg": {"licence": "CC0-1.0", "proof": "https://ambientcg.com/license",
                  "page": "https://ambientcg.com/a/{id}"},
}


@dataclass(frozen=True)
class Asset:
    source: str      # key of SOURCES
    asset_id: str    # id at the source
    kind: str        # "blend" (Poly Haven model/texture .blend) | "hdri" | "material" (ambientCG zip)
    resolution: str  # "1k"/"2k" (Poly Haven) or "1K-JPG"/"2K-JPG" (ambientCG)
    purpose: str     # role in the Act II scene
    used_in: tuple[str, ...] | None = None  # None = the Act II scene (SCENE_USE)

    @property
    def entry_id(self) -> str:
        return f"{self.source}-{self.asset_id}"

    @property
    def rel_path(self) -> str:
        return f"{self.source}/{self.asset_id}"


# What the Act II scene build plausibly needs. Everything else (monitor,
# keyboard, mouse, mug, chair, partitions, curtain wall, Fuji, skyline massing,
# rain, sticky note) is modelled procedurally -- see the spec's CC0 gaps.
CATALOGUE = [
    Asset("polyhaven", "metal_office_desk", "blend", "2k", "hero desk and colleague desks"),
    Asset("polyhaven", "wall_clock", "blend", "2k", "wall clock set to 03:07"),
    Asset("polyhaven", "desk_lamp_arm_01", "blend", "1k", "hero desk lamp (switched off)"),
    Asset("polyhaven", "office_notepads", "blend", "1k", "desk clutter (notepads)"),
    Asset("polyhaven", "binder_notebook", "blend", "1k", "desk clutter (binder)"),
    Asset("polyhaven", "stationery_supplies", "blend", "1k", "desk clutter (stationery)"),
    Asset("polyhaven", "potted_plant_04", "blend", "1k", "colleague desk personal prop"),
    Asset("polyhaven", "potted_plant_02", "blend", "1k", "floor plant"),
    Asset("polyhaven", "drawer_cabinet", "blend", "1k", "background furniture"),
    Asset("polyhaven", "dirty_carpet", "blend", "2k", "office floor carpet material"),
    Asset("polyhaven", "ceiling_interior", "blend", "1k", "ceiling material"),
    Asset("polyhaven", "painted_plaster_wall", "blend", "1k", "wall material"),
    # Fetched and evaluated, then rejected (moon + stars); kept so the record stays true.
    Asset("polyhaven", "kloppenheim_07_puresky", "hdri", "2k",
          "candidate overcast night sky; evaluated 2026-11-20 and REJECTED for act2_desk_0307: "
          "moon behind thin cloud (peak luminance 14.8) and visible stars",
          ("none -- not referenced by any scene (act2_desk_0307 uses a procedural overcast sky instead)",)),
    Asset("ambientcg", "Facade009", "material", "1K-JPG", "night city facades with lit windows"),
    Asset("ambientcg", "Facade005", "material", "1K-JPG", "glass office-tower facades (city variety)"),
    Asset("ambientcg", "Wood094", "material", "1K-JPG", "desk-top wood (tint toward walnut #3A2A1C)"),
]


def log(message: str) -> None:
    print(f"[fetch_assets] {message}", flush=True)


def fail(code: int, message: str):
    print(f"[fetch_assets] ERROR: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def _get_json(url: str):
    return json.loads(_get(url))


def _md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_atomic(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def _download(url: str, dest: Path, md5: str | None = None, size: int | None = None) -> bool:
    """Download ``url`` to ``dest`` unless a verified copy exists. Returns True if fetched."""
    if dest.is_file() and (md5 is None or _md5(dest) == md5) and (
        size is None or dest.stat().st_size == size
    ):
        return False
    data = _get(url)
    if md5 is not None and hashlib.md5(data).hexdigest() != md5:
        raise IOError(f"md5 mismatch for {url}")
    if size is not None and len(data) != size:
        raise IOError(f"size mismatch for {url}: got {len(data)}, expected {size}")
    _write_atomic(dest, data)
    return True


def safe_member_path(target: Path, member: str) -> Path:
    """Resolve a zip/include member below ``target``; reject traversal."""
    parts = PurePosixPath(member.replace("\\", "/")).parts
    if not parts or any(p in ("..", "", "/") or ":" in p for p in parts) or member.startswith("/"):
        raise IOError(f"unsafe member path {member!r}")
    path = target.joinpath(*parts)
    root = target.resolve()
    if not path.resolve().is_relative_to(root) or path.resolve() == root:
        raise IOError(f"unsafe member path {member!r}")
    return path


def fetch_polyhaven(asset: Asset, target: Path, dry_run: bool) -> int:
    files = _get_json(f"{POLYHAVEN_API}/files/{asset.asset_id}")
    if asset.kind == "hdri":
        meta = files["hdri"][asset.resolution]["hdr"]
        jobs = [(meta["url"], target / Path(urllib.parse.urlparse(meta["url"]).path).name, meta.get("md5"))]
    else:
        blend = files["blend"][asset.resolution]["blend"]
        jobs = [(blend["url"], target / Path(urllib.parse.urlparse(blend["url"]).path).name, blend.get("md5"))]
        for rel, meta in blend.get("include", {}).items():
            jobs.append((meta["url"], safe_member_path(target, rel), meta.get("md5")))
    if dry_run:
        for url, _, _ in jobs:
            log(f"  would fetch {url}")
        return 0
    fetched = sum(_download(url, dest, md5) for url, dest, md5 in jobs)
    info = _get_json(f"{POLYHAVEN_API}/info/{asset.asset_id}")
    (target / "polyhaven_info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    log(f"{asset.entry_id}: {len(jobs)} file(s), {fetched} downloaded, "
        f"authors {', '.join(info.get('authors', {}))}")
    return fetched


def fetch_ambientcg(asset: Asset, target: Path, dry_run: bool) -> int:
    query = urllib.parse.urlencode({"type": "Material", "id": asset.asset_id, "include": "downloadData"})
    found = _get_json(f"{AMBIENTCG_API}?{query}").get("foundAssets", [])
    record = next((a for a in found if a.get("assetId") == asset.asset_id), None)
    if record is None:
        raise IOError(f"ambientCG has no material {asset.asset_id!r}")
    downloads = record["downloadFolders"]["default"]["downloadFiletypeCategories"]["zip"]["downloads"]
    meta = next((d for d in downloads if d.get("attribute") == asset.resolution), None)
    if meta is None:
        raise IOError(f"{asset.asset_id}: no {asset.resolution} zip")
    if dry_run:
        log(f"  would fetch {meta['downloadLink']}")
        return 0
    marker = target / "ambientcg_info.json"
    if marker.is_file():
        previous = json.loads(marker.read_text(encoding="utf-8"))
        if previous.get("zip") == meta["fileName"] and previous.get("size") == meta["size"]:
            log(f"{asset.entry_id}: already extracted")
            return 0
    zip_path = target / meta["fileName"]
    _download(meta["downloadLink"], zip_path, size=int(meta["size"]))
    extracted = 0
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            dest = safe_member_path(target, member.filename)
            _write_atomic(dest, archive.read(member))
            extracted += 1
    zip_path.unlink()
    marker.write_text(json.dumps({"zip": meta["fileName"], "size": meta["size"],
                                  "url": meta["downloadLink"], "page": record.get("shortLink")},
                                 indent=2), encoding="utf-8")
    log(f"{asset.entry_id}: {extracted} file(s) extracted from {meta['fileName']}")
    return extracted


def entry_for(asset: Asset) -> dict:
    source = SOURCES[asset.source]
    return {
        "id": asset.entry_id,
        "source": source["page"].format(id=asset.asset_id),
        "licence": source["licence"],
        "proof": source["proof"],
        "path": asset.rel_path,
        "purpose": asset.purpose,
        "used-in": list(asset.used_in) if asset.used_in else [SCENE_USE],
    }


def merge_entries(existing: list[dict], fetched: list[dict]) -> list[dict]:
    """Insert or refresh ``fetched`` entries by id; keep every other entry and its used-in."""
    merged = [dict(e) for e in existing]
    index = {e.get("id"): i for i, e in enumerate(merged)}
    for entry in fetched:
        if entry["id"] in index:
            old = merged[index[entry["id"]]]
            used = list(old.get("used-in") or [])
            used += [u for u in entry["used-in"] if u not in used]
            merged[index[entry["id"]]] = {**old, **entry, "used-in": used}
        else:
            index[entry["id"]] = len(merged)
            merged.append(entry)
    return merged


def check_library(entries: list[dict], root: Path) -> int:
    problems = lg.validate_entries(entries)
    missing, orphans = lg.library_consistency(entries, root)
    problems += [f"{i}: listed in licenses/assets.yaml but absent from {root}" for i in missing]
    problems += [f"{o}: present in {root} but not listed in licenses/assets.yaml" for o in orphans]
    for problem in problems:
        log(f"MISMATCH {problem}")
    log(f"{len(entries)} entries, {len(problems)} problem(s)")
    return tc.EXIT_LICENCE if problems else tc.EXIT_OK


def check_selected(entries: list[dict], root: Path, ids: set[str]) -> int:
    """Post-fetch check for ``--only``: validate and look for the selected entries only."""
    chosen = [e for e in entries if e.get("id") in ids]
    problems = lg.validate_entries(chosen)
    missing, _ = lg.library_consistency(chosen, root)
    problems += [f"{i}: listed in licenses/assets.yaml but absent from {root}" for i in missing]
    for problem in problems:
        log(f"MISMATCH {problem}")
    log(f"{len(chosen)} selected entr{'y' if len(chosen) == 1 else 'ies'}, {len(problems)} problem(s)")
    return tc.EXIT_LICENCE if problems else tc.EXIT_OK


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="fetch_assets.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--only", nargs="+", metavar="ID", help="asset ids to fetch (source id, e.g. wall_clock)")
    parser.add_argument("--dry-run", action="store_true", help="list downloads, change nothing")
    parser.add_argument("--check", action="store_true", help="compare record and library, change nothing")
    args = parser.parse_args(argv)

    catalogue = CATALOGUE
    if args.only:
        known = {a.asset_id for a in catalogue}
        unknown = sorted(set(args.only) - known)
        if unknown:
            fail(tc.EXIT_USAGE, f"unknown asset id(s) {unknown}; known: {sorted(known)}")
        catalogue = [a for a in catalogue if a.asset_id in args.only]

    root = lg.library_root()
    if root is None:
        fail(tc.EXIT_USAGE, lg.LIBRARY_MISSING_HINT)
    try:
        text = lg.ASSETS_FILE.read_text(encoding="utf-8-sig")
        existing = lg.load_entries()
    except (OSError, lg.LicenceRecordError) as exc:
        fail(tc.EXIT_CONFIG, f"cannot read licence record: {exc}")

    if args.check:
        return check_library(existing, root)

    fetched = []
    for asset in catalogue:
        if asset.source not in SOURCES:
            fail(tc.EXIT_USAGE, f"{asset.entry_id}: source without licence proof")
        target = root / asset.source / asset.asset_id
        try:
            if asset.source == "polyhaven":
                fetch_polyhaven(asset, target, args.dry_run)
            else:
                fetch_ambientcg(asset, target, args.dry_run)
        except Exception as exc:  # noqa: BLE001 - network/IO errors are reported, not hidden
            fail(tc.EXIT_RENDER_FAILED, f"{asset.entry_id}: {exc}")
        fetched.append(entry_for(asset))

    if args.dry_run:
        return tc.EXIT_OK
    entries = merge_entries(existing, fetched)
    lg.ASSETS_FILE.write_text(lg.replace_assets_block(text, entries), encoding="utf-8", newline="\n")
    log(f"licenses/assets.yaml: {len(entries)} asset entr{'y' if len(entries) == 1 else 'ies'}")
    if args.only:  # partial fetch: verify only what was fetched (orphans are not its business)
        selected = {e["id"] for e in fetched}
        return check_selected(entries, root, selected)
    return check_library(entries, root)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
