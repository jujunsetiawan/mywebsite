// Story 1.6: project pages built from a temp copy of `content/` (via the
// `CONTENT_DIR` test seam): empty lists hide their section; projects without
// referencing testimonials have no testimonials block. Slugs and ids are read
// from `content/`, so a content swap needs no test edit.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, parseDocument } from 'yaml';
import { SECTION_KEYS } from '../../src/content/schemas.ts';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'project-pages-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const yamlFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.yaml'));

/** Edits a YAML file in place, keeping every untouched node (and its quoting) as written. */
function editYaml(file: string, edit: (doc: ReturnType<typeof parseDocument>) => void): void {
  const doc = parseDocument(readFileSync(file, 'utf8'));
  edit(doc);
  writeFileSync(file, doc.toString());
}

/** `data-section` values of a built project page, in document order. */
const sectionsOf = (html: string) => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);

interface ProjectData {
  slug: string;
  order: number;
  sections: Record<string, unknown>;
}

/** Sections a project shows: localized lists are non-empty by schema; other lists hide when empty. */
function expectedSections(project: ProjectData): string[] {
  return SECTION_KEYS.filter((key) => {
    const value = project.sections[key];
    return !Array.isArray(value) || value.length > 0;
  });
}

describe('project pages from edited content', () => {
  it('empty techStack/apiContract/uiux lists hide their sections; no referencing testimonial → no block', () => {
    const contentDir = path.join(tmpRoot, 'content');
    cpSync(path.join(repoRoot, 'content'), contentDir, { recursive: true });
    const projectsDir = path.join(contentDir, 'projects');
    const testimonialsDir = path.join(contentDir, 'testimonials');

    const projects = yamlFiles(projectsDir)
      .map((name) => parse(readFileSync(path.join(projectsDir, name), 'utf8')) as ProjectData)
      .sort((a, b) => a.order - b.order);
    const target = projects[0]!;
    const other = projects[1];

    // Target: empty the optional lists and drop every testimonial reference to it.
    editYaml(path.join(projectsDir, `${target.slug}.yaml`), (doc) => {
      for (const key of ['techStack', 'apiContract', 'uiux']) doc.setIn(['sections', key], doc.createNode([]));
    });
    const testimonialFiles = yamlFiles(testimonialsDir);
    for (const name of testimonialFiles) {
      editYaml(path.join(testimonialsDir, name), (doc) => {
        if (doc.get('project') === target.slug) doc.delete('project');
      });
    }
    // Other project (if any): make sure at least one testimonial references it.
    let otherTestimonial: string | undefined;
    if (other !== undefined) {
      const source = testimonialFiles[0]!;
      const orders = testimonialFiles.map((name) => Number(parse(readFileSync(path.join(testimonialsDir, name), 'utf8')).order));
      otherTestimonial = 'zz-project-pages-test';
      const copy = path.join(testimonialsDir, `${otherTestimonial}.yaml`);
      writeFileSync(copy, readFileSync(path.join(testimonialsDir, source), 'utf8'));
      editYaml(copy, (doc) => {
        doc.set('order', Math.max(...orders) + 1);
        doc.set('project', other.slug);
      });
    }

    const outDir = path.join(tmpRoot, 'dist');
    const { run, output } = astroBuild(outDir, { SITE_ENV: 'development', CONTENT_DIR: contentDir }, { freshContentStore: true });
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).toBe(0);

    for (const lang of ['id', 'en']) {
      const html = readFileSync(path.join(outDir, lang, `proyek/${target.slug}/index.html`), 'utf8');
      expect(sectionsOf(html), lang).toEqual(['outcomes', 'businessFlow', 'process', 'samplePrd', 'prototype']);
      expect(html).not.toMatch(/<h2[^>]*>(Kontrak API|API contract|Teknologi|Technology|UI\/UX)<\/h2>/);
      expect(html).not.toContain('class="project-testimonials"');
      expect(html).not.toContain('<figure');
      if (other !== undefined) {
        // An untouched project keeps its sections and shows its testimonial.
        const otherHtml = readFileSync(path.join(outDir, lang, `proyek/${other.slug}/index.html`), 'utf8');
        expect(sectionsOf(otherHtml)).toEqual(expectedSections(other));
        expect(otherHtml).toContain(`data-testimonial="${otherTestimonial}"`);
      }
    }
  }, 180_000);
});
