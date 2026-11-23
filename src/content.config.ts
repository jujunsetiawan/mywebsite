import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { awardSchema, projectSchema, testimonialSchema } from './content/schemas.ts';

const yamlIn = (name: string) => glob({ pattern: '**/*.yaml', base: `./content/${name}` });

export const collections = {
  projects: defineCollection({ loader: yamlIn('projects'), schema: projectSchema }),
  awards: defineCollection({ loader: yamlIn('awards'), schema: awardSchema }),
  testimonials: defineCollection({ loader: yamlIn('testimonials'), schema: testimonialSchema }),
};
