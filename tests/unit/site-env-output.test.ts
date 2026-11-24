import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SiteConfig } from '../../config/site.schema.ts';
import { headersFile, NOINDEX_HEADER_LINE, robotsTxt, writeEnvOutput } from '../../src/integrations/site-env.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const astroBin = path.join(repoRoot, 'node_modules/astro/bin/astro.mjs');
const sharedHeaders = readFileSync(path.join(repoRoot, 'public/_headers'), 'utf8');
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'site-env-'));

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const CSP =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const PREVIEW_HEADERS = `/*\n  X-Robots-Tag: noindex\n  Content-Security-Policy: ${CSP}\n`;

function config(env: SiteConfig['env'], analyticsToken: string | null = null): SiteConfig {
  return {
    env,
    productionOrigin: 'https://jun-portfolio.example.workers.dev',
    mediaBase: '/media',
    analyticsToken,
    features: { hubLinks: false, contact: false },
  };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('public/_headers', () => {
  it('holds exactly the shared CSP for /*', () => {
    expect(sharedHeaders).toBe(`/*\n  Content-Security-Policy: ${CSP}\n`);
  });
});

describe('pure env output', () => {
  it('robots.txt disallows everything outside production', () => {
    expect(robotsTxt(config('preview'))).toBe('User-agent: *\nDisallow: /\n');
    expect(robotsTxt(config('development'))).toBe('User-agent: *\nDisallow: /\n');
    expect(robotsTxt(config('production'))).toBe('User-agent: *\nAllow: /\n');
  });

  it('_headers gains X-Robots-Tag: noindex inside the /* rule outside production only', () => {
    expect(headersFile(sharedHeaders, config('preview'))).toBe(PREVIEW_HEADERS);
    expect(headersFile(sharedHeaders, config('development'))).toBe(PREVIEW_HEADERS);
    expect(headersFile(sharedHeaders, config('production'))).toBe(sharedHeaders);
    // Exactly one `/*` rule: a second block would replace the CSP.
    expect(PREVIEW_HEADERS.match(/^\/\*$/gm)).toHaveLength(1);
  });

  it('_headers without a /* rule gets one appended', () => {
    expect(headersFile('', config('preview'))).toBe(`/*\n${NOINDEX_HEADER_LINE}\n`);
    expect(headersFile('/id/*\n  A: b', config('preview'))).toBe(`/id/*\n  A: b\n\n/*\n${NOINDEX_HEADER_LINE}\n`);
    expect(headersFile('/x\n  A: b\n/*\n  C: d\n', config('preview'))).toBe(
      `/x\n  A: b\n/*\n${NOINDEX_HEADER_LINE}\n  C: d\n`,
    );
  });

  it('_headers with CRLF line endings is normalised to LF', () => {
    expect(headersFile('/*\r\n  C: d\r\n', config('preview'))).toBe(`/*\n${NOINDEX_HEADER_LINE}\n  C: d\n`);
  });

  it('writeEnvOutput writes robots.txt and _headers into the dist dir', async () => {
    const dist = path.join(tmpRoot, 'dist-pure');
    mkdirSync(dist);
    writeFileSync(path.join(dist, '_headers'), sharedHeaders);
    await writeEnvOutput(dist, config('preview'));
    expect(readFileSync(path.join(dist, '_headers'), 'utf8')).toContain('X-Robots-Tag: noindex');
    expect(readFileSync(path.join(dist, 'robots.txt'), 'utf8')).toBe('User-agent: *\nDisallow: /\n');

    const empty = path.join(tmpRoot, 'dist-empty');
    mkdirSync(empty);
    await writeEnvOutput(empty, config('production'));
    expect(readFileSync(path.join(empty, '_headers'), 'utf8')).toBe('');
    expect(readFileSync(path.join(empty, 'robots.txt'), 'utf8')).toBe('User-agent: *\nAllow: /\n');
  });
});

/** Real `astro build` of the site into a temp outDir. */
function build(name: string, env: Record<string, string>) {
  const outDir = path.join(tmpRoot, name);
  const run = spawnSync(process.execPath, [astroBin, 'build', '--outDir', outDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    timeout: 120_000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.error, output).toBeUndefined();
  expect(run.status, output).toBe(0);
  const read = (file: string) => readFileSync(path.join(outDir, file), 'utf8');
  return { read };
}

/** Temp config dir holding only the committed `site.<env>.json` (ignores any developer `site.local.json`). */
function committedConfigDir(env: SiteConfig['env']): string {
  const dir = path.join(tmpRoot, `committed-${env}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, `site.${env}.json`), readFileSync(path.join(repoRoot, `config/site.${env}.json`)));
  return dir;
}

function countBeacons(html: string): number {
  return html.split(`src="${BEACON_SRC}"`).length - 1;
}

describe('astro build per SITE_ENV', () => {
  it('preview: noindex meta, X-Robots-Tag, disallow robots, no beacon', () => {
    const { read } = build('preview', { SITE_ENV: 'preview', SITE_CONFIG_DIR: committedConfigDir('preview') });
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(countBeacons(html)).toBe(0);
      expect(html).not.toMatch(/<style/);
    }
    expect(read('_headers')).toBe(PREVIEW_HEADERS);
    expect(read('robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  }, 120_000);

  it('production with a token: no noindex, allow robots, exactly one beacon', () => {
    const dir = path.join(tmpRoot, 'config-token');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'site.production.json'), JSON.stringify(config('production', 'test-token-123')));
    const { read } = build('production-token', { SITE_ENV: 'production', SITE_CONFIG_DIR: dir });
    for (const lang of ['id', 'en']) {
      const html = read(`${lang}/index.html`);
      expect(html).not.toContain('noindex');
      expect(countBeacons(html)).toBe(1);
      expect(html).toMatch(
        /<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon="\{&quot;token&quot;:&quot;test-token-123&quot;\}"><\/script>/,
      );
    }
    expect(read('_headers')).toBe(sharedHeaders);
    expect(read('_headers')).not.toContain('X-Robots-Tag');
    expect(read('robots.txt')).toBe('User-agent: *\nAllow: /\n');
  }, 120_000);

  it('production with a null token (committed config): no beacon', () => {
    const { read } = build('production-null', {
      SITE_ENV: 'production',
      SITE_CONFIG_DIR: committedConfigDir('production'),
    });
    const html = read('id/index.html');
    expect(html).not.toContain('noindex');
    expect(countBeacons(html)).toBe(0);
    expect(read('robots.txt')).toBe('User-agent: *\nAllow: /\n');
  }, 120_000);
});
