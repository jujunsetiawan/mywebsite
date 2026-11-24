// Runs all dist/ budget checks, the layer-import check and the i18n route check.
// Usage: node scripts/check-budgets.ts  (Node native type stripping)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../config/load.ts';
import { diskReader, formatFirstLoad, measureFirstLoad } from './budgets/first-load.ts';
import { checkI18nRoutesDir, formatI18nRoutes } from './checks/i18n-routes.ts';
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

const read = diskReader(distDir);
for (const page of HOME_PAGES) {
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
const { productionOrigin } = loadSiteConfig({ configDir: process.env.SITE_CONFIG_DIR ?? path.join(rootDir, 'config') });
const routes = checkI18nRoutesDir(distDir, productionOrigin);
console.log(formatI18nRoutes(routes, productionOrigin));
if (!routes.ok) failed = true;

console.log('');
console.log(failed ? 'Budgets: FAIL' : 'Budgets: PASS');
process.exit(failed ? 1 : 0);
