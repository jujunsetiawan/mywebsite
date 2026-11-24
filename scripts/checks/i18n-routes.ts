// i18n route check over a built dist/ (Story 1.4).
//
// For every `dist/{id,en}/**/index.html`:
// - the mirror page (same route path in the other language) exists;
// - exactly one canonical, equal to the page's own URL on the production origin;
// - exactly one alternate per hreflang `id`, `en`, `x-default`, pointing at the
//   `id`/`en` variants of the same route path (`x-default` → the `id` variant);
// - every canonical/alternate href is on the production origin, has no query
//   or hash, and, mapped from the origin to dist/, resolves to an existing file.
// `dist/{id,en}/**/404.html` files (per-language not-found pages, Story 1.6)
// are not mirrored pages: they are allowed, not counted, and each must have
// its other-language twin at the same path.
// Pure core (`checkI18nRoutes`) plus a disk wrapper; wired into `npm run budgets`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, type Locale } from '../../src/content/schemas.ts';
import {
  DEFAULT_LOCALE,
  isLocale,
  localePath,
  mirrorPath,
  otherLocale,
  parseLocalePath,
  type Hreflang,
} from '../../src/i18n/routes.ts';
import { listFiles } from '../budgets/static-assets.ts';

export interface I18nProblem {
  /** URL path of the offending page, e.g. `/id/x/`. */
  page: string;
  problem: string;
}

export interface I18nRoutesResult {
  pages: string[];
  problems: I18nProblem[];
  ok: boolean;
}

interface HeadLink {
  rel: string;
  href: string | undefined;
  hreflang: string | undefined;
}

const HREFLANGS: readonly Hreflang[] = [...LOCALES, 'x-default'];

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** All `<link>` tags in the document with their rel/href/hreflang attributes. */
export function parseLinks(html: string): HeadLink[] {
  const links: HeadLink[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    links.push({ rel: (attrs.rel ?? '').toLowerCase(), href: attrs.href, hreflang: attrs.hreflang });
  }
  return links;
}

/** `id/x/index.html` → `/id/x/`; null for files that are not localized directory pages. */
function pageUrlPath(file: string): string | null {
  const match = /^(.+\/)index\.html$/.exec(file);
  if (!match) return null;
  const urlPath = `/${match[1]}`;
  return parseLocalePath(urlPath) ? urlPath : null;
}

/** Language of a `<lang>/…/404.html` file (a per-language not-found page); null otherwise. */
export function notFoundPageLang(file: string): Locale | null {
  const lang = /^([^/]+)\/(?:[a-z0-9][a-z0-9-]*\/)*404\.html$/.exec(file)?.[1];
  return lang !== undefined && isLocale(lang) ? lang : null;
}

/** `/x/y/` → `x/y/index.html` (directory-format build output). */
function distFileFor(urlPath: string): string {
  return `${urlPath.replace(/^\//, '')}index.html`;
}

/**
 * Pure check. `files` are dist-relative paths with forward slashes; `read`
 * returns a file's HTML; `origin` is the bare production origin.
 */
