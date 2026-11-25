// Cross-entry content rules (Story 1.5). Pure module (no `astro:*` imports):
// the homes' data loader runs it at build time and Vitest calls it directly.
// Each problem names the collection, the entry (or entries) and the field.

export interface IntegrityEntry<T> {
  /** Collection entry id: the file name without `.yaml`. */
  id: string;
  data: T;
}

export interface IntegrityInput {
  projects: readonly IntegrityEntry<{ slug: string; order: number }>[];
  awards: readonly IntegrityEntry<{ order: number }>[];
  testimonials: readonly IntegrityEntry<{ order: number; project?: string | undefined }>[];
}

export class ContentIntegrityError extends Error {
  override name = 'ContentIntegrityError';
}

/** `<collection> → <ids>: <field> — <message>` for every value held by more than one entry. */
function duplicates<T>(
  collection: string,
  field: string,
  entries: readonly IntegrityEntry<T>[],
  value: (data: T) => string | number,
): string[] {
  const byValue = new Map<string | number, string[]>();
  for (const entry of entries) {
    const key = value(entry.data);
    byValue.set(key, [...(byValue.get(key) ?? []), entry.id]);
  }
  return [...byValue]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => `${collection} → ${ids.join(', ')}: ${field} — duplicate ${JSON.stringify(key)}`);
}

/** Every cross-entry problem (empty = valid). */
export function checkContentIntegrity({ projects, awards, testimonials }: IntegrityInput): string[] {
  const problems: string[] = [];

  for (const { id, data } of projects) {
    if (data.slug !== id) {
      problems.push(
        `projects → ${id}: slug — must equal the file name "${id}" (content/projects/${id}.yaml), got "${data.slug}"`,
      );
    }
  }
  problems.push(...duplicates('projects', 'slug', projects, (data) => data.slug));
  problems.push(...duplicates('projects', 'order', projects, (data) => data.order));
  problems.push(...duplicates('awards', 'order', awards, (data) => data.order));
  problems.push(...duplicates('testimonials', 'order', testimonials, (data) => data.order));

  const slugs = new Set(projects.map(({ data }) => data.slug));
  for (const { id, data } of testimonials) {
    if (data.project !== undefined && !slugs.has(data.project)) {
      problems.push(`testimonials → ${id}: project — no project with slug "${data.project}"`);
    }
  }
  return problems;
}

/** Throws (failing `astro build`) listing every cross-entry problem. */
export function assertContentIntegrity(input: IntegrityInput): void {
  const problems = checkContentIntegrity(input);
  if (problems.length > 0) {
    throw new ContentIntegrityError(`Content integrity check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

/**
 * A single-entry collection (`content/<collection>/<collection>.yaml`) holds
 * exactly one entry. Returns it; throws (failing `astro build`) for zero or several.
 */
export function singleEntry<T extends { id: string }>(collection: string, entries: readonly T[]): T {
  if (entries.length === 0) {
    throw new ContentIntegrityError(
      `Content integrity check failed:\n  ${collection}: (collection) — missing entry (expected content/${collection}/${collection}.yaml)`,
    );
  }
  if (entries.length > 1) {
    const ids = entries.map((entry) => entry.id).sort();
    throw new ContentIntegrityError(
      `Content integrity check failed:\n  ${collection} → ${ids.join(', ')}: (collection) — expected exactly 1 entry, found ${entries.length}`,
    );
  }
  return entries[0]!;
}

/** The single `content/privacy/privacy.yaml` entry (Story 1.7). */
export function singlePrivacyEntry<T extends { id: string }>(entries: readonly T[]): T {
  return singleEntry('privacy', entries);
}

/** The single `content/profile/profile.yaml` entry (Story 1.9). */
export function singleProfileEntry<T extends { id: string }>(entries: readonly T[]): T {
  return singleEntry('profile', entries);
}

/** Entries sorted by their `order` field (ascending). */
export function byOrder<T extends { data: { order: number } }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.data.order - b.data.order);
}
