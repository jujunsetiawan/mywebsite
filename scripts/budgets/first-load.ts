// First-load budget: gzip (level 9) bytes of a built HTML page plus every
// CSS/JS/font it references, directly or transitively. Dependency-free.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const FIRST_LOAD_LIMIT_BYTES = 204_800; // 200 KB

const ASSET_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.woff', '.woff2', '.ttf', '.otf']);

export interface FileSize {
  /** Path relative to the dist root, forward slashes. */
  path: string;
  rawBytes: number;
  gzipBytes: number;
}

export interface FirstLoadResult {
  page: string;
  files: FileSize[];
  missing: string[];
  totalGzipBytes: number;
  limitBytes: number;
  ok: boolean;
}

export function gzipSize(content: Uint8Array | string): number {
  return gzipSync(content, { level: 9 }).byteLength;
}

function stripQueryAndHash(url: string): string {
  return url.replace(/[?#].*$/, '');
}

function isExternal(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

/**
 * Resolves a URL found in `fromFile` (dist-relative) to a dist-relative path,
 * or `null` when it is external, empty or not a counted asset type.
 */
export function resolveAssetUrl(url: string, fromFile: string): string | null {
  const clean = stripQueryAndHash(url.trim());
  if (!clean || isExternal(clean)) return null;
  const resolved = clean.startsWith('/')
    ? path.posix.normalize(clean.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  if (resolved.startsWith('..')) return null;
  if (!ASSET_EXTENSIONS.has(path.posix.extname(resolved).toLowerCase())) return null;
  return resolved;
}

/** URLs referenced by `<link href>` and `<script src>` in an HTML document. */
export function findHtmlReferences(html: string): string[] {
  const urls: string[] = [];
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of withoutComments.matchAll(/<link\b[^>]*>/gi)) {
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    if (href) urls.push(href[1] ?? href[2] ?? href[3] ?? '');
  }
  for (const tag of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(` ${tag[1] ?? ''}`);
    if (src) urls.push(src[1] ?? src[2] ?? src[3] ?? '');
    // Inline (e.g. hoisted module) scripts may statically import chunks.
    else urls.push(...findJsReferences(tag[2] ?? ''));
  }
  // Inline <style> blocks may reference fonts via url().
  for (const style of withoutComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    urls.push(...findCssReferences(style[1] ?? ''));
  }
  return urls;
}

/** URLs referenced by `url(...)` and `@import` in a stylesheet. */
export function findCssReferences(css: string): string[] {
  const urls: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of withoutComments.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    urls.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of withoutComments.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    urls.push(m[1] ?? m[2] ?? '');
  }
  return urls;
}

/**
 * Relative/absolute static import specifiers in a built JS chunk. Dynamic
 * `import()` is lazy and therefore not part of the first load.
 */
export function findJsReferences(js: string): string[] {
  const urls: string[] = [];
  for (const m of js.matchAll(/\b(?:import|from)\s*["']([^"']+)["']/g)) {
    const spec = m[1] ?? '';
    if (spec.startsWith('.') || spec.startsWith('/')) urls.push(spec);
  }
  return urls;
}

type ReadFile = (distRelativePath: string) => Uint8Array | null;

/**
 * Measures one page. `readFile` returns the bytes of a dist-relative path or
 * `null` when it does not exist, which keeps this function free of disk I/O.
 */
export function measureFirstLoad(
  page: string,
  readFile: ReadFile,
  limitBytes: number = FIRST_LOAD_LIMIT_BYTES,
): FirstLoadResult {
  const files: FileSize[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [page];
  const decoder = new TextDecoder();

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    const bytes = readFile(current);
    if (bytes === null) {
      missing.push(current);
      continue;
    }
    files.push({ path: current, rawBytes: bytes.byteLength, gzipBytes: gzipSize(bytes) });

    const ext = path.posix.extname(current).toLowerCase();
    let refs: string[] = [];
    if (current === page) refs = findHtmlReferences(decoder.decode(bytes));
    else if (ext === '.css') refs = findCssReferences(decoder.decode(bytes));
    else if (ext === '.js' || ext === '.mjs') refs = findJsReferences(decoder.decode(bytes));

    for (const ref of refs) {
      const resolved = resolveAssetUrl(ref, current);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  const totalGzipBytes = files.reduce((sum, f) => sum + f.gzipBytes, 0);
  return {
    page,
    files,
    missing,
    totalGzipBytes,
    limitBytes,
    ok: missing.length === 0 && totalGzipBytes <= limitBytes,
  };
}

export function diskReader(distDir: string): ReadFile {
  return (relative) => {
    const full = path.join(distDir, ...relative.split('/'));
    return existsSync(full) ? readFileSync(full) : null;
  };
}

export function formatFirstLoad(result: FirstLoadResult): string {
  const width = Math.max(4, ...result.files.map((f) => f.path.length), ...result.missing.map((m) => m.length));
  const lines = [
    `First-load budget — ${result.page}`,
    `  ${'file'.padEnd(width)}  ${'raw B'.padStart(10)}  ${'gzip-9 B'.padStart(10)}`,
    ...result.files.map(
      (f) => `  ${f.path.padEnd(width)}  ${String(f.rawBytes).padStart(10)}  ${String(f.gzipBytes).padStart(10)}`,
    ),
    ...result.missing.map((m) => `  ${m.padEnd(width)}  ${'MISSING'.padStart(10)}  ${'-'.padStart(10)}`),
    `  ${'TOTAL'.padEnd(width)}  ${''.padStart(10)}  ${String(result.totalGzipBytes).padStart(10)}  (limit ${result.limitBytes})`,
    `  ${result.ok ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}
