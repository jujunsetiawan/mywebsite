import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;
// Set by the CI deploy jobs: run only the deployed smoke specs against that URL.
const DEPLOY_URL = process.env.DEPLOY_URL?.replace(/\/+$/, '') || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: DEPLOY_URL ? 'deployed/**/*.spec.ts' : '**/*.spec.ts',
  testIgnore: ['**/spike/**', '**/pipeline/**', ...(DEPLOY_URL ? [] : ['**/deployed/**'])],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: DEPLOY_URL ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  // Local: serves the already-built dist/ (run `npm run build` first) through
  // `wrangler dev` in local mode, so `_headers`, `not_found_handling` and the
  // `/media` Worker behave as deployed. The smoke object is seeded into local R2 first.
  webServer: DEPLOY_URL
    ? undefined
    : {
        command: `node scripts/seed-local-r2.ts && npx wrangler dev --local --ip 127.0.0.1 --port ${PORT} --show-interactive-dev-session=false --log-level warn`,
        url: `http://127.0.0.1:${PORT}/id/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { WRANGLER_SEND_METRICS: 'false' },
      },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'mobile-portrait',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'mobile-landscape',
      use: { ...devices['Desktop Chrome'], viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
    },
  ],
});
