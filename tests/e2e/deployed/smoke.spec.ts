// Deployed smoke checks. Run only when DEPLOY_URL is set (CI deploy jobs):
//   DEPLOY_URL=https://… SITE_ENV=preview|production npx playwright test --project=chromium
// Uses the `request` fixture only, so no browser is launched.
// Requires the smoke object `smoke/ping.bin` in the R2 bucket (see infra/README.md).
import { expect, test } from '@playwright/test';

const siteEnv = process.env.SITE_ENV ?? 'production';
const indexable = siteEnv === 'production';

test('/media/smoke/ping.bin → 200 with immutable caching', async ({ request }) => {
  const response = await request.get('/media/smoke/ping.bin');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(response.headers()['etag']).toMatch(/^(W\/)?"[^"]+"$/);
  expect(response.headers()['set-cookie']).toBeUndefined();
  expect((await response.body()).length).toBeGreaterThan(0);
});

test('/media missing key → 404', async ({ request }) => {
  const response = await request.get('/media/smoke/does-not-exist.bin');
  expect(response.status()).toBe(404);
});

test(`robots rules match SITE_ENV=${siteEnv}`, async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toBe(indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');

  const home = await request.get('/id/');
  expect(home.status()).toBe(200);
  expect(home.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(home.headers()['set-cookie']).toBeUndefined();
  const html = await home.text();
  if (indexable) {
    expect(home.headers()['x-robots-tag']).toBeUndefined();
    expect(html).not.toContain('noindex');
  } else {
    expect(home.headers()['x-robots-tag']).toContain('noindex');
    expect(html).toContain('<meta name="robots" content="noindex">');
  }
});
