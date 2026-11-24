// Feature-flagged static chrome (Story 1.3): real `astro build`s of the site
// with flags off (committed development config) and on (temp config dir).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

/** Project slugs from the committed content (file names). */
const projectSlugs = () =>
  readdirSync(path.join(repoRoot, 'content/projects'))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.replace(/\.yaml$/, ''));
const chromeItem = (html: string, key: string) => html.includes(`data-chrome="${key}"`);

describe('static chrome feature flags', () => {
  it('flags false: skip-story, awards and contact are absent from the markup', () => {
    const read = build('flags-off', { hubLinks: false, contact: false });
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      for (const key of FLAGGED) expect(chromeItem(html, key), `${lang}: ${key}`).toBe(false);
      // The bar holds no hub/contact items (the awards *section* below is content, Story 1.5).
      const bar = html.match(/<header class="bar bar--top[\s\S]*?<\/header>/)?.[0];
      expect(bar, `${lang}: top bar`).toBeDefined();
      expect(bar).not.toMatch(/Lewati Cerita|Skip Story|Penghargaan|>Awards<|Hubungi|>Contact</);
      expect(html).not.toMatch(/Lewati Cerita|Skip Story|Hubungi|>Contact</);
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
    // ID/EN switch (Story 1.4): plain links, current language marked, names in their own language.
    expect(id).toContain('<nav class="lang-switch" aria-label="Bahasa">');
    expect(en).toContain('<nav class="lang-switch" aria-label="Language">');
    for (const html of [id, en]) {
      // No aria-label: name = visible code + visually hidden own-language name (WCAG 2.5.3).
      expect(html).not.toMatch(/<a [^>]*data-chrome="lang-[^>]*aria-label|<a [^>]*aria-label[^>]*data-chrome="lang-/);
      expect(html).toMatch(
        /<a class="chrome-link" href="\/id\/" hreflang="id" lang="id"[^>]*>ID<span class="visually-hidden"> Bahasa Indonesia<\/span><\/a>/,
      );
      expect(html).toMatch(
        /<a class="chrome-link" href="\/en\/" hreflang="en" lang="en"[^>]*>EN<span class="visually-hidden"> English<\/span><\/a>/,
      );
      expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    }
    // Story 1.5: the projects and awards sections list every content entry.
    const count = (collection: string) =>
      readdirSync(path.join(repoRoot, 'content', collection)).filter((name) => name.endsWith('.yaml')).length;
    for (const html of [id, en]) {
      expect(html.match(/<li class="content-list-item" data-project=/g) ?? []).toHaveLength(count('projects'));
      expect(html.match(/<li class="content-list-item" data-award=/g) ?? []).toHaveLength(count('awards'));
    }
    expect(id).toMatch(/<h2 id="penghargaan-heading"[^>]*>Penghargaan<\/h2>/);
    expect(en).toMatch(/<h2 id="penghargaan-heading"[^>]*>Awards<\/h2>/);
    expect(id).toMatch(/aria-current="true" data-chrome="lang-id"/);
    expect(en).toMatch(/aria-current="true" data-chrome="lang-en"/);
    // Keyed home copy: one language per page.
    expect(id).toContain('Product engineer yang menjaga sistem tetap hidup — dan menceritakannya lewat film pendek.');
    expect(id).not.toContain('A product engineer who keeps systems alive');
    expect(en).toContain('A product engineer who keeps systems alive — and tells the story as a short film.');
    expect(en).not.toContain('Product engineer yang menjaga');
    expect(id).toMatch(/<h2 id="proyek-heading"[^>]*>Proyek<\/h2>/);
    expect(en).toMatch(/<h2 id="proyek-heading"[^>]*>Projects<\/h2>/);
    // Story 1.6: project pages carry the secondary link but not the flag-gated primary pill.
    for (const lang of ['id', 'en']) {
      for (const slug of projectSlugs()) {
        const html = read(`${lang}/proyek/${slug}/index.html`);
        expect(html, `${lang}/${slug}`).toContain(`data-action="watch-film"`);
        expect(html, `${lang}/${slug}`).not.toContain('data-action="see-in-office"');
        expect(html).not.toMatch(/Lihat di kantor 3D|See it in the 3D office/);
        expect(html).not.toMatch(/<style|\sstyle=/);
      }
    }
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
    // Story 1.6: with hubLinks on, project pages show the primary pill into the 3D office.
    for (const slug of projectSlugs()) {
      expect(read(`id/proyek/${slug}/index.html`)).toMatch(
        /<a class="project-action-primary" href="\/id\/#proyek" data-action="see-in-office"><span class="project-pill t-ui-caps">Lihat di kantor 3D →<\/span><\/a>/,
      );
      expect(read(`en/proyek/${slug}/index.html`)).toMatch(
        /<a class="project-action-primary" href="\/en\/#proyek" data-action="see-in-office"><span class="project-pill t-ui-caps">See it in the 3D office →<\/span><\/a>/,
      );
    }
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

  it('every key has non-empty `id` and `en` text', () => {
    for (const key of COPY_KEYS) {
      const data = parseYaml(readFileSync(path.join(repoRoot, 'content/film-copy', `${key}.yaml`), 'utf8'));
      const result = filmCopySchema.safeParse(data);
      expect(result.success ? [] : formatIssues(key, result.error), key).toEqual([]);
    }
  });

  it('Story 1.4 keys carry the specified copy', () => {
    const text = (key: string) =>
      filmCopySchema.parse(parseYaml(readFileSync(path.join(repoRoot, 'content/film-copy', `${key}.yaml`), 'utf8'))).text;
    expect(text('chrome.lang-id')).toEqual({ id: 'ID', en: 'ID' });
    expect(text('chrome.lang-en')).toEqual({ id: 'EN', en: 'EN' });
    expect(text('chrome.lang-id-name')).toEqual({ id: 'Bahasa Indonesia', en: 'Bahasa Indonesia' });
    expect(text('chrome.lang-en-name')).toEqual({ id: 'English', en: 'English' });
    expect(text('chrome.lang-switch-label')).toEqual({ id: 'Bahasa', en: 'Language' });
    expect(text('page.home.title')).toEqual({ id: 'Jujun Setiawan', en: 'Jujun Setiawan' });
    expect(text('page.home.projects-heading')).toEqual({ id: 'Proyek', en: 'Projects' });
    expect(text('page.home.intro')).toEqual({
      id: 'Product engineer yang menjaga sistem tetap hidup — dan menceritakannya lewat film pendek.',
      en: 'A product engineer who keeps systems alive — and tells the story as a short film.',
    });
  });

  it('Story 1.5 keys carry the specified copy', () => {
    const text = (key: string) =>
      filmCopySchema.parse(parseYaml(readFileSync(path.join(repoRoot, 'content/film-copy', `${key}.yaml`), 'utf8'))).text;
    expect(text('page.home.awards-heading')).toEqual({ id: 'Penghargaan', en: 'Awards' });
    expect(text('page.home.verify')).toEqual({ id: 'Verifikasi', en: 'Verify' });
    expect(text('page.home.verify-new-tab')).toEqual({ id: '(tab baru)', en: '(new tab)' });
  });

  it('Story 1.6 keys carry the specified copy', () => {
    const text = (key: string) =>
      filmCopySchema.parse(parseYaml(readFileSync(path.join(repoRoot, 'content/film-copy', `${key}.yaml`), 'utf8'))).text;
    expect(text('page.project.eyebrow')).toEqual({ id: 'Dari arsip Jun', en: "From Jun's archive" });
    expect(text('page.project.role-label')).toEqual({ id: 'Peranku:', en: 'My role:' });
    const headings = {
      'page.project.outcomes': ['Hasil', 'Outcomes'],
      'page.project.business-flow': ['Alur bisnis', 'Business flow'],
      'page.project.process': ['Proses kerja', 'How we worked'],
      'page.project.tech-stack': ['Teknologi', 'Technology'],
      'page.project.api-contract': ['Kontrak API', 'API contract'],
      'page.project.sample-prd': ['Contoh PRD', 'Sample PRD'],
      'page.project.uiux': ['UI/UX', 'UI/UX'],
      'page.project.prototype': ['Prototipe', 'Prototype'],
    } as const;
    for (const [key, [id, en]] of Object.entries(headings)) expect(text(key), key).toEqual({ id, en });
    expect(text('page.project.watch-film')).toEqual({ id: 'Tonton filmnya dari awal', en: 'Watch the film from the start' });
    expect(text('page.project.see-in-office')).toEqual({ id: 'Lihat di kantor 3D →', en: 'See it in the 3D office →' });
    expect(text('page.archive-empty.title')).toEqual({ id: 'Arsip ini kosong', en: 'This archive is empty' });
    expect(text('page.archive-empty.body')).toEqual({
      id: 'Map ini sepertinya terselip. Coba pilih proyek lain.',
      en: 'This folder seems to have gone missing. Try another project.',
    });
  });

  it('the language home, project pages and their components hold no visible literals', () => {
    for (const file of [
      'src/pages/[lang]/index.astro',
      'src/pages/[lang]/proyek/[slug].astro',
      'src/pages/[lang]/proyek/404.astro',
      'src/components/ProjectDetail.astro',
      'src/components/Testimonial.astro',
    ]) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, file).not.toContain('Jujun Setiawan');
      expect(source, file).not.toMatch(
        /Dari arsip|Jun's archive|Peranku|My role|Tonton filmnya|Watch the film|Lihat di kantor|3D office|Arsip ini kosong|archive is empty|Hasil|Outcomes|Alur bisnis|Business flow|Proses kerja|How we worked|Kontrak API|API contract|Contoh PRD|Sample PRD|Prototipe/,
      );
    }
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
