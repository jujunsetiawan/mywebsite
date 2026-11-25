// Person JSON-LD for the language homes (Story 1.9). Pure module (no
// `astro:*` imports): the home page, the SEO build check and Vitest share it.
import type { Locale } from '../content/schemas.ts';
import { canonical } from '../i18n/routes.ts';

export interface PersonProfile {
  name: string;
  jobTitle: Record<Locale, string>;
  sameAs: readonly string[];
}

export interface PersonJsonLd {
  '@context': 'https://schema.org';
  '@type': 'Person';
  name: string;
  jobTitle: string;
  url: string;
  sameAs: string[];
}

/** Required string properties of a Person JSON-LD object. */
export const PERSON_REQUIRED_PROPS = ['name', 'jobTitle', 'url'] as const;

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`person JSON-LD: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The Person object for the `lang` home: `jobTitle` in the page language,
 * `url` = `<origin>/<lang>/`. Throws when a required property is missing or
 * empty (the profile schema already guarantees them for content).
 */
export function personJsonLd(profile: PersonProfile, lang: Locale, origin: string): PersonJsonLd {
  const name = requireText(profile.name, 'name');
  const jobTitle = requireText(profile.jobTitle?.[lang], `jobTitle.${lang}`);
  requireText(origin, 'origin');
  if (!Array.isArray(profile.sameAs) || profile.sameAs.length === 0) {
    throw new Error('person JSON-LD: sameAs must be a non-empty list');
  }
  const sameAs = profile.sameAs.map((url, index) => requireText(url, `sameAs.${index}`));
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name,
    jobTitle,
    url: canonical(origin, lang, ''),
    sameAs,
  };
}

/**
 * Serialises JSON-LD for a `<script type="application/ld+json">` body: plain
 * `JSON.stringify` with every `<` escaped as `\u003c`, so no value can close
 * the script element (`</script>`) or open a comment (`<!--`).
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
