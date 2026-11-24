# Jujun Setiawan — portfolio

Static Astro site (Indonesian default, English mirror). Epic 0 folders
(`pipeline/`, `spike/`, `licenses/`) are kept as-is and are not part of the
site build or its tooling.

## Requirements

- Node `>=22.23.4` (see `.nvmrc`), npm 10
- Dependencies are pinned exactly (`.npmrc` has `save-exact=true`); install with `npm ci`.

## Pinned toolchain

| Package | Version |
| --- | --- |
| astro | 7.4.13 |
| vite | 8.3.8 |
| typescript | 6.0.3 |
| @astrojs/check | 0.9.12 |
| zod | 4.6.7 (import via `astro/zod` only) |
| vitest | 5.1.1 |
| @playwright/test | 1.65.1 |
| @types/node | 22.20.5 |
| wrangler | 4.165.0 |
| @cloudflare/workers-types | 5.20261118.1 |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server |
| `npm run build` | Static build into `dist/` for `SITE_ENV` (`development` by default; fails on invalid content or site config) |
| `npm run preview` | Serve `dist/` with `astro preview` (no `_headers`, no `/media`) |
| `npm run check` | `astro check` |
| `npm run typecheck` | `tsc --noEmit` for the site and `tsc --noEmit -p worker` for the Worker |
| `npm run test:unit` | Vitest (`tests/unit/`), including the `/media` Worker in Wrangler's local runtime |
| `npm run test:e2e` | Playwright against `wrangler dev --local` serving the built `dist/` (Chromium, WebKit, 390×844, 844×390); seeds local R2 first. With `DEPLOY_URL` set, runs only `tests/e2e/deployed/` against that URL |
| `npm run budgets` | First-load (≤ 204,800 gzip-9 bytes per language home), static-asset limits (≤ 20,000 files, no file > 25 MiB) and layer-import checks |
| `npm run ci` | Everything above in CI order |

First-time Playwright setup: `npx playwright install chromium webkit`.

## Layout

- `content/` — all facts as YAML content collections (`projects`, `awards`, `testimonials`), validated by `src/content/schemas.ts`
- `config/` — Zod-validated site config: `site.schema.ts`, `site.{production,preview,development}.json` picked by `SITE_ENV`, optional git-ignored `site.local.json` override
- `src/pages`, `src/layouts`, `src/components`, `src/styles`
- `src/integrations/site-env.ts` — writes env-dependent `robots.txt` and `X-Robots-Tag` into `dist/`
- `src/film/{core,systems,adapters}` — film layers; import rules are enforced by `scripts/budgets/layer-imports.ts`
- `scripts/` — build-time checks (`node scripts/check-budgets.ts`), local R2 seeding for e2e
- `tests/unit`, `tests/e2e` (`tests/e2e/deployed/` runs only with `DEPLOY_URL`)
- `worker/media.ts` — read-only `/media/*` R2 proxy; `wrangler.jsonc` — Workers config
- `public/_headers` — shared CSP
- `infra/README.md` — Cloudflare setup, tokens, analytics, rollback

CI (`.github/workflows/ci.yml`): the `check` job runs `npm ci` → `astro check` → `tsc --noEmit` → Vitest → `astro build` → budgets → Playwright. After it passes, `deploy-preview` (pull requests) or `deploy-production` (push to `main`) deploys to Cloudflare Workers — see `infra/README.md`.
