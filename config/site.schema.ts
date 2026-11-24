// Site config schema (Story 1.2). Pure module: no file system, importable from
// astro.config.mjs, layouts, integrations and Vitest alike. No secrets belong
// in site config — every value here ends up in public build output or the repo.
import { z } from 'astro/zod';

export const SITE_ENVS = ['production', 'preview', 'development'] as const;
export type SiteEnv = (typeof SITE_ENVS)[number];

/** https origin only: no path, query, fragment, credentials or trailing slash. */
const origin = z
  .url({ protocol: /^https$/, error: 'must be an https URL' })
  .refine((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }, 'must be a bare https origin without path or trailing slash (e.g. https://example.workers.dev)');

export const siteConfigSchema = z.strictObject({
  env: z.enum(SITE_ENVS),
  productionOrigin: origin,
  mediaBase: z.literal('/media'),
  analyticsToken: z.string().trim().min(1, 'must be a non-empty string or null').nullable(),
  features: z.strictObject({
    hubLinks: z.boolean(),
    contact: z.boolean(),
  }),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

/** Only production output may be indexed by search engines. */
export function isIndexable(config: SiteConfig): boolean {
  return config.env === 'production';
}

/** Cloudflare Web Analytics token to embed, or null when no beacon may ship. */
export function beaconToken(config: SiteConfig): string | null {
  return config.env === 'production' ? config.analyticsToken : null;
}
