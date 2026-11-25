import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SiteConfig } from '../../config/site.schema.ts';
import { checkI18nRoutesDir } from '../../scripts/checks/i18n-routes.ts';
import { checkSeoDir } from '../../scripts/checks/seo.ts';
import { listFiles } from '../../scripts/budgets/static-assets.ts';
import { isNotFoundPath } from '../../src/seo/sitemap.ts';
import { headersFile, NOINDEX_HEADER_LINE, robotsTxt, writeEnvOutput } from '../../src/integrations/site-env.ts';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const sharedHeaders = readFileSync(path.join(repoRoot, 'public/_headers'), 'utf8');
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'site-env-'));

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const CSP =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const PREVIEW_HEADERS = `/*\n  X-Robots-Tag: noindex\n  Content-Security-Policy: ${CSP}\n`;
const PRODUCTION_ROBOTS =
  'User-agent: *\nAllow: /\nSitemap: https://jun-portfolio.example.workers.dev/sitemap-index.xml\n';

function config(env: SiteConfig['env'], analyticsToken: string | null = null): SiteConfig {
  return {
    env,
    productionOrigin: 'https://jun-portfolio.example.workers.dev',
    mediaBase: '/media',
    analyticsToken,
    features: { hubLinks: false, contact: false },
  };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('public/_headers', () => {
  it('holds exactly the shared CSP for /*', () => {
    expect(sharedHeaders).toBe(`/*\n  Content-Security-Policy: ${CSP}\n`);
  });
});

describe('pure env output', () => {
  it('robots.txt disallows everything outside production', () => {
    expect(robotsTxt(config('preview'))).toBe('User-agent: *\nDisallow: /\n');
    expect(robotsTxt(config('development'))).toBe('User-agent: *\nDisallow: /\n');
    // Story 1.9: production points crawlers at the sitemap index on the production origin.
    expect(robotsTxt(config('production'))).toBe(PRODUCTION_ROBOTS);
    expect(robotsTxt(config('preview'))).not.toContain('Sitemap');
  });

  it('_headers gains X-Robots-Tag: noindex inside the /* rule outside production only', () => {
    expect(headersFile(sharedHeaders, config('preview'))).toBe(PREVIEW_HEADERS);
    expect(headersFile(sharedHeaders, config('development'))).toBe(PREVIEW_HEADERS);
    expect(headersFile(sharedHeaders, config('production'))).toBe(sharedHeaders);
    // Exactly one `/*` rule: a second block would replace the CSP.
    expect(PREVIEW_HEADERS.match(/^\/\*$/gm)).toHaveLength(1);
  });

  it('_headers without a /* rule gets one appended', () => {
    expect(headersFile('', config('preview'))).toBe(`/*\n${NOINDEX_HEADER_LINE}\n`);
    expect(headersFile('/id/*\n  A: b', config('preview'))).toBe(`/id/*\n  A: b\n\n/*\n${NOINDEX_HEADER_LINE}\n`);
    expect(headersFile('/x\n  A: b\n/*\n  C: d\n', config('preview'))).toBe(
      `/x\n  A: b\n/*\n${NOINDEX_HEADER_LINE}\n  C: d\n`,
    );
  });

  it('_headers with CRLF line endings is normalised to LF', () => {
    expect(headersFile('/*\r\n  C: d\r\n', config('preview'))).toBe(`/*\n${NOINDEX_HEADER_LINE}\n  C: d\n`);
  });

  it('writeEnvOutput writes robots.txt and _headers into the dist dir', async () => {
    const dist = path.join(tmpRoot, 'dist-pure');
    mkdirSync(dist);
    writeFileSync(path.join(dist, '_headers'), sharedHeaders);
    await writeEnvOutput(dist, config('preview'));
    expect(readFileSync(path.join(dist, '_headers'), 'utf8')).toContain('X-Robots-Tag: noindex');
    expect(readFileSync(path.join(dist, 'robots.txt'), 'utf8')).toBe('User-agent: *\nDisallow: /\n');

    const empty = path.join(tmpRoot, 'dist-empty');
    mkdirSync(empty);
    await writeEnvOutput(empty, config('production'));
    expect(readFileSync(path.join(empty, '_headers'), 'utf8')).toBe('');
    expect(readFileSync(path.join(empty, 'robots.txt'), 'utf8')).toBe(PRODUCTION_ROBOTS);
  });
});

const outDir = (name: string) => path.join(tmpRoot, name);

/** Real `astro build` of the site into a temp outDir. */
function build(name: string, env: Record<string, string>) {
  const { run, output } = astroBuild(outDir(name), env);
  expect(run.error, output).toBeUndefined();
  expect(run.status, output).toBe(0);
  const read = (file: string) => readFileSync(path.join(outDir(name), file), 'utf8');
  return { read };
}

/** Temp config dir holding only the committed `site.<env>.json` (ignores any developer `site.local.json`). */
function committedConfigDir(env: SiteConfig['env']): string {
  const dir = path.join(tmpRoot, `committed-${env}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, `site.${env}.json`), readFileSync(path.join(repoRoot, `config/site.${env}.json`)));
  return dir;
}

function countBeacons(html: string): number {
  return html.split(`src="${BEACON_SRC}"`).length - 1;
}

describe('astro build per SITE_ENV', () => {
  it('preview: noindex meta, X-Robots-Tag, disallow robots, no beacon', () => {
    const { read } = build('preview', { SITE_ENV: 'preview', SITE_CONFIG_DIR: committedConfigDir('preview') });
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(countBeacons(html)).toBe(0);
      expect(html).not.toMatch(/<style/);
    }
    expect(read('_headers')).toBe(PREVIEW_HEADERS);
    expect(read('robots.txt')).toBe('User-agent: *\nDisallow: /\n');
    expect(read('_redirects')).toBe('/ /id/ 301\n/proyek/* /id/proyek/:splat 301\n');
    // Story 1.6: the empty-archive pages are moved into place, noindex even in production builds (below).
    // Story 1.8: so are the site-wide per-language not-found pages.
    for (const lang of ['id', 'en']) {
      for (const dir of ['', 'proyek/']) {
        expect(existsSync(path.join(outDir('preview'), lang, `${dir}404.html`)), `${lang}/${dir}`).toBe(true);
        expect(existsSync(path.join(outDir('preview'), lang, `${dir}404`)), `${lang}/${dir}`).toBe(false);
      }
    }
    // Story 1.4: canonical/alternates stay on the production origin in preview builds.
    const origin = JSON.parse(readFileSync(path.join(repoRoot, 'config/site.preview.json'), 'utf8')).productionOrigin;
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      expect(html).toContain(`<link rel="canonical" href="${origin}/${lang}/">`);
      expect(html).toContain(`<link rel="alternate" hreflang="id" href="${origin}/id/">`);
      expect(html).toContain(`<link rel="alternate" hreflang="en" href="${origin}/en/">`);
      expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${origin}/id/">`);
    }
    const routes = checkI18nRoutesDir(outDir('preview'), origin);
    expect(routes.problems).toEqual([]);
    // The unmirrored top-level 404 carries neither canonical nor alternates.
    expect(read('404.html')).not.toMatch(/rel="(canonical|alternate)"/);

    // Story 1.9 (matrix "Preview build"): sitemap, canonical and JSON-LD on the
    // production origin; robots disallow-all without a Sitemap line.
    expect(read('robots.txt')).not.toContain('Sitemap');
    const seo = checkSeoDir(outDir('preview'), origin, false);
    expect(seo.problems).toEqual([]);
    expect(seo.personPages.sort()).toEqual(['en/index.html', 'id/index.html']);
    expect(read('sitemap-index.xml')).toContain(`<loc>${origin}/sitemap-0.xml</loc>`);
    const sitemap = read('sitemap-0.xml');
    const projects = readdirSync(path.join(repoRoot, 'content/projects')).filter((f) => f.endsWith('.yaml'));
    const expectedPages = ['id', 'en'].flatMap((lang) => [
      `${origin}/${lang}/`,
      `${origin}/${lang}/privasi/`,
      ...projects.map((f) => `${origin}/${lang}/proyek/${f.replace(/\.yaml$/, '')}/`),
    ]);
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort()).toEqual(expectedPages.sort());
    for (const page of expectedPages) {
      const routePath = page.slice(origin.length + 4);
      const entry = sitemap.match(new RegExp(`<url><loc>${page.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</loc>[\\s\\S]*?</url>`))?.[0];
      expect(entry, page).toBeDefined();
      expect(entry).toContain(`<xhtml:link rel="alternate" hreflang="id" href="${origin}/id/${routePath}"/>`);
      expect(entry).toContain(`<xhtml:link rel="alternate" hreflang="en" href="${origin}/en/${routePath}"/>`);
    }
    for (const [, loc] of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) expect(isNotFoundPath(loc!), loc).toBe(false);
    expect(sitemap).not.toMatch(/localhost|127\.0\.0\.1/);

    // Titles keep "{page} — Jujun Setiawan" (homes: "Jujun Setiawan"); each home has one H1 with the name.
    const htmlFiles = listFiles(outDir('preview'))
      .map((file) => file.path)
      .filter((file) => file.endsWith('.html'));
    expect(htmlFiles.length).toBeGreaterThanOrEqual(15);
    for (const file of htmlFiles) {
      const html = read(file);
      const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]!);
      expect(titles, file).toHaveLength(1);
      expect(titles[0], file).toContain('Jujun Setiawan');
      // Story 1.9: every page has exactly one non-empty meta description.
      const descriptions = [...html.matchAll(/<meta name="description" content="([^"]*)">/g)].map((m) => m[1]!);
      expect(descriptions, file).toHaveLength(1);
      expect(descriptions[0]!.trim(), file).not.toBe('');
    }
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      expect(html).toContain('<title>Jujun Setiawan</title>');
      const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1]!);
      expect(h1s, lang).toHaveLength(1);
      expect(h1s[0]).toContain('Jujun Setiawan');
    }
  }, 120_000);

  it('production with a token: no noindex, allow robots, exactly one beacon', () => {
    const dir = path.join(tmpRoot, 'config-token');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'site.production.json'), JSON.stringify(config('production', 'test-token-123')));
    const { read } = build('production-token', { SITE_ENV: 'production', SITE_CONFIG_DIR: dir });
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      expect(html).not.toContain('noindex');
      expect(countBeacons(html)).toBe(1);
      expect(html).toMatch(
        /<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon="\{&quot;token&quot;:&quot;test-token-123&quot;\}"><\/script>/,
      );
    }
    expect(read('_headers')).toBe(sharedHeaders);
    expect(read('_headers')).not.toContain('X-Robots-Tag');
    expect(read('robots.txt')).toBe(PRODUCTION_ROBOTS);
    // Story 1.6: project pages are indexable in production; the empty archive never is.
    expect(read('id/proyek/sistem-order-distribusi/index.html')).not.toContain('noindex');
    // Story 1.8: every not-found page (root and per language) is noindex in production too.
    for (const file of ['404.html', 'id/404.html', 'en/404.html', 'id/proyek/404.html', 'en/proyek/404.html']) {
      const html = read(file);
      expect(html.match(/<meta name="robots" content="noindex">/g), file).toHaveLength(1);
      expect(html, file).not.toMatch(/rel="(canonical|alternate)"/);
    }
    expect(read('id/404.html')).toContain('<html lang="id"');
    expect(read('en/404.html')).toContain('<html lang="en"');
    expect(read('404.html')).toContain('<html lang="id"');
  }, 120_000);

  it('production with a null token (committed config): no beacon', () => {
    const { read } = build('production-null', {
      SITE_ENV: 'production',
      SITE_CONFIG_DIR: committedConfigDir('production'),
    });
    const html = read('id/index.html');
    expect(html).not.toContain('noindex');
    expect(countBeacons(html)).toBe(0);
    // Story 1.9: the committed production origin in the Sitemap line, and a clean SEO check.
    const origin = JSON.parse(readFileSync(path.join(repoRoot, 'config/site.production.json'), 'utf8')).productionOrigin;
    expect(read('robots.txt')).toBe(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap-index.xml\n`);
    expect(checkSeoDir(outDir('production-null'), origin, true).problems).toEqual([]);
  }, 120_000);
});
