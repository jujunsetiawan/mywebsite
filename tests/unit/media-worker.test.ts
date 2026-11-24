// Runs the real `worker/media.ts` in Wrangler's local runtime (workerd) against
// a local, temp-dir R2 binding. No network, no Cloudflare login.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy, unstable_startWorker } from 'wrangler';

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

const PING = new Uint8Array([0x70, 0x69, 0x6e, 0x67, 0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]);
const SECRET = new TextEncoder().encode('must never be served');

let tmp: string;
let worker: Worker;

async function request(pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const response = await worker.fetch(`http://localhost${pathname}`, init);
  const body = new Uint8Array(await response.arrayBuffer());
  return { response, body };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'media-worker-'));
  const configPath = path.join(tmp, 'wrangler.json');
  const persist = path.join(tmp, 'state');
  // Same Worker entry and R2 binding as wrangler.jsonc, minus static assets
  // (dist/ does not exist yet when unit tests run in CI order).
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'media-worker-test',
      main: path.resolve('worker/media.ts'),
      compatibility_date: '2026-11-18',
      r2_buckets: [{ binding: 'MEDIA', bucket_name: 'jun-portfolio-media' }],
    }),
  );

  const proxy = await getPlatformProxy<{ MEDIA: R2BucketLike }>({
    configPath,
    persist: { path: path.join(persist, 'v3') },
    remoteBindings: false,
  });
  await proxy.env.MEDIA.put('smoke/ping.bin', PING, { httpMetadata: { contentType: 'application/x-ping' } });
  await proxy.env.MEDIA.put('untyped.bin', PING);
  await proxy.env.MEDIA.put('dir with space/a+b.bin', PING, { httpMetadata: { contentType: 'image/avif' } });
  // Objects whose keys contain `..`: reachable only if the Worker skipped the key check.
  await proxy.env.MEDIA.put('../secret.bin', SECRET);
  await proxy.env.MEDIA.put('a/../secret.bin', SECRET);
  await proxy.dispose();

  worker = await unstable_startWorker({
    config: configPath,
    dev: { persist, remote: false, server: { port: 0 }, inspector: false, watch: false, logLevel: 'error' },
  });
  await worker.ready;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Minimal shape of the R2 binding used for seeding (Node side of the proxy). */
