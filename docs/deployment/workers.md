---
title: Deploy on Cloudflare Workers
description: Deploy Sink on Cloudflare Workers through Git integration.
---

# Deploy on Cloudflare Workers

## 1. Fork Sink and create resources

Create a [fork of the Sink repository](https://github.com/miantiao-me/Sink/fork). In the [Cloudflare dashboard](https://dash.cloudflare.com/), create:

| Binding name | Product                  | Required?   | Description               |
| ------------ | ------------------------ | ----------- | ------------------------- |
| `DB`         | D1 database              | Yes         | Stores links              |
| `KV`         | KV namespace             | Yes         | Speeds up redirects       |
| `ANALYTICS`  | Analytics Engine dataset | Recommended | Visit stats               |
| `R2`         | R2 bucket                | Yes         | Backups and social images |
| `AI`         | Workers AI               | Optional    | AI suggestions            |

Copy the **D1 database ID** and **KV namespace ID** from each resource’s detail page.

Analytics is optional — short links still work without it. Setup: [Analytics and Realtime](/features/analytics).

## 2. Connect Git (Workers Builds)

In the Cloudflare dashboard, create a Worker with **Git integration** and connect your fork:

- **Production branch:** `master`
- **Build command:** `pnpm build`
- **Deploy command:** `pnpm deploy:config && pnpm exec wrangler versions upload --config wrangler.deploy.jsonc`
- **Non-production branch deploy command:** `pnpm exec wrangler deploy --dry-run`

This marketing fork uploads reviewed versions without automatically moving production traffic. Non-production builds only validate the bundle locally.

Add these **build variables** (do **not** put production IDs into tracked `wrangler.jsonc` — set `DEPLOY_*` instead):

| Variable                         | Value                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `DEPLOY_WORKER_NAME`             | Required: the exact name of the existing production Worker; never use a temporary name     |
| `DEPLOY_D1_DATABASE_ID`          | Your D1 database ID (from the D1 detail page)                                              |
| `DEPLOY_KV_NAMESPACE_ID`         | Your KV namespace ID (from the KV detail page) → `kv_namespaces[].id`                      |
| `DEPLOY_KV_PREVIEW_NAMESPACE_ID` | Optional Wrangler preview KV → `preview_id` (defaults to `DEPLOY_KV_NAMESPACE_ID`)         |
| `DEPLOY_R2_BUCKET_NAME`          | Required backup bucket name → `bucket_name`; generation fails if it is omitted             |
| `DEPLOY_R2_PREVIEW_BUCKET_NAME`  | Optional Wrangler preview R2 → `preview_bucket_name` (defaults to `DEPLOY_R2_BUCKET_NAME`) |
| `DEPLOY_D1_DATABASE_NAME`        | Optional; default `sink`                                                                   |
| `DEPLOY_ANALYTICS_DATASET`       | Optional; default `sink`; the generator also sets runtime `NUXT_DATASET` to this value     |

`pnpm deploy:config` generates gitignored `wrangler.deploy.jsonc` from these values. It requires an explicit Worker name and storage IDs, so a manual upload cannot silently target a different Worker. When you connect the repo, Cloudflare creates a deploy token — no extra credential to paste.

The generated production config uses 302 redirects, forwards campaign queries, sets `Cache-Control: no-store`, keeps the KV read cache at 60 seconds, disables reverse proxying and bot visit analytics, and schedules automatic backups at 14:00 UTC daily. A backup bucket is required, so a missing build variable cannot silently remove R2. Requests run through the Worker before static assets; `workers.dev` and version preview URLs are disabled. Logs and Issues are enabled, traces are disabled, and request query strings are redacted from Cloudflare logs. Local `wrangler.jsonc` and Nuxt defaults stay unchanged.

Use the locked Wrangler version (4.134.0 or later) through `pnpm exec wrangler`; older versions cannot preserve Issues and query redaction. The generated config keeps existing runtime variables and secrets and declares the required secret names without copying their values from build variables.

## 3. App settings (login password and more)

Under **Settings → Variables and Secrets**, add:

| Variable             | Type             | Purpose                                                                                          |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `NUXT_SITE_TOKEN`    | Encrypted secret | Dashboard login password and API password (at least 8 characters, no whitespace, keep it stable) |
| `NUXT_CF_ACCOUNT_ID` | Variable         | Recommended for analytics                                                                        |
| `NUXT_CF_API_TOKEN`  | Encrypted secret | Required by this marketing fork for analytics                                                    |

Both `NUXT_SITE_TOKEN` and `NUXT_CF_API_TOKEN` must exist as encrypted runtime secrets before a version upload. The generated `secrets.required` guard prevents deployment when either secret is missing. Keep their values out of source control and production build variables.

Analytics details: [Analytics and Realtime](/features/analytics). Full list: [configuration](/configuration/).

Confirm bindings use the exact names `DB`, `KV`, `ANALYTICS`, `R2`, and `AI`.

## 4. Deploy and first use

Start a build from `master` and wait until it finishes.

Review the uploaded version before promoting it in the Cloudflare Worker dashboard. Apply any pending D1 schema migrations separately with `pnpm db:migrate:remote` before promotion; this command changes the configured production database. Verify existing short links, tracking queries, dashboard authentication, analytics, and a successful backup after promotion. Retain the previous version for rollback.

`pnpm deploy:worker` remains a direct deployment command that migrates D1 and immediately publishes; use the upload-only command above for the review and manual promotion workflow.

1. Open `/dashboard` and sign in with `NUXT_SITE_TOKEN`
2. Open **Dashboard → Links** once (one-time storage setup)
3. Create a link

::: tip First open of Links
Until storage setup finishes, creating links may fail with “storage not ready” (HTTP 423).
:::

Later upgrades: [Upgrading Sink](./upgrading).
