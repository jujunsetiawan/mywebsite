// Site config loader (Story 1.2).
//
// Picks `config/site.<SITE_ENV>.json` (SITE_ENV defaults to `development`),
// deep-merges the optional git-ignored `config/site.local.json` on top,
// validates with `siteConfigSchema`, and throws an error naming the file(s) and
// field path when anything is wrong — which fails `astro build`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SITE_ENVS, siteConfigSchema, type SiteConfig, type SiteEnv } from './site.schema.ts';

export interface LoadSiteConfigOptions {
  /** Defaults to `process.env.SITE_ENV`, then `development`. */
  siteEnv?: string | undefined;
  /**
   * Directory holding the JSON files. Defaults to `process.env.SITE_CONFIG_DIR`
   * (test seam only), then `<cwd>/config`.
   */
  configDir?: string | undefined;
}

export class SiteConfigError extends Error {
  override name = 'SiteConfigError';
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merges plain objects; any other override value replaces the base value. */
export function deepMerge(base: Json, override: Json): Json {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result: Record<string, Json> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = current === undefined ? value : deepMerge(current, value);
  }
  return result;
}

export function resolveSiteEnv(raw: string | undefined): SiteEnv {
  const value = raw === undefined || raw.trim() === '' ? 'development' : raw.trim();
  if (!(SITE_ENVS as readonly string[]).includes(value)) {
    throw new SiteConfigError(`Invalid site config: SITE_ENV "${value}" is not one of ${SITE_ENVS.join(', ')}`);
  }
  return value as SiteEnv;
}

function readJson(file: string, label: string): Json {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new SiteConfigError(`Invalid site config: cannot read ${label} (${(error as Error).message})`);
  }
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new SiteConfigError(`Invalid site config: ${label} is not valid JSON (${(error as Error).message})`);
  }
}

export function loadSiteConfig(options: LoadSiteConfigOptions = {}): SiteConfig {
  const siteEnv = resolveSiteEnv(options.siteEnv ?? process.env.SITE_ENV);
  const configDir = options.configDir ?? process.env.SITE_CONFIG_DIR ?? path.resolve(process.cwd(), 'config');

  const envLabel = `config/site.${siteEnv}.json`;
  const sources = [envLabel];
  let data = readJson(path.join(configDir, `site.${siteEnv}.json`), envLabel);

  const localFile = path.join(configDir, 'site.local.json');
  if (existsSync(localFile)) {
    sources.push('config/site.local.json');
    data = deepMerge(data, readJson(localFile, 'config/site.local.json'));
  }

  const result = siteConfigSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n');
    throw new SiteConfigError(`Invalid site config in ${sources.join(' + ')}:\n${details}`);
  }
  if (result.data.env !== siteEnv) {
    throw new SiteConfigError(
      `Invalid site config in ${sources.join(' + ')}:\n  env: "${result.data.env}" does not match SITE_ENV "${siteEnv}"`,
    );
  }
  return result.data;
}
