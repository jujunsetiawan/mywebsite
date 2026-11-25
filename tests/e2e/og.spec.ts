// Story 1.10: Open Graph / Twitter tags in the page language on the homes, a
// project page and a not-found page, and the og:image URLs (production
// origin, mapped to the local server) return 200 image/png. Local build
// (SITE_ENV unset → development) served by `wrangler dev`.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

type Lang = 'id' | 'en';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const ORIGIN: string = JSON.parse(read('config/site.development.json')).productionOrigin;
const LOCALE: Record<Lang, string> = { id: 'id_ID', en: 'en_US' };
const OTHER: Record<Lang, Lang> = { id: 'en', en: 'id' };
const siteName = (parseYaml(read('content/film-copy/page.home.title.yaml')) as { text: Record<Lang, string> }).text;
const firstProject = readdirSync(path.join(process.cwd(), 'content/projects'))
  .filter((name) => name.endsWith('.yaml'))
  .map((name) => parseYaml(read(`content/projects/${name}`)) as { slug: string; order: number; name: Record<Lang, string> })
  .sort((a, b) => a.order - b.order)[0]!;

const meta = (page: Page, key: string) =>
  page.locator(`head meta[property="${key}"], head meta[name="${key}"]`);

async function content(page: Page, key: string): Promise<string> {
  await expect(meta(page, key), key).toHaveCount(1);
  return (await meta(page, key).getAttribute('content')) ?? '';
}

/** Asserts the full OG/Twitter tag set, with og:url = `url` and og:image = `image`. */
async function expectOgTags(page: Page, lang: Lang, url: string, image: string): Promise<void> {
  const title = await page.title();
  expect(await content(page, 'og:type')).toBe('website');
  expect(await content(page, 'og:site_name')).toBe(siteName[lang]);
  expect(await content(page, 'og:title')).toBe(title);
  expect(await content(page, 'og:description')).toBe(await page.locator('meta[name="description"]').getAttribute('content'));
  expect(await content(page, 'og:url')).toBe(url);
  expect(await content(page, 'og:image')).toBe(image);
  expect(await content(page, 'og:image:width')).toBe('1200');
  expect(await content(page, 'og:image:height')).toBe('630');
  expect(await content(page, 'og:image:alt')).toBe(title);
  expect(await content(page, 'og:locale')).toBe(LOCALE[lang]);
  expect(await content(page, 'og:locale:alternate')).toBe(LOCALE[OTHER[lang]]);
  expect(await content(page, 'twitter:card')).toBe('summary_large_image');
  await expect(page.locator('meta[name^="twitter:site"], meta[name^="twitter:creator"]')).toHaveCount(0);
}

async function expectPng(request: APIRequestContext, imageUrl: string): Promise<void> {
  expect(imageUrl.startsWith(`${ORIGIN}/`)).toBe(true);
  const response = await request.get(imageUrl.slice(ORIGIN.length));
  expect(response.status(), imageUrl).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^image\/png/);
  const body = await response.body();
  expect(body.readUInt32BE(16)).toBe(1200);
  expect(body.readUInt32BE(20)).toBe(630);
}

for (const lang of ['id', 'en'] as const) {
  test(`/${lang}/: full OG/Twitter tag set in the page language, site image served`, async ({ page, request }) => {
    expect((await page.goto(`/${lang}/`))?.status()).toBe(200);
    const image = `${ORIGIN}/og/site-${lang}.png`;
    await expectOgTags(page, lang, `${ORIGIN}/${lang}/`, image);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', await content(page, 'og:url'));
    await expectPng(request, image);
  });

  test(`/${lang}/proyek/${firstProject.slug}/: own per-language project image`, async ({ page, request }) => {
    expect((await page.goto(`/${lang}/proyek/${firstProject.slug}/`))?.status()).toBe(200);
    const image = `${ORIGIN}/og/${lang}/proyek/${firstProject.slug}.png`;
    await expectOgTags(page, lang, `${ORIGIN}/${lang}/proyek/${firstProject.slug}/`, image);
    expect(await content(page, 'og:title')).toContain(firstProject.name[lang]);
    await expectPng(request, image);
  });

  test(`/${lang}/ unknown path: not-found page uses the site image and the language home as og:url`, async ({ page, request }) => {
    expect((await page.goto(`/${lang}/tidak-ada-og/`))?.status()).toBe(404);
    const image = `${ORIGIN}/og/site-${lang}.png`;
    await expectOgTags(page, lang, `${ORIGIN}/${lang}/`, image);
    await expectPng(request, image);
  });
}
