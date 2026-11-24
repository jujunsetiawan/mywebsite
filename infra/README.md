# Infrastructure — Cloudflare Workers + R2

The site is a static `dist/` served by **Workers static assets**. The only
server code is `worker/media.ts`, a read-only proxy that runs for `/media/*`
only and reads single keys from the private R2 bucket. Everything is defined in
the root `wrangler.jsonc`.

| Thing | Name |
| --- | --- |
| Worker | `jun-portfolio` |
| R2 bucket (binding `MEDIA`) | `jun-portfolio-media` |
| Production URL | `https://jun-portfolio.<your-subdomain>.workers.dev` |
| PR preview URL | `https://pr-<n>-jun-portfolio.<your-subdomain>.workers.dev` |

CI (`.github/workflows/ci.yml`):

- `check` — the quality gate (check, typecheck, Vitest, build, budgets, Playwright).
- `deploy-preview` — on same-repo pull requests, after `check`: `SITE_ENV=preview`
  build → `wrangler versions upload --preview-alias pr-<n>` → one PR comment with
  the URL (updated on every push) → deployed smoke tests.
- `deploy-production` — on push to `main`, after `check`: `SITE_ENV=production`
  build → `wrangler deploy` → deployed smoke tests.

Both deploy jobs **fail on purpose** with "Cloudflare secrets missing" until the
two GitHub secrets below exist. They are never skipped silently.

## Where tokens live

| Token | Lives in | Never in |
| --- | --- | --- |
| Cloudflare API token (deploy) | GitHub Actions secret `CLOUDFLARE_API_TOKEN` only | the repo, `config/`, your shell profile |
| Cloudflare account ID | GitHub Actions secret `CLOUDFLARE_ACCOUNT_ID` | — (not secret, but kept next to the token) |
| R2 write token (uploads) | your workstation environment only (a shell-session `CLOUDFLARE_API_TOKEN` scoped to R2, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for the S3 API) | GitHub, the repo, CI |

`config/site.*.json` holds **no secrets**: everything in it ends up in public
build output. The Web Analytics token is public by design (it is in the page HTML).

## One-time setup

