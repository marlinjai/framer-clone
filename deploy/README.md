---
title: framer-clone deploy runbook (app.lumitra.co)
type: documentation
summary: What is committed for the hosted demo deploy, and the exact (irreversible) provisioning steps Marlin runs by hand to reach go-live.
tags: [deploy, coolify, hetzner, infisical, terraform, app.lumitra.co]
---

# framer-clone deploy runbook: app.lumitra.co

The hosted demo serves ONE published site at `app.lumitra.co`. This document is
the single source of truth for the deploy. The application-side config is
committed in this repo; the infrastructure provisioning (Coolify app, Postgres,
DNS, TLS, Infisical project + secrets) is irreversible prod work that must be run
by hand. Those steps are the **escalation checklist** at the bottom.

Stack (from the `scaffold-project` skill): Hetzner aarch64 shared Coolify server,
Coolify at `coolify.lumitra.co`, Infisical at `infisical.lumitra.co` (single
source of truth for secrets, no `.env` files in prod), DNS on Cloudflare via
Terraform, image on GHCR built by GitHub Actions on `ubuntu-24.04-arm`.

## What is already committed (the app side)

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build: deps -> Next standalone build -> minimal runtime with the Infisical CLI + a Prisma 6 CLI sidecar (`/opt/prisma` + `NODE_PATH`). Builds for `linux/arm64`. `HOSTNAME=0.0.0.0` for Coolify's loopback healthcheck. |
| `entrypoint.sh` | Infisical Universal-Auth login -> `infisical run` (env=prod) -> `prisma migrate deploy` -> `node server.js`. Fails loud on missing wiring. |
| `.dockerignore` | Keeps node_modules / .next / .env* / tests / docs / git out of the image. |
| `.github/workflows/deploy.yml` | Build + push to GHCR (ARM), then delegate to `marlinjai/actions-shared/.github/workflows/coolify-deploy-verify.yml@v1` (creates a GitHub Deployment, fires the Coolify webhook, retry-curls the health URL, marks success/failure). |
| `next.config.ts` | `output: 'standalone'` for the Docker runtime. |
| `src/app/api/health/route.ts` | `GET /api/health` -> `{ ok: true }`, DB-independent liveness probe (what deploy-verify curls). The DB readiness probe stays at `/api/health/db`. |
| `ci.yml` (existing) | The verify gate: typecheck / lint / unit + Dockerized integration tests / build, on every push + PR to main. |

The first real `docker build` happens in the deploy workflow on the ARM runner /
the first Coolify deploy. It cannot be exercised locally without Docker; validate
it on the first deploy and consult the skill's troubleshooting table if the
container boots unhealthy.

## CRITICAL: host routing so app.lumitra.co serves the STOREFRONT

`src/middleware.ts` routes by Host: the **editor** is served on `EDITOR_HOST` (and
on localhost); **every other host** has its `/` rewritten to the published
storefront home. So for `app.lumitra.co` to serve the published site (not the
editor):

1. `EDITOR_HOST` MUST be set to a host that is NOT `app.lumitra.co`. If
   `EDITOR_HOST` is left UNSET, the middleware treats every host as the editor
   host and `app.lumitra.co/` would render the editor. Set it to the editor's own
   host (e.g. `editor.lumitra.co`), even if that host is not exposed for the demo.
2. `PUBLIC_SITE_BASE_HOST` MUST be `lumitra.co`, so `app.lumitra.co` resolves to
   subdomain `app` (see `parseSubdomain`).
3. A `SiteDomain` row with `subdomain = 'app'` must point at the published demo
   site, and that site's `status` must be `published`. The storefront 404s
   otherwise.

(The `EDITOR_HOST` example in `.env.example` predates this decision; the brief
locked `app.lumitra.co` as the storefront, so `EDITOR_HOST` is a DIFFERENT host.)

## Runtime env (Infisical, env=prod, path `/`)

