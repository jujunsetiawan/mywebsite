// Sitemap rules (Story 1.9). Pure module: `astro.config.mjs` (the
// `@astrojs/sitemap` filter), the SEO build check and Vitest share it.
import { LOCALES } from '../content/schemas.ts';

/** Sitemap index file name written by `@astrojs/sitemap` (`filenameBase` `sitemap`). */
export const SITEMAP_INDEX = 'sitemap-index.xml';

/** `@astrojs/sitemap` i18n option: `id` (default) and `en`, hreflang = locale code. */
export const SITEMAP_I18N = {
  defaultLocale: 'id',
  locales: Object.fromEntries(LOCALES.map((lang) => [lang, lang])) as Record<string, string>,
};

const NOT_FOUND_PATH = new RegExp(`^/(?:(?:${LOCALES.join('|')})/(?:proyek/)?)?404(?:/|\\.html)$`);

/**
 * True when a URL path (or absolute URL) is a not-found page: `/404/`,
 * `/<lang>/404/`, `/<lang>/proyek/404/`, or their `.html` forms.
 */
export function isNotFoundPath(urlOrPath: string): boolean {
  let pathname = urlOrPath;
  try {
    pathname = new URL(urlOrPath).pathname;
  } catch {
    // Already a path.
  }
  return NOT_FOUND_PATH.test(pathname);
}

/** `@astrojs/sitemap` `filter`: every page except the not-found pages. */
export function sitemapFilter(page: string): boolean {
  return !isNotFoundPath(page);
}

/** Absolute URL of the sitemap index on `origin`. */
export function sitemapIndexUrl(origin: string): string {
  return `${origin}/${SITEMAP_INDEX}`;
}
