// Pure Zod schemas for content collections. This module must not import
// `astro:content` so that Vitest can load it directly. Collections with image
// fields export a schema factory that takes Astro's `image` helper (Vitest
// passes a stub).
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

const nonEmptyTextList = z
  .array(nonEmptyText, { error: (issue) => (issue.input === undefined ? 'is required' : 'must be a list') })
  .min(1, { error: 'must be a non-empty list' });

/**
 * A bilingual list: `id` and `en` are both non-empty lists of non-empty
 * strings with the same number of items (item n of `id` translates item n of `en`).
 */
export const localizedList = () =>
  z.strictObject({ id: nonEmptyTextList, en: nonEmptyTextList }).check((ctx) => {
    const { id, en } = ctx.value;
    if (id.length !== en.length) {
      ctx.issues.push({
        code: 'custom',
        input: en,
        path: ['en'],
        message: `must have the same number of items as id (${id.length}), got ${en.length}`,
      });
    }
  });

export type LocalizedList = z.infer<ReturnType<typeof localizedList>>;

/** Kebab-case slug: lowercase letters and digits in `-`-separated groups. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const slug = z
  .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be a string') })
  .regex(SLUG_PATTERN, { error: 'must be kebab-case (lowercase letters and digits separated by single hyphens)' });

/** True when `value` is `YYYY-MM-DD` naming a real calendar day. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * ISO date as a quoted YAML string. Unquoted YAML dates are rejected: the YAML
 * timestamp parser silently rolls invalid days over (`2026-13-40` → 2027-02-09).
 */
const isoDate = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? 'is required'
        : issue.input instanceof Date
          ? 'must be a quoted ISO date string, e.g. "2026-03-01" (unquoted YAML dates are not checked)'
          : 'must be a string',
  })
  .refine(isIsoDate, { error: 'must be a real calendar date in ISO format YYYY-MM-DD' });

const httpsUrl = z
  .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be a string') })
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { error: 'must be an absolute https URL' },
  );

const year = z.number().int().min(1900).max(2100);
const order = z.number().int().positive();
const dummy = z.boolean().default(false);

export const PROJECT_TYPES = ['web', 'mobile', 'integrasi'] as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Project page sections in their fixed display order. */
export const SECTION_KEYS = [
  'outcomes',
  'businessFlow',
  'process',
  'techStack',
  'apiContract',
  'samplePrd',
  'uiux',
  'prototype',
] as const;

/** The subset of Astro's `SchemaContext` the factories use; Vitest passes a stub. */
export interface SchemaHelpers<I extends z.ZodType> {
  image: () => I;
}

const period = z.strictObject({ start: isoDate, end: isoDate }).check((ctx) => {
  const { start, end } = ctx.value;
  // Only compare two valid dates; an invalid one already has its own issue.
  if (isIsoDate(start) && isIsoDate(end) && end < start) {
    ctx.issues.push({ code: 'custom', input: end, path: ['end'], message: `must not be before start (${start})` });
  }
});

/** `content/projects/<slug>.yaml`; images in `content/projects/assets/`. */
export const projectSchema = <I extends z.ZodType>({ image }: SchemaHelpers<I>) =>
  z.strictObject({
    slug,
    order,
    type: z.enum(PROJECT_TYPES),
    year,
    name: localized(),
    oneLineOutcome: localized(),
    period,
    role: localized(),
    stack: z.array(nonEmptyText).min(1, { error: 'must be a non-empty list' }),
    sections: z.strictObject({
      outcomes: localizedList(),
      businessFlow: localizedList(),
      process: localizedList(),
      techStack: z.array(z.strictObject({ name: nonEmptyText, purpose: localized() })),
      apiContract: z.array(
        z.strictObject({
          method: z.enum(HTTP_METHODS),
          path: nonEmptyText.regex(/^\//, { error: 'must start with "/"' }),
          summary: localized(),
        }),
      ),
      samplePrd: localized(),
      uiux: z.array(z.strictObject({ image: image(), alt: localized() })),
      prototype: z.strictObject({ note: localized(), url: httpsUrl.optional() }),
    }),
    dummy,
  });

/** `content/awards/<id>.yaml`; certificate images in `content/awards/assets/`. */
export const awardSchema = <I extends z.ZodType>({ image }: SchemaHelpers<I>) =>
  z.strictObject({
    order,
    title: localized(),
    issuer: nonEmptyText,
    date: isoDate,
    certificate: image(),
    certificateAlt: localized(),
    verifyUrl: httpsUrl,
    dummy,
  });

/** `content/testimonials/<id>.yaml`; photos in `content/testimonials/assets/`. */
export const testimonialSchema = <I extends z.ZodType>({ image }: SchemaHelpers<I>) =>
  z.strictObject({
    order,
    photo: image(),
    name: nonEmptyText,
    company: nonEmptyText,
    quote: localized(),
    project: slug.optional(),
    dummy,
  });

/**
 * A plain email address safe to put in a `mailto:` link: local part of
 * letters, digits, `_`, `+`, `-` in dot-separated groups (no leading, trailing
 * or consecutive dots; no `?`, `&`, `#`, `%`, `/` that could add headers), and
 * a hostname of dot-separated labels ending in a letters-only TLD.
 */
export const EMAIL_PATTERN =
  /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

const email = z
  .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be a string') })
  .regex(EMAIL_PATTERN, { error: 'must be an email address, e.g. "name@example.com"' });

/** One privacy-page section: kebab-case `id` (HTML anchor), heading and paragraphs. */
const privacySection = z.strictObject({
  id: slug,
  heading: localized(),
  paragraphs: localizedList(),
  /** The processor's own privacy policy, linked in a new tab (processor sections only). */
  policyUrl: httpsUrl.optional(),
});

/** Section id whose section carries the `contactEmail` mailto link. */
export const PRIVACY_CONTACT_SECTION = 'contact';

/**
 * `content/privacy/privacy.yaml` — the single privacy-page entry (Story 1.7).
 * Section ids must be unique (they become anchors) and one must be
 * `contact` (the page renders `contactEmail` there).
 */
export const privacySchema = z
  .strictObject({
    lastUpdated: isoDate,
    title: localized(),
    intro: localized(),
    contactEmail: email,
    sections: z
      .array(privacySection, { error: (issue) => (issue.input === undefined ? 'is required' : 'must be a list') })
      .min(1, { error: 'must be a non-empty list' }),
    dummy,
  })
  .check((ctx) => {
    // Checks also run when other fields already failed: only inspect a usable list.
    const sections: unknown = ctx.value.sections;
    if (!Array.isArray(sections) || sections.length === 0) return;
    const ids = sections.map((section: unknown) =>
      typeof section === 'object' && section !== null ? (section as { id?: unknown }).id : undefined,
    );
    ids.forEach((id, index) => {
      if (typeof id === 'string' && ids.indexOf(id) !== index) {
        ctx.issues.push({ code: 'custom', input: id, path: ['sections', index, 'id'], message: `duplicate section id "${id}"` });
      }
    });
    if (!ids.includes(PRIVACY_CONTACT_SECTION)) {
      ctx.issues.push({
        code: 'custom',
        input: ids,
        path: ['sections'],
        message: `must include a section with id "${PRIVACY_CONTACT_SECTION}" (it carries contactEmail)`,
      });
    }
  });

export type Privacy = z.infer<typeof privacySchema>;

/** One keyed piece of static UI copy (`content/film-copy/<key>.yaml`). */
export const filmCopySchema = z.strictObject({
  text: localized(),
});

export type FilmCopy = z.infer<typeof filmCopySchema>;

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
