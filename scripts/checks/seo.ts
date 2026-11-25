// SEO check over a built dist/ (Story 1.9).
//
// Whatever SITE_ENV built dist/, every SEO URL must be on the configured
// production origin:
// - every canonical and hreflang alternate `<link>` in every HTML file;
// - the Person JSON-LD `url` on the language homes;
// - every `<loc>` in `sitemap-index.xml` and the sitemaps it lists, and every
//   `xhtml:link` alternate in them;
// - `robots.txt` must exist; an indexable (production) build has exactly one
//   `Sitemap: <origin>/sitemap-index.xml` line, any other build none.
// It also checks that the sitemap lists exactly the site's pages (every
// `**/index.html` in dist/), never a not-found page, each with one `id` and one
// `en` alternate pointing at the mirrored URLs, and that each language home
// carries exactly one Person JSON-LD (`@context`, `@type`, `name`,
// `jobTitle`, `url` = `<origin>/<lang>/`, non-empty `sameAs`) while no other
// page carries any JSON-LD.
// Pure core (`checkSeo`) plus a disk wrapper; wired into `npm run budgets`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, type Locale } from '../../src/content/schemas.ts';
import { isLocale, localePath, parseLocalePath } from '../../src/i18n/routes.ts';
import { PERSON_REQUIRED_PROPS } from '../../src/seo/person.ts';
import { isNotFoundPath, SITEMAP_INDEX } from '../../src/seo/sitemap.ts';
import { listFiles } from '../budgets/static-assets.ts';
import { decodeEntities, parseLinks, tagAttrs } from './i18n-routes.ts';

export interface SeoProblem {
  /** dist-relative file (or sitemap URL) the problem is about. */
  file: string;
  problem: string;
}

export interface SeoResult {
  /** Page URLs listed in the sitemap. */
  sitemapUrls: string[];
  /** Language homes carrying a valid Person JSON-LD. */
  personPages: string[];
  problems: SeoProblem[];
  ok: boolean;
}

/** Bodies of every `<script type="application/ld+json">` in the document. */
export function jsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if ((tagAttrs(`<script ${match[1]!}>`).type ?? '').trim().toLowerCase() === 'application/ld+json') {
      blocks.push(match[2]!);
    }
  }
  return blocks;
}

/** `<lang>` of a language home file (`<lang>/index.html`); null otherwise. */
function homeLang(file: string): Locale | null {
  const lang = /^([^/]+)\/index\.html$/.exec(file)?.[1];
  return lang !== undefined && isLocale(lang) ? lang : null;
}

/** Text of every `<loc>` element (entity-decoded, trimmed). */
function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => decodeEntities(m[1]!.trim()));
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Pure check. `files` are dist-relative paths with forward slashes; `read`
 * returns a file's text; `origin` is the bare production origin; `indexable`
 * is `isIndexable(siteConfig)` of the env that built dist/.
 */
