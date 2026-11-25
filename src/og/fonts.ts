// Fonts for the build-time OG images (Story 1.10): OFL-1.1 `.woff` files from
// the pinned Fontsource devDependencies (never served by the site), plus a
// tiny WOFF 1.0 reader for advance widths so text can be wrapped before
// rendering (`text.ts`). Node built-ins only.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

/** Font family names used in the OG image markup. */
export const SERIF = 'Source Serif 4';
export const SANS = 'Inter';

export type FontStyle = 'normal' | 'italic';

export interface OgFontFile {
  family: string;
  style: FontStyle;
  /** Package specifier of the `.woff` file, resolved from the project root. */
  specifier: string;
}

/** Weight 400 only; latin before latin-ext (the fallback order for missing glyphs). */
export const OG_FONT_FILES: readonly OgFontFile[] = [
  ...(['normal', 'italic'] as const).flatMap((style) =>
    ['latin', 'latin-ext'].map((subset) => ({
      family: SERIF,
      style,
      specifier: `@fontsource/source-serif-4/files/source-serif-4-${subset}-400-${style}.woff`,
    })),
  ),
  ...['latin', 'latin-ext'].map((subset) => ({
    family: SANS,
    style: 'normal' as const,
    specifier: `@fontsource/inter/files/inter-${subset}-400-normal.woff`,
  })),
];

/** Horizontal metrics of one font file. */
export interface FontMetrics {
  unitsPerEm: number;
  /** `hhea` ascender (font units, positive up). */
  ascender: number;
  /** `hhea` descender (font units, negative below the baseline). */
  descender: number;
  /** Advance width in font units; undefined when the font has no glyph for the code point. */
  advance(codePoint: number): number | undefined;
}

// ---------- WOFF 1.0 → sfnt tables ----------

function woffTables(woff: Uint8Array): Map<string, DataView> {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (woff.byteLength < 44 || view.getUint32(0) !== 0x774f4646) throw new Error('not a WOFF 1.0 file');
  const tables = new Map<string, DataView>();
  const count = view.getUint16(12);
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const tag = String.fromCharCode(woff[at]!, woff[at + 1]!, woff[at + 2]!, woff[at + 3]!);
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    const stored = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(stored) : stored;
    tables.set(tag, new DataView(data.buffer, data.byteOffset, data.byteLength));
  }
  return tables;
}

function requireTable(tables: Map<string, DataView>, tag: string): DataView {
  const table = tables.get(tag);
  if (!table) throw new Error(`font has no "${tag}" table`);
  return table;
}

type GlyphLookup = (codePoint: number) => number;

function cmapFormat4(t: DataView, at: number): GlyphLookup {
  const segX2 = t.getUint16(at + 6);
  const ends = at + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let s = 0; s < segX2; s += 2) {
      if (cp > t.getUint16(ends + s)) continue;
      const start = t.getUint16(starts + s);
      if (cp < start) return 0;
      const delta = t.getUint16(deltas + s);
      const rangeOffset = t.getUint16(ranges + s);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const glyph = t.getUint16(ranges + s + rangeOffset + (cp - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

function cmapFormat12(t: DataView, at: number): GlyphLookup {
  const groups = t.getUint32(at + 12);
  return (cp) => {
    for (let g = 0; g < groups; g++) {
      const base = at + 16 + g * 12;
      const start = t.getUint32(base);
      if (cp >= start && cp <= t.getUint32(base + 4)) return t.getUint32(base + 8) + (cp - start);
    }
    return 0;
  };
}

function cmapLookup(cmap: DataView): GlyphLookup {
  const count = cmap.getUint16(2);
  const subtables: { platform: number; encoding: number; at: number; format: number }[] = [];
  for (let i = 0; i < count; i++) {
    const rec = 4 + i * 8;
    const at = cmap.getUint32(rec + 4);
    subtables.push({ platform: cmap.getUint16(rec), encoding: cmap.getUint16(rec + 2), at, format: cmap.getUint16(at) });
  }
  const unicode = (s: (typeof subtables)[number]) => s.platform === 0 || (s.platform === 3 && (s.encoding === 1 || s.encoding === 10));
  const f12 = subtables.find((s) => unicode(s) && s.format === 12);
  if (f12) return cmapFormat12(cmap, f12.at);
  const f4 = subtables.find((s) => unicode(s) && s.format === 4);
  if (f4) return cmapFormat4(cmap, f4.at);
  throw new Error('font has no Unicode cmap subtable (format 4 or 12)');
}

/** Advance widths and vertical metrics from a WOFF 1.0 font (`head`, `hhea`, `hmtx`, `cmap`). */
export function woffMetrics(woff: Uint8Array): FontMetrics {
  const tables = woffTables(woff);
  const unitsPerEm = requireTable(tables, 'head').getUint16(18);
  const hhea = requireTable(tables, 'hhea');
  const numberOfHMetrics = hhea.getUint16(34);
  const hmtx = requireTable(tables, 'hmtx');
  const glyphOf = cmapLookup(requireTable(tables, 'cmap'));
  return {
    unitsPerEm,
    ascender: hhea.getInt16(4),
    descender: hhea.getInt16(6),
    advance(codePoint) {
      const glyph = glyphOf(codePoint);
      if (glyph === 0) return undefined;
      return hmtx.getUint16(Math.min(glyph, numberOfHMetrics - 1) * 4);
    },
  };
}

// ---------- Loading ----------

/** A font as satori takes it. */
export interface SatoriFont {
  name: string;
  data: Buffer;
  weight: 400;
  style: FontStyle;
}

/** Fonts for the renderer plus per-face metrics (subsets in fallback order). */
export interface OgFonts {
  satori: SatoriFont[];
  metrics: Record<string, FontMetrics[]>;
}

/** Key of `OgFonts.metrics` for a face. */
export function faceKey(family: string, style: FontStyle): string {
  return `${family}/${style}`;
}

/**
 * Reads every OG font file, resolving the package specifiers from `rootDir`
 * (the project root). Throws naming the file when one is missing or unreadable.
 */
export async function loadOgFonts(rootDir: string, files: readonly OgFontFile[] = OG_FONT_FILES): Promise<OgFonts> {
  const require = createRequire(`${rootDir.replace(/[\\/]+$/, '')}/package.json`);
  const fonts: OgFonts = { satori: [], metrics: {} };
  for (const file of files) {
    let data: Buffer;
    try {
      data = await readFile(require.resolve(file.specifier));
    } catch (error) {
      throw new Error(`og fonts: cannot read ${file.specifier} (${(error as Error).message})`);
    }
    fonts.satori.push({ name: file.family, data, weight: 400, style: file.style });
    const key = faceKey(file.family, file.style);
    (fonts.metrics[key] ??= []).push(woffMetrics(data));
  }
  return fonts;
}
