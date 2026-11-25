// Story 1.7: the privacy page at /id/privasi/ and /en/privasi/ and the
// footer "Privasi"/"Privacy" link on every static page. Section copy is read
// from the committed content; processor names and storage items are the
// spec's required facts. Local build served by `wrangler dev`.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

type Lang = 'id' | 'en';
type Text = Record<Lang, string>;

interface Privacy {
  lastUpdated: string;
  contactEmail: string;
  title: Text;
  intro: Text;
  sections: { id: string; heading: Text; paragraphs: Record<Lang, string[]>; policyUrl?: string }[];
}

const privacy = parseYaml(readFileSync(path.join(process.cwd(), 'content/privacy/privacy.yaml'), 'utf8')) as Privacy;

const firstProjectSlug = readdirSync(path.join(process.cwd(), 'content/projects'))
  .filter((name) => name.endsWith('.yaml'))
  .map((name) => parseYaml(readFileSync(path.join(process.cwd(), 'content/projects', name), 'utf8')) as { slug: string; order: number })
  .sort((a, b) => a.order - b.order)[0]!.slug;

const ORIGIN: string = JSON.parse(readFileSync(path.join(process.cwd(), 'config/site.development.json'), 'utf8')).productionOrigin;

const DATE_LOCALES: Record<Lang, string> = { id: 'id-ID', en: 'en-GB' };
const formatDate = (iso: string, lang: Lang) =>
  new Intl.DateTimeFormat(DATE_LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

const COPY = {
  id: {
    footer: 'Privasi',
    updated: 'Terakhir diperbarui',
    newTab: '(tab baru)',
    policyLink: 'Baca kebijakan privasinya',
    storage: ['nama pengunjung', 'film sudah selesai', 'babak terakhir', 'preferensi gerak'],
    rights: [
      'persetujuanmu saat kamu mengirim formulir',
      'mengakses, memperbaiki, atau menghapus datamu',
      'menarik persetujuanmu kapan saja',
    ],
  },
  en: {
    footer: 'Privacy',
    updated: 'Last updated',
    newTab: '(new tab)',
    policyLink: 'Read their privacy policy',
    storage: ['visitor name', 'completion flag', 'last act reached', 'motion preference'],
    rights: ['consent when you send the form', 'access, correct or delete your data', 'withdraw your consent at any time'],
  },
} as const;

const SECTION_ORDER = ['cloudflare', 'web3forms', 'hcaptcha', 'browser-storage', 'controller-rights', 'contact'];
const PROCESSORS = ['Cloudflare', 'Web3Forms', 'hCaptcha', 'Intuition Machines'];

async function seriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

/** Tabs forward from the top of the page until the footer privacy link has focus; false if never reached. */
async function tabToFooterLink(page: Page, budget = 80): Promise<boolean> {
  for (let i = 0; i < budget; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.chrome === 'privacy')) return true;
  }
  return false;
}

