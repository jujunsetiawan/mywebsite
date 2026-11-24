// Story 1.6: static project pages, the /proyek/* redirect and the
// per-language empty-archive 404. Expectations are read from the committed
// content, so a content swap needs no test edit. Local build (flags off)
// served by `wrangler dev`, so `_redirects` and `404-page` handling behave as deployed.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

type Lang = 'id' | 'en';
type Text = Record<Lang, string>;
type TextList = Record<Lang, string[]>;

interface Project {
  order: number;
  slug: string;
  name: Text;
  oneLineOutcome: Text;
  period: { start: string; end: string };
  role: Text;
  stack: string[];
  sections: {
    outcomes: TextList;
    businessFlow: TextList;
    process: TextList;
    techStack: unknown[];
    apiContract: { method: string; path: string; summary: Text }[];
    uiux: { alt: Text }[];
    prototype: { note: Text; url?: string };
  };
}

interface Testimonial {
  order: number;
  name: string;
  company: string;
  quote: Text;
  project?: string;
}

function load<T extends { order: number }>(collection: string): T[] {
  const dir = path.join(process.cwd(), 'content', collection);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => parseYaml(readFileSync(path.join(dir, name), 'utf8')) as T)
    .sort((a, b) => a.order - b.order);
}

const projects = load<Project>('projects');
const testimonials = load<Testimonial>('testimonials');
const FIRST = projects[0]!;

const ORIGIN: string = JSON.parse(
  readFileSync(path.join(process.cwd(), 'config/site.development.json'), 'utf8'),
).productionOrigin;

const DATE_LOCALES: Record<Lang, string> = { id: 'id-ID', en: 'en-GB' };
const formatDate = (iso: string, lang: Lang) =>
  new Intl.DateTimeFormat(DATE_LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

const COPY = {
  id: {
    eyebrow: 'Dari arsip Jun',
    role: 'Peranku:',
    watch: 'Tonton filmnya dari awal',
    pill: 'Lihat di kantor 3D →',
    headings: {
      outcomes: 'Hasil',
      businessFlow: 'Alur bisnis',
      process: 'Proses kerja',
      techStack: 'Teknologi',
      apiContract: 'Kontrak API',
      samplePrd: 'Contoh PRD',
      uiux: 'UI/UX',
      prototype: 'Prototipe',
    },
    empty: { title: 'Arsip ini kosong', body: 'Map ini sepertinya terselip. Coba pilih proyek lain.' },
  },
  en: {
    eyebrow: "From Jun's archive",
    role: 'My role:',
    watch: 'Watch the film from the start',
    pill: 'See it in the 3D office →',
    headings: {
      outcomes: 'Outcomes',
      businessFlow: 'Business flow',
      process: 'How we worked',
      techStack: 'Technology',
      apiContract: 'API contract',
      samplePrd: 'Sample PRD',
      uiux: 'UI/UX',
      prototype: 'Prototype',
    },
    empty: { title: 'This archive is empty', body: 'This folder seems to have gone missing. Try another project.' },
  },
} as const;

const SECTION_ORDER = [
  'outcomes',
  'businessFlow',
  'process',
  'techStack',
  'apiContract',
  'samplePrd',
  'uiux',
  'prototype',
] as const;

/** Sections a project shows (empty lists hide theirs). */
function visibleSections(project: Project) {
  const { sections } = project;
  const lengths: Record<(typeof SECTION_ORDER)[number], number> = {
    outcomes: sections.outcomes.id.length,
    businessFlow: sections.businessFlow.id.length,
    process: sections.process.id.length,
    techStack: sections.techStack.length,
    apiContract: sections.apiContract.length,
    samplePrd: 1,
    uiux: sections.uiux.length,
    prototype: 1,
  };
  return SECTION_ORDER.filter((key) => lengths[key] > 0);
}

/** Collects CSP violations (console + securitypolicyviolation events) for the next navigation. */
async function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = store;
    document.addEventListener('securitypolicyviolation', (event) => store.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  return async () => [...violations, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))];
}

async function seriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  // Not vacuous: axe really ran its rules against the page.
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

test('the seed has at least one project and a project with no referencing testimonial', () => {
  expect(projects.length).toBeGreaterThan(0);
  test.skip(!projects.every((p) => (p as unknown as { dummy?: boolean }).dummy === true), 'real content');
  expect(projects.some((p) => !testimonials.some((t) => t.project === p.slug))).toBe(true);
});