These are fetched at boot by `entrypoint.sh` via `infisical run`. Set them in the
framer-clone Infisical project (created by Terraform below). Use obvious
placeholders where the real value is not yet available.

| Key | Value for the demo | Notes |
| --- | --- | --- |
| `DATABASE_URL` | the Coolify Postgres INTERNAL url | from Terraform output / Coolify DB |
| `EDITOR_HOST` | `editor.lumitra.co` | NOT `app.lumitra.co` (see host routing above) |
| `PUBLIC_SITE_BASE_HOST` | `lumitra.co` | so `app.lumitra.co` -> subdomain `app` |
| `AUTH_BRAIN_URL` | `https://auth.lumitra.co` | default; only the editor surface is gated |
| `ANTHROPIC_API_KEY` | real key | server-side AI surface (`/api/ai/*`) |
| `OPENFGA_API_URL` / `OPENFGA_STORE_ID` | real | per-resource `can()` checks; without them guarded writes fail closed |
| `ANALYTICS_PUBLIC_INGESTION_KEY` | `ap_live_...` (PUBLIC) | BLOCKED on the auth-brain machine-api key mint (see below). Placeholder until then. |
| `ANALYTICS_INGESTION_ENDPOINT` | `https://ingest.lumitra.co` | where the tracker POSTs events |
| `ANALYTICS_TRACKER_SCRIPT_URL` | the tracker loader URL | the `<script async src>` that actually emits; without it the page only publishes config |
| `ANALYTICS_PROJECT_ID` | the analytics project id | optional, tags events |

The published site also needs its `lumitraEnabled` flag set (per-site, in the DB)
for the analytics snippet to inject at all.

## Escalation checklist (Marlin runs these; irreversible prod ops)

Run in order. Steps 1-9 follow the `scaffold-project` skill (read it for the
canonical Terraform HCL and the known boot-failure table).

