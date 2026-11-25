// Story 1.9 SEO: profile schema and single-entry rule, the committed profile,
// the Person JSON-LD builder, the sitemap filter, robots per env, the SEO
// build check (fixtures), no literals in pages/layouts, and a real build that
// fails on an empty `sameAs`. The check against real preview/production builds
// lives in site-env-output.test.ts (it reuses those builds).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SiteConfig } from '../../config/site.schema.ts';
import { checkSeo, jsonLdBlocks } from '../../scripts/checks/seo.ts';
import { ContentIntegrityError, singleProfileEntry } from '../../src/content/integrity.ts';
import { formatIssues, profileSchema } from '../../src/content/schemas.ts';
import { robotsTxt } from '../../src/integrations/site-env.ts';
import { personJsonLd, serializeJsonLd } from '../../src/seo/person.ts';
import { isNotFoundPath, SITEMAP_I18N, sitemapFilter } from '../../src/seo/sitemap.ts';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const ORIGIN = 'https://jun.example.workers.dev';

function validProfile() {
  return {
    dummy: true,
    name: 'Jujun Setiawan',
    jobTitle: { id: 'Product Engineer', en: 'Product Engineer' },
    sameAs: ['https://github.com/jujunsetiawan', 'https://www.linkedin.com/in/jujunsetiawan'],
  };
}

function issuesFor(data: unknown): string[] {
  const result = profileSchema.safeParse(data);
  expect(result.success, 'expected the entry to be rejected').toBe(false);
  return formatIssues('profile', result.error!);
}

// ---------- Profile ----------

describe('profile schema', () => {
  it('a valid entry parses; dummy defaults to false', () => {
    expect(profileSchema.parse(validProfile()).name).toBe('Jujun Setiawan');
    const { dummy: _dummy, ...withoutDummy } = validProfile();
    expect(profileSchema.parse(withoutDummy).dummy).toBe(false);
  });

  it('matrix: empty sameAs fails naming the field', () => {
    expect(issuesFor({ ...validProfile(), sameAs: [] })).toEqual(['profile: sameAs — must be a non-empty list']);
  });

  it('matrix: relative sameAs fails naming the field', () => {
    expect(issuesFor({ ...validProfile(), sameAs: ['/me'] })).toEqual(['profile: sameAs.0 — must be an absolute https URL']);
  });

  it('http or non-URL sameAs entries fail', () => {
    expect(issuesFor({ ...validProfile(), sameAs: ['https://ok.example', 'http://github.com/x'] })).toEqual([
      'profile: sameAs.1 — must be an absolute https URL',
    ]);
    expect(issuesFor({ ...validProfile(), sameAs: ['github.com/x'] })).toEqual(['profile: sameAs.0 — must be an absolute https URL']);
  });

  it('a missing sameAs fails', () => {
    const { sameAs: _sameAs, ...rest } = validProfile();
    expect(issuesFor(rest)).toEqual(['profile: sameAs — is required']);
  });

  it('missing language: jobTitle without en (or id) fails naming the field', () => {
    expect(issuesFor({ ...validProfile(), jobTitle: { id: 'Product Engineer' } })).toEqual(['profile: jobTitle.en — is required']);
    expect(issuesFor({ ...validProfile(), jobTitle: { en: 'Product Engineer' } })).toEqual(['profile: jobTitle.id — is required']);
    expect(issuesFor({ ...validProfile(), jobTitle: { id: ' ', en: 'x' } })).toEqual([
      'profile: jobTitle.id — must be a non-empty string',
    ]);
  });

  it('an empty name and unknown keys are rejected', () => {
    expect(issuesFor({ ...validProfile(), name: '' })).toEqual(['profile: name — must be a non-empty string']);
    expect(profileSchema.safeParse({ ...validProfile(), url: 'https://x.example/' }).success).toBe(false);
  });
});

