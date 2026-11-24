// Story 1.4: Indonesian-default routing with mirrored English pages. Local
// build served by `wrangler dev`, so `public/_redirects` behaves as deployed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Local e2e runs the development build; canonical/hreflang target the production origin.
const ORIGIN: string = JSON.parse(
  readFileSync(path.join(process.cwd(), 'config/site.development.json'), 'utf8'),
).productionOrigin;

const HOMES = [
  {
    lang: 'id',
    other: 'en',
    intro: 'Product engineer yang menjaga sistem tetap hidup — dan menceritakannya lewat film pendek.',
    projects: 'Proyek',
    foreignIntro: 'A product engineer who keeps systems alive',
  },
  {
    lang: 'en',
    other: 'id',
    intro: 'A product engineer who keeps systems alive — and tells the story as a short film.',
    projects: 'Projects',
    foreignIntro: 'Product engineer yang menjaga',
  },
] as const;

test('GET / answers 301 with Location /id/', async ({ request }) => {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers()['location']).toBe('/id/');
});

test('canonical drops the query string', async ({ page }) => {
  await page.goto('/id/?utm_source=x');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${ORIGIN}/id/`);
});

for (const home of HOMES) {
  test.describe(`/${home.lang}/`, () => {
    test('head carries id/en/x-default alternates on the production origin', async ({ page }) => {
      await page.goto(`/${home.lang}/`);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${ORIGIN}/${home.lang}/`);
      const alternates = await page
        .locator('link[rel="alternate"]')
        .evaluateAll((links) => links.map((l) => [l.getAttribute('hreflang'), l.getAttribute('href')]));
      expect(alternates).toEqual([
        ['id', `${ORIGIN}/id/`],
        ['en', `${ORIGIN}/en/`],
        ['x-default', `${ORIGIN}/id/`],
      ]);
    });

    test('shows H1, intro and #proyek in its own language only', async ({ page }) => {
      await page.goto(`/${home.lang}/`);
      await expect(page.locator('html')).toHaveAttribute('lang', home.lang);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jujun Setiawan');
      await expect(page.locator('#main p.home-intro')).toHaveText(home.intro);
      const section = page.locator('section#proyek');
      await expect(section).toBeVisible();
      await expect(section.locator('ul')).toHaveCount(0);
      await expect(page.getByRole('region', { name: home.projects })).toBeVisible();
      await expect(section.getByRole('heading', { level: 2 })).toHaveText(home.projects);
      await expect(page.locator('body')).not.toContainText(home.foreignIntro);
    });

    test('switch marks the current language and links plainly to both homes', async ({ page }) => {
      await page.goto(`/${home.lang}/#proyek`);
      const nav = page.getByRole('navigation', { name: home.lang === 'id' ? 'Bahasa' : 'Language' });
      // Accessible name = visible code + hidden own-language name (WCAG 2.5.3 Label in Name).
      const NAMES = { id: 'ID Bahasa Indonesia', en: 'EN English' } as const;
      const current = nav.getByRole('link', { name: NAMES[home.lang], exact: true });
      const other = nav.getByRole('link', { name: NAMES[home.other], exact: true });
      for (const link of [current, other]) await expect(link).not.toHaveAttribute('aria-label', /.*/);
      await expect(current).toHaveAttribute('aria-current', 'true');
      await expect(other).not.toHaveAttribute('aria-current', /.*/);
      await expect(current).toHaveAttribute('href', `/${home.lang}/`);
      await expect(other).toHaveAttribute('href', `/${home.other}/`);
      await expect(other).toHaveAttribute('hreflang', home.other);
      await expect(other).toHaveAttribute('lang', home.other);
      // Only the code is painted; the language name is visually hidden.
      await expect(other).toHaveText(NAMES[home.other]);
      await expect(other.locator('.visually-hidden')).toHaveText(NAMES[home.other].slice(3));
      expect(await other.locator('.visually-hidden').evaluate((el) => getComputedStyle(el).clipPath)).toBe('inset(50%)');
      expect(await current.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
      for (const link of [current, other]) {
        const box = (await link.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
}

test.describe('switch without JavaScript, by keyboard', () => {
  test.use({ javaScriptEnabled: false });

  /** Tabs until the link with `data-chrome=<key>` has focus (proves keyboard reachability). */
  async function tabTo(page: Page, key: string) {
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.locator(`[data-chrome="${key}"]`).evaluate((el) => el === document.activeElement)) return;
    }
    throw new Error(`Tab never reached [data-chrome="${key}"]`);
  }

  test('Enter on EN goes to /en/ and Enter on ID comes back', async ({ page, browserName }) => {
    // Playwright WebKit never Tabs to links (see static-layout.spec.ts); focus directly there.
    const focus = async (key: string) =>
      browserName === 'webkit' ? page.locator(`[data-chrome="${key}"]`).focus() : tabTo(page, key);

    await page.goto('/id/');
    await focus('lang-en');
    await Promise.all([page.waitForURL('**/en/'), page.keyboard.press('Enter')]);
    expect(new URL(page.url()).pathname).toBe('/en/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-chrome="lang-en"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('[data-chrome="lang-id"]')).not.toHaveAttribute('aria-current', /.*/);

    await focus('lang-id');
    await Promise.all([page.waitForURL('**/id/'), page.keyboard.press('Enter')]);
    expect(new URL(page.url()).pathname).toBe('/id/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    await expect(page.locator('[data-chrome="lang-id"]')).toHaveAttribute('aria-current', 'true');
  });
});
