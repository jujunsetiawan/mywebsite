// Story 1.9: meta descriptions on every static page and the Person JSON-LD on
// the language homes only. Local build (SITE_ENV unset → development) served
// by `wrangler dev`; the JSON-LD url is on the configured production origin.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

type Lang = 'id' | 'en';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const ORIGIN: string = JSON.parse(read('config/site.development.json')).productionOrigin;
const profile = parseYaml(read('content/profile/profile.yaml')) as {
  name: string;
  jobTitle: Record<Lang, string>;
  sameAs: string[];
};
const homeDescription = (parseYaml(read('content/film-copy/page.home.description.yaml')) as { text: Record<Lang, string> }).text;
const privacyIntro = (parseYaml(read('content/privacy/privacy.yaml')) as { intro: Record<Lang, string> }).intro;
const archiveEmptyBody = (parseYaml(read('content/film-copy/page.archive-empty.body.yaml')) as { text: Record<Lang, string> }).text;
const notFoundBody = (parseYaml(read('content/film-copy/page.not-found.body.yaml')) as { text: Record<Lang, string> }).text;
const firstProject = readdirSync(path.join(process.cwd(), 'content/projects'))
  .filter((name) => name.endsWith('.yaml'))
  .map((name) => parseYaml(read(`content/projects/${name}`)) as { slug: string; order: number; oneLineOutcome: Record<Lang, string> })
  .sort((a, b) => a.order - b.order)[0]!;

async function jsonLd(page: Page): Promise<unknown[]> {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.map((block) => JSON.parse(block) as unknown);
}

for (const lang of ['id', 'en'] as const) {
  test(`/${lang}/: one Person JSON-LD with the required props in the page language`, async ({ page }) => {
    const response = await page.goto(`/${lang}/`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Jujun Setiawan');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', homeDescription[lang]);
    const blocks = await jsonLd(page);
    expect(blocks).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'Person',
        name: profile.name,
        jobTitle: profile.jobTitle[lang],
        url: `${ORIGIN}/${lang}/`,
        sameAs: profile.sameAs,
      },
    ]);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Jujun Setiawan');
  });

  test(`/${lang}/proyek/${firstProject.slug}/: description is the one-line outcome, no JSON-LD`, async ({ page }) => {
    const response = await page.goto(`/${lang}/proyek/${firstProject.slug}/`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/ — Jujun Setiawan$/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', firstProject.oneLineOutcome[lang]);
    expect(await jsonLd(page)).toEqual([]);
  });

  test(`/${lang}/privasi/: description is the privacy intro, no JSON-LD`, async ({ page }) => {
    const response = await page.goto(`/${lang}/privasi/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', privacyIntro[lang]);
    expect(await jsonLd(page)).toEqual([]);
  });

  test(`/${lang}/proyek/tidak-ada/: empty-archive page has its body as description, no JSON-LD`, async ({ page }) => {
    const response = await page.goto(`/${lang}/proyek/tidak-ada/`);
    expect(response?.status()).toBe(404);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', archiveEmptyBody[lang]);
    expect(await jsonLd(page)).toEqual([]);
  });

  test(`/${lang}/ unknown path: not-found page has a description, no JSON-LD`, async ({ page }) => {
    const response = await page.goto(`/${lang}/tidak-ada-${lang}/`);
    expect(response?.status()).toBe(404);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', notFoundBody[lang]);
    expect(await jsonLd(page)).toEqual([]);
  });
}

test('sitemap index is served and robots.txt has no Sitemap line in a non-production build', async ({ request }) => {
  const index = await request.get('/sitemap-index.xml');
  expect(index.status()).toBe(200);
  expect(await index.text()).toContain(`<loc>${ORIGIN}/sitemap-0.xml</loc>`);
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).not.toContain('Sitemap');
});
