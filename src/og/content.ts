// Content for the OG images (Story 1.10), read in plain Node from the same
// YAML files the site's content collections load (`content/`, or the
// `CONTENT_DIR` test seam) and validated with the same pure schemas. The
// generator runs in `astro:build:done`, outside Astro's content layer.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'astro/zod';
import { parse as parseYaml } from 'yaml';
import { byOrder } from '../content/integrity.ts';
import {
  filmCopySchema,
  formatIssues,
  profileSchema,
  projectSchema,
  type Localized,
} from '../content/schemas.ts';

/** Film-copy key of the "Jun Studio mempersembahkan" / "Jun Studio presents" credit. */
export const CREDIT_KEY = 'chrome.credit';

export interface OgProject {
  slug: string;
  name: Localized;
  oneLineOutcome: Localized;
}

export interface OgContent {
  /** Profile `name` ("Jujun Setiawan"). */
  name: string;
  /** Profile `jobTitle`. */
  jobTitle: Localized;
  /** `chrome.credit` text (uppercased by the renderer). */
  credit: Localized;
  /** Sorted by `order`. */
  projects: OgProject[];
}

// Image fields are irrelevant here: any string passes (Astro resolves them in the real build).
const projects = projectSchema({ image: () => z.string() });

async function readEntry<S extends z.ZodType>(file: string, label: string, schema: S): Promise<z.infer<S>> {
  let data: unknown;
  try {
    data = parseYaml(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`og content: cannot read ${label} (${(error as Error).message})`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`og content: invalid ${label}:\n${formatIssues(label, result.error).map((l) => `  ${l}`).join('\n')}`);
  }
  return result.data;
}

/** YAML files under `dir` (recursive), as `{ id, file }` with id = relative path without `.yaml`. */
async function yamlFiles(dir: string): Promise<{ id: string; file: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { id: path.relative(dir, file).split(path.sep).join('/').replace(/\.yaml$/, ''), file };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Loads and validates the OG content from a content directory. */
export async function loadOgContent(contentDir: string): Promise<OgContent> {
  const profileFiles = await yamlFiles(path.join(contentDir, 'profile'));
  if (profileFiles.length !== 1) {
    throw new Error(`og content: expected exactly 1 profile entry in ${path.join(contentDir, 'profile')}, found ${profileFiles.length}`);
  }
  const profile = await readEntry(profileFiles[0]!.file, `profile/${profileFiles[0]!.id}`, profileSchema);
  const credit = await readEntry(
    path.join(contentDir, 'film-copy', `${CREDIT_KEY}.yaml`),
    `film-copy/${CREDIT_KEY}`,
    filmCopySchema,
  );
  const loaded = [];
  for (const { id, file } of await yamlFiles(path.join(contentDir, 'projects'))) {
    const data = await readEntry(file, `projects/${id}`, projects);
    loaded.push({ id, data });
  }
  return {
    name: profile.name,
    jobTitle: profile.jobTitle,
    credit: credit.text,
    projects: byOrder(loaded).map(({ data }) => ({ slug: data.slug, name: data.name, oneLineOutcome: data.oneLineOutcome })),
  };
}
