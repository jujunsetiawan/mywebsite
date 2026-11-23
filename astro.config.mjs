// @ts-check
import { defineConfig } from 'astro/config';

// Static output only. `site` is intentionally omitted until Story 1.2 adds the
// Zod-validated site config with the production origin.
export default defineConfig({
  output: 'static',
  srcDir: './src',
  publicDir: './public',
  outDir: './dist',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  vite: {
    server: {
      watch: {
        // Epic 0 folders are not part of the site.
        ignored: ['**/spike/**', '**/pipeline/**'],
      },
    },
  },
});