for (const lang of ['id', 'en'] as const) {
  const other: Lang = lang === 'id' ? 'en' : 'id';

  for (const project of projects) {
    test.describe(`/${lang}/proyek/${project.slug}/`, () => {
      const url = `/${lang}/proyek/${project.slug}/`;

      test('renders the project in its language with sections in order and no script', async ({ page }) => {
        const readViolations = await watchCsp(page);
        const response = await page.goto(url);
        expect(response?.status()).toBe(200);
        await page.waitForLoadState('load');
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        await expect(page).toHaveTitle(`${project.name[lang]} — Jujun Setiawan`);

        const article = page.locator('main article.project');
        await expect(article.locator('.project-eyebrow')).toHaveText(COPY[lang].eyebrow);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(project.name[lang]);
        await expect(article.locator('.project-lede')).toHaveText(project.oneLineOutcome[lang]);
        await expect(article.locator('.project-meta')).toHaveText(
          `${formatDate(project.period.start, lang)} – ${formatDate(project.period.end, lang)} · ` +
            `${COPY[lang].role} ${project.role[lang]} · ${project.stack.join(' · ')}`,
        );

        const sections = visibleSections(project);
        await expect(article.locator('.project-section')).toHaveCount(sections.length);
        expect(await article.locator('.project-section > h2').allTextContents()).toEqual(
          sections.map((key) => COPY[lang].headings[key]),
        );
        // Lists: ordered for business flow and process, bulleted for outcomes.
        await expect(article.locator('[data-section="businessFlow"] ol > li')).toHaveCount(
          project.sections.businessFlow[lang].length,
        );
        await expect(article.locator('[data-section="process"] ol > li')).toHaveCount(project.sections.process[lang].length);
        await expect(article.locator('[data-section="outcomes"] ul > li')).toHaveCount(project.sections.outcomes[lang].length);
        // API contract: a <dl> on printed paper.
        if (project.sections.apiContract.length > 0) {
          const dl = article.locator('[data-section="apiContract"] dl.paper');
          await expect(dl.locator('dt')).toHaveCount(project.sections.apiContract.length);
          const first = project.sections.apiContract[0]!;
          await expect(dl.locator('dt').first()).toContainText(first.method);
          await expect(dl.locator('dt').first()).toContainText(first.path);
          await expect(dl.locator('dd').first()).toHaveText(first.summary[lang]);
        }
        const paper = await article.locator('[data-section="samplePrd"] .paper').evaluate((el) => {
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius, shadow: cs.boxShadow };
        });
        expect(paper).toEqual({ bg: 'rgb(216, 208, 192)', color: 'rgb(18, 13, 9)', radius: '0px', shadow: 'none' });
        // UI/UX images carry the localized alt.
        for (const [index, shot] of project.sections.uiux.entries()) {
          await expect(article.locator('[data-section="uiux"] img').nth(index)).toHaveAttribute('alt', shot.alt[lang]);
        }
        // Prototype: note plus an optional external link in a new tab.
        await expect(article.locator('[data-section="prototype"] p').first()).toHaveText(project.sections.prototype.note[lang]);
        const protoLink = article.locator('[data-section="prototype"] a');
        if (project.sections.prototype.url === undefined) {
          await expect(protoLink).toHaveCount(0);
        } else {
          await expect(protoLink).toHaveAttribute('href', project.sections.prototype.url);
          await expect(protoLink).toHaveAttribute('target', '_blank');
          await expect(protoLink).toHaveAttribute('rel', 'noopener');
        }

        // Actions: secondary link to the language home; primary pill absent while hubLinks is off.
        const watch = page.getByRole('link', { name: COPY[lang].watch, exact: true });
        await expect(watch).toHaveAttribute('href', `/${lang}/`);
        await expect(page.locator('[data-action="see-in-office"]')).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText(COPY[lang].pill);

        // Static markup only: no script anywhere in the page body (no analytics in the dev build either).
        await expect(page.locator('main script, body script')).toHaveCount(0);

        // One language per page.
        await expect(page.locator('main')).not.toContainText(project.oneLineOutcome[other]);

        // Mirrored alternates.
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${ORIGIN}${url}`);
        const alternates = await page
          .locator('link[rel="alternate"]')
          .evaluateAll((links) => links.map((l) => [l.getAttribute('hreflang'), l.getAttribute('href')]));
        expect(alternates).toEqual([
          ['id', `${ORIGIN}/id/proyek/${project.slug}/`],
          ['en', `${ORIGIN}/en/proyek/${project.slug}/`],
          ['x-default', `${ORIGIN}/id/proyek/${project.slug}/`],
        ]);

        expect(await readViolations()).toEqual([]);
      });

      test('axe: no serious or critical violations', async ({ page }) => {
        await page.goto(url);
        expect(await seriousAxeViolations(page)).toEqual([]);
      });

      test('shows the testimonials that reference it, and only those', async ({ page }) => {
        await page.goto(url);
        const expected = testimonials.filter((t) => t.project === project.slug);
        const figures = page.locator('main figure.testimonial');
        await expect(figures).toHaveCount(expected.length);
        if (expected.length === 0) {
          await expect(page.locator('.project-testimonials')).toHaveCount(0);
          return;
        }
        for (const [index, testimonial] of expected.entries()) {
          const figure = figures.nth(index);
          await expect(figure.locator('blockquote')).toHaveText(testimonial.quote[lang]);
          await expect(figure.locator('blockquote')).not.toContainText(testimonial.quote[other]);
          await expect(figure.locator('figcaption')).toContainText(testimonial.name);
          await expect(figure.locator('figcaption')).toContainText(testimonial.company);
          const style = await figure.evaluate((el) => {
            const img = el.querySelector('img')!;
            const quote = el.querySelector('blockquote')!;
            const cite = el.querySelector('figcaption')!;
            return {
              w: img.getBoundingClientRect().width,
              h: img.getBoundingClientRect().height,
              radius: getComputedStyle(img).borderRadius,
              italic: getComputedStyle(quote).fontStyle,
              cite: getComputedStyle(cite).color,
            };
          });
          expect(style).toEqual({ w: 56, h: 56, radius: '9999px', italic: 'italic', cite: 'rgb(168, 161, 150)' });
        }
        // No quote ornaments or stars.
        await expect(page.locator('main .project-testimonials')).not.toContainText(/[“”«»★☆]/);
      });
    });
  }

  test.describe(`/${lang}/ empty archive`, () => {
    const missing = lang === 'id' ? '/id/proyek/tidak-ada/' : '/en/proyek/missing/';

    test(`${missing} answers 404 with the ${lang} empty-archive page, noindex`, async ({ page, request }) => {
      const head = await request.get(missing, { maxRedirects: 0 });
      expect(head.status()).toBe(404);
      const readViolations = await watchCsp(page);
      const response = await page.goto(missing);
      expect(response?.status()).toBe(404);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(COPY[lang].empty.title);
      await expect(page.locator('main')).toContainText(COPY[lang].empty.body);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
      await expect(page.locator('meta[name="robots"]')).toHaveCount(1);
      await expect(page.locator('link[rel="canonical"], link[rel="alternate"]')).toHaveCount(0);
      await expect(page.locator('[data-action="archive"]')).toHaveAttribute('href', `/${lang}/#proyek`);
      await expect(page.locator('[data-action="home"]')).toHaveAttribute('href', `/${lang}/`);
      await expect(page.locator('main')).not.toContainText(COPY[other].empty.title);
      expect(await readViolations()).toEqual([]);
    });

    test('axe: no serious or critical violations on the empty-archive page', async ({ page }) => {
      await page.goto(missing);
      expect(await seriousAxeViolations(page)).toEqual([]);
    });

  });
}

