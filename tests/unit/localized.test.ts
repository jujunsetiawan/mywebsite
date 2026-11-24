// Bilingual field helpers (`localized()`, `localizedList()`) and their error
// messages, as used by the Story 1.5 content model.
import { describe, expect, it } from 'vitest';
import { formatIssues, localized, localizedList } from '../../src/content/schemas.ts';

function issues(schema: { safeParse: (data: unknown) => { success: boolean; error?: unknown } }, data: unknown) {
  const result = schema.safeParse(data);
  expect(result.success).toBe(false);
  return formatIssues('entry', result.error as Parameters<typeof formatIssues>[1]);
}

describe('localized()', () => {
  it('accepts non-empty id and en', () => {
    expect(localized().parse({ id: 'Halo', en: 'Hello' })).toEqual({ id: 'Halo', en: 'Hello' });
  });

  it('missing en names the field', () => {
    expect(issues(localized(), { id: 'Halo' })).toEqual(['entry: en — is required']);
  });

  it('missing id names the field', () => {
    expect(issues(localized(), { en: 'Hello' })).toEqual(['entry: id — is required']);
  });

  it('rejects whitespace-only text', () => {
    expect(issues(localized(), { id: 'Halo', en: '  ' })).toEqual(['entry: en — must be a non-empty string']);
  });

  it('rejects unknown keys', () => {
    expect(localized().safeParse({ id: 'Halo', en: 'Hello', fr: 'Bonjour' }).success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(issues(localized(), { id: 1, en: 'Hello' })).toEqual(['entry: id — must be a string']);
  });
});

describe('localizedList()', () => {
  it('accepts equal-length non-empty lists', () => {
    const value = { id: ['Satu', 'Dua'], en: ['One', 'Two'] };
    expect(localizedList().parse(value)).toEqual(value);
  });

  it('length mismatch names the en field', () => {
    expect(issues(localizedList(), { id: ['a', 'b', 'c'], en: ['a', 'b'] })).toEqual([
      'entry: en — must have the same number of items as id (3), got 2',
    ]);
  });

  it('missing en names the field', () => {
    expect(issues(localizedList(), { id: ['a'] })).toEqual(['entry: en — is required']);
  });

  it('rejects empty lists', () => {
    expect(issues(localizedList(), { id: [], en: [] })).toEqual([
      'entry: id — must be a non-empty list',
      'entry: en — must be a non-empty list',
    ]);
  });

  it('rejects empty items, naming the item index', () => {
    expect(issues(localizedList(), { id: ['a', ' '], en: ['a', 'b'] })).toEqual([
      'entry: id.1 — must be a non-empty string',
    ]);
  });

  it('rejects a plain string instead of a list', () => {
    expect(issues(localizedList(), { id: 'a', en: ['a'] })).toEqual(['entry: id — must be a list']);
  });

  it('rejects unknown keys', () => {
    expect(localizedList().safeParse({ id: ['a'], en: ['a'], fr: ['a'] }).success).toBe(false);
  });
});