Do these once, in this order, in the Cloudflare dashboard
(<https://dash.cloudflare.com>) and on GitHub.

### 1. Find your workers.dev subdomain

1. Dashboard → **Workers & Pages** → **Overview**.
2. On the right, **Subdomain** shows `<your-subdomain>.workers.dev`. If none is
   set yet, click **Change**/**Set up** and pick one (lowercase).
3. In `config/site.production.json`, `config/site.preview.json` and
   `config/site.development.json`, replace
   `https://jun-portfolio.your-subdomain.workers.dev` with
   `https://jun-portfolio.<your-subdomain>.workers.dev` (no trailing slash).
   The production deploy job prints a warning while they differ.

### 2. Enable R2 and create the bucket

1. Dashboard → **R2 Object Storage**. If asked, enable R2 (the free tier needs a
   payment method on file; usage within the free tier is not charged).
2. **Create bucket** → name `jun-portfolio-media`, location **Automatic**,
   storage class **Standard** → **Create bucket**.
3. Open the bucket → **Settings** → **Public access**:
   - **R2.dev subdomain** must say **Disabled** (it is off by default; if it
     shows **Allowed**, click **Disable**). Media is only reachable through the
     `/media` Worker.
   - Do not add a custom domain to the bucket.

### 3. Create a scoped API token for CI

1. Dashboard → top-right profile → **My Profile** → **API Tokens** →
   **Create Token** → **Edit Cloudflare Workers** template → **Use template**.
2. Permissions — keep only what deploys need:
   - Account → **Workers Scripts** → Edit
   - Account → **Workers R2 Storage** → Read (wrangler checks the binding)
   - Account → **Account Settings** → Read
   - User → **User Details** → Read
   - Remove the zone-level rows (Workers Routes) — there is no custom domain yet.
3. **Account Resources** → Include → *your account*. **Client IP filtering**: none
   (GitHub runners have changing IPs). **TTL**: optional; if set, note the date.
4. **Continue to summary** → **Create Token** → copy the token (shown once).
5. Copy your **Account ID** from Dashboard → **Workers & Pages** → **Overview**
   (right column) or any zone's overview page.

### 4. Add the GitHub secrets

1. GitHub → `jujunsetiawan/mywebsite` → **Settings** → **Secrets and variables**
   → **Actions** → **New repository secret**.
2. Add `CLOUDFLARE_API_TOKEN` = the token from step 3.
3. Add `CLOUDFLARE_ACCOUNT_ID` = the account ID.

Delete the token from your clipboard/notes afterwards; it only lives in GitHub.

### 5. Billing notification

1. Dashboard → **Manage Account** → **Notifications** → **Add**.
2. Pick **Usage Based Billing** (R2 / Workers) and set a low threshold (for
   example the first billable unit), delivery to your email → **Save**.
3. Optionally also add a **Billing** → budget alert if your account offers one.

### 6. First production deploy

`wrangler versions upload` (PR previews) needs the Worker to exist, so the first
deploy must be a production one: push to `main` after the secrets exist (or
re-run the failed `deploy-production` job). After that, PR previews work.

### 7. Upload the smoke object

The deployed smoke tests request `/media/smoke/ping.bin`, so the bucket must
contain it. Upload it from your workstation with **your** R2 write access
(never with the CI token):

```powershell
# Option A — wrangler with a workstation-only Cloudflare API token that has
# only Account → Workers R2 Storage → Edit (create it like step 3, separate
# from the CI token). Set it for this shell session only:
$env:CLOUDFLARE_API_TOKEN = '<workstation R2 token>'
$env:CLOUDFLARE_ACCOUNT_ID = '<account id>'
Set-Content -NoNewline -Path $env:TEMP\ping.bin -Value "ping`n"
npx wrangler r2 object put jun-portfolio-media/smoke/ping.bin --file $env:TEMP\ping.bin --content-type application/octet-stream --remote
```

```powershell
# Option B — R2 S3 API token (R2 → Manage R2 API Tokens → Object Read & Write,
# scoped to jun-portfolio-media) with the AWS CLI, kept in your workstation env only:
$env:AWS_ACCESS_KEY_ID = '<access key id>'
$env:AWS_SECRET_ACCESS_KEY = '<secret access key>'
aws s3 cp $env:TEMP\ping.bin s3://jun-portfolio-media/smoke/ping.bin `
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com --content-type application/octet-stream
```

Check it: `curl -I https://jun-portfolio.<your-subdomain>.workers.dev/media/smoke/ping.bin`
→ `200`, `cache-control: public, max-age=31536000, immutable`.

## Cloudflare Web Analytics (optional, production only)

`analyticsToken` is `null` everywhere today, so no beacon ships. To turn it on:

1. Dashboard → **Analytics & Logs** → **Web Analytics** → **Add a site**.
2. Hostname: `jun-portfolio.<your-subdomain>.workers.dev`.
3. Choose **Manual setup / JS snippet** (not automatic setup — there is no
   proxied zone). Cloudflare shows a snippet like
   `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "abc123…"}'></script>`.
4. Copy only the `token` value from `data-cf-beacon`.
5. Put it in `config/site.production.json`: `"analyticsToken": "abc123…"`.
   Leave preview and development at `null` (the build never emits a beacon
   outside production anyway).
6. Commit and push to `main`. The production page then contains exactly one
   beacon script; the CSP already allows `static.cloudflareinsights.com`
   (script) and `cloudflareinsights.com` (beacon POST). The beacon sets no cookies.

If Cloudflare rejects the `*.workers.dev` hostname: keep `analyticsToken: null`
and revisit with the real domain in Epic 10. Nothing else needs to change.

## Rollback

Production serves whatever `main` last deployed. To roll back:

- **Preferred:** revert the bad commit on `main` (`git revert <sha>`, push). CI
  runs the checks and redeploys the earlier code.
- **Fast, from your workstation:** `npx wrangler rollback` (pick an earlier
  version; optional `--message`), or Dashboard → Workers & Pages →
  `jun-portfolio` → **Deployments** → **Rollback** on an earlier version. The
  next push to `main` deploys again, so also fix `main`.
- Re-run an older `deploy-production` job: GitHub → Actions → the run for the
  good commit → **Re-run jobs**.

Rollbacks do not touch R2 objects; media keys are immutable by convention
(new content gets a new key).

## Local development

- `npm run test:e2e` seeds `smoke/ping.bin` into **local** R2
  (`.wrangler/state`, git-ignored) and serves `dist/` through
  `wrangler dev --local`. No Cloudflare account or network is needed.
- `SITE_ENV` selects `config/site.<env>.json` (default `development`). A
  git-ignored `config/site.local.json` is deep-merged on top for local tweaks.
