// Layer-import check for the film architecture. Dependency-free: a small
// comment/string-aware scanner plus regexes, no AST parser.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'location',
  'HTMLElement',
  'matchMedia',
] as const;

export interface LayerRule {
  name: string;
  /** Root-relative directory the rule applies to. */
  from: string;
  /** Root-relative directories files in `from` must not import. */
  forbidImports: readonly string[];
  forbidBrowserGlobals: boolean;
}

export const LAYER_RULES: readonly LayerRule[] = [
  {
    name: 'systems-no-adapters-or-browser',
    from: 'src/film/systems',
    forbidImports: ['src/film/adapters'],
    forbidBrowserGlobals: true,
  },
  {
    name: 'core-no-systems-or-adapters',
    from: 'src/film/core',
    forbidImports: ['src/film/systems', 'src/film/adapters'],
    forbidBrowserGlobals: false,
  },
  {
    name: 'pages-no-core-or-systems',
    from: 'src/pages',
    forbidImports: ['src/film/core', 'src/film/systems'],
    forbidBrowserGlobals: false,
  },
];

export interface Violation {
  /** Root-relative file path, forward slashes. */
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.astro']);

/**
 * Returns `source` with the same length and line breaks, but with comments
 * blanked out. When `blankStrings` is true, string/template literal contents
 * are blanked too (quotes are kept). Template `${…}` expressions stay code.
 */
export function sanitize(source: string, blankStrings: boolean): string {
  const out = source.split('');
  const blank = (i: number): void => {
    if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  // Stack of brace depths at which a template literal resumes.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;
  const n = source.length;

  const scanTemplate = (): void => {
    // `i` points just after the opening backtick or after a closing `}` of `${`.
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        if (blankStrings) {
          blank(i);
          if (i + 1 < n) blank(i + 1);
        }
        i += 2;
      } else if (c === '`') {
        i += 1;
        return;
      } else if (c === '$' && source[i + 1] === '{') {
        templateStack.push(braceDepth);
        braceDepth += 1;
        i += 2;
        return;
      } else {
        if (blankStrings) blank(i);
        i += 1;
      }
    }
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') blank(i++);
    } else if (c === '/' && next === '*') {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          if (blankStrings) blank(i);
          i += 1;
        }
        if (blankStrings && i < n) blank(i);
        i += 1;
      }
      i += 1;
    } else if (c === '`') {
      i += 1;
      scanTemplate();
    } else if (c === '{') {
      braceDepth += 1;
      i += 1;
    } else if (c === '}') {
      braceDepth -= 1;
      i += 1;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        scanTemplate();
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/**
 * For `.astro` files only the frontmatter and `<script>` bodies are code;
 * everything else is blanked (keeping offsets and line numbers intact).
 */
export function astroCodeRegions(source: string): string {
  const keep = new Array<boolean>(source.length).fill(false);
  const fm = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (fm) {
    const start = fm.index + fm[0].indexOf(fm[1] ?? '');
    for (let k = start; k < start + (fm[1] ?? '').length; k++) keep[k] = true;
  }
  for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1] ?? '';
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
    for (let k = start; k < start + body.length; k++) keep[k] = true;
  }
  return source
    .split('')
    .map((ch, k) => (keep[k] || ch === '\n' || ch === '\r' ? ch : ' '))
    .join('');
}

export interface ImportRef {
  specifier: string;
  index: number;
}

/** Static `import`/`export … from`, side-effect `import '…'` and dynamic `import()`. */
export function extractImports(code: string): ImportRef[] {
  const text = sanitize(code, false);
  const refs: ImportRef[] = [];
  const patterns = [
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1/g,
    /\b(?:import|export)\b[^;"'`()]*?\bfrom\s*(["'])([^"']+)\1/g,
    /\bimport\s*(["'])([^"']+)\1/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) refs.push({ specifier: m[2] ?? '', index: m.index ?? 0 });
  }
  return refs.sort((a, b) => a.index - b.index);
}

export interface GlobalRef {
  name: string;
  index: number;
}

/**
 * True when the identifier at `start..end` is a property key or declared
 * member/parameter name (`{ location: 1 }`, `(location?: T)`), not a value
 * reference. A ternary branch (`a ? window : b`) is still a reference.
 */
function isKeyPosition(text: string, start: number, end: number): boolean {
  if (!/^\s*\??\s*:(?!:)/.test(text.slice(end))) return false;
  const before = text.slice(0, start).replace(/\s+$/, '');
  return before === '' || /[{,;(]$/.test(before);
}

export function findBrowserGlobals(code: string): GlobalRef[] {
  const text = sanitize(code, true);
  const re = new RegExp(`(?<![\\w$.])(${BROWSER_GLOBALS.join('|')})(?![\\w$])`, 'g');
  return [...text.matchAll(re)]
    .filter((m) => !isKeyPosition(text, m.index ?? 0, (m.index ?? 0) + (m[1] ?? '').length))
    .map((m) => ({ name: m[1] ?? '', index: m.index ?? 0 }));
}

/** Resolves a specifier to a root-relative path, or `null` for packages. */
export function resolveSpecifier(specifier: string, fileRel: string): string | null {
  if (specifier.startsWith('/src/')) return path.posix.normalize(specifier.slice(1));
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), specifier));
  }
  return null;
}

const isWithin = (target: string, dir: string): boolean => target === dir || target.startsWith(`${dir}/`);

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text[k] === '\n') line += 1;
  return line;
}

/** Checks one file. `fileRel` is root-relative with forward slashes. */
export function checkFile(
  fileRel: string,
  source: string,
  rules: readonly LayerRule[] = LAYER_RULES,
): Violation[] {
  const applicable = rules.filter((r) => isWithin(fileRel, r.from));
  if (applicable.length === 0) return [];
  const code = fileRel.endsWith('.astro') ? astroCodeRegions(source) : source;
  const violations: Violation[] = [];
  const imports = extractImports(code);
  for (const rule of applicable) {
    for (const ref of imports) {
      const target = resolveSpecifier(ref.specifier, fileRel);
      if (target === null) continue;
      const hit = rule.forbidImports.find((dir) => isWithin(target, dir));
      if (hit) {
        violations.push({
          file: fileRel,
          line: lineAt(code, ref.index),
          rule: rule.name,
          detail: `imports ${hit} via '${ref.specifier}'`,
        });
      }
    }
    if (rule.forbidBrowserGlobals) {
      for (const g of findBrowserGlobals(code)) {
        violations.push({
          file: fileRel,
          line: lineAt(code, g.index),
          rule: rule.name,
          detail: `references browser global '${g.name}'`,
        });
      }
    }
  }
  return violations;
}

/** Walks `<rootDir>/src` and checks every source file. */
export function checkLayers(rootDir: string, rules: readonly LayerRule[] = LAYER_RULES): Violation[] {
  const srcDir = path.join(rootDir, 'src');
  const violations: Violation[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const rel = path.relative(rootDir, full).split(path.sep).join('/');
        violations.push(...checkFile(rel, readFileSync(full, 'utf8'), rules));
      }
    }
  };
  walk(srcDir);
  return violations;
}

export function formatLayers(violations: readonly Violation[]): string {
  const lines = ['Layer-import check — src/'];
  if (violations.length === 0) lines.push('  no violations', '  PASS');
  else {
    for (const v of violations) lines.push(`  ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
    lines.push(`  ${violations.length} violation(s)`, '  FAIL');
  }
  return lines.join('\n');
}