export function checkSeo(
  files: readonly string[],
  read: (file: string) => string,
  origin: string,
  indexable: boolean,
): SeoResult {
  const fileSet = new Set(files);
  const problems: SeoProblem[] = [];
  const personPages: string[] = [];
  const onOrigin = (url: string | undefined): boolean => url !== undefined && url.startsWith(`${origin}/`);
  const report = (file: string, problem: string) => problems.push({ file, problem });

  // ---------- HTML: canonical/alternates and JSON-LD ----------
  for (const file of [...files].filter((f) => f.endsWith('.html')).sort()) {
    const html = read(file);
    for (const link of parseLinks(html)) {
      if (link.rel !== 'canonical' && link.rel !== 'alternate') continue;
      if (!onOrigin(link.href)) {
        const label = link.rel === 'canonical' ? 'canonical' : `alternate hreflang="${link.hreflang ?? ''}"`;
        report(file, `${label} ${link.href ?? '(no href)'} is not on the production origin ${origin}`);
      }
    }

    const blocks = jsonLdBlocks(html);
    const lang = homeLang(file);
    if (lang === null) {
      if (blocks.length > 0) report(file, `expected no JSON-LD outside the language homes, found ${blocks.length}`);
      continue;
    }
    if (blocks.length !== 1) {
      report(file, `expected exactly 1 Person JSON-LD, found ${blocks.length} JSON-LD block(s)`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[0]!);
    } catch (error) {
      report(file, `JSON-LD is not valid JSON (${(error as Error).message})`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      report(file, 'JSON-LD must be an object');
      continue;
    }
    const data = parsed as Record<string, unknown>;
    const before = problems.length;
    if (data['@context'] !== 'https://schema.org') report(file, `JSON-LD @context must be "https://schema.org"`);
    if (data['@type'] !== 'Person') report(file, `JSON-LD @type must be "Person", got ${JSON.stringify(data['@type'])}`);
    for (const prop of PERSON_REQUIRED_PROPS) {
      if (!nonEmptyString(data[prop])) report(file, `JSON-LD ${prop} must be a non-empty string`);
    }
    const url = data.url;
    const expectedUrl = `${origin}${localePath(lang, '')}`;
    if (nonEmptyString(url)) {
      if (!onOrigin(url)) report(file, `JSON-LD url ${JSON.stringify(url)} is not on the production origin ${origin}`);
      else if (url !== expectedUrl) report(file, `JSON-LD url ${url} should be ${expectedUrl}`);
    }
    const sameAs = data.sameAs;
    if (!Array.isArray(sameAs) || sameAs.length === 0 || !sameAs.every(nonEmptyString)) {
      report(file, 'JSON-LD sameAs must be a non-empty list of URLs');
    }
    if (problems.length === before) personPages.push(file);
  }

  // ---------- Sitemap ----------
  const sitemapUrls: string[] = [];
  if (!fileSet.has(SITEMAP_INDEX)) {
    report(SITEMAP_INDEX, `missing sitemap index dist/${SITEMAP_INDEX}`);
  } else {
    const sitemaps = locs(read(SITEMAP_INDEX));
    if (sitemaps.length === 0) report(SITEMAP_INDEX, 'lists no sitemap');
    for (const loc of sitemaps) {
      if (!onOrigin(loc)) {
        report(SITEMAP_INDEX, `<loc> ${loc} is not on the production origin ${origin}`);
        continue;
      }
      const sitemapFile = loc.slice(origin.length + 1);
      if (!fileSet.has(sitemapFile)) {
        report(SITEMAP_INDEX, `<loc> ${loc} does not resolve to a file in dist/ (expected dist/${sitemapFile})`);
        continue;
      }
      for (const entry of read(sitemapFile).match(/<url>[\s\S]*?<\/url>/g) ?? []) {
        const [pageUrl] = locs(entry);
        if (pageUrl === undefined) {
          report(sitemapFile, '<url> without <loc>');
          continue;
        }
        if (!onOrigin(pageUrl)) {
          report(sitemapFile, `<loc> ${pageUrl} is not on the production origin ${origin}`);
          continue;
        }
        sitemapUrls.push(pageUrl);
        const urlPath = pageUrl.slice(origin.length);
        if (isNotFoundPath(urlPath)) {
          report(sitemapFile, `<loc> ${pageUrl} is a not-found page`);
          continue;
        }

        const links = (entry.match(/<xhtml:link\b[^>]*>/g) ?? []).map(tagAttrs);
        for (const link of links) {
          if (!onOrigin(link.href)) {
            report(sitemapFile, `xhtml:link hreflang="${link.hreflang ?? ''}" ${link.href ?? '(no href)'} of ${pageUrl} is not on the production origin ${origin}`);
          } else if (isNotFoundPath(link.href!.slice(origin.length))) {
            report(sitemapFile, `xhtml:link ${link.href} of ${pageUrl} is a not-found page`);
          }
        }
        const parsed = parseLocalePath(urlPath);
        if (parsed === null) continue;
        for (const lang of LOCALES) {
          const matches = links.filter((link) => link.hreflang === lang);
          const expected = `${origin}${localePath(lang, parsed.path)}`;
          if (matches.length !== 1) {
            report(sitemapFile, `${pageUrl}: expected exactly 1 xhtml:link hreflang="${lang}", found ${matches.length}`);
          } else if (matches[0]!.href !== expected) {
            report(sitemapFile, `${pageUrl}: xhtml:link hreflang="${lang}" ${matches[0]!.href} should be ${expected}`);
          }
        }
      }
    }

    // Exactly the built pages: every directory-format `index.html`.
    const expected = files
      .filter((file) => file === 'index.html' || file.endsWith('/index.html'))
      .map((file) => `${origin}/${file.slice(0, -'index.html'.length)}`)
      .sort();
    const listed = new Set(sitemapUrls);
    for (const url of expected) if (!listed.has(url)) report(SITEMAP_INDEX, `sitemap is missing page ${url}`);
    const expectedSet = new Set(expected);
    for (const url of sitemapUrls) {
      if (!expectedSet.has(url) && !isNotFoundPath(url.slice(origin.length))) {
        report(SITEMAP_INDEX, `sitemap lists ${url}, which is not a page in dist/`);
      }
    }
    const seen = new Set<string>();
    for (const url of sitemapUrls) {
      if (seen.has(url)) report(SITEMAP_INDEX, `sitemap lists ${url} more than once`);
      seen.add(url);
    }
  }

  // ---------- robots.txt ----------
  // Indexable (production): exactly one `Sitemap: <origin>/sitemap-index.xml`; otherwise none.
  if (!fileSet.has('robots.txt')) {
    report('robots.txt', 'missing dist/robots.txt');
  } else {
    const expected = `${origin}/${SITEMAP_INDEX}`;
    const sitemapLines = read('robots.txt')
      .split(/\r?\n/)
      .map((line) => /^\s*sitemap\s*:\s*(\S*)/i.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    if (indexable) {
      if (sitemapLines.length !== 1) {
        report('robots.txt', `expected exactly 1 "Sitemap: ${expected}" line, found ${sitemapLines.length}`);
      }
      for (const value of sitemapLines) {
        if (value !== expected) report('robots.txt', `Sitemap: ${value} should be ${expected}`);
      }
    } else if (sitemapLines.length > 0) {
      report('robots.txt', `non-indexable build must have no Sitemap line, found ${sitemapLines.length}`);
    }
  }

  return { sitemapUrls, personPages, problems, ok: problems.length === 0 };
}

/** Runs the check over a dist/ directory on disk. */
export function checkSeoDir(distDir: string, origin: string, indexable: boolean): SeoResult {
  const files = listFiles(distDir).map((file) => file.path);
  return checkSeo(files, (file) => readFileSync(path.join(distDir, file), 'utf8'), origin, indexable);
}

export function formatSeo(result: SeoResult, origin: string): string {
  return [
    `SEO — dist/ (origin ${origin})`,
    `  sitemap URLs: ${result.sitemapUrls.length}`,
    `  Person JSON-LD: ${result.personPages.length > 0 ? result.personPages.join(', ') : 'none'}`,
    ...result.problems.map((p) => `  FAIL ${p.file}: ${p.problem}`),
    `  ${result.ok ? 'PASS' : 'FAIL'}`,
  ].join('\n');
}

// Standalone: `node scripts/checks/seo.ts <distDir> <productionOrigin> [--indexable]`; exit 1 on failure.
// `--indexable` for a production build (robots.txt must carry the Sitemap line).
// (`npm run budgets` calls the functions above instead.)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [distDir, origin, flag] = process.argv.slice(2);
  if (distDir === undefined || origin === undefined || (flag !== undefined && flag !== '--indexable')) {
    console.error('usage: node scripts/checks/seo.ts <distDir> <productionOrigin> [--indexable]');
    process.exit(2);
  }
  const result = checkSeoDir(distDir, origin, flag === '--indexable');
  console.log(formatSeo(result, origin));
  process.exit(result.ok ? 0 : 1);
}
