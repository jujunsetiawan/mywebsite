// Helpers for the DESIGN.md ↔ tokens.css checks (Story 1.3). Pure functions
// plus small file readers; no Astro imports.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const repoRoot = path.resolve(import.meta.dirname, '../../..');
export const DESIGN_MD = path.join(repoRoot, 'docs/design/DESIGN.md');
export const TOKENS_CSS = path.join(repoRoot, 'src/styles/tokens.css');

/** Typography styles built as tokens (kanji-vertical is retired and not built). */
export const TYPE_STYLES = [
  'display-serif',
  'title-serif',
  'subtitle-serif',
  'kanji-chrome',
  'ui-caps',
  'body',
  'terminal',
  'numeral',
] as const;

/** Frontmatter keys deliberately not mapped to CSS custom properties. */
export const UNMAPPED = {
  // Same value as spacing.letterbox; only the two-row phone bar (not built) would use it.
  spacing: ['letterbox-mobile'],
} as const;

const TYPE_FIELDS = {
  fontFamily: 'family',
  fontSize: 'size',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
} as const;

type Scalar = string | number;
export interface DesignFrontmatter {
  colors: Record<string, Record<string, Scalar>>;
  typography: Record<string, Record<string, Scalar>>;
  rounded: Record<string, Scalar>;
  spacing: Record<string, Scalar>;
  components: Record<string, Record<string, Scalar>>;
}

export function parseFrontmatter(markdown: string): DesignFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) throw new Error('DESIGN.md has no YAML frontmatter');
  return parse(match[1] ?? '') as DesignFrontmatter;
}

export function readDesign(): DesignFrontmatter {
  return parseFrontmatter(readFileSync(DESIGN_MD, 'utf8'));
}

/** Maps the frontmatter to the expected `--<group>-<name>` custom properties. */
export function expectedTokens(front: DesignFrontmatter): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [group, entries] of Object.entries(front.colors)) {
    for (const [name, value] of Object.entries(entries)) tokens.set(`--${group}-${name}`, String(value));
  }
  const skipSpacing = new Set<string>(UNMAPPED.spacing);
  for (const [name, value] of Object.entries(front.spacing)) {
    if (!skipSpacing.has(name)) tokens.set(`--space-${name}`, String(value));
  }
  for (const [name, value] of Object.entries(front.rounded)) tokens.set(`--radius-${name}`, String(value));
  for (const style of TYPE_STYLES) {
    const spec = front.typography[style];
    if (!spec) throw new Error(`DESIGN.md typography.${style} is missing`);
    for (const [field, suffix] of Object.entries(TYPE_FIELDS)) {
      const value = spec[field];
      if (value !== undefined) tokens.set(`--type-${style}-${suffix}`, String(value));
    }
  }
  return tokens;
}

/** Custom properties declared in `:root` blocks of a stylesheet. */
export function parseCssTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of clean.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const decl of (block[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(decl[1] ?? '', (decl[2] ?? '').trim());
    }
  }
  return tokens;
}

export function normalizeValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/#[0-9a-f]{3,8}\b/gi, (hex) => hex.toLowerCase());
}

/** Human-readable differences; empty when the CSS matches the frontmatter exactly. */
export function diffTokens(expected: Map<string, string>, actual: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, value] of expected) {
    const got = actual.get(name);
    if (got === undefined) problems.push(`missing ${name} (DESIGN.md: ${value})`);
    else if (normalizeValue(got) !== normalizeValue(value))
      problems.push(`${name} differs: DESIGN.md "${value}" vs tokens.css "${got}"`);
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) problems.push(`extra ${name} (not mapped from DESIGN.md)`);
  }
  return problems;
}

/** Source files a style rule can live in. */
export function listStyleSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listStyleSources(full));
    else if (/\.(css|astro)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  file: string;
  text: string;
}

