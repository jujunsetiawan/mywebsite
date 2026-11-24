import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { awardSchema, filmCopySchema, projectSchema, testimonialSchema } from './content/schemas.ts';

// `CONTENT_DIR` is a test seam only (tests/unit/content-swap.test.ts builds the
// site from a temp copy of `content/`); real builds always read `./content`.
const contentDir = process.env.CONTENT_DIR;
if (contentDir && !existsSync(contentDir)) {
  throw new Error(`CONTENT_DIR "${contentDir}" does not exist (unset it to build from ./content)`);
}
const baseFor = (name: string) => (contentDir ? pathToFileURL(`${contentDir}/${name}/`) : `./content/${name}`);

// Entry id = file name without `.yaml` (Astro would otherwise use a `slug`
// field as the id, hiding a slug/file-name mismatch from the integrity check).
// `**/*.yaml` never picks up the SVGs in `assets/`.
const yamlIn = (name: string) =>
  glob({ pattern: '**/*.yaml', base: baseFor(name), generateId: ({ entry }) => entry.replace(/\.yaml$/, '') });

// The schema factories are wrapped so their image type is inferred from
// Astro's `image()` helper (typed `ImageMetadata` in components, Story 1.6).
export const collections = {
  projects: defineCollection({ loader: yamlIn('projects'), schema: ({ image }) => projectSchema({ image }) }),
  awards: defineCollection({ loader: yamlIn('awards'), schema: ({ image }) => awardSchema({ image }) }),
  testimonials: defineCollection({ loader: yamlIn('testimonials'), schema: ({ image }) => testimonialSchema({ image }) }),
  // Keyed static copy: the file name is the dot-separated key (`chrome.projects.yaml`
  // → `chrome.projects`), kept verbatim instead of slugified.
  'film-copy': defineCollection({
    loader: glob({
      pattern: '*.yaml',
      base: baseFor('film-copy'),
      generateId: ({ entry }) => entry.replace(/\.yaml$/, ''),
    }),
    schema: filmCopySchema,
  }),
};
