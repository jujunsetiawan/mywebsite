// i18n route check (Story 1.4) against fixture dist/ trees and in-memory pages.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkI18nRoutes,
  checkI18nRoutesDir,
  formatI18nRoutes,
  hasNoindexMeta,
  parseLinks,
} from '../../scripts/checks/i18n-routes.ts';
import { repoRoot } from './helpers/astro-build.ts';

const ORIGIN = 'https://jun.example';
const fixture = (name: string) => path.join(repoRoot, 'tests/unit/fixtures/i18n-routes', name);
const messages = (result: ReturnType<typeof checkI18nRoutes>) => result.problems.map((p) => `${p.page}: ${p.problem}`);

function page(lang: string, routePath: string, overrides: { canonical?: string; links?: string } = {}): string {
  const canonical = overrides.canonical ?? `${ORIGIN}/${lang}/${routePath}`;
  const links =
    overrides.links ??
    [
      `<link rel="alternate" hreflang="id" href="${ORIGIN}/id/${routePath}">`,
      `<link rel="alternate" hreflang="en" href="${ORIGIN}/en/${routePath}">`,
      `<link rel="alternate" hreflang="x-default" href="${ORIGIN}/id/${routePath}">`,
    ].join('');
  return `<!DOCTYPE html><html><head><link rel="canonical" href="${canonical}">${links}</head></html>`;
}

/** In-memory dist: file → html. */
function check(tree: Record<string, string>) {
  return checkI18nRoutes(Object.keys(tree), (file) => tree[file]!, ORIGIN);
}

describe('fixture dist trees', () => {
  it('clean: every page has its mirror and all links resolve', () => {
    const result = checkI18nRoutesDir(fixture('clean'), ORIGIN);
    expect(messages(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pages).toEqual(['/en/', '/en/proyek/x/', '/id/', '/id/proyek/x/']);
    expect(formatI18nRoutes(result, ORIGIN)).toContain('PASS');
  });

  it('missing mirror: fails naming the page and the missing mirror', () => {
    const result = checkI18nRoutesDir(fixture('missing-mirror'), ORIGIN);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain('/id/x/: missing mirror /en/x/ (expected dist/en/x/index.html)');
    expect(formatI18nRoutes(result, ORIGIN)).toContain('FAIL /id/x/: missing mirror /en/x/');
  });

  it('dangling alternate: fails naming the page and the href', () => {
    const result = checkI18nRoutesDir(fixture('dangling-alternate'), ORIGIN);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      '/id/: alternate hreflang="en" https://jun.example/en/gone/ does not resolve to a file in dist/ (expected dist/en/gone/index.html)',
    );
    expect(result.problems.every((p) => p.page === '/id/')).toBe(true);
  });

  it('wrong canonical: fails when the canonical is not the page itself', () => {
    const result = checkI18nRoutesDir(fixture('wrong-canonical'), ORIGIN);
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual([
      "/en/: canonical https://jun.example/id/ is not the page's own URL https://jun.example/en/",
    ]);
  });

  it('404 twin missing: dist has id/proyek/404.html only → fails naming it, exit 1', () => {
    const result = checkI18nRoutesDir(fixture('missing-404-twin'), ORIGIN);
    expect(messages(result)).toEqual(['id/proyek/404.html: missing 404 twin dist/en/proyek/404.html']);
    const script = path.join(repoRoot, 'scripts/checks/i18n-routes.ts');
    const run = spawnSync(process.execPath, [script, fixture('missing-404-twin'), ORIGIN], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stdout).toContain('FAIL id/proyek/404.html: missing 404 twin dist/en/proyek/404.html');
  }, 30_000);

  it('missing root 404: dist/404.html absent → fails naming it, exit 1', () => {
    const result = checkI18nRoutesDir(fixture('missing-root-404'), ORIGIN);
    expect(messages(result)).toEqual(['404.html: missing root not-found page dist/404.html']);
    const script = path.join(repoRoot, 'scripts/checks/i18n-routes.ts');
    const run = spawnSync(process.execPath, [script, fixture('missing-root-404'), ORIGIN], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stdout).toContain('FAIL 404.html: missing root not-found page dist/404.html');
  }, 30_000);

  it('standalone run exits 1 on failure and 0 on a clean tree', () => {
    const script = path.join(repoRoot, 'scripts/checks/i18n-routes.ts');
    const bad = spawnSync(process.execPath, [script, fixture('missing-mirror'), ORIGIN], { encoding: 'utf8' });
    expect(bad.status, bad.stderr).toBe(1);
    expect(bad.stdout).toContain('FAIL /id/x/: missing mirror /en/x/');
    const good = spawnSync(process.execPath, [script, fixture('clean'), ORIGIN], { encoding: 'utf8' });
    expect(good.status, `${good.stdout}\n${good.stderr}`).toBe(0);
  }, 30_000);
});

