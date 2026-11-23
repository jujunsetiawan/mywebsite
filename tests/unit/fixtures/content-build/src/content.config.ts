import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { projectSchema } from '../../../../../src/content/schemas.ts';

export const collections = {
  projects: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './content/projects' }),
    schema: projectSchema,
  }),
};