const FORBIDDEN_TEXT_COLOR =
  /(?<![\w-])color\s*:[^;}]*?(var\(\s*--signal-(?:error|alarm-red|beacon-red)\s*[,)]|#c8392e\b|#e04a3c\b|#e0473a\b)/i;
const PURE_WHITE_TEXT = /(?<![\w-])color\s*:[^;}]*?(#fff\b|#ffffff\b|\bwhite\b)/i;

export const FOCUS_HALO = '0 0 0 4px #000';

/**
 * The single documented non-token colour (Story 1.6): the printed-paper tone
 * from the DESIGN.md set-dressing prose, used behind the sample PRD and API
 * contract blocks with ink.on-light text (contrast-tested).
 */
export const PAPER_HEX = '#D8D0C0';

/** Hex literals allowed in stylesheets outside tokens.css: the focus halo black and the paper tone. */
const ALLOWED_HEX = new Set(['#000', PAPER_HEX.toLowerCase()]);
const ZERO_RADII = new Set(['0', '0px', 'var(--radius-none)', 'var(--radius-card)', 'var(--radius-pill)']);

/** Style-rule violations as `file:line — message`. */
export function scanStyleRules(sources: SourceFile[]): string[] {
  const problems: string[] = [];
  for (const { file, text } of sources) {
    // Colours come from tokens: stylesheets other than tokens.css hold no other hex literal.
    const checkHex = file.endsWith('.css') && file !== 'src/styles/tokens.css';
    text.split(/\r?\n/).forEach((line, index) => {
      const at = `${file}:${index + 1}`;
      if (checkHex) {
        for (const m of line.replace(/\/\*.*?\*\//g, '').matchAll(/#[0-9a-f]{3,8}\b/gi)) {
          if (!ALLOWED_HEX.has(m[0].toLowerCase()))
            problems.push(`${at} — colour ${m[0]} is not a token (only ${[...ALLOWED_HEX].join(', ')} are allowed)`);
        }
      }
      const forbidden = FORBIDDEN_TEXT_COLOR.exec(line);
      if (forbidden) problems.push(`${at} — text colour uses ${forbidden[1]} (fill/light only, never text)`);
      const white = PURE_WHITE_TEXT.exec(line);
      if (white) problems.push(`${at} — pure white text (${white[1]}); use --ink-primary`);
      for (const m of line.matchAll(/(?<![\w-])box-shadow\s*:\s*([^;}]+)/gi)) {
        const shadow = normalizeValue(m[1] ?? '');
        if (shadow !== FOCUS_HALO && shadow !== 'none')
          problems.push(`${at} — box-shadow "${(m[1] ?? '').trim()}" (only the focus halo "${FOCUS_HALO}" is allowed)`);
      }
      for (const m of line.matchAll(/(?<![\w-])font-weight\s*:\s*([^;}]+)/gi)) {
        if ((m[1] ?? '').trim() !== '400') problems.push(`${at} — font-weight ${(m[1] ?? '').trim()} (400 only)`);
      }
      for (const m of line.matchAll(/(?<![\w-])border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/gi)) {
        if (!ZERO_RADII.has(normalizeValue(m[1] ?? '')))
          problems.push(`${at} — border-radius ${(m[1] ?? '').trim()} (0 or var(--radius-pill) only)`);
      }
      if (/@font-face/i.test(line)) problems.push(`${at} — @font-face (system font stacks only)`);
    });
  }
  return problems;
}

export function readStyleSources(): SourceFile[] {
  return listStyleSources(path.join(repoRoot, 'src')).map((full) => ({
    file: path.relative(repoRoot, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

// ---------- Contrast (WCAG 2.x) ----------

export type Rgb = [number, number, number];

/** `#RGB`, `#RRGGBB` or `#RRGGBBAA` → rgb + alpha (0..1). */
export function parseHex(hex: string): { rgb: Rgb; alpha: number } {
  const clean = hex.trim().replace(/^#/, '');
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join('') : clean;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  const byte = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { rgb: [byte(0), byte(2), byte(4)], alpha: full.length === 8 ? byte(6) / 255 : 1 };
}

/** Composites `top` (with alpha) over an opaque `bottom`, rounded to 8-bit channels. */
export function composite(top: string, bottom: string): Rgb {
  const t = parseHex(top);
  const b = parseHex(bottom).rgb;
  return t.rgb.map((c, i) => Math.round(c * t.alpha + (b[i] ?? 0) * (1 - t.alpha))) as Rgb;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
