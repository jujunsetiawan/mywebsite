// Local build (SITE_ENV unset → development) served by `wrangler dev`.
import { expect, test } from '@playwright/test';

const CSP =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

for (const lang of ['id', 'en'] as const) {
  test(`/${lang}/ sets no cookies, sends the CSP and triggers no CSP violations`, async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) violations.push(`console: ${message.text()}`);
    });
    await page.addInitScript(() => {
      const store: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = store;
      document.addEventListener('securitypolicyviolation', (event) => {
        store.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    const response = await page.goto(`/${lang}/`);
    expect(response?.status()).toBe(200);
    const headers = await response!.allHeaders();
    expect(headers['set-cookie']).toBeUndefined();
    expect(headers['content-security-policy']).toBe(CSP);

    await page.waitForLoadState('load');
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    expect((await page.context().cookies()).length).toBe(0);
    violations.push(...(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)));
    expect(violations).toEqual([]);
  });

  test(`/${lang}/ is non-indexable in a non-production build`, async ({ page }) => {
    const response = await page.goto(`/${lang}/`);
    expect(response?.headers()['x-robots-tag']).toBe('noindex');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('script[src*="cloudflareinsights"]')).toHaveCount(0);
  });
}

test('robots.txt disallows crawling in a non-production build', async ({ request }) => {
  const response = await request.get('/robots.txt');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
});

test('paths outside /media/* are served as static assets, not by the Worker', async ({ request }) => {
  // `_headers` rules apply to static-asset responses only, never to Worker responses.
  const page = await request.get('/id/');
  expect(page.headers()['content-security-policy']).toBe(CSP);
  const media = await request.get('/media/smoke/ping.bin');
  expect(media.headers()['content-security-policy']).toBeUndefined();
  // A non-/media path that the Worker would answer with its text/plain 404 is
  // answered by the assets 404 handling instead.
  const missing = await request.get('/smoke/ping.bin');
  expect(missing.status()).toBe(404);
  expect(await missing.text()).not.toBe('Not Found');
});
