// Data loaders for the language homes (Story 1.5) and the project pages
// (Story 1.6). Both run the cross-entry integrity rules on every build, so a
// broken reference fails `astro build`.
import { getCollection, type CollectionEntry } from 'astro:content';
import { assertContentIntegrity, byOrder } from './integrity.ts';

export interface HomeContent {
  projects: CollectionEntry<'projects'>[];
  awards: CollectionEntry<'awards'>[];
}

export interface ProjectContent {
  /** Sorted by `order`. */
  projects: CollectionEntry<'projects'>[];
  /** Sorted by `order`. */
  testimonials: CollectionEntry<'testimonials'>[];
}

async function loadAll() {
  const [projects, awards, testimonials] = await Promise.all([
    getCollection('projects'),
    getCollection('awards'),
    getCollection('testimonials'),
  ]);
  assertContentIntegrity({ projects, awards, testimonials });
  return { projects: byOrder(projects), awards: byOrder(awards), testimonials: byOrder(testimonials) };
}

export async function loadHomeContent(): Promise<HomeContent> {
  const { projects, awards } = await loadAll();
  return { projects, awards };
}

export async function loadProjectContent(): Promise<ProjectContent> {
  const { projects, testimonials } = await loadAll();
  return { projects, testimonials };
}

/** Testimonials that reference `slug`, in `order`. */
export function testimonialsFor(
  testimonials: CollectionEntry<'testimonials'>[],
  slug: string,
): CollectionEntry<'testimonials'>[] {
  return testimonials.filter((entry) => entry.data.project === slug);
}
