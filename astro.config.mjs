// @ts-check
import { defineConfig } from 'astro/config';
import { loadSiteConfig } from './config/load.ts';
import siteEnv from './src/integrations/site-env.ts';

// Selected by SITE_ENV (default `development`); throws — failing the build —
// when the config is invalid. `site` stays unset until Story 1.9 (SEO).
const siteConfig = loadSiteConfig();

// Static output only, no adapter: `dist/` is served by Workers static assets.
export default defineConfig({
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
  integrations: [siteEnv(siteConfig)],
  vite: {
    server: {
      watch: {
        // Epic 0 folders are not part of the site.
        ignored: ['**/spike/**', '**/pipeline/**'],
      },
    },
  },
});
