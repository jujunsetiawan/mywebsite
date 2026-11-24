// Data loader for the language homes (Story 1.5). Runs the cross-entry
// integrity rules on every build, so a broken reference fails `astro build`.
import { getCollection, type CollectionEntry } from 'astro:content';
import { assertContentIntegrity, byOrder } from './integrity.ts';

export interface HomeContent {
  projects: CollectionEntry<'projects'>[];
  awards: CollectionEntry<'awards'>[];
}

export async function loadHomeContent(): Promise<HomeContent> {
  const [projects, awards, testimonials] = await Promise.all([
    getCollection('projects'),
    getCollection('awards'),
    getCollection('testimonials'),
  ]);
  assertContentIntegrity({ projects, awards, testimonials });
  return { projects: byOrder(projects), awards: byOrder(awards) };
}
