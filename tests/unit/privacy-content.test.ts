// Story 1.7 privacy content: schema rules (I/O matrix rows), the single-entry
// rule, the committed seed, the new copy keys, and real `astro build`s that
// fail on a second entry or a missing language (via the `CONTENT_DIR` seam).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, parseDocument } from 'yaml';
import { filmCopySchema, formatIssues, privacySchema } from '../../src/content/schemas.ts';
import { ContentIntegrityError, singlePrivacyEntry } from '../../src/content/integrity.ts';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const L = (id: string, en: string) => ({ id, en });
const LL = (id: string[], en: string[]) => ({ id, en });

function validPrivacy() {
  return {
    lastUpdated: '2026-11-25',
    dummy: true,
    contactEmail: 'jun@example.com',
    title: L('Privasi', 'Privacy'),
    intro: L('Pengantar', 'Intro'),
    sections: [
      {
        id: 'cloudflare',
        heading: L('Cloudflare', 'Cloudflare'),
        paragraphs: LL(['a'], ['a']),
        policyUrl: 'https://www.cloudflare.com/privacypolicy/',
      },
      { id: 'contact', heading: L('Kontak', 'Contact'), paragraphs: LL(['b'], ['b']) },
    ],
  };
}

function issuesFor(data: unknown, entryId = 'privacy'): string[] {
  const result = privacySchema.safeParse(data);
  expect(result.success, 'expected the entry to be rejected').toBe(false);
  return formatIssues(entryId, result.error!);
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

describe('privacy schema', () => {
  it('a valid entry parses; policyUrl is optional and dummy defaults to false', () => {
    expect(privacySchema.parse(validPrivacy()).contactEmail).toBe('jun@example.com');
    const minimal = withField(withField(validPrivacy(), 'sections.0.policyUrl', undefined), 'dummy', undefined);
    expect(privacySchema.parse(minimal).dummy).toBe(false);
  });

  describe('matrix: missing language', () => {
    for (const field of ['sections.0.heading', 'sections.1.paragraphs', 'title', 'intro']) {
      it(`${field} without en fails naming entry + ${field}.en`, () => {
        expect(issuesFor(withField(validPrivacy(), `${field}.en`, undefined))).toEqual([`privacy: ${field}.en — is required`]);
      });
    }

    it('title without id fails naming title.id', () => {
      expect(issuesFor(withField(validPrivacy(), 'title.id', undefined))).toEqual(['privacy: title.id — is required']);
    });

    it('paragraphs with different item counts per language fail', () => {
      expect(issuesFor(withField(validPrivacy(), 'sections.0.paragraphs', LL(['a', 'b'], ['a'])))).toEqual([
        'privacy: sections.0.paragraphs.en — must have the same number of items as id (2), got 1',
      ]);
    });
  });

  describe('matrix: bad email', () => {
    it('accepts plain addresses', () => {
      for (const contactEmail of ['jun@example.com', 'jujun.setiawan+site@mail.example.co.id', 'j_s-1@a-b.io']) {
        expect(privacySchema.safeParse({ ...validPrivacy(), contactEmail }).success, contactEmail).toBe(true);
      }
    });

    for (const contactEmail of [
      'jun',
      'jun@',
      '@example.com',
      'jun@example',
      'jun @example.com',
      'Jun <jun@example.com>',
      '',
      // mailto: header injection and dot problems
      'jun?cc=x@example.com',
      'jun@example.com?cc=x@y.z',
      'jun&x@example.com',
      'jun#x@example.com',
      'jun%40x@example.com',
      'jun/x@example.com',
      '.jun@x.com',
      'jun.@x.com',
      'ju..n@x.com',
      'jun@x..com',
      'jun@.x.com',
    ]) {
      it(`contactEmail "${contactEmail}" fails naming the field`, () => {
        expect(issuesFor({ ...validPrivacy(), contactEmail })).toEqual([
          'privacy: contactEmail — must be an email address, e.g. "name@example.com"',
        ]);
      });
    }

    it('a missing contactEmail fails', () => {
      expect(issuesFor(withField(validPrivacy(), 'contactEmail', undefined))).toEqual(['privacy: contactEmail — is required']);
    });
  });

  describe('lastUpdated', () => {
    it('an unquoted YAML date (parsed to a Date) is rejected with a hint', () => {
      expect(issuesFor({ ...validPrivacy(), lastUpdated: new Date('2026-11-25') })).toEqual([
        'privacy: lastUpdated — must be a quoted ISO date string, e.g. "2026-03-01" (unquoted YAML dates are not checked)',
      ]);
    });

    it('the unquoted YAML date really parses to a Date (Astro loader settings)', () => {
      const parsed = parseDocument('lastUpdated: 2026-11-25\n', { customTags: ['timestamp'], schema: 'core' }).toJS();
      expect(parsed.lastUpdated).toBeInstanceOf(Date);
    });

    it('an impossible date is rejected', () => {
      expect(issuesFor({ ...validPrivacy(), lastUpdated: '2026-02-30' })).toEqual([
        'privacy: lastUpdated — must be a real calendar date in ISO format YYYY-MM-DD',
      ]);
    });
  });

  describe('sections', () => {
    it('must be a non-empty list', () => {
      expect(issuesFor({ ...validPrivacy(), sections: [] })).toEqual(['privacy: sections — must be a non-empty list']);
    });

    it('ids are kebab-case', () => {
      expect(issuesFor(withField(validPrivacy(), 'sections.0.id', 'Cloud_Flare'))[0]).toMatch(/^privacy: sections\.0\.id — must be kebab-case/);
    });

    it('ids are unique', () => {
      expect(issuesFor(withField(validPrivacy(), 'sections.0.id', 'contact'))).toEqual([
        'privacy: sections.1.id — duplicate section id "contact"',
      ]);
    });

    it('a contact section is required (it carries contactEmail)', () => {
      expect(issuesFor(withField(validPrivacy(), 'sections.1.id', 'questions'))).toEqual([
        'privacy: sections — must include a section with id "contact" (it carries contactEmail)',
      ]);
    });

    it('policyUrl must be https', () => {
      expect(issuesFor(withField(validPrivacy(), 'sections.0.policyUrl', 'http://example.com'))).toEqual([
        'privacy: sections.0.policyUrl — must be an absolute https URL',
      ]);
    });

    it('rejects unknown keys', () => {
      expect(privacySchema.safeParse({ ...validPrivacy(), retention: '30 days' }).success).toBe(false);
      expect(privacySchema.safeParse(withField(validPrivacy(), 'sections.0.extra', 1)).success).toBe(false);
    });
  });
});

describe('matrix: zero or two entries', () => {
  it('one entry is returned', () => {
    expect(singlePrivacyEntry([{ id: 'privacy' }])).toEqual({ id: 'privacy' });
  });

  it('zero entries fail naming the expected file', () => {
    expect(() => singlePrivacyEntry([])).toThrow(ContentIntegrityError);
    expect(() => singlePrivacyEntry([])).toThrow('privacy: (collection) — missing entry (expected content/privacy/privacy.yaml)');
  });

  it('two entries fail naming both', () => {
    expect(() => singlePrivacyEntry([{ id: 'privacy' }, { id: 'extra' }])).toThrow(
      'privacy → extra, privacy: (collection) — expected exactly 1 entry, found 2',
    );
  });
});

// ---------- Committed seed ----------

const seedSource = readFileSync(path.join(repoRoot, 'content/privacy/privacy.yaml'), 'utf8');
const seedRaw = parseDocument(seedSource, { customTags: ['timestamp'], merge: true, schema: 'core' }).toJS();

describe('committed content/privacy/privacy.yaml', () => {
  it('parses', () => {
    const result = privacySchema.safeParse(seedRaw);
    expect(result.success ? [] : formatIssues('privacy', result.error), 'privacy').toEqual([]);
  });

  const seed = privacySchema.parse(seedRaw);

  it('names the processors in the specified order, then browser storage and contact', () => {
    expect(seed.sections.map((section) => section.id)).toEqual([
      'cloudflare',
      'web3forms',
      'hcaptcha',
      'browser-storage',
      'controller-rights',
      'contact',
    ]);
  });

  it('links each processor policy', () => {
    const urls = Object.fromEntries(seed.sections.map((section) => [section.id, section.policyUrl]));
    expect(urls).toEqual({
      cloudflare: 'https://www.cloudflare.com/privacypolicy/',
      web3forms: 'https://web3forms.com/privacy',
      hcaptcha: 'https://www.hcaptcha.com/privacy',
      'browser-storage': undefined,
      'controller-rights': undefined,
      contact: undefined,
    });
  });

  it('while dummy: the contact email is the approved placeholder', () => {
    if (!seed.dummy) return;
    expect(seed.contactEmail).toBe('jun@example.com');
  });

  it('carries the required facts in both languages and promises no retention period', () => {
    const text = (lang: 'id' | 'en', id: string) =>
      seed.sections.find((section) => section.id === id)!.paragraphs[lang].join(' ');
    for (const lang of ['id', 'en'] as const) {
      expect(text(lang, 'cloudflare')).toMatch(/Web Analytics/);
      expect(text(lang, 'cloudflare')).toMatch(/R2/);
      expect(text(lang, 'cloudflare')).toMatch(/IP/);
      expect(text(lang, 'web3forms')).toMatch(lang === 'id' ? /Amerika Serikat/ : /United States/);
      expect(text(lang, 'web3forms')).toMatch(/WhatsApp/);
      expect(text(lang, 'hcaptcha')).toMatch(/Intuition Machines/);
      expect(text(lang, 'cloudflare')).toMatch(lang === 'id' ? /jaringan global.*luar Indonesia/ : /global network.*outside Indonesia/);
      expect(text(lang, 'hcaptcha')).toMatch(
        lang === 'id' ? /alamat IP.*sinyal perangkat dan interaksi.*luar Indonesia/ : /IP address.*device and interaction signals.*outside Indonesia/,
      );
      expect(text(lang, 'controller-rights')).toMatch(/Jujun Setiawan/);
      expect(text(lang, 'controller-rights')).toMatch(
        lang === 'id'
          ? /persetujuanmu saat kamu mengirim formulir.*mengakses, memperbaiki, atau menghapus.*menarik persetujuanmu kapan saja.*email ke Jun/
          : /consent when you send the form.*access, correct or delete.*withdraw your consent at any time.*emailing Jun/,
      );
      expect(text(lang, 'browser-storage')).toMatch(/sessionStorage/);
      const all = [seed.title[lang], seed.intro[lang], ...seed.sections.flatMap((s) => s.paragraphs[lang])].join(' ');
      expect(all).not.toMatch(/retention|retensi|disimpan selama|kept for|stored for/i);
    }
    const storage = { id: text('id', 'browser-storage'), en: text('en', 'browser-storage') };
    for (const item of ['nama pengunjung', 'film sudah selesai', 'babak terakhir', 'preferensi gerak']) expect(storage.id).toContain(item);
    for (const item of ['visitor name', 'completion flag', 'last act reached', 'motion preference']) expect(storage.en).toContain(item);
  });

  it('lastUpdated is quoted in the YAML source and dated to the amended copy', () => {
    expect(seedSource).toMatch(/^lastUpdated: "2026-11-25"$/m);
  });
});

describe('Story 1.7 copy', () => {
  const text = (key: string) =>
    filmCopySchema.parse(parseYaml(readFileSync(path.join(repoRoot, 'content/film-copy', `${key}.yaml`), 'utf8'))).text;

  it('keys carry the specified copy', () => {
    expect(text('chrome.privacy')).toEqual({ id: 'Privasi', en: 'Privacy' });
    expect(text('page.privacy.last-updated')).toEqual({ id: 'Terakhir diperbarui', en: 'Last updated' });
    expect(text('page.privacy.new-tab')).toEqual({ id: '(tab baru)', en: '(new tab)' });
    expect(text('page.privacy.policy-link')).toEqual({ id: 'Baca kebijakan privasinya', en: 'Read their privacy policy' });
  });

  it('the privacy page and the layout hold no visible literals', () => {
    for (const file of ['src/pages/[lang]/privasi.astro', 'src/layouts/StaticLayout.astro']) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, file).not.toMatch(
        /Jujun Setiawan|>Privasi<|>Privacy<|Terakhir diperbarui|Last updated|tab baru|new tab|Cloudflare|Web3Forms|hCaptcha|example\.com/,
      );
    }
  });
});

