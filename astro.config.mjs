// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { loadSiteConfig } from './config/load.ts';
import siteEnv from './src/integrations/site-env.ts';
import { SITEMAP_I18N, sitemapFilter } from './src/seo/sitemap.ts';

// Selected by SITE_ENV (default `development`); throws — failing the build —
// when the config is invalid.
const siteConfig = loadSiteConfig();

// Static output only, no adapter: `dist/` is served by Workers static assets.
export default defineConfig({
  // Story 1.9: the production origin in every env, so sitemap URLs (like
  // canonical/hreflang) never point at a preview or development host.
  site: siteConfig.productionOrigin,
  output: 'static',
  srcDir: './src',
  publicDir: './public',
  outDir: './dist',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // No inline <style>: the CSP allows `style-src 'self'` only.
    inlineStylesheets: 'never',
  },
  // The sitemap lists every page from Astro's route list with id/en alternates;
  // `sitemapFilter` drops the not-found pages (`siteEnv` moving them does not matter).
  integrations: [siteEnv(siteConfig), sitemap({ i18n: SITEMAP_I18N, filter: sitemapFilter })],
  vite: {
    server: {
      watch: {
        // Epic 0 folders are not part of the site.
        ignored: ['**/spike/**', '**/pipeline/**'],
      },
    },
  },
});
