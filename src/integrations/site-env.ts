// Writes the environment-dependent deploy files into `dist/` after the build
// (Story 1.2): `robots.txt` (with a `Sitemap:` line in production, Story 1.9), and for non-production an `X-Robots-Tag: noindex`
// line added to the `/*` rule of the shared `_headers` (copied from
// `public/_headers`). Workers static assets read a single `_headers` file and
// a second `/*` block replaces the first one's headers (verified with
// `wrangler dev`: the CSP disappeared), so the line goes into the existing
// `/*` block; a new block is appended only when there is none.
//
// It also moves the per-language not-found pages into place (Stories 1.6, 1.8).
import { readdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { isIndexable, type SiteConfig } from '../../config/site.schema.ts';
import { LOCALES } from '../content/schemas.ts';
import { sitemapIndexUrl } from '../seo/sitemap.ts';

export const NOINDEX_HEADER_LINE = '  X-Robots-Tag: noindex';

/**
 * Production allows crawling and points at the sitemap index on the
 * production origin (Story 1.9); every other env disallows all, no Sitemap line.
 */
export function robotsTxt(config: SiteConfig): string {
  return isIndexable(config)
    ? `User-agent: *\nAllow: /\nSitemap: ${sitemapIndexUrl(config.productionOrigin)}\n`
    : 'User-agent: *\nDisallow: /\n';
}

/** `_headers` content for this environment, given the shared committed file (may be empty). */
export function headersFile(shared: string, config: SiteConfig): string {
  if (isIndexable(config)) return shared;
  const lines = shared === '' ? [] : shared.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const ruleIndex = lines.findIndex((line) => line.trimEnd() === '/*');
  if (ruleIndex === -1) {
    if (lines.length > 0) lines.push('');
    lines.push('/*', NOINDEX_HEADER_LINE);
  } else {
    lines.splice(ruleIndex + 1, 0, NOINDEX_HEADER_LINE);
  }
  return `${lines.join('\n')}\n`;
}

export async function writeEnvOutput(distDir: string, config: SiteConfig): Promise<void> {
  const headersPath = path.join(distDir, '_headers');
  let shared = '';
  try {
    shared = await readFile(headersPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(headersPath, headersFile(shared, config));
  await writeFile(path.join(distDir, 'robots.txt'), robotsTxt(config));
}

/** Per-language not-found pages: dist-relative directory (under `<lang>/`) and their Astro source. */
export const NOT_FOUND_PAGES = [
  // Site-wide not-found page (Story 1.8).
  { dir: '', source: 'src/pages/[lang]/404.astro' },
  // Empty-archive page for unknown project slugs (Story 1.6).
  { dir: 'proyek/', source: 'src/pages/[lang]/proyek/404.astro' },
] as const;

/**
 * Moves every expected per-language not-found page from the directory-format
 * `<lang>/<dir>404/index.html` to `<lang>/<dir>404.html`, so Workers'
 * `not_found_handling: "404-page"` (nearest `404.html` up the path) serves it
 * with status 404: `<lang>/404.html` for unknown paths under `/<lang>/`, and
 * `<lang>/proyek/404.html` (nearer, so it wins) for unknown project slugs.
 * Removes each then-empty `404/` dir. All sources are checked before anything
 * moves; a missing one, or a source dir holding anything besides `index.html`,
 * throws (failing the build) naming every offender. Returns the moved
 * dist-relative targets. The root `dist/404.html` is emitted flat by Astro.
 */
export async function moveNotFoundPages(distDir: string, locales: readonly string[] = LOCALES): Promise<string[]> {
  const moves = locales.flatMap((lang) =>
    NOT_FOUND_PAGES.map(({ dir, source }) => ({ rel: `${lang}/${dir}404`, source })),
  );
  const missing: string[] = [];
  for (const { rel, source } of moves) {
    try {
      await stat(path.join(distDir, rel, 'index.html'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(`dist/${rel}/index.html (built from ${source})`);
    }
  }
  if (missing.length > 0) throw new Error(`site-env: not-found page missing: ${missing.join(', ')}`);
  const cluttered: string[] = [];
  for (const { rel } of moves) {
    const extra = (await readdir(path.join(distDir, rel))).filter((name) => name !== 'index.html').sort();
    if (extra.length > 0) cluttered.push(`dist/${rel}/ (${extra.join(', ')})`);
  }
  if (cluttered.length > 0) {
    throw new Error(`site-env: not-found source dir holds more than index.html: ${cluttered.join(', ')}`);
  }
  const moved: string[] = [];
  for (const { rel } of moves) {
    const sourceDir = path.join(distDir, rel);
    await rename(path.join(sourceDir, 'index.html'), path.join(distDir, `${rel}.html`));
    await rmdir(sourceDir);
    moved.push(`${rel}.html`);
  }
  return moved;
}

export default function siteEnv(config: SiteConfig): AstroIntegration {
  return {
    name: 'site-env',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const distDir = fileURLToPath(dir);
        const moved = await moveNotFoundPages(distDir);
        logger.info(`not-found pages: ${moved.join(', ')}`);
        await writeEnvOutput(distDir, config);
        logger.info(`env "${config.env}": robots.txt ${isIndexable(config) ? 'allows' : 'disallows'} crawling`);
      },
    },
  };
}
