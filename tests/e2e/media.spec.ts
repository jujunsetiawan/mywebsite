// `/media/*` through `wrangler dev` (local R2 seeded by scripts/seed-local-r2.ts).
import { expect, test } from '@playwright/test';

const SMOKE_BODY = 'ping\n'; // keep in sync with scripts/seed-local-r2.ts

test('/media/smoke/ping.bin → 200 with stored bytes and immutable caching', async ({ request }) => {
  const response = await request.get('/media/smoke/ping.bin');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe(SMOKE_BODY);
  const headers = response.headers();
  expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(headers['content-type']).toBe('application/octet-stream');
  expect(headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  expect(headers['accept-ranges']).toBe('bytes');
  expect(headers['set-cookie']).toBeUndefined();
});

test('/media range request → 206', async ({ request }) => {
  const response = await request.get('/media/smoke/ping.bin', { headers: { Range: 'bytes=0-1' } });
  expect(response.status()).toBe(206);
  expect(await response.text()).toBe('pi');
  expect(response.headers()['content-range']).toBe(`bytes 0-1/${SMOKE_BODY.length}`);
});

test('/media missing key → 404', async ({ request }) => {
  const response = await request.get('/media/smoke/does-not-exist.bin');
  expect(response.status()).toBe(404);
});