// ---------- Real builds ----------

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'privacy-content-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function contentCopy(name: string, edit: (dir: string) => void): string {
  const dir = path.join(tmpRoot, `content-${name}`);
  cpSync(path.join(repoRoot, 'content'), dir, { recursive: true });
  edit(dir);
  return dir;
}

function build(name: string, contentDir: string) {
  return astroBuild(path.join(tmpRoot, `dist-${name}`), { SITE_ENV: 'development', CONTENT_DIR: contentDir }, { freshContentStore: true });
}

describe('privacy build failures', () => {
  it('a second entry in content/privacy/ fails astro build', () => {
    const dir = contentCopy('two', (root) => {
      writeFileSync(path.join(root, 'privacy/extra.yaml'), readFileSync(path.join(root, 'privacy/privacy.yaml')));
    });
    const { run, output } = build('two', dir);
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).not.toBe(0);
    expect(output).toContain('privacy → extra, privacy: (collection) — expected exactly 1 entry, found 2');
  }, 180_000);

  it('sections[0].heading.en missing fails astro build naming entry + field', () => {
    const dir = contentCopy('no-en', (root) => {
      const file = path.join(root, 'privacy/privacy.yaml');
      const source = readFileSync(file, 'utf8');
      const broken = source.replace(/(heading:\r?\n\s+id: Cloudflare\r?\n)\s+en: Cloudflare\r?\n/, '$1');
      expect(broken).not.toBe(source);
      writeFileSync(file, broken);
    });
    const { run, output } = build('no-en', dir);
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).not.toBe(0);
    expect(output).toMatch(/privacy → privacy/);
    expect(output).toMatch(/sections\.0\.heading\.en/);
  }, 180_000);
});
