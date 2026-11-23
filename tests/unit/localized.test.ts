import { describe, expect, it } from 'vitest';
import {
  awardSchema,
  formatIssues,
  localized,
  projectSchema,
  testimonialSchema,
} from '../../src/content/schemas.ts';

const validProject = {
  dummy: true,
  title: { id: 'Contoh Proyek', en: 'Sample Project' },
  summary: { id: 'Ringkasan', en: 'Summary' },
  year: 2026,
};

function issuesFor(entryId: string, data: unknown): string[] {
  const result = projectSchema.safeParse(data);
  expect(result.success).toBe(false);
  return result.success ? [] : formatIssues(entryId, result.error);
}

describe('localized()', () => {
  it('accepts non-empty id and en', () => {
    expect(localized().parse({ id: 'Halo', en: 'Hello' })).toEqual({ id: 'Halo', en: 'Hello' });
  });

  it('rejects unknown keys', () => {
    expect(localized().safeParse({ id: 'Halo', en: 'Hello', fr: 'Bonjour' }).success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(localized().safeParse({ id: 1, en: 'Hello' }).success).toBe(false);
  });
});

describe('content entry validation (I/O matrix)', () => {
  it('valid entry parses', () => {
    expect(projectSchema.parse(validProject).title.en).toBe('Sample Project');
  });

  it('missing en fails naming entry id and field path', () => {
    const issues = issuesFor('sample-project', { ...validProject, title: { id: 'Contoh' } });
    expect(issues).toContain('sample-project: title.en — is required');
  });

  it('missing id fails naming entry id and field path', () => {
    const issues = issuesFor('sample-project', { ...validProject, title: { en: 'Sample' } });
    expect(issues).toContain('sample-project: title.id — is required');
  });

  it('whitespace-only locale fails naming entry id and field path', () => {
    const issues = issuesFor('sample-project', { ...validProject, title: { id: 'Contoh', en: '  ' } });
    expect(issues).toContain('sample-project: title.en — must be a non-empty string');
  });

  it('dummy defaults to false when omitted', () => {
    const { dummy: _omit, ...rest } = validProject;
    expect(projectSchema.parse(rest).dummy).toBe(false);
  });
});

describe('schema strictness and field rules', () => {
  const validAward = { title: { id: 'P', en: 'A' }, issuer: 'X', year: 2026 };
  const validTestimonial = { title: { id: 'T', en: 'T' }, quote: { id: 'Q', en: 'Q' }, author: 'X' };

  it('rejects unknown top-level keys', () => {
    expect(projectSchema.safeParse({ ...validProject, summery: 'typo' }).success).toBe(false);
  });

  it('rejects whitespace-only issuer and author', () => {
    expect(awardSchema.safeParse({ ...validAward, issuer: '   ' }).success).toBe(false);
    expect(testimonialSchema.safeParse({ ...validTestimonial, author: '   ' }).success).toBe(false);
  });

  it('accepts integer years 1900–2100 only', () => {
    expect(awardSchema.safeParse({ ...validAward, year: 1899 }).success).toBe(false);
    expect(awardSchema.safeParse({ ...validAward, year: 2101 }).success).toBe(false);
    expect(awardSchema.safeParse({ ...validAward, year: 2026.5 }).success).toBe(false);
    expect(projectSchema.safeParse({ ...validProject, year: 1899 }).success).toBe(false);
    expect(projectSchema.safeParse({ ...validProject, year: 2101 }).success).toBe(false);
    expect(projectSchema.safeParse({ ...validProject, year: 2026.5 }).success).toBe(false);
  });

  it('rejects a testimonial quote missing en', () => {
    expect(testimonialSchema.safeParse({ ...validTestimonial, quote: { id: 'Q' } }).success).toBe(false);
  });
});

describe('award and testimonial schemas', () => {
  it('require a localized title', () => {
    expect(awardSchema.safeParse({ title: { id: 'A' }, issuer: 'X', year: 2026 }).success).toBe(false);
    expect(
      testimonialSchema.safeParse({ title: { id: 'A', en: 'A' }, quote: { id: 'Q', en: 'Q' }, author: 'X' }).success,
    ).toBe(true);
  });
});