test('/proyek/<slug> answers 301 to /id/proyek/<slug>', async ({ request }) => {
  const response = await request.get(`/proyek/${FIRST.slug}`, { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers()['location']).toBe(`/id/proyek/${FIRST.slug}`);
});

test('/ still answers 301 to /id/', async ({ request }) => {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers()['location']).toBe('/id/');
});

// ---------- Layout sizes and reflow on one project page ----------

const SIZES = [
  { name: '390x844', width: 390, height: 844 },
  { name: '844x390', width: 844, height: 390 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '320x640', width: 320, height: 640 },
] as const;

for (const size of SIZES) {
  test.describe(`project page at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('no horizontal scroll; sections in auto-fit columns with hairline rules', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name.startsWith('mobile'), 'size matrix runs in the desktop projects');
      await page.goto(`/id/proyek/${FIRST.slug}/`);
      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        const sections = [...document.querySelectorAll<HTMLElement>('.project-section')];
        const grid = getComputedStyle(document.querySelector('.project-sections')!);
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          columns: grid.gridTemplateColumns.split(' ').length,
          minWidth: Math.min(...sections.map((s) => s.getBoundingClientRect().width)),
          rules: sections.map((s) => `${getComputedStyle(s).borderTopWidth} ${getComputedStyle(s).borderTopColor}`),
          overflowing: [...document.querySelectorAll<HTMLElement>('main *')]
            .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 0.5)
            .map((el) => el.tagName),
        };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.overflowing).toEqual([]);
      for (const rule of layout.rules) expect(rule).toBe('1px rgb(42, 36, 30)');
      if (size.width >= 1440) expect(layout.columns).toBeGreaterThan(1);
      if (size.width >= 760) expect(layout.minWidth).toBeGreaterThanOrEqual(240);
      await testInfo.attach(`project-${size.name}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
  });
}
