// Story 1.8: language-aware not-found pages. Local build (flags off) served by
// `wrangler dev`, so `404-page` handling (nearest `404.html` up the path)
// behaves as deployed: `/<lang>/404.html` for unknown paths under a language,
// `/<lang>/proyek/404.html` (Story 1.6) for unknown project slugs, and the
// root `/404.html` (Indonesian + English-home link) for everything else.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Lang = 'id' | 'en';

const COPY = {
  id: {
    title: 'Halaman tidak ditemukan',
    body: 'Tautan ini mungkin salah ketik atau halamannya sudah dipindahkan.',
    home: 'Kembali ke beranda',
    projects: 'Lihat proyek',
    privacy: 'Privasi',
    emptyArchive: 'Arsip ini kosong',
  },
  en: {
    title: 'Page not found',
    body: 'This link may have a typo, or the page has moved.',
    home: 'Back to the home page',
    projects: 'See the projects',
    privacy: 'Privacy',
    emptyArchive: 'This archive is empty',
  },
} as const;

const ENGLISH_LINK = 'Read this site in English';

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
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

/** Shared assertions for every not-found response: status, noindex, unmirrored, footer, no script, no CSP violations. */
async function expectNotFoundChrome(page: Page, url: string, lang: Lang) {
  const readViolations = await watchCsp(page);
  const response = await page.goto(url);
  expect(response?.status()).toBe(404);
  await page.waitForLoadState('load');
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('link[rel="canonical"], link[rel="alternate"]')).toHaveCount(0);
  await expect(page.locator('nav.lang-switch')).toHaveCount(0);
  const footer = page.locator('footer.bar--bottom a[data-chrome="privacy"]');
  await expect(footer).toHaveCount(1);
  await expect(footer).toHaveText(COPY[lang].privacy);
  await expect(footer).toHaveAttribute('href', `/${lang}/privasi/`);
  await expect(page.locator('body script')).toHaveCount(0);
  expect(await readViolations()).toEqual([]);
}

/** The site-wide not-found page body in `lang`. */
async function expectNotFoundPage(page: Page, lang: Lang) {
  const other: Lang = lang === 'id' ? 'en' : 'id';
  await expect(page).toHaveTitle(`${COPY[lang].title} — Jujun Setiawan`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(COPY[lang].title);
  const main = page.locator('main');
  await expect(main).toContainText(COPY[lang].body);
  await expect(main).not.toContainText(COPY[other].title);
  await expect(main).not.toContainText(COPY[other].body);
  const home = page.locator('main a[data-action="home"]');
  await expect(home).toHaveText(COPY[lang].home);
  await expect(home).toHaveAttribute('href', `/${lang}/`);
  const projects = page.locator('main a[data-action="projects"]');
  await expect(projects).toHaveText(COPY[lang].projects);
  await expect(projects).toHaveAttribute('href', `/${lang}/#proyek`);
}

const CASES = [
  { url: '/en/does-not-exist/', lang: 'en', english: false },
  { url: '/id/tidak-ada/', lang: 'id', english: false },
  { url: '/xyz', lang: 'id', english: true },
] as const;

for (const { url, lang, english } of CASES) {
  test.describe(url, () => {
    test(`answers 404 with the ${lang} not-found page${english ? ' and a link to /en/' : ''}`, async ({ page, request }) => {
      const raw = await request.get(url, { maxRedirects: 0 });
      expect(raw.status()).toBe(404);
      await expectNotFoundChrome(page, url, lang);
      await expectNotFoundPage(page, lang);
      const englishLink = page.locator('main a[data-action="english"]');
      if (english) {
        await expect(englishLink).toBeVisible();
        await expect(englishLink).toHaveText(ENGLISH_LINK);
        await expect(englishLink).toHaveAttribute('href', '/en/');
        await expect(englishLink).toHaveAttribute('lang', 'en');
        await expect(englishLink).toHaveAttribute('hreflang', 'en');
      } else {
        await expect(englishLink).toHaveCount(0);
        await expect(page.locator('main')).not.toContainText(ENGLISH_LINK);
      }
    });

    test('axe: no serious or critical violations', async ({ page }) => {
      await page.goto(url);
      expect(await seriousAxeViolations(page)).toEqual([]);
    });
  });
}

test('/xyz: the English-home link opens the English home', async ({ page }) => {
  await page.goto('/xyz');
  await page.locator('main a[data-action="english"]').click();
  await expect(page).toHaveURL(/\/en\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

for (const { url, lang } of [
  { url: '/id/proyek/tidak-ada/', lang: 'id' },
  { url: '/en/proyek/missing/', lang: 'en' },
] as const) {
  test(`${url} still answers 404 with the ${lang} empty-archive page`, async ({ page }) => {
    await expectNotFoundChrome(page, url, lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(COPY[lang].emptyArchive);
    await expect(page.locator('[data-page="archive-empty"]')).toHaveCount(1);
    await expect(page.locator('[data-page="not-found"]')).toHaveCount(0);
  });
}