describe('matrix: zero or two profile entries', () => {
  it('one entry is returned', () => {
    expect(singleProfileEntry([{ id: 'profile' }])).toEqual({ id: 'profile' });
  });

  it('zero entries fail naming the expected file', () => {
    expect(() => singleProfileEntry([])).toThrow(ContentIntegrityError);
    expect(() => singleProfileEntry([])).toThrow('profile: (collection) — missing entry (expected content/profile/profile.yaml)');
  });

  it('two entries fail naming both', () => {
    expect(() => singleProfileEntry([{ id: 'profile' }, { id: 'extra' }])).toThrow(
      'profile → extra, profile: (collection) — expected exactly 1 entry, found 2',
    );
  });
});

describe('committed content/profile/profile.yaml', () => {
  const raw = parseYaml(readFileSync(path.join(repoRoot, 'content/profile/profile.yaml'), 'utf8'));

  it('parses and carries the specified dummy values', () => {
    const result = profileSchema.safeParse(raw);
    expect(result.success ? [] : formatIssues('profile', result.error), 'profile').toEqual([]);
    const profile = profileSchema.parse(raw);
    expect(profile.name).toBe('Jujun Setiawan');
    if (profile.dummy) {
      expect(profile.jobTitle).toEqual({ id: 'Product Engineer', en: 'Product Engineer' });
      expect(profile.sameAs).toEqual(['https://github.com/jujunsetiawan', 'https://www.linkedin.com/in/jujunsetiawan']);
    }
  });
});

// ---------- JSON-LD builder ----------

describe('personJsonLd', () => {
  it('builds the Person for each language home with url on the origin', () => {
    const profile = { ...validProfile(), jobTitle: { id: 'Insinyur Produk', en: 'Product Engineer' } };
    expect(personJsonLd(profile, 'id', ORIGIN)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: 'Jujun Setiawan',
      jobTitle: 'Insinyur Produk',
      url: `${ORIGIN}/id/`,
      sameAs: validProfile().sameAs,
    });
    expect(personJsonLd(profile, 'en', ORIGIN)).toMatchObject({ jobTitle: 'Product Engineer', url: `${ORIGIN}/en/` });
  });

  it('throws on a missing required property', () => {
    expect(() => personJsonLd({ ...validProfile(), name: ' ' }, 'id', ORIGIN)).toThrow('name must be a non-empty string');
    expect(() => personJsonLd({ ...validProfile(), jobTitle: { id: 'x' } as never }, 'en', ORIGIN)).toThrow(
      'jobTitle.en must be a non-empty string',
    );
    expect(() => personJsonLd({ ...validProfile(), sameAs: [] }, 'id', ORIGIN)).toThrow('sameAs must be a non-empty list');
    expect(() => personJsonLd(validProfile(), 'id', '')).toThrow('origin must be a non-empty string');
  });

  it('serializeJsonLd escapes every "<" so no value can close the script', () => {
    const data = personJsonLd({ ...validProfile(), name: 'Jun</script><script>alert(1)</script><!--' }, 'id', ORIGIN);
    const json = serializeJsonLd(data);
    expect(json).not.toContain('<');
    expect(json).toContain('\\u003c/script>');
    expect(JSON.parse(json)).toEqual(data);
    expect(json.startsWith('{"@context":"https://schema.org","@type":"Person"')).toBe(true);
  });
});

// ---------- Sitemap filter and robots ----------

describe('sitemap filter', () => {
  it('uses id (default) and en locales', () => {
    expect(SITEMAP_I18N).toEqual({ defaultLocale: 'id', locales: { id: 'id', en: 'en' } });
  });

  it('excludes every not-found page, in directory and .html form', () => {
    for (const p of ['/404/', '/404.html', '/id/404/', '/en/404.html', '/id/proyek/404/', '/en/proyek/404.html']) {
      expect(isNotFoundPath(p), p).toBe(true);
      expect(sitemapFilter(`${ORIGIN}${p}`), p).toBe(false);
    }
  });

  it('keeps real pages', () => {
    for (const p of ['/id/', '/en/', '/id/privasi/', '/en/proyek/sistem-order-distribusi/', '/id/proyek/404-tips/', '/id/x/404/']) {
      expect(sitemapFilter(`${ORIGIN}${p}`), p).toBe(true);
    }
  });
});

