// Which project page the first-load budget measures (Story 1.6): the first
// project by `order` in `content/projects/`.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * Slug of the project with the lowest `order` in `projectsDir` (`<slug>.yaml`
 * files). Throws naming the file for any entry without a string `slug` and a
 * numeric `order`, and when the directory holds no project.
 */
export function firstProjectSlug(projectsDir: string): string {
  const entries = readdirSync(projectsDir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const file = path.join(projectsDir, name);
      const data: unknown = parse(readFileSync(file, 'utf8'));
      const { slug, order } = (typeof data === 'object' && data !== null ? data : {}) as { slug?: unknown; order?: unknown };
      if (typeof slug !== 'string' || typeof order !== 'number') {
        throw new Error(`invalid project ${file}: needs a string "slug" and a numeric "order"`);
      }
      return { slug, order };
    });
  if (entries.length === 0) throw new Error(`no project (*.yaml) in ${projectsDir}`);
  return entries.sort((a, b) => a.order - b.order)[0]!.slug;
}
