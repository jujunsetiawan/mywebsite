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
| yaml | 2.9.1 (DESIGN.md frontmatter parsing in tests) |
| @axe-core/playwright | 4.14.0 (accessibility scans in e2e) |

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
| `npm run budgets` | First-load (≤ 204,800 gzip-9 bytes per language home and per language for the first project page by `order`), static-asset limits (≤ 20,000 files, no file > 25 MiB), layer-import checks and the i18n route check (see Routing) |
| `npm run ci` | Everything above in CI order |

First-time Playwright setup: `npx playwright install chromium webkit`.

## Layout

- `content/` — all facts as YAML content collections (`projects`, `awards`, `testimonials`, `film-copy`, `privacy`), validated by `src/content/schemas.ts` (see Content model). `film-copy/<key>.yaml` holds keyed UI copy (`text: { id, en }`); components read it with `t(key, lang)` from `src/i18n/copy.ts` and contain no visible literals
- `docs/design/DESIGN.md` — the committed design spec and the source of truth for tokens. Future DESIGN.md edits must be made in (or copied to) this file; `tests/unit/design-tokens.test.ts` fails CI when `src/styles/tokens.css` drifts from its frontmatter
- `src/styles/` — `tokens.css` (DESIGN.md tokens as `--<group>-<name>` custom properties), `type.css` (`.t-<style>` utilities, weight 400 only), `base.css` (reset, letterbox bars, skip link, focus ring). System font stacks only, no web fonts
- `src/layouts/StaticLayout.astro` — office-styled static page frame: skip link, top letterbox bar (`src/components/StaticChrome.astro`; named slot `lang-switch`), `<main id="main">` on the panel, footer bar with the "Privasi"/"Privacy" link to `/<lang>/privasi/` (`aria-current="page"` on the privacy page). Hub links and the contact pill render only when `features.hubLinks` / `features.contact` are on
- `config/` — Zod-validated site config: `site.schema.ts`, `site.{production,preview,development}.json` picked by `SITE_ENV`, optional git-ignored `site.local.json` override
- `src/pages`, `src/layouts`, `src/components`
- `src/i18n/copy.ts` — `t(key, lang)` reads keyed copy from the `film-copy` collection; `COPY_KEYS` (`src/i18n/copy-keys.ts`) lists every key and must match `content/film-copy/*.yaml` (unit-tested). `src/i18n/routes.ts` — mirrored-route helpers (see Routing)
- `src/integrations/site-env.ts` — writes env-dependent `robots.txt` and `X-Robots-Tag` into `dist/`, and moves the per-language not-found pages to `<lang>/404.html` and `<lang>/proyek/404.html`
- `src/film/{core,systems,adapters}` — film layers; import rules are enforced by `scripts/budgets/layer-imports.ts`
- `scripts/` — build-time checks (`node scripts/check-budgets.ts`, `scripts/budgets/`, `scripts/checks/`), local R2 seeding for e2e
- `tests/unit`, `tests/e2e` (`tests/e2e/deployed/` runs only with `DEPLOY_URL`)
- `worker/media.ts` — read-only `/media/*` R2 proxy; `wrangler.jsonc` — Workers config
- `public/_headers` — shared CSP; `public/_redirects` — `/` → `/id/` and `/proyek/*` → `/id/proyek/*` 301s
- `infra/README.md` — Cloudflare setup, tokens, analytics, rollback

## Content model

