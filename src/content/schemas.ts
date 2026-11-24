// Pure Zod schemas for content collections. This module must not import
// `astro:content` so that Vitest can load it directly.
import { z } from 'astro/zod';

export const LOCALES = ['id', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const nonEmptyText = z
  .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be a string') })
  .trim()
  .min(1, { error: 'must be a non-empty string' });

/**
 * A bilingual text field. Both `id` (Indonesian) and `en` (English) are
 * required, must be non-empty after trimming, and unknown keys are rejected.
 */
export const localized = () =>
  z.strictObject({
    id: nonEmptyText,
    en: nonEmptyText,
  });

export type Localized = z.infer<ReturnType<typeof localized>>;

const year = z.number().int().min(1900).max(2100);

export const projectSchema = z.strictObject({
  title: localized(),
  summary: localized(),
  year,
  dummy: z.boolean().default(false),
});

export const awardSchema = z.strictObject({
  title: localized(),
  issuer: nonEmptyText,
  year,
  dummy: z.boolean().default(false),
});

export const testimonialSchema = z.strictObject({
  title: localized(),
  quote: localized(),
  author: nonEmptyText,
  dummy: z.boolean().default(false),
});

/** One keyed piece of static UI copy (`content/film-copy/<key>.yaml`). */
export const filmCopySchema = z.strictObject({
  text: localized(),
});

export type Project = z.infer<typeof projectSchema>;
export type FilmCopy = z.infer<typeof filmCopySchema>;
export type Award = z.infer<typeof awardSchema>;
export type Testimonial = z.infer<typeof testimonialSchema>;

/**
 * Formats Zod issues as `<entryId>: <field.path> — <message>` lines. Used by
 * unit tests; `astro build` prints its own error (`<collection> → <entry>`
 * plus `<field.path>: <message>`).
 */
export function formatIssues(entryId: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '(root)';
    return `${entryId}: ${path} — ${issue.message}`;
  });
}
