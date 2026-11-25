// Story 1.10: the `og` build check over dist/ fixtures (clean, missing file,
// wrong size, off-origin, wrong image, orphan, alpha PNG) and its CLI.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkOg, ogMeta } from '../../scripts/checks/og.ts';
import { OG_HEIGHT, OG_WIDTH } from '../../src/og/paths.ts';
import { encodeRgbPng } from '../../src/og/png.ts';
import { repoRoot } from './helpers/astro-build.ts';

const ORIGIN = 'https://jun.example.workers.dev';
const LEAK = 'https://pr-7-jun-portfolio.preview.workers.dev';
const LANGS = ['id', 'en'] as const;

const png = (width: number, height: number) => encodeRgbPng(new Uint8Array(width * height * 4).fill(255), width, height);
const GOOD_PNG = png(OG_WIDTH, OG_HEIGHT);

function page(lang: string, image: string, origin = ORIGIN, size = { w: '1200', h: '630' }): string {
  return (
    `<!doctype html><html lang="${lang}"><head><title>t</title>` +
    `<meta property="og:image" content="${origin}/${image}">` +
    `<meta property="og:image:width" content="${size.w}"><meta property="og:image:height" content="${size.h}">` +
    `<meta name="twitter:card" content="summary_large_image"></head><body></body></html>`
  );
}

type Dist = Record<string, string | Uint8Array>;

function cleanDist(): Dist {
  const files: Dist = { '404.html': page('id', 'og/site-id.png') };
  for (const lang of LANGS) {
    files[`${lang}/index.html`] = page(lang, `og/site-${lang}.png`);
    files[`${lang}/privasi/index.html`] = page(lang, `og/site-${lang}.png`);
    files[`${lang}/404.html`] = page(lang, `og/site-${lang}.png`);
    files[`${lang}/proyek/x/index.html`] = page(lang, `og/${lang}/proyek/x.png`);
    files[`og/site-${lang}.png`] = GOOD_PNG;
    files[`og/${lang}/proyek/x.png`] = GOOD_PNG;
  }
  return files;
}

function check(files: Dist) {
  return checkOg(
    Object.keys(files),
    (file) => {
      const value = files[file]!;
      return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
    },
    (file) => {
      const value = files[file]!;
      return typeof value === 'string' ? Buffer.from(value) : value;
    },
    ORIGIN,
  );
}

const messages = (files: Dist) => check(files).problems.map((p) => `${p.file}: ${p.problem}`);

describe('checkOg', () => {
  it('fixture clean: passes', () => {
    const result = check(cleanDist());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pages).toBe(9);
    expect(result.images).toHaveLength(4);
  });

  it('matrix: a missing image file fails naming the page', () => {
    const { 'og/en/proyek/x.png': _gone, ...files } = cleanDist();
    expect(messages(files)).toEqual([
      `en/proyek/x/index.html: og:image ${ORIGIN}/og/en/proyek/x.png does not resolve to a file in dist/ (expected dist/og/en/proyek/x.png)`,
      'og/en/proyek/x.png: missing expected image dist/og/en/proyek/x.png',
    ]);
    expect(check(files).ok).toBe(false);
  });

  it('matrix: a PNG that is not 1200×630 fails naming the file', () => {
    expect(messages({ ...cleanDist(), 'og/site-en.png': png(600, 315) })).toEqual(['og/site-en.png: is 600×315, expected 1200×630']);
  });

  it('a non-PNG or an alpha PNG fails', () => {
    expect(messages({ ...cleanDist(), 'og/site-id.png': 'GIF89a' })).toEqual(['og/site-id.png: is not a PNG']);
    const rgba = Buffer.from(GOOD_PNG);
    rgba[25] = 6; // colour type RGBA in IHDR
    expect(messages({ ...cleanDist(), 'og/site-id.png': rgba })).toEqual([
      'og/site-id.png: must be 8-bit RGB without alpha (bit depth 8, colour type 6)',
    ]);
  });

  it('fixture off-origin: an og:image on another origin fails', () => {
    expect(messages({ ...cleanDist(), 'id/privasi/index.html': page('id', 'og/site-id.png', LEAK) })).toEqual([
      `id/privasi/index.html: og:image ${LEAK}/og/site-id.png is not on the production origin ${ORIGIN}`,
    ]);
    expect(messages({ ...cleanDist(), 'id/privasi/index.html': page('id', 'og/site-id.png', '') })).toEqual([
      `id/privasi/index.html: og:image /og/site-id.png is not on the production origin ${ORIGIN}`,
    ]);
  });

  it('a page with no or two og:image fails', () => {
    expect(messages({ ...cleanDist(), 'en/index.html': '<html lang="en"><head></head></html>' })).toEqual([
      'en/index.html: expected exactly 1 og:image, found 0',
    ]);
    const twice = page('en', 'og/site-en.png').replace('</head>', `<meta property="og:image" content="${ORIGIN}/og/site-en.png"></head>`);
    expect(messages({ ...cleanDist(), 'en/index.html': twice })).toEqual(['en/index.html: expected exactly 1 og:image, found 2']);
  });

  it('a project page must use its own image in its language; other pages the site image of their language', () => {
    expect(
      messages({
        ...cleanDist(),
        'id/proyek/x/index.html': page('id', 'og/site-id.png'),
        'en/privasi/index.html': page('en', 'og/site-id.png'),
      }),
    ).toEqual([
      `en/privasi/index.html: og:image ${ORIGIN}/og/site-id.png should be ${ORIGIN}/og/site-en.png`,
      `id/proyek/x/index.html: og:image ${ORIGIN}/og/site-id.png should be ${ORIGIN}/og/id/proyek/x.png`,
    ]);
  });

  it('wrong og:image:width/height fail', () => {
    expect(messages({ ...cleanDist(), 'en/index.html': page('en', 'og/site-en.png', ORIGIN, { w: '1080', h: '630' }) })).toEqual([
      'en/index.html: og:image:width must be 1200, found 1080',
    ]);
  });

  it('an orphaned og/ file fails', () => {
    expect(messages({ ...cleanDist(), 'og/id/proyek/old.png': GOOD_PNG })).toEqual([
      'og/id/proyek/old.png: orphaned: no page uses this image',
    ]);
  });

  it('ogMeta reads property and name metas, entity-decoded', () => {
    const meta = ogMeta(`<meta property="og:title" content="A &amp; B"><meta name="twitter:card" content='summary_large_image'>`);
    expect(meta.get('og:title')).toEqual(['A & B']);
    expect(meta.get('twitter:card')).toEqual(['summary_large_image']);
  });
});

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'og-check-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('og check CLI', () => {
  it('exits 1 on a wrong-size image and 0 when clean', () => {
    const write = (name: string, files: Dist) => {
      const dir = path.join(tmpRoot, name);
      for (const [file, data] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), data);
      }
      return dir;
    };
    const script = path.join(repoRoot, 'scripts/checks/og.ts');
    const bad = spawnSync(process.execPath, [script, write('bad', { ...cleanDist(), 'og/site-id.png': png(10, 10) }), ORIGIN], {
      encoding: 'utf8',
    });
    expect(bad.status, bad.stdout + bad.stderr).toBe(1);
    expect(bad.stdout).toContain('FAIL og/site-id.png: is 10×10, expected 1200×630');
    const good = spawnSync(process.execPath, [script, write('good', cleanDist()), ORIGIN], { encoding: 'utf8' });
    expect(good.status, good.stdout + good.stderr).toBe(0);
  });
});