interface R2BucketLike {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

describe('/media Worker', () => {
  it('GET streams the stored bytes with type, ETag and immutable caching', async () => {
    const { response, body } = await request('/media/smoke/ping.bin');
    expect(response.status).toBe(200);
    expect(body).toEqual(PING);
    expect(response.headers.get('content-type')).toBe('application/x-ping');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe(String(PING.length));
  });

  it('falls back to application/octet-stream without a stored type', async () => {
    const { response } = await request('/media/untyped.bin');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('URL-decodes the key', async () => {
    const { response, body } = await request('/media/dir%20with%20space/a%2Bb.bin');
    expect(response.status).toBe(200);
    expect(body).toEqual(PING);
    expect(response.headers.get('content-type')).toBe('image/avif');
  });

  it('HEAD returns headers including Content-Length and no body', async () => {
    const { response, body } = await request('/media/smoke/ping.bin', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(body.length).toBe(0);
    expect(response.headers.get('content-length')).toBe(String(PING.length));
    expect(response.headers.get('content-type')).toBe('application/x-ping');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('Range bytes=0-3 → 206 with 4 bytes and Content-Range', async () => {
    const { response, body } = await request('/media/smoke/ping.bin', { headers: { Range: 'bytes=0-3' } });
    expect(response.status).toBe(206);
    expect(body).toEqual(PING.slice(0, 4));
    expect(response.headers.get('content-range')).toBe(`bytes 0-3/${PING.length}`);
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it.each([
    ['bytes=4-', 4, PING.length - 1],
    ['bytes=-3', PING.length - 3, PING.length - 1],
    ['bytes=8-999', 8, PING.length - 1],
  ])('Range %s → 206 for the clamped range', async (range, first, last) => {
    const { response, body } = await request('/media/smoke/ping.bin', { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(body).toEqual(PING.slice(first, last + 1));
    expect(response.headers.get('content-range')).toBe(`bytes ${first}-${last}/${PING.length}`);
  });

  it.each(['bytes=10-', 'bytes=100-200', 'bytes=-0'])('unsatisfiable Range %s → 416 with bytes */size', async (range) => {
    for (const method of ['GET', 'HEAD']) {
      const { response, body } = await request('/media/smoke/ping.bin', { method, headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(body.length).toBe(0);
      expect(response.headers.get('content-range')).toBe(`bytes */${PING.length}`);
    }
  });

  it('HEAD with Range → 206 headers only', async () => {
    const { response, body } = await request('/media/smoke/ping.bin', { method: 'HEAD', headers: { Range: 'bytes=0-3' } });
    expect(response.status).toBe(206);
    expect(body.length).toBe(0);
    expect(response.headers.get('content-range')).toBe(`bytes 0-3/${PING.length}`);
  });

  it('ignores malformed or multi-range headers and serves the full object', async () => {
    for (const range of ['bytes=3-1', 'bytes=0-1,4-5', 'items=0-1']) {
      const { response, body } = await request('/media/smoke/ping.bin', { headers: { Range: range } });
      expect(response.status).toBe(200);
      expect(body).toEqual(PING);
    }
  });

  it('If-None-Match matching the ETag → 304 without body (GET and HEAD, strong and weak)', async () => {
    const etag = (await request('/media/smoke/ping.bin', { method: 'HEAD' })).response.headers.get('etag')!;
    for (const method of ['GET', 'HEAD']) {
      for (const tag of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
        const { response, body } = await request('/media/smoke/ping.bin', { method, headers: { 'If-None-Match': tag } });
        expect(response.status, `${method} ${tag}`).toBe(304);
        expect(body.length).toBe(0);
        expect(response.headers.get('etag')).toBe(etag);
      }
    }
  });

  it('If-None-Match matching the ETag wins over an unsatisfiable Range → 304', async () => {
    const etag = (await request('/media/smoke/ping.bin', { method: 'HEAD' })).response.headers.get('etag')!;
    for (const method of ['GET', 'HEAD']) {
      const { response, body } = await request('/media/smoke/ping.bin', {
        method,
        headers: { 'If-None-Match': etag, Range: 'bytes=100-' },
      });
      expect(response.status, method).toBe(304);
      expect(body.length).toBe(0);
    }
  });

  it('sends X-Content-Type-Options: nosniff on media responses', async () => {
    const { response } = await request('/media/smoke/ping.bin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('If-None-Match with a different ETag → 200 with body', async () => {
    const { response, body } = await request('/media/smoke/ping.bin', { headers: { 'If-None-Match': '"nope"' } });
    expect(response.status).toBe(200);
    expect(body).toEqual(PING);
  });

  it('unknown key → 404 (GET and HEAD)', async () => {
    expect((await request('/media/nope.bin')).response.status).toBe(404);
    expect((await request('/media/nope.bin', { method: 'HEAD' })).response.status).toBe(404);
  });

  it.each(['/media/', '/media/..%2Fsecret.bin', '/media/a/..%2Fsecret.bin', '/media/%E0%A4%A', '/other/smoke/ping.bin'])(
    'bad key %s → 404 without reading R2',
    async (pathname) => {
      const { response, body } = await request(pathname);
      expect(response.status).toBe(404);
      expect(new TextDecoder().decode(body)).not.toContain('must never be served');
    },
  );

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s → 405 with Allow: GET, HEAD', async (method) => {
    const { response } = await request('/media/x', { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('sets no cookies and no CORS headers', async () => {
    const { response } = await request('/media/smoke/ping.bin', { headers: { Origin: 'https://evil.example' } });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