function siteConfig(env: SiteConfig['env']): SiteConfig {
  return { env, productionOrigin: ORIGIN, mediaBase: '/media', analyticsToken: null, features: { hubLinks: false, contact: false } };
}

describe('robots.txt per env', () => {
  it('production: allow all and the sitemap index on the production origin', () => {
    expect(robotsTxt(siteConfig('production'))).toBe(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap-index.xml\n`);
  });

  it('preview and development: disallow all, no Sitemap line', () => {
    for (const env of ['preview', 'development'] as const) {
      expect(robotsTxt(siteConfig(env))).toBe('User-agent: *\nDisallow: /\n');
    }
  });
});

// ---------- SEO check (fixtures) ----------

const PAGES = ['', 'privasi/', 'proyek/x/'];
const LANGS = ['id', 'en'] as const;

function head(lang: string, route: string, extra = '', origin = ORIGIN): string {
  return (
    `<html lang="${lang}"><head><title>T — Jujun Setiawan</title><meta name="description" content="d">` +
    `<link rel="canonical" href="${origin}/${lang}/${route}">` +
    `<link rel="alternate" hreflang="id" href="${origin}/id/${route}">` +
    `<link rel="alternate" hreflang="en" href="${origin}/en/${route}">` +
    `<link rel="alternate" hreflang="x-default" href="${origin}/id/${route}">${extra}</head><body></body></html>`
  );
}

function person(lang: string, origin = ORIGIN): string {
  const data = personJsonLd(validProfile(), lang as 'id' | 'en', origin);
  return `<script type="application/ld+json">${serializeJsonLd(data)}</script>`;
}

function sitemapUrl(route: string, origin = ORIGIN): string {
  const links = LANGS.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${origin}/${l}/${route}"/>`).join('');
  return LANGS.map((lang) => `<url><loc>${origin}/${lang}/${route}</loc>${links}</url>`).join('');
}

function cleanDist(): Record<string, string> {
  const files: Record<string, string> = {
    '404.html': '<html><head><meta name="robots" content="noindex"></head></html>',
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    'sitemap-index.xml': `<?xml version="1.0"?><sitemapindex><sitemap><loc>${ORIGIN}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    'sitemap-0.xml': `<?xml version="1.0"?><urlset>${PAGES.map((p) => sitemapUrl(p)).join('')}</urlset>`,
  };
  for (const lang of LANGS) {
    for (const route of PAGES) files[`${lang}/${route}index.html`] = head(lang, route, route === '' ? person(lang) : '');
    files[`${lang}/404.html`] = '<html><head><meta name="robots" content="noindex"></head></html>';
    files[`${lang}/proyek/404.html`] = '<html><head><meta name="robots" content="noindex"></head></html>';
  }
  return files;
}

function check(files: Record<string, string>, indexable = false) {
  return checkSeo(Object.keys(files), (file) => files[file]!, ORIGIN, indexable);
}

const messages = (files: Record<string, string>, indexable = false) =>
  check(files, indexable).problems.map((p) => `${p.file}: ${p.problem}`);
const PROD_ROBOTS = `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap-index.xml\n`;

describe('checkSeo', () => {
  it('fixture clean: passes', () => {
    const result = check(cleanDist());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.sitemapUrls).toHaveLength(6);
    expect(result.personPages.sort()).toEqual(['en/index.html', 'id/index.html']);
  });

  it('production robots with the right Sitemap line passes; a wrong one fails', () => {
    expect(check({ ...cleanDist(), 'robots.txt': PROD_ROBOTS }, true).ok).toBe(true);
    expect(
      messages({ ...cleanDist(), 'robots.txt': 'Sitemap: https://pr-3.preview.workers.dev/sitemap-index.xml\n' }, true),
    ).toEqual([`robots.txt: Sitemap: https://pr-3.preview.workers.dev/sitemap-index.xml should be ${ORIGIN}/sitemap-index.xml`]);
  });

  it('production robots without the Sitemap line (or with two) fails', () => {
    expect(messages({ ...cleanDist(), 'robots.txt': 'User-agent: *\nAllow: /\n' }, true)).toEqual([
      `robots.txt: expected exactly 1 "Sitemap: ${ORIGIN}/sitemap-index.xml" line, found 0`,
    ]);
    expect(messages({ ...cleanDist(), 'robots.txt': `${PROD_ROBOTS}Sitemap: ${ORIGIN}/sitemap-index.xml\n` }, true)).toEqual([
      `robots.txt: expected exactly 1 "Sitemap: ${ORIGIN}/sitemap-index.xml" line, found 2`,
    ]);
  });

  it('preview robots with a Sitemap line fails, even on the production origin', () => {
    expect(messages({ ...cleanDist(), 'robots.txt': `User-agent: *\nDisallow: /\nSitemap: ${ORIGIN}/sitemap-index.xml\n` })).toEqual([
      'robots.txt: non-indexable build must have no Sitemap line, found 1',
    ]);
  });

  it('a missing robots.txt fails in every env', () => {
    const { 'robots.txt': _robots, ...files } = cleanDist();
    expect(messages(files)).toEqual(['robots.txt: missing dist/robots.txt']);
    expect(messages(files, true)).toEqual(['robots.txt: missing dist/robots.txt']);
  });

  it('a JSON-LD block that is not an object fails without crashing', () => {
    for (const body of ['null', '42', '"x"', '[]']) {
      const files = { ...cleanDist(), 'id/index.html': head('id', '', `<script type="application/ld+json">${body}</script>`) };
      expect(messages(files), body).toEqual(['id/index.html: JSON-LD must be an object']);
    }
  });

  describe('fixture preview-origin leak', () => {
    const LEAK = 'https://pr-7-jun-portfolio.preview.workers.dev';

    it('fails a canonical/alternate on another origin', () => {
      const files = { ...cleanDist(), 'en/privasi/index.html': head('en', 'privasi/', '', LEAK) };
      const result = messages(files);
      expect(result).toContain(`en/privasi/index.html: canonical ${LEAK}/en/privasi/ is not on the production origin ${ORIGIN}`);
      expect(result).toContain(
        `en/privasi/index.html: alternate hreflang="x-default" ${LEAK}/id/privasi/ is not on the production origin ${ORIGIN}`,
      );
      expect(result).toHaveLength(4);
    });

    it('fails a JSON-LD url on another origin', () => {
      const files = { ...cleanDist(), 'id/index.html': head('id', '', person('id', LEAK)) };
      expect(messages(files)).toEqual([
        `id/index.html: JSON-LD url "${LEAK}/id/" is not on the production origin ${ORIGIN}`,
      ]);
    });

    it('fails sitemap <loc> and xhtml:link on another origin', () => {
      const files = cleanDist();
      files['sitemap-0.xml'] = files['sitemap-0.xml']!.replace(
        `<url><loc>${ORIGIN}/en/privasi/</loc>`,
        `<url><loc>${LEAK}/en/privasi/</loc>`,
      ).replace(`hreflang="id" href="${ORIGIN}/id/proyek/x/"`, `hreflang="id" href="${LEAK}/id/proyek/x/"`);
      const result = messages(files);
      expect(result).toContain(`sitemap-0.xml: <loc> ${LEAK}/en/privasi/ is not on the production origin ${ORIGIN}`);
      expect(result).toContain(`sitemap-index.xml: sitemap is missing page ${ORIGIN}/en/privasi/`);
      expect(result).toContain(
        `sitemap-0.xml: xhtml:link hreflang="id" ${LEAK}/id/proyek/x/ of ${ORIGIN}/id/proyek/x/ is not on the production origin ${ORIGIN}`,
      );
    });

    it('fails a sitemap index pointing elsewhere', () => {
      const files = { ...cleanDist(), 'sitemap-index.xml': `<sitemapindex><sitemap><loc>${LEAK}/sitemap-0.xml</loc></sitemap></sitemapindex>` };
      expect(messages(files)).toContain(`sitemap-index.xml: <loc> ${LEAK}/sitemap-0.xml is not on the production origin ${ORIGIN}`);
      expect(check(files).ok).toBe(false);
    });
  });

  it('fixture 404 in sitemap: fails', () => {
    const files = cleanDist();
    files['sitemap-0.xml'] = files['sitemap-0.xml']!.replace(
      '</urlset>',
      `<url><loc>${ORIGIN}/id/proyek/404/</loc></url><url><loc>${ORIGIN}/404.html</loc></url></urlset>`,
    );
    expect(messages(files)).toEqual([
      `sitemap-0.xml: <loc> ${ORIGIN}/id/proyek/404/ is a not-found page`,
      `sitemap-0.xml: <loc> ${ORIGIN}/404.html is a not-found page`,
    ]);
  });

  it('standalone CLI: exit 1 with a 404 in the sitemap, exit 0 when clean', () => {
    const write = (name: string, files: Record<string, string>) => {
      const dir = path.join(tmpRoot, name);
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), text);
      }
      return dir;
    };
    const script = path.join(repoRoot, 'scripts/checks/seo.ts');
    const broken = cleanDist();
    broken['sitemap-0.xml'] = broken['sitemap-0.xml']!.replace('</urlset>', `<url><loc>${ORIGIN}/en/404/</loc></url></urlset>`);
    const bad = spawnSync(process.execPath, [script, write('cli-404', broken), ORIGIN], { encoding: 'utf8' });
    expect(bad.status, bad.stdout + bad.stderr).toBe(1);
    expect(bad.stdout).toContain(`FAIL sitemap-0.xml: <loc> ${ORIGIN}/en/404/ is a not-found page`);
    const good = spawnSync(process.execPath, [script, write('cli-clean', cleanDist()), ORIGIN], { encoding: 'utf8' });
    expect(good.status, good.stdout + good.stderr).toBe(0);
  });

  it('fixture duplicate Person: fails', () => {
    const files = { ...cleanDist(), 'en/index.html': head('en', '', person('en') + person('en')) };
    expect(messages(files)).toEqual(['en/index.html: expected exactly 1 Person JSON-LD, found 2 JSON-LD block(s)']);
  });

  it('fails JSON-LD on a non-home page and a home without it', () => {
    const files = {
      ...cleanDist(),
      'id/proyek/x/index.html': head('id', 'proyek/x/', person('id')),
      'id/proyek/404.html': `<html><head>${person('id')}</head></html>`,
      'en/index.html': head('en', ''),
    };
    expect(messages(files)).toEqual([
      'en/index.html: expected exactly 1 Person JSON-LD, found 0 JSON-LD block(s)',
      'id/proyek/404.html: expected no JSON-LD outside the language homes, found 1',
      'id/proyek/x/index.html: expected no JSON-LD outside the language homes, found 1',
    ]);
  });

  it('fails a Person with wrong type, missing props or the other language url', () => {
    const bad = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: '',
      url: `${ORIGIN}/en/`,
      sameAs: [],
    })}</script>`;
    expect(messages({ ...cleanDist(), 'id/index.html': head('id', '', bad) })).toEqual([
      'id/index.html: JSON-LD @type must be "Person", got "Organization"',
      'id/index.html: JSON-LD name must be a non-empty string',
      'id/index.html: JSON-LD jobTitle must be a non-empty string',
      `id/index.html: JSON-LD url ${ORIGIN}/en/ should be ${ORIGIN}/id/`,
      'id/index.html: JSON-LD sameAs must be a non-empty list of URLs',
    ]);
    expect(messages({ ...cleanDist(), 'id/index.html': head('id', '', '<script type="application/ld+json">{</script>') })[0]).toMatch(
      /^id\/index\.html: JSON-LD is not valid JSON/,
    );
  });

  it('fails a sitemap missing a page, listing an extra one, or lacking alternates', () => {
    const files = cleanDist();
    files['sitemap-0.xml'] = files['sitemap-0.xml']!
      .replace(`<url><loc>${ORIGIN}/id/proyek/x/</loc>`, `<url><loc>${ORIGIN}/id/proyek/y/</loc>`)
      .replace(/<xhtml:link rel="alternate" hreflang="en" href="[^"]*\/en\/privasi\/"\/>/g, '');
    const result = messages(files);
    expect(result).toContain(`sitemap-index.xml: sitemap is missing page ${ORIGIN}/id/proyek/x/`);
    expect(result).toContain(`sitemap-index.xml: sitemap lists ${ORIGIN}/id/proyek/y/, which is not a page in dist/`);
    expect(result).toContain(`sitemap-0.xml: ${ORIGIN}/id/proyek/y/: xhtml:link hreflang="id" ${ORIGIN}/id/proyek/x/ should be ${ORIGIN}/id/proyek/y/`);
    expect(result).toContain(`sitemap-0.xml: ${ORIGIN}/id/privasi/: expected exactly 1 xhtml:link hreflang="en", found 0`);
  });

  it('fails a missing sitemap index', () => {
    const { 'sitemap-index.xml': _index, ...files } = cleanDist();
    expect(messages(files)).toEqual(['sitemap-index.xml: missing sitemap index dist/sitemap-index.xml']);
  });

  it('jsonLdBlocks only reads ld+json scripts', () => {
    expect(jsonLdBlocks(`<script src="/a.js"></script><script type='application/ld+json'>{"a":1}</script><script>x</script>`)).toEqual([
      '{"a":1}',
    ]);
  });
});

// ---------- No literals ----------

describe('no SEO literals in pages, components or layouts', () => {
  it('descriptions, job title and profile URLs come from content', () => {
    for (const file of [
      'src/pages/[lang]/index.astro',
      'src/pages/[lang]/privasi.astro',
      'src/pages/[lang]/proyek/[slug].astro',
      'src/pages/[lang]/proyek/404.astro',
      'src/components/NotFound.astro',
      'src/layouts/BaseLayout.astro',
      'src/layouts/StaticLayout.astro',
      'src/seo/person.ts',
    ]) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, file).not.toMatch(/Jujun Setiawan|Portofolio|Portfolio of|Product Engineer|github\.com|linkedin\.com|workers\.dev/);
    }
  });
});

// ---------- Real build ----------

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'seo-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('profile build failures', () => {
  it('matrix: an empty sameAs fails astro build naming entry + field', () => {
    const dir = path.join(tmpRoot, 'content-empty-same-as');
    cpSync(path.join(repoRoot, 'content'), dir, { recursive: true });
    const file = path.join(dir, 'profile/profile.yaml');
    const source = readFileSync(file, 'utf8');
    const broken = source.replace(/sameAs:\r?\n(?:\s+- .*\r?\n?)+/, 'sameAs: []\n');
    expect(broken).not.toBe(source);
    writeFileSync(file, broken);
    const { run, output } = astroBuild(
      path.join(tmpRoot, 'dist-empty-same-as'),
      { SITE_ENV: 'development', CONTENT_DIR: dir },
      { freshContentStore: true },
    );
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).not.toBe(0);
    expect(output).toMatch(/profile → profile/);
    expect(output).toMatch(/sameAs/);
    expect(output).toMatch(/must be a non-empty list/);
  }, 180_000);
});
