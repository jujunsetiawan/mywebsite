// Mirrored ID/EN routes (Story 1.4). Pure module: no `astro:*` imports, so
// layouts, build checks (`scripts/checks/i18n-routes.ts`) and Vitest share it.
//
// A route path is the part of the URL after the language segment: `''` for a
// language home, `proyek/x/` for a nested page (trailing slash, no leading
// slash, no query or hash). `/<lang>/<path>` mirrors to `/<other>/<path>`.
import { LOCALES, type Locale } from '../content/schemas.ts';

/** Language served by `x-default` (and by `/` via `public/_redirects`). */
export const DEFAULT_LOCALE: Locale = 'id';

/** Route path of the privacy page (`/<lang>/privasi/`, Story 1.7). */
export const PRIVACY_PATH = 'privasi/';

export type Hreflang = Locale | 'x-default';

export interface Alternate {
  hreflang: Hreflang;
  href: string;
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Throws when `path` is not a route path (`''` or `seg/…/seg/`). */
export function assertRoutePath(path: string): void {
  if (path === '') return;
  if (!/^(?:[a-z0-9][a-z0-9-]*\/)+$/.test(path)) {
    throw new Error(`invalid route path "${path}": expected '' or kebab-case segments ending in '/' (e.g. 'proyek/x/')`);
  }
}

/** `/<lang>/<path>`, e.g. `localePath('en', 'proyek/x/')` → `/en/proyek/x/`. */
export function localePath(lang: Locale, path: string): string {
  assertRoutePath(path);
  return `/${lang}/${path}`;
}

/** Splits `/<lang>/<path>` into its parts; null when it is not a localized URL path. */
export function parseLocalePath(urlPath: string): { lang: Locale; path: string } | null {
  const match = /^\/([^/]+)\/(.*)$/.exec(urlPath);
  if (!match || !isLocale(match[1]!)) return null;
  const path = match[2]!;
  try {
    assertRoutePath(path);
  } catch {
    return null;
  }
  return { lang: match[1] as Locale, path };
}

export function otherLocale(lang: Locale): Locale {
  return LOCALES.find((candidate) => candidate !== lang)!;
}

/** Mirror of `/<lang>/<path>` (identical slug in the other language); null for non-localized paths. */
export function mirrorPath(urlPath: string): string | null {
  const parsed = parseLocalePath(urlPath);
  return parsed ? localePath(otherLocale(parsed.lang), parsed.path) : null;
}

/** Self-canonical URL: absolute on `origin`, never a query string. */
export function canonical(origin: string, lang: Locale, path: string): string {
  return `${origin}${localePath(lang, path)}`;
}

/** hreflang alternates for a mirrored route: every locale plus `x-default` (→ the Indonesian page). */
export function alternates(origin: string, path: string): Alternate[] {
  return [
    ...LOCALES.map((lang) => ({ hreflang: lang, href: canonical(origin, lang, path) })),
    { hreflang: 'x-default' as const, href: canonical(origin, DEFAULT_LOCALE, path) },
  ];
}
