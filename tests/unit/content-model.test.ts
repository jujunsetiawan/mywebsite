// Story 1.5 content model: schema rules for projects, awards and testimonials
// (I/O matrix rows), plus the committed bilingual dummy seed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'astro/zod';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, parseDocument } from 'yaml';
import {
  awardSchema,
  formatIssues,
  isIsoDate,
  projectSchema,
  SECTION_KEYS,
  testimonialSchema,
} from '../../src/content/schemas.ts';
import { formatDate } from '../../src/i18n/dates.ts';
import { repoRoot } from './helpers/astro-build.ts';

// Stand-in for Astro's `image()` helper: a relative path to an image in the entry's `assets/`.
const image = () => z.string().regex(/^\.\/assets\/[^/]+\.(svg|png|jpe?g|webp|avif|gif)$/i);
const projects = projectSchema({ image });
const awards = awardSchema({ image });
const testimonials = testimonialSchema({ image });

const L = (id: string, en: string) => ({ id, en });

function validProject() {
  return {
    slug: 'contoh-proyek',
    order: 1,
    type: 'web',
    year: 2026,
    dummy: true,
    name: L('Contoh', 'Sample'),
    oneLineOutcome: L('Hasil', 'Outcome'),
    period: { start: '2026-01-01', end: '2026-03-31' },
    role: L('Peran', 'Role'),
    stack: ['TypeScript'],
    sections: {
      outcomes: { id: ['a', 'b'], en: ['a', 'b'] },
      businessFlow: { id: ['a'], en: ['a'] },
      process: { id: ['a'], en: ['a'] },
      techStack: [{ name: 'Node.js', purpose: L('Tujuan', 'Purpose') }],
      apiContract: [{ method: 'GET', path: '/v1/x', summary: L('Ringkas', 'Summary') }],
      samplePrd: L('PRD', 'PRD'),
      uiux: [{ image: './assets/x.svg', alt: L('Alt', 'Alt') }],
      prototype: { note: L('Catatan', 'Note'), url: 'https://example.com/p' },
    },
  };
}

function validAward() {
  return {
    order: 1,
    dummy: true,
    title: L('Penghargaan (contoh)', 'Award (sample)'),
    issuer: 'Lembaga Sertifikasi Contoh',
    date: '2026-03-12',
    certificate: './assets/x.svg',
    certificateAlt: L('Sertifikat', 'Certificate'),
    verifyUrl: 'https://example.com/verify/x',
  };
}

function validTestimonial() {
  return {
    order: 1,
    dummy: true,
    photo: './assets/x.svg',
    name: 'Nama Contoh',
    company: 'PT Contoh',
    quote: L('Kutipan', 'Quote'),
    project: 'contoh-proyek',
  };
}

type Schema = { safeParse: (data: unknown) => { success: boolean; error?: unknown } };

function issuesFor(schema: Schema, entryId: string, data: unknown): string[] {
  const result = schema.safeParse(data);
  expect(result.success, 'expected the entry to be rejected').toBe(false);
  return formatIssues(entryId, result.error as Parameters<typeof formatIssues>[1]);
}

/** Deep-sets `value` at a dotted path of a fresh copy (`undefined` deletes the key). */
function withField<T>(data: T, dotted: string, value: unknown): T {
  const copy = structuredClone(data) as Record<string, unknown>;
  const keys = dotted.split('.');
  let target = copy;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  const last = keys.at(-1)!;
  if (value === undefined) delete target[last];
  else target[last] = value;
  return copy as T;
}

describe('valid entries', () => {
  it('parse, with sections in the fixed display order', () => {
    const parsed = projects.parse(validProject());
    expect(Object.keys(parsed.sections)).toEqual([...SECTION_KEYS]);
    expect(awards.parse(validAward()).issuer).toBe('Lembaga Sertifikasi Contoh');
    expect(testimonials.parse(validTestimonial()).project).toBe('contoh-proyek');
  });

  it('prototype url and testimonial project are optional; dummy defaults to false', () => {
    const project = withField(withField(validProject(), 'sections.prototype.url', undefined), 'dummy', undefined);
    expect(projects.parse(project).dummy).toBe(false);
    expect(testimonials.safeParse(withField(validTestimonial(), 'project', undefined)).success).toBe(true);
  });
});

describe('matrix: non-kebab slug', () => {
  for (const slug of ['Sistem_Order', 'sistem--order', '-sistem', 'sistem-', 'Sistem', 'sistem order']) {
    it(`rejects "${slug}" naming entry + slug`, () => {
      expect(issuesFor(projects, 'sistem-order', { ...validProject(), slug })).toEqual([
        'sistem-order: slug — must be kebab-case (lowercase letters and digits separated by single hyphens)',
      ]);
    });
  }

  it('rejects a non-kebab testimonial project reference', () => {
    expect(issuesFor(testimonials, 't', { ...validTestimonial(), project: 'Nope_X' })[0]).toMatch(/^t: project — must be kebab-case/);
  });
});

