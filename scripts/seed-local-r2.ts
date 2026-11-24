// Seeds the smoke object into the *local* R2 bucket used by `wrangler dev`
// (`.wrangler/state/v3`, Wrangler's default persistence). Never touches
// Cloudflare: remote bindings are disabled. Run with `node scripts/seed-local-r2.ts`.
import { getPlatformProxy } from 'wrangler';

// Keep in sync with tests/e2e/media.spec.ts.
const SMOKE_KEY = 'smoke/ping.bin';
const SMOKE_BYTES = new TextEncoder().encode('ping\n');

interface Env {
  MEDIA: {
    put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  };
}

const proxy = await getPlatformProxy<Env>({ configPath: 'wrangler.jsonc', remoteBindings: false });
try {
  await proxy.env.MEDIA.put(SMOKE_KEY, SMOKE_BYTES, { httpMetadata: { contentType: 'application/octet-stream' } });
  console.log(`seeded local R2: ${SMOKE_KEY} (${SMOKE_BYTES.length} bytes)`);
} finally {
  await proxy.dispose();
}
