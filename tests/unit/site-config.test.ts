import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { deepMerge, loadSiteConfig, resolveSiteEnv, SiteConfigError } from '../../config/load.ts';
import { beaconToken, isIndexable, SITE_ENVS, type SiteConfig } from '../../config/site.schema.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const astroBin = path.join(repoRoot, 'node_modules/astro/bin/astro.mjs');
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'site-config-'));

// Copies of the committed env files only, so a developer's git-ignored
// `config/site.local.json` cannot change the results.
const realConfigDir = path.join(tmpRoot, 'committed');
mkdirSync(realConfigDir);
for (const env of SITE_ENVS) {
  copyFileSync(path.join(repoRoot, `config/site.${env}.json`), path.join(realConfigDir, `site.${env}.json`));
}

function valid(env: SiteConfig['env']): SiteConfig {
  return {
    env,
    productionOrigin: 'https://jun-portfolio.example.workers.dev',
    mediaBase: '/media',
    analyticsToken: null,
    features: { hubLinks: false, contact: false },
  };
}

let dirCount = 0;
/** Writes `site.<name>.json` files (raw strings or objects) into a fresh temp config dir. */
function configDir(files: Record<string, unknown>): string {
  const dir = path.join(tmpRoot, `c${dirCount++}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, `site.${name}.json`), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function loadError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected loadSiteConfig to throw');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('committed config files', () => {
  it.each(SITE_ENVS)('config/site.%s.json is valid and matches its env', (env) => {
    const config = loadSiteConfig({ siteEnv: env, configDir: realConfigDir });
    expect(config.env).toBe(env);
    expect(config.mediaBase).toBe('/media');
    expect(config.features).toEqual({ hubLinks: false, contact: false });
  });

  it('defaults to development when SITE_ENV is unset or empty', () => {
    vi.stubEnv('SITE_ENV', undefined);
    expect(loadSiteConfig({ configDir: realConfigDir }).env).toBe('development');
    vi.stubEnv('SITE_ENV', '');
    expect(loadSiteConfig({ configDir: realConfigDir }).env).toBe('development');
  });

  it('reads SITE_ENV from the environment', () => {
    vi.stubEnv('SITE_ENV', 'preview');
    expect(loadSiteConfig({ configDir: realConfigDir }).env).toBe('preview');
  });
});

describe('validation errors name the file and field path', () => {
  it('unknown SITE_ENV', () => {
    const error = loadError(() => loadSiteConfig({ siteEnv: 'staging', configDir: realConfigDir }));
    expect(error).toBeInstanceOf(SiteConfigError);
    expect(error.message).toMatch(/SITE_ENV "staging"/);
    expect(() => resolveSiteEnv('Production')).toThrow(/SITE_ENV/);
  });

  it.each([
    ['http://jun.example.workers.dev', 'http'],
    ['https://jun.example.workers.dev/', 'trailing slash'],
    ['https://jun.example.workers.dev/id', 'path'],
    ['https://jun.example.workers.dev?x=1', 'query'],
    ['not a url', 'garbage'],
  ])('production with bad productionOrigin %s (%s)', (productionOrigin) => {
    const dir = configDir({ production: { ...valid('production'), productionOrigin } });
    const error = loadError(() => loadSiteConfig({ siteEnv: 'production', configDir: dir }));
    expect(error.message).toContain('config/site.production.json');
    expect(error.message).toMatch(/^\s+productionOrigin: /m);
  });

  it.each([
    ['mediaBase', { mediaBase: '/assets' }, /^\s+mediaBase: /m],
    ['analyticsToken empty', { analyticsToken: '  ' }, /^\s+analyticsToken: /m],
    ['analyticsToken number', { analyticsToken: 42 }, /^\s+analyticsToken: /m],
    ['features.contact', { features: { hubLinks: false, contact: 'no' } }, /^\s+features\.contact: /m],
    ['missing features.hubLinks', { features: { contact: false } }, /^\s+features\.hubLinks: /m],
    ['unknown key', { apiSecret: 'x' }, /apiSecret/],
    ['env enum', { env: 'staging' }, /^\s+env: /m],
  ])('%s', (_name, patch, pattern) => {
    const dir = configDir({ preview: { ...valid('preview'), ...patch } });
    const error = loadError(() => loadSiteConfig({ siteEnv: 'preview', configDir: dir }));
    expect(error.message).toContain('config/site.preview.json');
    expect(error.message).toMatch(pattern);
  });

  it('env field must match SITE_ENV', () => {
    const dir = configDir({ preview: valid('production') });
    const error = loadError(() => loadSiteConfig({ siteEnv: 'preview', configDir: dir }));
    expect(error.message).toContain('config/site.preview.json');
    expect(error.message).toMatch(/env: "production" does not match SITE_ENV "preview"/);
  });

  it('invalid JSON and missing files name the file', () => {
    const dir = configDir({ development: '{ "env": ' });
    expect(loadError(() => loadSiteConfig({ siteEnv: 'development', configDir: dir })).message).toMatch(
      /config\/site\.development\.json is not valid JSON/,
    );
    expect(loadError(() => loadSiteConfig({ siteEnv: 'production', configDir: dir })).message).toMatch(
      /cannot read config\/site\.production\.json/,
    );
  });
});

describe('git-ignored local override', () => {
  it('is deep-merged over the env file', () => {
    const dir = configDir({
      development: valid('development'),
      local: { analyticsToken: 'local-token', features: { contact: true } },
    });
    const config = loadSiteConfig({ siteEnv: 'development', configDir: dir });
    expect(config.analyticsToken).toBe('local-token');
    expect(config.features).toEqual({ hubLinks: false, contact: true });
    expect(config.productionOrigin).toBe('https://jun-portfolio.example.workers.dev');
  });

  it('errors name both files when the merged result is invalid', () => {
    const dir = configDir({ development: valid('development'), local: { productionOrigin: 'http://x.dev' } });
    const error = loadError(() => loadSiteConfig({ siteEnv: 'development', configDir: dir }));
    expect(error.message).toContain('config/site.development.json + config/site.local.json');
    expect(error.message).toMatch(/productionOrigin/);
  });

  it('deepMerge replaces non-object values and keeps unrelated keys', () => {
    expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, e: null })).toEqual({
      a: { b: 1, c: [2] },
      d: 1,
      e: null,
    });
  });
});

describe('env rules', () => {
  it('only production is indexable', () => {
    expect(isIndexable(valid('production'))).toBe(true);
    expect(isIndexable(valid('preview'))).toBe(false);
    expect(isIndexable(valid('development'))).toBe(false);
  });

  it('beacon token only in production with a non-null token', () => {
    expect(beaconToken({ ...valid('production'), analyticsToken: 'abc' })).toBe('abc');
    expect(beaconToken(valid('production'))).toBeNull();
    expect(beaconToken({ ...valid('preview'), analyticsToken: 'abc' })).toBeNull();
    expect(beaconToken({ ...valid('development'), analyticsToken: 'abc' })).toBeNull();
  });
});

describe('astro build with an invalid site config', () => {
  function build(env: Record<string, string>) {
    const run = spawnSync(process.execPath, [astroBin, 'build', '--outDir', path.join(tmpRoot, 'never-written')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      timeout: 120_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.error, output).toBeUndefined();
    expect(run.signal, output).toBeNull();
    expect(run.status, output).not.toBe(0);
    return output;
  }

  it('fails for an unknown SITE_ENV', () => {
    expect(build({ SITE_ENV: 'staging' })).toMatch(/SITE_ENV "staging"/);
  }, 120_000);

  it('fails for SITE_ENV=production with a bad productionOrigin, naming file and field', () => {
    const dir = configDir({ production: { ...valid('production'), productionOrigin: 'http://jun.example.dev/' } });
    const output = build({ SITE_ENV: 'production', SITE_CONFIG_DIR: dir });
    expect(output).toContain('config/site.production.json');
    expect(output).toMatch(/productionOrigin: /);
  }, 120_000);
});
