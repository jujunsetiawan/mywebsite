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

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server |
| `npm run build` | Static build into `dist/` (fails on invalid content) |
| `npm run preview` | Serve `dist/` |
| `npm run check` | `astro check` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Vitest (`tests/unit/`) |
| `npm run test:e2e` | Playwright against `astro preview` of the built `dist/` (Chromium, WebKit, 390×844, 844×390) |
| `npm run budgets` | First-load (≤ 204,800 gzip-9 bytes per language home), static-asset limits (≤ 20,000 files, no file > 25 MiB) and layer-import checks |
| `npm run ci` | Everything above in CI order |

First-time Playwright setup: `npx playwright install chromium webkit`.

## Layout

- `content/` — all facts as YAML content collections (`projects`, `awards`, `testimonials`), validated by `src/content/schemas.ts`
- `config/` — site config (Story 1.2)
- `src/pages`, `src/layouts`, `src/components`, `src/styles`
- `src/film/{core,systems,adapters}` — film layers; import rules are enforced by `scripts/budgets/layer-imports.ts`
- `scripts/` — build-time checks (`node scripts/check-budgets.ts`)
- `tests/unit`, `tests/e2e`
- `worker/`, `public/`, `infra/` — deploy pieces (Story 1.2)

CI (`.github/workflows/ci.yml`) runs: `npm ci` → `astro check` → `tsc --noEmit` → Vitest → `astro build` → budgets → Playwright.
