import { describe, expect, it } from 'vitest';
import {
  FIRST_LOAD_LIMIT_BYTES,
  findHtmlReferences,
  formatFirstLoad,
  gzipSize,
  measureFirstLoad,
  resolveAssetUrl,
} from '../../scripts/budgets/first-load.ts';

const enc = new TextEncoder();

function readerFrom(files: Record<string, string | Uint8Array>) {
  return (p: string): Uint8Array | null => {
    const v = files[p];
    if (v === undefined) return null;
    return typeof v === 'string' ? enc.encode(v) : v;
  };
}

/** Deterministic, poorly compressible bytes. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('reference discovery', () => {
  it('finds link href and script src, ignoring comments', () => {
    const html = `<link rel="stylesheet" href="/_astro/a.css"><script type="module" src='/_astro/b.js'></script><!-- <link href="/x.css"> -->`;
    expect(findHtmlReferences(html)).toEqual(['/_astro/a.css', '/_astro/b.js']);
  });

  it('ignores data-href / data-src and reads the real attribute', () => {
    const html = `<link data-href="/_astro/wrong.css" href="/_astro/a.css"><script data-src="/_astro/wrong.js" src="/_astro/b.js"></script>`;
    expect(findHtmlReferences(html)).toEqual(['/_astro/a.css', '/_astro/b.js']);
  });

  it('resolves absolute and relative URLs and skips external / non-asset ones', () => {
    expect(resolveAssetUrl('/_astro/a.css?v=1', 'id/index.html')).toBe('_astro/a.css');
    expect(resolveAssetUrl('../_astro/b.js', 'id/index.html')).toBe('_astro/b.js');
    expect(resolveAssetUrl('fonts/f.woff2', '_astro/a.css')).toBe('_astro/fonts/f.woff2');
    expect(resolveAssetUrl('https://cdn.example/x.js', 'id/index.html')).toBeNull();
    expect(resolveAssetUrl('data:font/woff2;base64,AAA', '_astro/a.css')).toBeNull();
    expect(resolveAssetUrl('/favicon.svg', 'id/index.html')).toBeNull();
  });
});

describe('measureFirstLoad', () => {
  it('sums gzip-9 bytes of the HTML and its CSS/JS/font closure', () => {
    const files = {
      'id/index.html': '<link rel="stylesheet" href="/_astro/a.css"><script src="/_astro/b.js"></script>',
      '_astro/a.css': '@font-face{src:url(/fonts/f.woff2)} body{color:red}',
      '_astro/b.js': 'import{x}from"./c.js";import("./lazy.js");x();',
      '_astro/c.js': 'export const x=()=>1;',
      'fonts/f.woff2': noise(100),
      '_astro/lazy.js': 'export default 1;',
    };
    const result = measureFirstLoad('id/index.html', readerFrom(files));
    expect(result.files.map((f) => f.path).sort()).toEqual(
      ['_astro/a.css', '_astro/b.js', '_astro/c.js', 'fonts/f.woff2', 'id/index.html'].sort(),
    );
    const expected = result.files.reduce((s, f) => s + gzipSize(readerFrom(files)(f.path) as Uint8Array), 0);
    expect(result.totalGzipBytes).toBe(expected);
    expect(result.ok).toBe(true);
  });

  it('counts fonts referenced from inline <style>', () => {
    const files = {
      'id/index.html': '<style>@font-face{src:url(/fonts/f.woff2)}</style>',
      'fonts/f.woff2': noise(50),
    };
    const result = measureFirstLoad('id/index.html', readerFrom(files));
    expect(result.files.map((f) => f.path)).toContain('fonts/f.woff2');
  });

  it('counts stylesheets pulled in by CSS @import', () => {
    const files = {
      'id/index.html': '<link rel="stylesheet" href="/_astro/a.css">',
      '_astro/a.css': '@import "./b.css"; body{color:red}',
      '_astro/b.css': 'p{margin:0}',
    };
    const result = measureFirstLoad('id/index.html', readerFrom(files));
    expect(result.files.map((f) => f.path)).toContain('_astro/b.css');
  });

  it('counts chunks statically imported by inline module scripts', () => {
    const files = {
      'id/index.html': '<script type="module">import{x}from"/_astro/chunk.js";x();</script>',
      '_astro/chunk.js': 'export const x=()=>1;',
    };
    const result = measureFirstLoad('id/index.html', readerFrom(files));
    expect(result.files.map((f) => f.path)).toContain('_astro/chunk.js');
  });

  it('fails when the total exceeds 204,800 gzip bytes and prints a per-file table', () => {
    expect(FIRST_LOAD_LIMIT_BYTES).toBe(204_800);
    const files = {
      'en/index.html': '<script src="/_astro/big.js"></script>',
      '_astro/big.js': noise(210_000),
    };
    const result = measureFirstLoad('en/index.html', readerFrom(files));
    expect(result.totalGzipBytes).toBeGreaterThan(204_800);
    expect(result.ok).toBe(false);
    const table = formatFirstLoad(result);
    expect(table).toContain('en/index.html');
    expect(table).toContain('_astro/big.js');
    expect(table).toContain('TOTAL');
    expect(table).toContain('FAIL');
  });

  it('passes at exactly the limit and fails one byte over', () => {
    const files = { 'id/index.html': 'x' };
    const size = gzipSize('x');
    expect(measureFirstLoad('id/index.html', readerFrom(files), size).ok).toBe(true);
    expect(measureFirstLoad('id/index.html', readerFrom(files), size - 1).ok).toBe(false);
  });

  it('fails when a referenced asset is missing', () => {
    const result = measureFirstLoad('id/index.html', readerFrom({ 'id/index.html': '<script src="/_astro/gone.js"></script>' }));
    expect(result.missing).toEqual(['_astro/gone.js']);
    expect(result.ok).toBe(false);
  });
});