export function checkI18nRoutes(
  files: readonly string[],
  read: (file: string) => string,
  origin: string,
): I18nRoutesResult {
  const fileSet = new Set(files);
  const pages: string[] = [];
  const problems: I18nProblem[] = [];

  for (const file of [...files].sort()) {
    const notFoundLang = notFoundPageLang(file);
    if (notFoundLang !== null) {
      // Per-language 404 pages (e.g. the empty archive, Story 1.6) are not
      // mirrored pages, but each needs its other-language twin.
      const twin = `${otherLocale(notFoundLang)}/${file.slice(notFoundLang.length + 1)}`;
      if (!fileSet.has(twin)) problems.push({ page: file, problem: `missing 404 twin dist/${twin}` });
      continue;
    }
    const page = pageUrlPath(file);
    if (page === null) {
      // Any other HTML under a language dir is a page outside the mirrored route scheme.
      if (LOCALES.some((lang) => file.startsWith(`${lang}/`)) && file.endsWith('.html')) {
        problems.push({ page: file, problem: 'localized HTML is not a valid <lang>/<route>/index.html page' });
      }
      continue;
    }
    pages.push(page);
    const report = (problem: string) => problems.push({ page, problem });
    const { path: routePath } = parseLocalePath(page)!;

    const mirror = mirrorPath(page)!;
    if (!fileSet.has(distFileFor(mirror))) report(`missing mirror ${mirror} (expected dist/${distFileFor(mirror)})`);

    /** Checks an absolute href: on the origin, no query/hash, resolves in dist/. Returns its URL path or null. */
    const resolve = (label: string, href: string | undefined): string | null => {
      if (href === undefined || href === '') {
        report(`${label} has no href`);
        return null;
      }
      if (!href.startsWith(`${origin}/`)) {
        report(`${label} ${href} is not on the production origin ${origin}`);
        return null;
      }
      const urlPath = href.slice(origin.length);
      if (/[?#]/.test(urlPath)) {
        report(`${label} ${href} carries a query string or hash`);
        return null;
      }
      if (!urlPath.endsWith('/') || !fileSet.has(distFileFor(urlPath))) {
        report(`${label} ${href} does not resolve to a file in dist/ (expected dist/${distFileFor(urlPath)})`);
        return null;
      }
      return urlPath;
    };

    const links = parseLinks(read(file));

    const canonicals = links.filter((link) => link.rel === 'canonical');
    if (canonicals.length !== 1) {
      report(`expected exactly 1 canonical link, found ${canonicals.length}`);
    } else {
      const target = resolve('canonical', canonicals[0]!.href);
      if (target !== null && target !== page) report(`canonical ${canonicals[0]!.href} is not the page's own URL ${origin}${page}`);
    }

    const alternateLinks = links.filter((link) => link.rel === 'alternate' && link.hreflang !== undefined);
    for (const hreflang of HREFLANGS) {
      const matches = alternateLinks.filter((link) => link.hreflang === hreflang);
      if (matches.length !== 1) {
        report(`expected exactly 1 alternate hreflang="${hreflang}", found ${matches.length}`);
        continue;
      }
      const href = matches[0]!.href;
      const target = resolve(`alternate hreflang="${hreflang}"`, href);
      const expected = localePath(hreflang === 'x-default' ? DEFAULT_LOCALE : hreflang, routePath);
      if (target !== null && target !== expected) {
        report(`alternate hreflang="${hreflang}" ${href} should point to ${origin}${expected}`);
      }
    }
    for (const link of alternateLinks) {
      if (!(HREFLANGS as readonly string[]).includes(link.hreflang!)) {
        report(`unexpected alternate hreflang="${link.hreflang}" ${link.href ?? ''}`.trimEnd());
      }
    }
  }

  if (pages.length === 0) problems.push({ page: '(dist)', problem: 'no /id/ or /en/ pages found' });
  return { pages, problems, ok: problems.length === 0 };
}

/** Runs the check over a dist/ directory on disk. */
export function checkI18nRoutesDir(distDir: string, origin: string): I18nRoutesResult {
  const files = listFiles(distDir).map((file) => file.path);
  return checkI18nRoutes(files, (file) => readFileSync(path.join(distDir, file), 'utf8'), origin);
}

export function formatI18nRoutes(result: I18nRoutesResult, origin: string): string {
  const lines = [
    `i18n routes — dist/ (origin ${origin})`,
    `  pages: ${result.pages.length}${result.pages.length > 0 ? ` (${result.pages.join(', ')})` : ''}`,
    ...result.problems.map((p) => `  FAIL ${p.page}: ${p.problem}`),
    `  ${result.ok ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}

// Standalone: `node scripts/checks/i18n-routes.ts <distDir> <productionOrigin>`; exit 1 on failure.
// (`npm run budgets` calls the functions above instead.)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [distDir, origin] = process.argv.slice(2);
  if (distDir === undefined || origin === undefined) {
    console.error('usage: node scripts/checks/i18n-routes.ts <distDir> <productionOrigin>');
    process.exit(2);
  }
  const result = checkI18nRoutesDir(distDir, origin);
  console.log(formatI18nRoutes(result, origin));
  process.exit(result.ok ? 0 : 1);
}
