// Data loader for Jun's profile (Story 1.9): the single `profile` entry.
import { getCollection, type CollectionEntry } from 'astro:content';
import { singleProfileEntry } from './integrity.ts';

/** The one `content/profile/profile.yaml` entry; fails the build for zero or several entries. */
export async function loadProfileContent(): Promise<CollectionEntry<'profile'>> {
  return singleProfileEntry(await getCollection('profile'));
}