1. **Terraform: Coolify project + Postgres + DNS + Infisical project.** Create
   `infra/deployments/framer-clone/` (versions.tf, variables.tf, main.tf,
   deploy.sh per the skill). `main.tf` on the shared server:
   `coolify_project` -> `coolify_postgresql_database` -> cloudflare dns-record
   module (`app.lumitra.co` -> shared server IP `157.90.119.98`, `proxied=false`
   so Coolify does Let's Encrypt TLS); plus `infisical_project`
   (`should_create_default_envs = true`). Also add the Coolify-app machine
   identity to `infra/deployments/infisical-config/<org>.tf` (the `framer_clone_app`
   identity + universal-auth client secret, per the skill). `./deploy.sh plan`
   then `./deploy.sh apply`. Capture: `project_uuid`, `db_internal_url`, the
   Infisical `project_id`, and the MI `client_id` / `client_secret`.

2. **DNS record.** `app.lumitra.co` A/AAAA -> `157.90.119.98` (the shared Coolify
   server), `proxied=false`. (Created by the Terraform dns-record module in step 1.)

3. **Infisical secrets (env=prod, path `/`).** With `<PROJECT_ID>` from step 1,
   set every key from the Runtime env table. Placeholders are fine where the real
   value is pending (analytics key especially):

   ```sh
   infisical secrets set DATABASE_URL=<coolify-internal-db-url> EDITOR_HOST=editor.lumitra.co \
     PUBLIC_SITE_BASE_HOST=lumitra.co AUTH_BRAIN_URL=https://auth.lumitra.co \
     ANALYTICS_INGESTION_ENDPOINT=https://ingest.lumitra.co \
     ANALYTICS_TRACKER_SCRIPT_URL=https://cdn.lumitra.co/tracker.js \
     ANALYTICS_PUBLIC_INGESTION_KEY=ap_live_PLACEHOLDER_REPLACE_ME \
     --env=prod --projectId=<PROJECT_ID> --path=/ --domain=https://infisical.lumitra.co
   ```
   Then set the real `ANTHROPIC_API_KEY`, `OPENFGA_API_URL`, `OPENFGA_STORE_ID`
   (real values via `! infisical secrets set ...` in your terminal, never pasted
   into Claude). The analytics key stays a placeholder until step 8.

4. **Coolify app (MCP).** `application action=create_public` on the shared server
   (`server_uuid` for `157.90.119.98`), `project_uuid` from step 1,
   `build_pack=dockerfile` initially, `ports_exposes=3000`. Then `action=update`
   `fqdn=https://app.lumitra.co` and `health_check_host=127.0.0.1` (NOT
   `localhost`). Ensure rolling/zero-downtime deploy is on.

5. **Coolify env (the ONLY plain env on the app).** `env_vars action=bulk_update`:
   `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`
   (from step 1's MI), and `INFISICAL_PROJECT_ID=<PROJECT_ID>`. Everything else is
   fetched at boot by `entrypoint.sh`.

6. **GitHub deploy-trigger secrets.** Capture the Coolify deploy webhook
   (`https://coolify.lumitra.co/api/v1/deploy?uuid=<app-uuid>&force=false`), then:
   ```sh
   gh secret set COOLIFY_WEBHOOK -R marlinjai/framer-clone   # the webhook url
   gh secret set COOLIFY_TOKEN   -R marlinjai/framer-clone   # a read-capable Coolify API token
   gh secret list -R marlinjai/framer-clone                  # confirm BOTH exist BEFORE pushing
   ```
   (GH Actions captures secrets at queue time; if these are missing the
   deploy-verify job calls `curl ""` and fails.)

7. **Switch the Coolify build pack** from "dockerfile" to "docker image",
   image `ghcr.io/marlinjai/framer-clone:latest`. `deploy.yml` ships as
   `workflow_dispatch`-only (so it does not auto-run before the infra exists);
   trigger the first deploy by hand: `gh workflow run deploy --ref main`. Watch
   the Deployments tab go green within ~90s; if the container is unhealthy, pull
   logs via the Coolify MCP and consult the skill's boot-failure table. For
   continuous deploy, add the `push: [main]` trigger back to `deploy.yml` (the
   commented block at the top of the file) once the first manual deploy is green.

8. **Analytics key (BLOCKED dependency).** The real PUBLIC `ap_live_` ingestion
   key is minted via the auth-brain machine API, which is NOT yet merged/deployed
   (a separate teammate owns it). Once it exists, mint the key and replace the
   `ANALYTICS_PUBLIC_INGESTION_KEY` placeholder (step 3) with the real value via
   `! infisical secrets set ...`. The wiring (env var -> snippet -> loader) is
   already done in the app; only the value is pending. A secret-shaped key is
   refused by the build backstop, so only the PUBLIC key works.

9. **Seed + publish the demo site.** Create the demo site, add a `SiteDomain` row
   with `subdomain = 'app'`, set the site `status = 'published'` and
   `lumitraEnabled = true`, and publish at least the home page (empty/`index`/`home`
   slug). Verify `https://app.lumitra.co/` serves the storefront home (not the
   editor), the fake-pay checkout runs end to end, and (once step 8 lands) the
   analytics snippet + loader appear in the page source.

### Optional production hardening

- **Commerce least-privilege roles.** `prisma migrate deploy` applies the schema +
  CHECK constraints, but the append-only REVOKEs on `commerce.stock_movement` /
  `order` / `order_line_item` are conditional on a `commerce_app` role existing.
  To enforce them, apply `prisma/sql/commerce-roles.sql` to the prod DB
  out-of-band and point the app's `DATABASE_URL` at the `commerce_app` role rather
  than the DB owner. Without this the constraints still hold; only the role-level
  append-only guarantee is absent.
- **Local dev wiring.** Add a committed `.infisical-org` marker + an `.infisical.json`
  (workspaceId) and switch `package.json`'s `dev` script to the MI-token
  `infisical run` form (skill Step 8), and grant the developer MI `viewer` on the
  new project. Not needed for the demo deploy.
