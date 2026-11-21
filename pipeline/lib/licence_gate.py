"""Licence gate: refuse to render a scene that references an unlisted asset.

Pure Python (no ``bpy``, no PyYAML -- neither is available inside Blender's
bundled Python), so it is unit-tested with plain ``python -m unittest``.

``licenses/assets.yaml`` is read with a deliberately small YAML subset parser
(block mappings, block lists, ``- key: value`` list items, quoted/plain
scalars, ``[]``/``{}`` and inline ``[a, b]`` lists, ``#`` comments). That is
all the licence record uses; anything else raises ``LicenceRecordError``.

Matching rule: every file a scene references (image, linked library, font,
sound, ...) must lie inside the ``path`` of an ``assets:`` entry. Entry paths
are relative to the asset library root (env var ``JFILM_LIBRARY``), or
absolute, or a Blender pseudo-path such as ``<builtin>`` (exact match). A
reference *without a file path* may instead carry an ``asset_id`` (custom
property ``jfilm_asset_id``); it matches an entry with that id that has no
``path``. A reference with a file path must always lie inside an entry path.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_FILE = REPO_ROOT / "licenses" / "assets.yaml"
LIBRARY_ENV = "JFILM_LIBRARY"

REQUIRED_FIELDS = ("id", "source", "licence", "proof", "used-in")
# 3D models, textures and HDRIs must be CC0; self-made files are "original".
ALLOWED_LICENCES = {"CC0-1.0", "original"}
# Fonts may additionally be under the SIL Open Font Licence.
ALLOWED_LICENCES_BY_KIND = {"font": {"OFL-1.1"}}


class LicenceRecordError(ValueError):
    """``licenses/assets.yaml`` is unreadable or outside the supported subset."""


# --------------------------------------------------------------- YAML subset


_KEY_RE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*)|\s*)$")


def _strip_comment(line: str) -> str:
    """Drop a ``#`` comment that is outside quotes.

    A quote only opens a quoted scalar where one can start (after ``: ``,
    ``- ``, ``[``, ``,`` or at the start of the content), so apostrophes in
    plain scalars (``Jun's desk``) do not swallow a trailing comment.
    """
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"" and (line[:i].strip() == "" or line[:i].rstrip()[-1] in ":-[,"):
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _scalar(text: str):
    text = text.strip()
    if text == "[]":
        return []
    if text == "{}":
        return {}
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        body = text[1:-1]
        if text[0] == '"':
            body = re.sub(r'\\(["\\])', r"\1", body)
        else:
            body = body.replace("''", "'")
        return body
    if text.startswith("[") and text.endswith("]"):
        return [_scalar(part) for part in text[1:-1].split(",") if part.strip()]
    if text.startswith(("{", "&", "*", "!", "|", ">")):
        raise LicenceRecordError(f"unsupported YAML construct: {text!r}")
    return text


def _tokenise(text: str) -> list[tuple[int, str, int]]:
    tokens = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise LicenceRecordError(f"line {lineno}: tabs are not allowed for indentation")
        line = _strip_comment(raw).rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        tokens.append((indent, line.strip(), lineno))
    return tokens


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def block(self, indent: int):
        tok = self.peek()
        if tok is None:
            return None
        if tok[1] == "-" or tok[1].startswith("- "):
            return self.seq(tok[0])
        return self.mapping(tok[0])

    def mapping(self, indent: int) -> dict:
        result: dict = {}
        while (tok := self.peek()) is not None and tok[0] == indent:
            ind, content, lineno = tok
            if content == "-" or content.startswith("- "):
                break
            match = _KEY_RE.match(content)
            if not match:
                raise LicenceRecordError(f"line {lineno}: expected 'key: value', got {content!r}")
            key, rest = match.group(1), match.group(2)
            if key in result:
                raise LicenceRecordError(f"line {lineno}: duplicate key {key!r}")
            self.i += 1
            if rest is not None and rest.strip():
                result[key] = _scalar(rest)
                continue
            nxt = self.peek()
            if nxt is not None and (
                nxt[0] > indent
                or (nxt[0] == indent and (nxt[1] == "-" or nxt[1].startswith("- ")))
            ):
                result[key] = self.block(nxt[0])
            else:
                result[key] = None
        tok = self.peek()
        if tok is not None and tok[0] > indent:
            raise LicenceRecordError(f"line {tok[2]}: unexpected indentation")
        return result

    def seq(self, indent: int) -> list:
        result: list = []
        while (tok := self.peek()) is not None and tok[0] == indent:
            ind, content, lineno = tok
            if not (content == "-" or content.startswith("- ")):
                break
            item = content[1:].strip()
            if not item:
                self.i += 1
                nxt = self.peek()
                result.append(self.block(nxt[0]) if nxt and nxt[0] > indent else None)
            elif _KEY_RE.match(item):
                # "- key: value" opens a mapping whose keys sit at the item's column.
                col = indent + (len(content) - len(item))
                self.tokens[self.i] = (col, item, lineno)
                result.append(self.mapping(col))
            else:
                self.i += 1
                result.append(_scalar(item))
        return result


def parse_yaml_subset(text: str):
    tokens = _tokenise(text)
    if not tokens:
        return {}
    parser = _Parser(tokens)
    data = parser.block(tokens[0][0])
    if parser.peek() is not None:
        raise LicenceRecordError(f"line {parser.peek()[2]}: could not parse")
    return data


def _yaml_quote(value: str) -> str:
    plain_ok = (
        value
        and value == value.strip()
        and not re.search(r"(:\s)|(\s#)|[\[\]{}\"',]", value)
        and not value.startswith(("-", "?", "&", "*", "!", "|", ">", "%", "@", "`", "#"))
        and not value.endswith(":")
    )
    if plain_ok:
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def dump_asset_entries(entries: Sequence[dict]) -> str:
    """Serialise asset entries as the ``assets:`` block of ``licenses/assets.yaml``."""
    if not entries:
        return "assets: []\n"
    order = ["id", "source", "licence", "proof", "path"]
    lines = ["assets:"]
    for entry in entries:
        keys = [k for k in order if k in entry]
        keys += [k for k in entry if k not in order and k != "used-in"]
        keys.append("used-in")
        first = True
        for key in keys:
            prefix = "  - " if first else "    "
            first = False
            value = entry.get(key)
            if isinstance(value, list):
                if not value:
                    lines.append(f"{prefix}{key}: []")
                else:
                    lines.append(f"{prefix}{key}:")
                    lines.extend(f"      - {_yaml_quote(str(v))}" for v in value)
            else:
                lines.append(f"{prefix}{key}: {_yaml_quote(str(value))}")
    return "\n".join(lines) + "\n"


def replace_assets_block(text: str, entries: Sequence[dict]) -> str:
    """Return ``text`` with its top-level ``assets:`` block replaced by ``entries``."""
    lines = text.splitlines(keepends=True)
    start = next((i for i, ln in enumerate(lines) if re.match(r"^assets\s*:", ln)), None)
    if start is None:
        raise LicenceRecordError("no top-level 'assets:' key")
    end = start + 1
    while end < len(lines) and (not lines[end].strip() or lines[end][0] in " -"):
        end += 1
    # Keep blank lines (and comments) that separate the block from the next key.
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    return "".join(lines[:start]) + dump_asset_entries(entries) + "".join(lines[end:])


# -------------------------------------------------------------- Licence record


def load_record(path: Path | str | None = None) -> dict:
    file_path = Path(path) if path is not None else ASSETS_FILE
    try:
        text = file_path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise LicenceRecordError(f"cannot read {file_path}: {exc}") from exc
    data = parse_yaml_subset(text)
    if not isinstance(data, dict) or "assets" not in data:
        raise LicenceRecordError(f"{file_path}: missing top-level 'assets:' key")
    if data["assets"] is None:
        data["assets"] = []
    if not isinstance(data["assets"], list):
        raise LicenceRecordError(f"{file_path}: 'assets:' must be a list")
    return data


def load_entries(path: Path | str | None = None) -> list[dict]:
    return load_record(path)["assets"]


def validate_entries(entries: Iterable[dict]) -> list[str]:
    """Return human-readable problems with the asset entries (empty = valid)."""
    problems = []
    seen = set()
    for n, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            problems.append(f"assets[{n}] is not a mapping")
            continue
        label = entry.get("id") or f"assets[{n}]"
        for field in REQUIRED_FIELDS:
            value = entry.get(field)
            if value in (None, "", []):
                problems.append(f"{label}: missing '{field}'")
        if not isinstance(entry.get("used-in", []), list):
            problems.append(f"{label}: 'used-in' must be a list")
        if entry.get("id") in seen:
            problems.append(f"{label}: duplicate id")
        seen.add(entry.get("id"))
    return problems


def library_root(environ=None) -> Path | None:
    """Asset library root from ``JFILM_LIBRARY`` (``None`` when unset or blank)."""
    env = os.environ if environ is None else environ
    raw = str(env.get(LIBRARY_ENV, "")).strip()
    return Path(raw) if raw else None


LIBRARY_MISSING_HINT = (
    f"{LIBRARY_ENV} is not set. Point it at the asset library outside git, e.g.\n"
    f'    $env:{LIBRARY_ENV} = "C:\\Users\\Jun\\jfilm-library"'
)


def library_consistency(entries: Iterable[dict], root: Path | str) -> tuple[list[str], list[str]]:
    """Compare library-relative entry paths with the asset folders on disk.

    Returns ``(missing, orphans)``: ids whose ``path`` folder is absent or
    empty, and ``<source>/<asset>`` folders on disk that no entry covers.
    Absolute and pseudo (``<...>``) paths are ignored.
    """
    root = Path(root)
    missing, covered = [], set()
    for entry in entries:
        raw = entry.get("path")
        if not raw or str(raw).startswith("<") or os.path.isabs(str(raw)):
            continue
        rel = Path(str(raw))
        covered.add(os.path.normcase(str(rel)))
        folder = root / rel
        if not (folder.exists() and (folder.is_file() or any(folder.iterdir()))):
            missing.append(str(entry.get("id")))
    orphans = []
    if root.is_dir():
        for source_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            for asset_dir in sorted(p for p in source_dir.iterdir() if p.is_dir()):
                rel = asset_dir.relative_to(root)
                if os.path.normcase(str(rel)) not in covered:
                    orphans.append(rel.as_posix())
    return missing, orphans


# ---------------------------------------------------------------------- Gate


@dataclass(frozen=True)
class Reference:
    """One external file a scene depends on."""

    kind: str  # image | library | font | sound | movieclip | volume | cache_file
    name: str  # datablock name in the .blend
    path: str  # absolute file path (or a pseudo-path like "<builtin>")
    asset_id: str | None = None


def resolve_reference_path(raw: str | None, base_dir: str | os.PathLike | None) -> str:
    """Absolute, normalised form of a path stored in a .blend (bpy-free).

    ``//`` prefixes are Blender-relative to ``base_dir`` (the directory of the
    .blend -- or of the linked library -- that owns the datablock). Pseudo-paths
    such as ``<builtin>`` are returned unchanged; empty input gives ``""``.
    Relative paths without ``//`` are resolved against ``base_dir`` too, so the
    result never depends on the process working directory.
    """
    if not raw:
        return ""
    raw = str(raw)
    if raw.startswith("<"):
        return raw
    if raw.startswith("//"):
        raw = raw[2:]
        if base_dir is None:
            raise ValueError(f"blend-relative path {raw!r} needs a base directory")
        raw = os.path.join(str(base_dir), raw)
    elif not os.path.isabs(raw):
        if base_dir is None:
            raise ValueError(f"relative path {raw!r} needs a base directory")
        raw = os.path.join(str(base_dir), raw)
    return os.path.normpath(os.path.abspath(raw))


@dataclass(frozen=True)
class Violation:
    reference: Reference
    reason: str

    def __str__(self) -> str:
        return f"{self.reference.kind} '{self.reference.name}': {self.reference.path or '(no path)'} -- {self.reason}"


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def _is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def _entry_root(entry: dict, library_root: str | None) -> str | None:
    raw = entry.get("path")
    if not raw:
        return None
    raw = str(raw)
    if raw.startswith("<"):
        return raw
    if os.path.isabs(raw):
        return _norm(raw)
    if library_root is None:
        return None
    return _norm(os.path.join(library_root, raw))


def find_violations(
    references: Iterable[Reference],
    entries: Sequence[dict],
    library_root: str | os.PathLike | None,
) -> list[Violation]:
    """Return every reference not covered by a correctly licensed entry."""
    lib = _norm(str(library_root)) if library_root else None
    roots = []
    for entry in entries:
        root = _entry_root(entry, lib)
        if root is not None:
            roots.append((root, entry))
    # Deepest path wins when entries nest.
    roots.sort(key=lambda item: len(item[0]), reverse=True)
    by_id = {e.get("id"): e for e in entries if not e.get("path")}

    violations = []
    for ref in references:
        entry = None
        if ref.path:
            if ref.path.startswith("<"):
                entry = next((e for r, e in roots if r == ref.path), None)
            else:
                target = _norm(ref.path)
                entry = next(
                    (e for r, e in roots if not r.startswith("<") and _is_within(target, r)),
                    None,
                )
        # The id fallback is only for references without a file path: a tag must never
        # whitelist an arbitrary file that lies outside every entry's path.
        if entry is None and ref.asset_id and not ref.path:
            entry = by_id.get(ref.asset_id)
        if entry is None:
            reason = "not listed in licenses/assets.yaml"
            if lib is None and ref.path and not ref.path.startswith("<"):
                reason += f" (and {LIBRARY_ENV} is not set)"
            violations.append(Violation(ref, reason))
            continue
        allowed = ALLOWED_LICENCES | ALLOWED_LICENCES_BY_KIND.get(ref.kind, set())
        if str(entry.get("licence")) not in allowed:
            violations.append(
                Violation(ref, f"entry '{entry.get('id')}' has disallowed licence {entry.get('licence')!r}")
            )
    return violations


def check(
    references: Iterable[Reference],
    record_path: Path | str | None = None,
    library_root: str | os.PathLike | None = None,
) -> list[str]:
    """Run the full gate; return printable problems (empty list = pass)."""
    try:
        entries = load_entries(record_path)
    except LicenceRecordError as exc:
        return [f"licence record invalid: {exc}"]
    problems = [f"licence record invalid: {p}" for p in validate_entries(entries)]
    problems += [str(v) for v in find_violations(references, entries, library_root)]
    return problems