describe('matrix: invalid date', () => {
  const realDate = 'must be a real calendar date in ISO format YYYY-MM-DD';

  for (const date of ['2026-13-40', '2026-02-30', '2026-3-1', '12-03-2026', '2026-03-12T00:00:00Z', '']) {
    it(`award date "${date}" fails naming entry + date`, () => {
      expect(issuesFor(awards, 'a', { ...validAward(), date })).toEqual([`a: date — ${realDate}`]);
    });
  }

  it('an unquoted YAML date (parsed to a Date) is rejected with a hint', () => {
    expect(issuesFor(awards, 'a', { ...validAward(), date: new Date('2027-02-09') })).toEqual([
      'a: date — must be a quoted ISO date string, e.g. "2026-03-01" (unquoted YAML dates are not checked)',
    ]);
  });

  it('period.start 2026-13-40 fails naming entry + period.start', () => {
    expect(issuesFor(projects, 'p', withField(validProject(), 'period.start', '2026-13-40'))).toEqual([
      `p: period.start — ${realDate}`,
    ]);
  });

  it('end before start fails naming entry + period.end', () => {
    expect(issuesFor(projects, 'p', withField(validProject(), 'period', { start: '2026-03-01', end: '2026-02-28' }))).toEqual([
      'p: period.end — must not be before start (2026-03-01)',
    ]);
  });

  it('end equal to start is accepted', () => {
    expect(projects.safeParse(withField(validProject(), 'period', { start: '2026-03-01', end: '2026-03-01' })).success).toBe(true);
  });

  it('isIsoDate accepts leap days only in leap years', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
  });
});

describe('matrix: localized list mismatch', () => {
  for (const key of ['outcomes', 'businessFlow', 'process'] as const) {
    it(`sections.${key} with 3 id and 2 en items fails naming the field`, () => {
      const data = withField(validProject(), `sections.${key}`, { id: ['a', 'b', 'c'], en: ['a', 'b'] });
      expect(issuesFor(projects, 'p', data)).toEqual([
        `p: sections.${key}.en — must have the same number of items as id (3), got 2`,
      ]);
    });
  }
});

describe('matrix: missing language', () => {
  const projectFields = [
    'name',
    'oneLineOutcome',
    'role',
    'sections.outcomes',
    'sections.businessFlow',
    'sections.process',
    'sections.techStack.0.purpose',
    'sections.apiContract.0.summary',
    'sections.samplePrd',
    'sections.uiux.0.alt',
    'sections.prototype.note',
  ];
  for (const field of projectFields) {
    it(`project ${field} without en fails naming entry + ${field}.en`, () => {
      const data = withField(validProject(), `${field}.en`, undefined);
      expect(issuesFor(projects, 'p', data)).toEqual([`p: ${field}.en — is required`]);
    });
  }

  for (const field of ['title', 'certificateAlt']) {
    it(`award ${field} without en fails naming entry + ${field}.en`, () => {
      expect(issuesFor(awards, 'a', withField(validAward(), `${field}.en`, undefined))).toEqual([`a: ${field}.en — is required`]);
    });
  }

  it('testimonial quote without en fails naming entry + quote.en', () => {
    expect(issuesFor(testimonials, 't', withField(validTestimonial(), 'quote.en', undefined))).toEqual([
      't: quote.en — is required',
    ]);
  });

  it('project name without id fails naming entry + name.id', () => {
    expect(issuesFor(projects, 'p', withField(validProject(), 'name.id', undefined))).toEqual(['p: name.id — is required']);
  });
});

