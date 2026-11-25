// Data loader for the privacy page (Story 1.7): the single `privacy` entry.
import { getCollection, type CollectionEntry } from 'astro:content';
import { singlePrivacyEntry } from './integrity.ts';

/** The one `content/privacy/privacy.yaml` entry; fails the build for zero or several entries. */
export async function loadPrivacyContent(): Promise<CollectionEntry<'privacy'>> {
  return singlePrivacyEntry(await getCollection('privacy'));
}
