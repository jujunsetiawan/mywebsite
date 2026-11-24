import { describe, expect, it } from 'vitest';
import {
  alternates,
  assertRoutePath,
  canonical,
  localePath,
  mirrorPath,
  otherLocale,
  parseLocalePath,
} from '../../src/i18n/routes.ts';

const ORIGIN = 'https://jun.example';

describe('localePath', () => {
  it('joins language and route path with trailing slashes', () => {
    expect(localePath('id', '')).toBe('/id/');
    expect(localePath('en', '')).toBe('/en/');
    expect(localePath('en', 'proyek/x/')).toBe('/en/proyek/x/');
  });

  it('rejects malformed route paths', () => {
    for (const bad of ['/', '/proyek/x/', 'proyek/x', 'proyek//x/', 'proyek/x/?a=1', 'proyek/x/#top', 'Proyek/']) {
      expect(() => assertRoutePath(bad), bad).toThrow(/invalid route path/);
      expect(() => localePath('id', bad), bad).toThrow();
    }
  });
});

describe('parseLocalePath / mirrorPath', () => {
  it('mirrors to the other language with the identical slug', () => {
    expect(mirrorPath('/id/')).toBe('/en/');
    expect(mirrorPath('/en/')).toBe('/id/');
    expect(mirrorPath('/id/proyek/x/')).toBe('/en/proyek/x/');
    expect(mirrorPath('/en/proyek/x/')).toBe('/id/proyek/x/');
  });

  it('returns null for non-localized paths', () => {
    for (const p of ['/', '/fr/', '/proyek/x/', '/id', '/id/x', '404.html']) {
      expect(parseLocalePath(p), p).toBeNull();
      expect(mirrorPath(p), p).toBeNull();
    }
  });

  it('parses language and route path', () => {
    expect(parseLocalePath('/en/proyek/x/')).toEqual({ lang: 'en', path: 'proyek/x/' });
    expect(otherLocale('id')).toBe('en');
    expect(otherLocale('en')).toBe('id');
  });
});

describe('canonical / alternates', () => {
  it('canonical is absolute on the origin and never carries a query', () => {
    expect(canonical(ORIGIN, 'id', '')).toBe('https://jun.example/id/');
    expect(canonical(ORIGIN, 'en', 'proyek/x/')).toBe('https://jun.example/en/proyek/x/');
  });

  it('alternates list id, en and x-default (→ the id page)', () => {
    expect(alternates(ORIGIN, '')).toEqual([
      { hreflang: 'id', href: 'https://jun.example/id/' },
      { hreflang: 'en', href: 'https://jun.example/en/' },
      { hreflang: 'x-default', href: 'https://jun.example/id/' },
    ]);
    expect(alternates(ORIGIN, 'proyek/x/').map((a) => a.href)).toEqual([
      'https://jun.example/id/proyek/x/',
      'https://jun.example/en/proyek/x/',
      'https://jun.example/id/proyek/x/',
    ]);
  });
});
