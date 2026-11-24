// Feature-flagged static chrome (Story 1.3): real `astro build`s of the site
// with flags off (committed development config) and on (temp config dir).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { filmCopySchema, formatIssues } from '../../src/content/schemas.ts';
import { COPY_KEYS } from '../../src/i18n/copy-keys.ts';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'static-chrome-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function configDir(name: string, features: { hubLinks: boolean; contact: boolean }): string {
  const dir = path.join(tmpRoot, `config-${name}`);
  mkdirSync(dir);
  const committed = JSON.parse(readFileSync(path.join(repoRoot, 'config/site.development.json'), 'utf8'));
  writeFileSync(path.join(dir, 'site.development.json'), JSON.stringify({ ...committed, features }));
  return dir;
}

function build(name: string, features: { hubLinks: boolean; contact: boolean }) {
  const outDir = path.join(tmpRoot, name);
  const { run, output } = astroBuild(outDir, {
    SITE_ENV: 'development',
    SITE_CONFIG_DIR: configDir(name, features),
  });
  expect(run.error, output).toBeUndefined();
  expect(run.status, output).toBe(0);
  return (file: string) => readFileSync(path.join(outDir, file), 'utf8');
}

const FLAGGED = ['skip-story', 'awards', 'contact'] as const;
const chromeItem = (html: string, key: string) => html.includes(`data-chrome="${key}"`);

describe('static chrome feature flags', () => {
  it('flags false: skip-story, awards and contact are absent from the markup', () => {
    const read = build('flags-off', { hubLinks: false, contact: false });
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      for (const key of FLAGGED) expect(chromeItem(html, key), `${lang}: ${key}`).toBe(false);
      expect(html).not.toMatch(/Lewati Cerita|Skip Story|Penghargaan|>Awards<|Hubungi|>Contact</);
      expect(chromeItem(html, 'projects')).toBe(true);
      expect(chromeItem(html, 'credit')).toBe(true);
    }
    const id = read('id/index.html');
    expect(id).toContain('Jun Studio mempersembahkan');
    expect(id).toContain('>Proyek<');
    expect(id).toContain('href="/id/#proyek"');
    const en = read('en/index.html');
    expect(en).toContain('Jun Studio presents');
    expect(en).toContain('>Projects<');
    expect(en).toContain('href="/en/#proyek"');
    expect(en).toContain('>Skip to content<');
    expect(id).toContain('aria-label="Kaki situs"');
    expect(en).toContain('aria-label="Site footer"');
    // CSP `style-src 'self'`: no inline <style> and no style attributes.
    for (const html of [id, en]) expect(html).not.toMatch(/<style|\sstyle=/);
  }, 120_000);

  it('flags true: skip-story, awards and the contact pill render in the page language', () => {
    const read = build('flags-on', { hubLinks: true, contact: true });
    const id = read('id/index.html');
    for (const key of FLAGGED) expect(chromeItem(id, key), key).toBe(true);
    expect(id).toContain('>Lewati Cerita<');
    expect(id).toContain('>Penghargaan<');
    expect(id).toMatch(/class="chrome-pill">Hubungi</);
    for (const target of ['#hub', '#penghargaan', '#hubungi']) expect(id).toContain(`href="/id/${target}"`);
    const en = read('en/index.html');
    for (const target of ['#hub', '#penghargaan', '#hubungi']) expect(en).toContain(`href="/en/${target}"`);
    expect(en).toContain('>Skip Story<');
    expect(en).toContain('>Awards<');
    expect(en).toMatch(/class="chrome-pill">Contact</);
  }, 120_000);

  it('only hubLinks: hub links render, the contact pill does not', () => {
    const read = build('hub-only', { hubLinks: true, contact: false });
    const html = read('id/index.html');
    expect(chromeItem(html, 'skip-story')).toBe(true);
    expect(chromeItem(html, 'awards')).toBe(true);
    expect(chromeItem(html, 'contact')).toBe(false);
  }, 120_000);
});

describe('film-copy keys', () => {
  it('content/film-copy/*.yaml basenames equal COPY_KEYS exactly', () => {
    const files = readdirSync(path.join(repoRoot, 'content/film-copy'))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.replace(/\.yaml$/, ''))
      .sort();
    expect(files).toEqual([...COPY_KEYS].sort());
  });
});

describe('film-copy schema', () => {
  it('rejects an entry without `en`, naming entry and field', () => {
    const result = filmCopySchema.safeParse({ text: { id: 'Proyek' } });
    expect(result.success).toBe(false);
    expect(formatIssues('chrome.projects', result.error!)).toEqual(['chrome.projects: text.en — is required']);
  });

  it('rejects unknown fields', () => {
    expect(filmCopySchema.safeParse({ text: { id: 'a', en: 'b' }, extra: 1 }).success).toBe(false);
  });
});
