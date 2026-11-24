import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { awardSchema, filmCopySchema, projectSchema, testimonialSchema } from './content/schemas.ts';

const yamlIn = (name: string) => glob({ pattern: '**/*.yaml', base: `./content/${name}` });

export const collections = {
  projects: defineCollection({ loader: yamlIn('projects'), schema: projectSchema }),
  awards: defineCollection({ loader: yamlIn('awards'), schema: awardSchema }),
  testimonials: defineCollection({ loader: yamlIn('testimonials'), schema: testimonialSchema }),
  // Keyed static copy: the file name is the dot-separated key (`chrome.projects.yaml`
  // → `chrome.projects`), kept verbatim instead of slugified.
  'film-copy': defineCollection({
    loader: glob({
      pattern: '*.yaml',
      base: './content/film-copy',
      generateId: ({ entry }) => entry.replace(/\.yaml$/, ''),
    }),
    schema: filmCopySchema,
  }),
};
