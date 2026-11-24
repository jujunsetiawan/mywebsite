// Story 1.5: the language homes list projects and awards from `content/`.
// Expectations are read from the committed content, so a content swap needs
// no test edit. Local build served by `wrangler dev`.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

type Lang = 'id' | 'en';
type Text = Record<Lang, string>;

function load<T extends { order: number }>(collection: string): (T & { id: string })[] {
  const dir = path.join(process.cwd(), 'content', collection);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => ({ id: name.replace(/\.yaml$/, ''), ...(parseYaml(readFileSync(path.join(dir, name), 'utf8')) as T) }))
    .sort((a, b) => a.order - b.order);
}

const projects = load<{ order: number; slug: string; name: Text; oneLineOutcome: Text; dummy?: boolean }>('projects');
const awards = load<{ order: number; title: Text; issuer: string; date: string; verifyUrl: string; dummy?: boolean }>(
  'awards',
);

const DATE_LOCALES: Record<Lang, string> = { id: 'id-ID', en: 'en-GB' };
const formatDate = (iso: string, lang: Lang) =>
  new Intl.DateTimeFormat(DATE_LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

const COPY = {
  id: { projects: 'Proyek', awards: 'Penghargaan', verify: 'Verifikasi (tab baru)' },
  en: { projects: 'Projects', awards: 'Awards', verify: 'Verify (new tab)' },
} as const;

test('while the seed is all dummy it has at least 3 projects and 6 awards', () => {
  test.skip(![...projects, ...awards].every((entry) => entry.dummy === true), 'real content: no seed size');
  expect(projects.length).toBeGreaterThanOrEqual(3);
  expect(awards.length).toBeGreaterThanOrEqual(6);
});

for (const lang of ['id', 'en'] as const) {
  test.describe(`/${lang}/ content lists`, () => {
    test('#proyek lists every project by order, linking to /<lang>/proyek/<slug>/', async ({ page }) => {
      await page.goto(`/${lang}/`);
      const section = page.getByRole('region', { name: COPY[lang].projects });
      await expect(section).toHaveAttribute('id', 'proyek');
      const links = section.getByRole('listitem').getByRole('link');
      await expect(links).toHaveCount(projects.length);
      for (const [index, project] of projects.entries()) {
        const link = links.nth(index);
        await expect(link).toHaveAttribute('href', `/${lang}/proyek/${project.slug}/`);
        await expect(link).toContainText(project.name[lang]);
        await expect(link).toContainText(project.oneLineOutcome[lang]);
      }
    });

    test('#penghargaan lists every award by order with issuer, date and a new-tab verify link', async ({ page }) => {
      await page.goto(`/${lang}/`);
      const section = page.getByRole('region', { name: COPY[lang].awards });
      await expect(section).toHaveAttribute('id', 'penghargaan');
      const items = section.getByRole('listitem');
      await expect(items).toHaveCount(awards.length);
      for (const [index, award] of awards.entries()) {
        const item = items.nth(index);
        await expect(item).toContainText(award.title[lang]);
        await expect(item).toContainText(award.issuer);
        await expect(item.locator('time')).toHaveAttribute('datetime', award.date);
        await expect(item.locator('time')).toHaveText(formatDate(award.date, lang));
        const verify = item.getByRole('link', { name: COPY[lang].verify, exact: true });
        await expect(verify).toHaveAttribute('href', award.verifyUrl);
        await expect(verify).toHaveAttribute('target', '_blank');
        await expect(verify).toHaveAttribute('rel', 'noopener');
        await expect(verify).toHaveAccessibleDescription(award.title[lang]);
      }
    });

    test('shows only its own language and triggers no CSP violations', async ({ page }) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (/content security policy/i.test(message.text())) violations.push(message.text());
      });
      await page.addInitScript(() => {
        const store: string[] = [];
        (window as unknown as { __csp: string[] }).__csp = store;
        document.addEventListener('securitypolicyviolation', (event) => store.push(`${event.violatedDirective} ${event.blockedURI}`));
      });
      await page.goto(`/${lang}/`);
      await page.waitForLoadState('load');
      const other: Lang = lang === 'id' ? 'en' : 'id';
      const main = page.locator('main');
      for (const project of projects) await expect(main).not.toContainText(project.name[other]);
      for (const award of awards) await expect(main).not.toContainText(award.title[other]);
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)));
      expect(violations).toEqual([]);
    });
  });
}
