// Open Graph image locations and head-tag values (Story 1.10). Pure module
// (no Astro, Node or renderer imports): shared by `BaseLayout`, the generator
// integration, the `og` build check and tests.
import { LOCALES, type Locale } from '../content/schemas.ts';
import { assertRoutePath } from '../i18n/routes.ts';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** dist-relative directory holding every OG image. */
export const OG_DIR = 'og';

/** `og/site-<lang>.png`: the site image for every page that is not a project page. */
export function siteImagePath(lang: Locale): string {
  return `${OG_DIR}/site-${lang}.png`;
}

/** `og/<lang>/proyek/<slug>.png`: one image per project per language. */
export function projectImagePath(lang: Locale, slug: string): string {
  assertRoutePath(`${slug}/`);
  return `${OG_DIR}/${lang}/proyek/${slug}.png`;
}

/** Every image a build with these project slugs must hold (sorted). */
export function expectedImagePaths(slugs: readonly string[]): string[] {
  return LOCALES.flatMap((lang) => [siteImagePath(lang), ...slugs.map((slug) => projectImagePath(lang, slug))]).sort();
}

/** Absolute image URL on `origin` (bare, no trailing slash). */
export function ogImageUrl(origin: string, imagePath: string): string {
  return `${origin}/${imagePath}`;
}

/** `og:locale` value per page language. */
export const OG_LOCALES: Record<Locale, string> = { id: 'id_ID', en: 'en_US' };