describe('checkI18nRoutes', () => {
  const NOINDEX = '<html><head><meta name="robots" content="noindex"></head></html>';
  const clean = { '404.html': NOINDEX, 'id/index.html': page('id', ''), 'en/index.html': page('en', '') };

  it('x-default must point to the id variant', () => {
    const links = [
      `<link rel="alternate" hreflang="id" href="${ORIGIN}/id/">`,
      `<link rel="alternate" hreflang="en" href="${ORIGIN}/en/">`,
      `<link rel="alternate" hreflang="x-default" href="${ORIGIN}/en/">`,
    ].join('');
    const result = check({ ...clean, 'en/index.html': page('en', '', { links }) });
    expect(messages(result)).toEqual([
      '/en/: alternate hreflang="x-default" https://jun.example/en/ should point to https://jun.example/id/',
    ]);
  });

  it('flags missing and duplicate alternates and canonicals', () => {
    const result = check({
      ...clean,
      'id/index.html': `<link rel="canonical" href="${ORIGIN}/id/"><link rel="canonical" href="${ORIGIN}/id/">`,
    });
    expect(messages(result)).toEqual([
      '/id/: expected exactly 1 canonical link, found 2',
      '/id/: expected exactly 1 alternate hreflang="id", found 0',
      '/id/: expected exactly 1 alternate hreflang="en", found 0',
      '/id/: expected exactly 1 alternate hreflang="x-default", found 0',
    ]);
  });

  it('rejects hrefs off the production origin or carrying a query string', () => {
    const offOrigin = check({ ...clean, 'id/index.html': page('id', '', { canonical: 'https://preview.example/id/' }) });
    expect(messages(offOrigin)).toEqual([
      '/id/: canonical https://preview.example/id/ is not on the production origin https://jun.example',
    ]);
    const query = check({ ...clean, 'id/index.html': page('id', '', { canonical: `${ORIGIN}/id/?utm_source=x` }) });
    expect(messages(query)).toEqual(['/id/: canonical https://jun.example/id/?utm_source=x carries a query string or hash']);
  });

  it('flags an unexpected alternate hreflang', () => {
    const extra = `<link rel="alternate" hreflang="fr" href="${ORIGIN}/fr/">`;
    const html = page('id', '').replace('</head>', `${extra}</head>`);
    expect(messages(check({ ...clean, 'id/index.html': html }))).toEqual([
      '/id/: unexpected alternate hreflang="fr" https://jun.example/fr/',
    ]);
  });

  it('flags localized HTML that is not a valid route page, naming the file', () => {
    const result = check({ ...clean, 'id/about.html': '<html></html>', 'en/Bad_Slug/index.html': '<html></html>' });
    expect(messages(result)).toEqual([
      'en/Bad_Slug/index.html: localized HTML is not a valid <lang>/<route>/index.html page',
      'id/about.html: localized HTML is not a valid <lang>/<route>/index.html page',
    ]);
  });

  it('allows per-language 404.html files with their twin and does not count them as pages', () => {
    const result = check({
      ...clean,
      'id/proyek/404.html': NOINDEX,
      'en/proyek/404.html': NOINDEX,
      'id/404.html': NOINDEX,
      'en/404.html': NOINDEX,
    });
    expect(messages(result)).toEqual([]);
    expect(result.pages).toEqual(['/en/', '/id/']);
  });

  it('fails a 404.html without its other-language twin, naming it', () => {
    const result = check({ ...clean, 'id/proyek/404.html': NOINDEX });
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual(['id/proyek/404.html: missing 404 twin dist/en/proyek/404.html']);
    expect(formatI18nRoutes(result, ORIGIN)).toContain('FAIL id/proyek/404.html: missing 404 twin');
  });

  it('fails every per-language 404.html without a noindex robots meta, naming it', () => {
    const indexable = '<html><head><meta name="robots" content="index, follow"></head></html>';
    const result = check({
      ...clean,
      'id/404.html': '<html></html>',
      'en/404.html': NOINDEX,
      'id/proyek/404.html': NOINDEX,
      'en/proyek/404.html': indexable,
    });
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual([
      'en/proyek/404.html: not-found page lacks <meta name="robots" content="noindex">',
      'id/404.html: not-found page lacks <meta name="robots" content="noindex">',
    ]);
  });

  it('fails a missing root 404.html, or one without a noindex robots meta', () => {
    const { '404.html': _root, ...withoutRoot } = clean;
    expect(messages(check(withoutRoot))).toEqual(['404.html: missing root not-found page dist/404.html']);
    expect(messages(check({ ...clean, '404.html': '<html></html>' }))).toEqual([
      '404.html: not-found page lacks <meta name="robots" content="noindex">',
    ]);
  });

  it('hasNoindexMeta reads attributes in any order and the content list', () => {
    expect(hasNoindexMeta(`<meta content='NOINDEX, nofollow' name="Robots">`)).toBe(true);
    expect(hasNoindexMeta('<meta name="robots" content="noindex">')).toBe(true);
    expect(hasNoindexMeta('<meta name="googlebot" content="noindex">')).toBe(false);
    expect(hasNoindexMeta('<meta name="robots" content="index">')).toBe(false);
    expect(hasNoindexMeta('<p>noindex</p>')).toBe(false);
  });

  it('ignores non-localized files and fails an empty dist', () => {
    expect(check({ ...clean, 'robots.txt': '', 'favicon.svg': '' }).ok).toBe(true);
    expect(messages(check({ '404.html': NOINDEX }))).toEqual(['(dist): no /id/ or /en/ pages found']);
  });

  it('parseLinks reads attributes in any order and decodes entities', () => {
    expect(parseLinks(`<link href='https://a.example/x/?a=1&amp;b=2' hreflang=en rel="Alternate">`)).toEqual([
      { rel: 'alternate', href: 'https://a.example/x/?a=1&b=2', hreflang: 'en' },
    ]);
  });
});