describe('other field rules', () => {
  it('type is web | mobile | integrasi', () => {
    for (const type of ['web', 'mobile', 'integrasi']) expect(projects.safeParse({ ...validProject(), type }).success).toBe(true);
    expect(issuesFor(projects, 'p', { ...validProject(), type: 'desktop' })[0]).toMatch(/^p: type — /);
  });

  it('order is a positive integer', () => {
    for (const order of [0, -1, 1.5, '1']) {
      expect(issuesFor(awards, 'a', { ...validAward(), order })[0]).toMatch(/^a: order — /);
    }
  });

  it('stack is a non-empty list of non-empty strings', () => {
    expect(issuesFor(projects, 'p', { ...validProject(), stack: [] })).toEqual(['p: stack — must be a non-empty list']);
    expect(issuesFor(projects, 'p', { ...validProject(), stack: [' '] })).toEqual(['p: stack.0 — must be a non-empty string']);
  });

  it('apiContract method is GET|POST|PUT|PATCH|DELETE and path starts with /', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(projects.safeParse(withField(validProject(), 'sections.apiContract.0.method', method)).success).toBe(true);
    }
    expect(issuesFor(projects, 'p', withField(validProject(), 'sections.apiContract.0.method', 'get'))[0]).toMatch(
      /^p: sections\.apiContract\.0\.method — /,
    );
    expect(issuesFor(projects, 'p', withField(validProject(), 'sections.apiContract.0.path', 'v1/x'))).toEqual([
      'p: sections.apiContract.0.path — must start with "/"',
    ]);
  });

  it('URLs must be absolute https', () => {
    for (const url of ['http://example.com/v', 'example.com/v', 'ftp://example.com/v', '']) {
      expect(issuesFor(awards, 'a', { ...validAward(), verifyUrl: url })).toEqual(['a: verifyUrl — must be an absolute https URL']);
      expect(issuesFor(projects, 'p', withField(validProject(), 'sections.prototype.url', url))).toEqual([
        'p: sections.prototype.url — must be an absolute https URL',
      ]);
    }
  });

  it('image fields go through the image helper', () => {
    expect(issuesFor(awards, 'a', { ...validAward(), certificate: 'cert.png' })[0]).toMatch(/^a: certificate — /);
    expect(issuesFor(testimonials, 't', { ...validTestimonial(), photo: undefined })[0]).toMatch(/^t: photo — /);
    expect(issuesFor(projects, 'p', withField(validProject(), 'sections.uiux.0.image', 'x.jpg'))[0]).toMatch(
      /^p: sections\.uiux\.0\.image — /,
    );
  });

  it('rejects unknown keys at every level and the old placeholder fields', () => {
    expect(projects.safeParse({ ...validProject(), title: L('a', 'b') }).success).toBe(false);
    expect(projects.safeParse(withField(validProject(), 'sections.extra', 1)).success).toBe(false);
    expect(projects.safeParse(withField(validProject(), 'period.middle', '2026-02-01')).success).toBe(false);
    expect(awards.safeParse({ ...validAward(), year: 2026 }).success).toBe(false);
    expect(testimonials.safeParse({ ...validTestimonial(), author: 'X' }).success).toBe(false);
  });

  it('rejects hub slot fields (Epic 8/9)', () => {
    expect(projects.safeParse({ ...validProject(), districtSlot: 1 }).success).toBe(false);
    expect(awards.safeParse({ ...validAward(), folderSlot: 1 }).success).toBe(false);
  });

  it('a missing section fails naming the section', () => {
    expect(issuesFor(projects, 'p', withField(validProject(), 'sections.samplePrd', undefined))[0]).toMatch(
      /^p: sections\.samplePrd — /,
    );
  });
});

describe('formatDate (award dates on the homes)', () => {
  it('formats day month year in id-ID and en-GB', () => {
    expect(formatDate('2026-03-12', 'id')).toBe('12 Maret 2026');
    expect(formatDate('2026-03-12', 'en')).toBe('12 March 2026');
  });

  it('does not shift the day across time zones', () => {
    expect(formatDate('2025-12-31', 'en')).toBe('31 December 2025');
    expect(formatDate('2026-01-01', 'id')).toBe('1 Januari 2026');
  });
});

// ---------- Committed seed ----------

/** Parses YAML exactly like Astro's data loader (`timestamp` tag on, core schema). */
function readEntry(collection: string, file: string): unknown {
  const source = readFileSync(path.join(repoRoot, 'content', collection, file), 'utf8');
  return parseDocument(source, { customTags: ['timestamp'], merge: true, schema: 'core' }).toJS();
}

function entries(collection: string): { id: string; data: Record<string, unknown> }[] {
  return readdirSync(path.join(repoRoot, 'content', collection))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => ({ id: name.replace(/\.yaml$/, ''), data: readEntry(collection, name) as Record<string, unknown> }));
}

const SCHEMAS = { projects, awards, testimonials } as const;

const parsedProjects = entries('projects').map(({ id, data }) => ({ id, data: projects.parse(data) }));
const parsedAwards = entries('awards').map(({ id, data }) => ({ id, data: awards.parse(data) }));
const parsedTestimonials = entries('testimonials').map(({ id, data }) => ({ id, data: testimonials.parse(data) }));
const allDummy = [...parsedProjects, ...parsedAwards, ...parsedTestimonials].every(({ data }) => data.dummy);

