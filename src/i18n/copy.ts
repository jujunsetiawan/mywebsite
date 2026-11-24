// Keyed bilingual UI copy from the `film-copy` collection (Story 1.3).
// Components call `t(key, lang)` instead of holding visible literals.
import { getCollection } from 'astro:content';
import type { Locale } from '../content/schemas.ts';
import type { CopyKey } from './copy-keys.ts';

export { COPY_KEYS, type CopyKey } from './copy-keys.ts';

/** Text for `key` in `lang`; throws (failing the build) when the entry is missing. */
export async function t(key: CopyKey, lang: Locale): Promise<string> {
  const entries = await getCollection('film-copy');
  const entry = entries.find((candidate) => candidate.id === key);
  if (!entry) throw new Error(`film-copy: missing entry "${key}" (expected content/film-copy/${key}.yaml)`);
  return entry.data.text[lang];
}
