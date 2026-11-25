// Runs all dist/ budget checks, the layer-import check, the i18n route check
// and the SEO check.
// Usage: node scripts/check-budgets.ts  (Node native type stripping)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../config/load.ts';
import { isIndexable } from '../config/site.schema.ts';
import { diskReader, formatFirstLoad, measureFirstLoad } from './budgets/first-load.ts';
import { firstProjectSlug } from './budgets/project-pages.ts';
import { checkI18nRoutesDir, formatI18nRoutes } from './checks/i18n-routes.ts';
import { checkSeoDir, formatSeo } from './checks/seo.ts';
import { checkLayers, formatLayers } from './budgets/layer-imports.ts';
import { checkStaticAssets, formatStaticAssets, listFiles } from './budgets/static-assets.ts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const HOME_PAGES = ['id/index.html', 'en/index.html'];

let failed = false;

if (!existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

// Story 1.6: also the first project page (by `order`) in both languages.
const firstSlug = firstProjectSlug(path.join(process.env.CONTENT_DIR ?? path.join(rootDir, 'content'), 'projects'));
const PROJECT_PAGES = ['id', 'en'].map((lang) => `${lang}/proyek/${firstSlug}/index.html`);

const read = diskReader(distDir);
for (const page of [...HOME_PAGES, ...PROJECT_PAGES]) {
  const result = measureFirstLoad(page, read);
  console.log(formatFirstLoad(result));
  console.log('');
  if (!result.ok) failed = true;
}

const assets = checkStaticAssets(listFiles(distDir));
console.log(formatStaticAssets(assets));
console.log('');
if (!assets.ok) failed = true;

const violations = checkLayers(rootDir);
console.log(formatLayers(violations));
if (violations.length > 0) failed = true;
console.log('');

// Canonical/hreflang always target the production origin, whatever SITE_ENV built dist/.
// SITE_ENV must match the build's (it selects the config, and with it the robots rule below).
const siteConfig = loadSiteConfig({ configDir: process.env.SITE_CONFIG_DIR ?? path.join(rootDir, 'config') });
const { productionOrigin } = siteConfig;
const routes = checkI18nRoutesDir(distDir, productionOrigin);
console.log(formatI18nRoutes(routes, productionOrigin));
if (!routes.ok) failed = true;
console.log('');

// Story 1.9: sitemap, JSON-LD and robots Sitemap line on the production origin too.
const seo = checkSeoDir(distDir, productionOrigin, isIndexable(siteConfig));
console.log(formatSeo(seo, productionOrigin));
if (!seo.ok) failed = true;

console.log('');
console.log(failed ? 'Budgets: FAIL' : 'Budgets: PASS');
process.exit(failed ? 1 : 0);