// Seed-specific expectations for the Story 1.5 dummy projects (applied only to `dummy: true` entries).
const SEED_PROJECTS: Record<string, { type: string; outcome: RegExp }> = {
  'sistem-order-distribusi': { type: 'integrasi', outcome: /3 warehouses.*3 hours to 4 minutes/ },
  'dashboard-operasional': { type: 'web', outcome: /one screen.*6 minutes/ },
  'integrasi-pembayaran': { type: 'integrasi', outcome: /backoff.*61 % to 0\.2 %/ },
};

describe('committed content', () => {
  for (const [collection, schema] of Object.entries(SCHEMAS)) {
    it(`content/${collection}/*.yaml all parse`, () => {
      for (const { id, data } of entries(collection)) {
        const result = schema.safeParse(data);
        expect(result.success ? [] : formatIssues(id, result.error), id).toEqual([]);
      }
    });
  }

  it('the old sample-* placeholders are gone', () => {
    for (const collection of Object.keys(SCHEMAS)) {
      expect(entries(collection).map(({ id }) => id).filter((id) => id.startsWith('sample-'))).toEqual([]);
    }
  });

  it('while the whole seed is dummy: at least 3 projects, 6 awards, 3 testimonials (2 referencing projects)', () => {
    if (!allDummy) return;
    expect(parsedProjects.length).toBeGreaterThanOrEqual(3);
    expect(parsedAwards.length).toBeGreaterThanOrEqual(6);
    expect(parsedTestimonials.length).toBeGreaterThanOrEqual(3);
    expect(parsedTestimonials.filter(({ data }) => data.project !== undefined).length).toBeGreaterThanOrEqual(2);
  });

  it('dummy projects are the specified seed (slug, type, outcome)', () => {
    for (const { id, data } of parsedProjects.filter(({ data }) => data.dummy)) {
      const seed = SEED_PROJECTS[data.slug];
      expect(seed, `${id}: unexpected dummy project`).toBeDefined();
      expect(data.type, id).toBe(seed!.type);
      expect(data.oneLineOutcome.en, id).toMatch(seed!.outcome);
    }
  });

  it('dummy awards are marked as samples with fictional issuers and example.com/verify/<id>', () => {
    for (const { id, data } of parsedAwards.filter(({ data }) => data.dummy)) {
      expect(data.title.id, id).toMatch(/\(contoh\)$/);
      expect(data.title.en, id).toMatch(/\(sample\)$/);
      expect(data.issuer, id).toMatch(/Contoh/);
      expect(data.verifyUrl, id).toBe(`https://example.com/verify/${id}`);
    }
  });

  it('dummy testimonials come from fictional companies', () => {
    for (const { id, data } of parsedTestimonials.filter(({ data }) => data.dummy)) {
      expect(data.company, id).toMatch(/Contoh/);
    }
  });
});

describe('content images', () => {
  const assetFiles = ['projects', 'awards', 'testimonials'].flatMap((collection) => {
    const dir = path.join(repoRoot, 'content', collection, 'assets');
    return existsSync(dir) ? readdirSync(dir).map((name) => `content/${collection}/assets/${name}`) : [];
  });
  const licences = parseYaml(readFileSync(path.join(repoRoot, 'licenses/assets.yaml'), 'utf8')) as {
    assets: { id: string; licence: string; kind?: string; proof: string; 'used-in': string[] }[];
  };

  /** Repo paths of the images referenced by entries, split by the entry's `dummy` flag. */
  const referenced = { dummy: new Set<string>(), real: new Set<string>() };
  const add = (dummy: boolean, file: string) => referenced[dummy ? 'dummy' : 'real'].add(file);
  for (const { data } of parsedProjects) {
    for (const shot of data.sections.uiux) add(data.dummy, `content/projects/${shot.image.slice(2)}`);
  }
  for (const { data } of parsedAwards) add(data.dummy, `content/awards/${data.certificate.slice(2)}`);
  for (const { data } of parsedTestimonials) add(data.dummy, `content/testimonials/${data.photo.slice(2)}`);

  it('every image a content entry references exists, and no asset is orphaned', () => {
    const all = new Set([...referenced.dummy, ...referenced.real]);
    for (const file of all) expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
    expect([...all].sort()).toEqual([...assetFiles].sort());
  });

  it('images of dummy entries are self-made SVGs (no embedded raster images)', () => {
    for (const file of referenced.dummy) {
      expect(file).toMatch(/\.svg$/);
      const svg = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(svg, file).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg, file).not.toMatch(/<image|data:image|href=/);
    }
  });

  it('images of dummy entries are listed in licenses/assets.yaml as original, kind image, with used-in', () => {
    for (const file of referenced.dummy) {
      const entry = licences.assets.find((asset) => asset.proof === file);
      expect(entry, file).toBeDefined();
      expect(entry!.licence).toBe('original');
      expect(entry!.kind).toBe('image');
      expect(entry!['used-in'].length).toBeGreaterThan(0);
    }
  });
});