Every fact on the site lives in `content/`. Schemas: `src/content/schemas.ts` (pure Zod; image fields come from a factory taking Astro's `image` helper). Cross-entry rules: `src/content/integrity.ts`, run on every build by the homes' data loader (`src/content/home.ts`). Any violation fails `astro build` naming the entry and the field.

- A **localized** field is `{ id, en }`, both non-empty. A **localized list** is `{ id: [...], en: [...] }`, both non-empty, same length, no empty items.
- **Dates** are ISO `YYYY-MM-DD` and must be **quoted** (`date: "2026-03-12"`): unquoted YAML dates are parsed loosely (`2026-13-40` silently becomes 2027-02-09), so the schema rejects them.
- `projects/<slug>.yaml` — `slug` (kebab-case, equal to the file name), `order` (positive, unique), `type` (`web | mobile | integrasi`), `year`, `name`, `oneLineOutcome`, `period: { start, end }` (`end` ≥ `start`), `role` (localized), `stack` (non-empty list), `sections` in display order: `outcomes`, `businessFlow`, `process` (localized lists), `techStack` (`{ name, purpose }`), `apiContract` (`{ method: GET|POST|PUT|PATCH|DELETE, path, summary }`), `samplePrd` (localized), `uiux` (`{ image, alt }`), `prototype` (`{ note, url? }`, https), `dummy`.
- `awards/<id>.yaml` — `order` (unique), `title`, `issuer`, `date`, `certificate` (image), `certificateAlt`, `verifyUrl` (https), `dummy`.
- `testimonials/<id>.yaml` — `order` (unique), `photo` (image), `name`, `company`, `quote`, `project?` (an existing project slug), `dummy`.
- `privacy/privacy.yaml` — exactly one entry (zero or several fail the build): `lastUpdated` (quoted date), `title`, `intro`, `contactEmail` (email; currently the placeholder `jun@example.com`, `dummy: true`, replaced in Epic 10), `sections` (non-empty; each `{ id: kebab-case, heading, paragraphs: localized list, policyUrl?: https }`, ids unique, one must be `contact` — the page renders the `mailto:` link there), `dummy`.
- Images live in each collection's `assets/` folder and are referenced relative to the entry (`./assets/x.svg`). Every placeholder image is self-made and listed in `licenses/assets.yaml` (`licence: original`, `kind: image`).

The language homes list projects (`#proyek`, name + one-line outcome, linking to `/<lang>/proyek/<slug>/`) and awards (`#penghargaan`, title, issuer, localized date, verify link in a new tab), both sorted by `order`.

**Swapping dummy for real content is a `content/` edit only:** edit or replace the YAML files (and their images in `assets/`), set `dummy: false`, list any new image in `licenses/assets.yaml`, and rebuild. No file in `src/` holds project, award or testimonial text. The current entries are all fictional (`dummy: true`).

## Routing (ID default, EN mirror)

| Route | Source | Response |
| --- | --- | --- |
| `/` | `public/_redirects` | 301 → `/id/` |
| `/proyek/<slug>` | `public/_redirects` (`/proyek/* /id/proyek/:splat 301`) | 301 → `/id/proyek/<slug>` |
| `/id/`, `/en/` | `src/pages/[lang]/index.astro` | Language home: project list (`#proyek`), awards (`#penghargaan`) |
| `/id/proyek/<slug>/`, `/en/proyek/<slug>/` | `src/pages/[lang]/proyek/[slug].astro` → `src/components/ProjectDetail.astro` | Static project page (one per language × project in `content/projects/`), no client JS |
| `/id/privasi/`, `/en/privasi/` | `src/pages/[lang]/privasi.astro` ← `content/privacy/privacy.yaml` | Privacy page: last-updated date, one section per processor (Cloudflare, Web3Forms, hCaptcha) with a link to its own policy, browser storage, controller and rights, contact `mailto:`; no client JS |
| `/id/proyek/<anything else>`, `/en/proyek/<anything else>` | `src/pages/[lang]/proyek/404.astro` → `dist/<lang>/proyek/404.html` | 404 "Arsip ini kosong" / "This archive is empty", `noindex` in every env |
| `/id/<anything else>`, `/en/<anything else>` | `src/pages/[lang]/404.astro` → `src/components/NotFound.astro` → `dist/<lang>/404.html` | 404 "Halaman tidak ditemukan" / "Page not found" with links to the language home and its project list (`/<lang>/#proyek`), `noindex` in every env |
| any other unknown path (outside `/id/`, `/en/`) | `src/pages/404.astro` → `src/components/NotFound.astro` → `dist/404.html` | 404, the Indonesian not-found page plus a visible "Read this site in English" link to `/en/`, `noindex` in every env |

- `public/_redirects` holds `/ /id/ 301` and `/proyek/* /id/proyek/:splat 301` — real HTTP 301s from Workers static assets (no meta-refresh, no Accept-Language detection, no Astro `i18n` config).
- Project pages: eyebrow, name, one-line outcome, caps meta (period, role, stack), the "Tonton filmnya dari awal" link to the language home, then the sections in fixed order (outcomes, business flow, process, tech stack, API contract, sample PRD, UI/UX, prototype; an empty list hides its section) and the testimonials that reference the project. The "Lihat di kantor 3D →" pill renders only with `features.hubLinks`. The sample PRD and API contract sit on printed paper `#D8D0C0` (DESIGN.md set-dressing tone; the one non-token colour, allowed by the style scan and contrast-tested).
- Not-found pages: Astro builds `src/pages/[lang]/404.astro` to `<lang>/404/index.html` and `src/pages/[lang]/proyek/404.astro` to `<lang>/proyek/404/index.html`; the `site-env` integration moves them to `<lang>/404.html` and `<lang>/proyek/404.html` after the build (failing the build, naming the file, if any is missing). Workers' `not_found_handling: "404-page"` serves the nearest `404.html` up the path with status 404, so an unknown project slug gets the empty archive, any other unknown path under `/<lang>/` gets that language's not-found page, and everything else gets the root `dist/404.html` (emitted flat by Astro). No Worker code, no Accept-Language detection, no client JS.
- **Sitemap (Story 1.9):** no sitemap exists yet; when it is added it must exclude every `404.html` (`dist/404.html`, `dist/<lang>/404.html`, `dist/<lang>/proyek/404.html`).
- Every page lives under `/id/<path>` and `/en/<path>` with the identical slug (`trailingSlash: 'always'`). The route path is the part after the language segment: `''` for the homes, e.g. `proyek/x/` later.
- Pages pass that route path to `StaticLayout` (`path=""` on the homes). `BaseLayout` then emits a self-canonical plus `id`/`en`/`x-default` (→ `/id/<path>`) alternates, always absolute on `productionOrigin` from site config — also in preview/development builds — and never with a query string. Pages without `path` (the not-found and empty-archive pages) emit neither and have no ID/EN switch.
- `StaticLayout` fills the bar's `lang-switch` slot with `src/components/LangSwitch.astro`: two plain links "ID"/"EN" (`hreflang`, `lang`, accessible name = the language's own name, `aria-current="true"` + underline on the current one). No JS; hash and query are not carried over.
- `src/i18n/routes.ts` holds the pure helpers (`localePath`, `mirrorPath`, `canonical`, `alternates`).
- `scripts/checks/i18n-routes.ts` (run by `npm run budgets`, or standalone: `node scripts/checks/i18n-routes.ts <distDir> <productionOrigin>`) fails, naming the page and the problem, when a `dist/{id,en}/**/index.html` lacks its mirror, its canonical is not its own URL, or any canonical/alternate is off the production origin, carries a query, or does not resolve to a file in `dist/`. `dist/{id,en}/**/404.html` files are not mirrored pages and are not counted, but each must have its other-language twin and a `noindex` robots meta; the root `dist/404.html` must exist and carry a `noindex` robots meta.

CI (`.github/workflows/ci.yml`): the `check` job runs `npm ci` → `astro check` → `tsc --noEmit` → Vitest → `astro build` → budgets → Playwright. After it passes, `deploy-preview` (pull requests) or `deploy-production` (push to `main`) deploys to Cloudflare Workers — see `infra/README.md`.