for (const lang of ['id', 'en'] as const) {
  const other: Lang = lang === 'id' ? 'en' : 'id';
  const url = `/${lang}/privasi/`;

  test.describe(url, () => {
    test('renders the privacy page in its language: H1, date, five sections, links, alternates', async ({ page }) => {
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['set-cookie']).toBeUndefined();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page).toHaveTitle(`${privacy.title[lang]} — Jujun Setiawan`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(privacy.title[lang]);

      const time = page.locator('main time');
      await expect(time).toHaveAttribute('datetime', privacy.lastUpdated);
      await expect(time).toHaveText(formatDate(privacy.lastUpdated, lang));
      await expect(page.locator('.privacy-updated')).toHaveText(`${COPY[lang].updated} ${formatDate(privacy.lastUpdated, lang)}`);
      await expect(page.locator('.privacy-intro')).toHaveText(privacy.intro[lang]);

      // Five sections in order, each a labelled region with an H2.
      const sections = page.locator('main section.privacy-section');
      expect(await sections.evaluateAll((els) => els.map((el) => el.getAttribute('data-section')))).toEqual(SECTION_ORDER);
      expect(await page.locator('main section > h2').allTextContents()).toEqual(
        SECTION_ORDER.map((id) => privacy.sections.find((s) => s.id === id)!.heading[lang]),
      );
      for (const id of SECTION_ORDER) {
        await expect(page.getByRole('region', { name: privacy.sections.find((s) => s.id === id)!.heading[lang] })).toHaveCount(1);
      }

      const main = page.locator('main');
      for (const name of PROCESSORS) await expect(main).toContainText(name);
      for (const item of COPY[lang].storage) await expect(page.locator('[data-section="browser-storage"]')).toContainText(item);
      const rights = page.locator('[data-section="controller-rights"]');
      await expect(rights).toContainText('Jujun Setiawan');
      for (const phrase of COPY[lang].rights) await expect(rights).toContainText(phrase);
      // One language per page.
      await expect(main).not.toContainText(privacy.intro[other]);

      // Processor policies open in a new tab with a hidden hint.
      const policies = page.locator('a[data-action="policy"]');
      await expect(policies).toHaveCount(3);
      const policyHrefs = await policies.evaluateAll((links) =>
        links.map((l) => [l.closest('section')!.getAttribute('data-section'), l.getAttribute('href'), l.getAttribute('target'), l.getAttribute('rel')]),
      );
      expect(policyHrefs).toEqual([
        ['cloudflare', 'https://www.cloudflare.com/privacypolicy/', '_blank', 'noopener'],
        ['web3forms', 'https://web3forms.com/privacy', '_blank', 'noopener'],
        ['hcaptcha', 'https://www.hcaptcha.com/privacy', '_blank', 'noopener'],
      ]);
      for (let i = 0; i < 3; i += 1) {
        await expect(policies.nth(i)).toContainText(COPY[lang].policyLink);
        await expect(policies.nth(i)).not.toContainText(COPY[other].policyLink);
        await expect(policies.nth(i).locator('.visually-hidden')).toHaveText(COPY[lang].newTab);
      }

      // Contact: mailto link to contactEmail in the contact section.
      const mail = page.locator('[data-section="contact"] a[href^="mailto:"]');
      await expect(mail).toHaveAttribute('href', `mailto:${privacy.contactEmail}`);
      await expect(mail).toHaveText(privacy.contactEmail);

      // No client JS, nothing stored.
      await expect(page.locator('body script')).toHaveCount(0);
      expect(await page.evaluate(() => [document.cookie, sessionStorage.length, localStorage.length])).toEqual(['', 0, 0]);

      // Mirrored canonical + alternates.
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${ORIGIN}${url}`);
      const alternates = await page
        .locator('link[rel="alternate"]')
        .evaluateAll((links) => links.map((l) => [l.getAttribute('hreflang'), l.getAttribute('href')]));
      expect(alternates).toEqual([
        ['id', `${ORIGIN}/id/privasi/`],
        ['en', `${ORIGIN}/en/privasi/`],
        ['x-default', `${ORIGIN}/id/privasi/`],
      ]);
      // The ID/EN switch points at the mirrored privacy page.
      await expect(page.locator(`[data-chrome="lang-${other}"]`)).toHaveAttribute('href', `/${other}/privasi/`);
    });

    test('footer link is marked as the current page', async ({ page }) => {
      await page.goto(url);
      const link = page.locator('footer.bar--bottom a[data-chrome="privacy"]');
      await expect(link).toHaveText(COPY[lang].footer);
      await expect(link).toHaveAttribute('href', url);
      await expect(link).toHaveAttribute('aria-current', 'page');
    });

    test('triggers no CSP violations', async ({ page }) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (/content security policy/i.test(message.text())) violations.push(message.text());
      });
      await page.addInitScript(() => {
        const store: string[] = [];
        (window as unknown as { __csp: string[] }).__csp = store;
        document.addEventListener('securitypolicyviolation', (event) => store.push(`${event.violatedDirective} ${event.blockedURI}`));
      });
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['content-security-policy']).toBeDefined();
      await page.waitForLoadState('load');
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)));
      expect(violations).toEqual([]);
    });

    test('axe: no serious or critical violations', async ({ page }) => {
      await page.goto(url);
      expect(await seriousAxeViolations(page)).toEqual([]);
    });
  });

  for (const [label, pageUrl] of [
    ['home', `/${lang}/`],
    ['project page', `/${lang}/proyek/${firstProjectSlug}/`],
    ['empty-archive page', lang === 'id' ? '/id/proyek/tidak-ada/' : '/en/proyek/missing/'],
  ] as const) {
    test(`${label} ${pageUrl}: footer link to ${url} in the page language, >= 44px`, async ({ page }) => {
      await page.goto(pageUrl);
      const link = page.locator('footer.bar--bottom a[data-chrome="privacy"]');
      await expect(link).toHaveCount(1);
      await expect(link).toHaveText(COPY[lang].footer);
      await expect(link).toHaveAttribute('href', url);
      await expect(link).not.toHaveAttribute('aria-current', /.*/);
      const box = await link.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  }

  for (const pageUrl of [`/${lang}/`, `/${lang}/proyek/${firstProjectSlug}/`, url]) {
    test(`${pageUrl}: the footer privacy link is reachable by keyboard and opens ${url}`, async ({ page, browserName }) => {
      test.skip(browserName === 'webkit', 'Playwright WebKit does not Tab to links (layout-only coverage)');
      await page.goto(pageUrl);
      expect(await tabToFooterLink(page)).toBe(true);
      // The focused link's text is inside the viewport. (Its 44px hit area may
      // overhang the 40px bar by its invisible padding on short viewports.)
      const text = await page.locator('footer a[data-chrome="privacy"]').evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
      });
      expect(text.top).toBeGreaterThanOrEqual(0);
      expect(text.bottom).toBeLessThanOrEqual(text.viewport + 0.5);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${url.replace(/\//g, '\\/')}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(privacy.title[lang]);
    });
  }
}

test('the root not-found page carries the footer link too', async ({ page }) => {
  const response = await page.goto('/tidak-ada-halaman/');
  expect(response?.status()).toBe(404);
  await expect(page.locator('footer a[data-chrome="privacy"]')).toHaveAttribute('href', '/id/privasi/');
});
