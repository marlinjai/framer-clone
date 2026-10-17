---
title: framer-clone deploy (app side)
type: documentation
summary: What the framer-clone image does at start, which host serves what, the two required commerce database roles, and every environment variable by name and meaning. The ordered production steps live in the infra repo's RUNBOOK.
tags: [deploy, coolify, hetzner, infisical, postgres, commerce]
---

# framer-clone deploy: the app side

This page describes what the repository ships and expects. The ordered steps that
create the infrastructure and run the first deploy (Terraform, the Postgres
database and its backup schedule, DNS, the Coolify application, the Infisical
values, the demo seed) live in the infra repository:
`infra/deployments/framer-clone/RUNBOOK.md`. Read that one to deploy; read this
one to know what the image does once it runs.

Stack: the shared Hetzner aarch64 server running Coolify, Postgres 16 in Coolify,
secrets in Infisical (`infisical.lumitra.co`, project `framer-clone`, env `prod`,
path `/`, never a `.env` file in production), DNS on Cloudflare through Terraform,
the image on GHCR (`ghcr.io/marlinjai/framer-clone`) built by GitHub Actions on an
arm64 runner.

## Hosts: editor and published sites

`src/middleware.ts` decides by the request's Host header:

| Host | Serves |
| --- | --- |
| `EDITOR_HOST` (production: `app.lumitra.co`) | the editor; `/projects` and the authoring API require an auth-brain session |
| `<label>.PUBLIC_SITE_BASE_HOST` (production: `<label>.sites.lumitra.co`) | the published site whose `SiteDomain.subdomain` is `<label>`, if that site is `published`; anything else is a 404 |

With `EDITOR_HOST` unset, every host counts as the editor host (local
development). Phase 1 of the RUNBOOK has explicit records for `app.lumitra.co` and
`demo.sites.lumitra.co`; phase 2 adds the `*.sites.lumitra.co` wildcard so every
publish gets a live address.

## What is committed

| File | Purpose |
| --- | --- |
| `Dockerfile` | Three stages: dependencies (frozen lockfile), builder (Prisma client, Next standalone build, and `pnpm build:boot`, which bundles the commerce start step into one file), runtime (node, the Infisical CLI, a Prisma CLI sidecar under `/opt/prisma`, the standalone server, `commerce-migrate.cjs`, `entrypoint.sh`, `boot.sh`). Built for `linux/arm64`. |
| `entrypoint.sh` | Logs in to Infisical with the machine identity, then runs `boot.sh` inside `infisical run`, so every secret below is in the environment. Fails at once if the three Coolify variables are missing. |
| `boot.sh` | The start sequence, see below. Runnable on its own for tests: `docker run --entrypoint ./boot.sh -e ...`. |
| `scripts/commerce-migrate.ts` | The commerce start step (source of `commerce-migrate.cjs`). Logic in `src/server/commerce/provisioning/deploy.ts`. |
| `prisma/sql/commerce-roles.sql` | Creates the two commerce roles with all their privileges. Applied once per database, as the database superuser, before the first start. No passwords. |
| `.github/workflows/ci.yml` | Typecheck, lint, guards, unit tests, Docker integration tests, build, and a real `docker build` of the production image, on every push and pull request. |
| `.github/workflows/deploy.yml` | Manual for now (`gh workflow run deploy --ref main`): builds and pushes the image, fires the Coolify webhook, then polls `https://app.lumitra.co/api/health/db` for up to 180 seconds. |
| `src/app/api/health/route.ts` | `GET /api/health`, liveness, `{ "ok": true }` without touching the database. Coolify's health check uses it. |
| `src/app/api/health/db/route.ts` | `GET /api/health/db`, readiness, runs `SELECT 1` through Prisma; a 503 names the error. The deploy workflow polls it. |

## The start sequence

Every container start runs, in order, and stops the start with a non-zero exit at
the first failure (Coolify then marks the deploy failed instead of serving a broken
app):

1. `prisma migrate deploy` on `DATABASE_URL`: sites, CMS and data-table tables.
2. `node commerce-migrate.cjs`, as the owner role on `COMMERCE_OWNER_DATABASE_URL`:
   the commerce public migrations (`ext` schema with pgcrypto and the UUIDv7
   default, the `public.tenant_groups` registry), then the tenant fleet migration
   (every company's `tg_<id>` schema gets the commerce migrations it lacks, and the
   append-only rules are re-asserted). It refuses to run when the owner URL is
   unset, still a placeholder, equal to the app URL, or authenticates as
   `commerce_app`. Both steps are idempotent and advisory-locked, so a rolling
   deploy with the old container still serving is safe, and a start with nothing
   new applies nothing.
3. `node server.js`, the Next standalone server on port 3000, bound to `0.0.0.0`.

What the start does NOT do: seed the demo. `scripts/seed-demo.ts` creates the demo
site and catalog and is not repeatable, so it is a one-off operator step (RUNBOOK,
step 10). A company's own `tg_<id>` schema is created when it creates its first
project in the editor (`src/app/api/projects/route.ts`, owner connection).

## Commerce database roles (required)

The shop module keeps each company's data in its own Postgres schema, `tg_<hex32>`,
and needs two roles besides the database's bootstrap user (which owns the Prisma
tables and is `DATABASE_URL`):

| Role | URL variable | What it may do |
| --- | --- | --- |
| `commerce_app` | `COMMERCE_APP_DATABASE_URL` | Low privilege, used by every storefront and editor request. Reads and writes rows inside the company schemas, but may not change or delete a placed order, its lines, a credit note or a stock movement (insert and read only). Creates nothing. Its default `search_path` is exactly `ext`, which the app checks on first commerce use and refuses to run otherwise. |
| `commerce_ddl` | `COMMERCE_OWNER_DATABASE_URL` | Owner, not a superuser. Owns `ext`, the registry and every company schema; runs the start step and the first-project provisioning. Holds `CREATE` on the database and on `public`, plus `CREATEROLE` with admin rights over `commerce_app` only, because provisioning resets `commerce_app`'s `search_path` (Postgres 16 allows that only with both). |

`prisma/sql/commerce-roles.sql` sets all of this up on Postgres 16 or later and is
safe to run again. It creates both roles without a login; the RUNBOOK's
`07-commerce-roles.sh` then gives each a login with a freshly generated password and
writes both URLs into Infisical without printing them. The integration test
`src/server/commerce/provisioning/__tests__/roles.itest.ts` proves the whole chain
on a fresh Postgres 16: the file twice, the start step, a company provision and a
placed order, with `commerce_ddl` as a non-superuser and the append-only rules
holding for `commerce_app`.

## Environment

Names and meaning only; values live in Infisical (`prod`, path `/`) and the RUNBOOK
says where each comes from.

**On the Coolify application** (the only plain variables there):

| Name | Meaning |
| --- | --- |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | Client id of the `framer-clone-app` machine identity |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | Its client secret (runtime only, never a build variable) |
| `INFISICAL_PROJECT_ID` | The `framer-clone` Infisical project |

**In Infisical, read at every start:**

| Name | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres URL of the database's bootstrap user: Prisma migrations, sites, CMS |
| `COMMERCE_APP_DATABASE_URL` | yes | Same database as `commerce_app`; every commerce read and write at runtime |
| `COMMERCE_OWNER_DATABASE_URL` | yes | Same database as `commerce_ddl`; the start step and first-project provisioning. The start fails without it. |
| `EDITOR_HOST` | yes | Host that serves the editor (`app.lumitra.co`); every other host is treated as a published site |
| `PUBLIC_SITE_BASE_HOST` | yes | Parent domain of published sites (`sites.lumitra.co`); the label in front of it selects the site |
| `AUTH_BRAIN_URL` | no | auth-brain base URL for session checks and the login redirect; defaults to `https://auth.lumitra.co` |
| `OPENFGA_API_URL`, `OPENFGA_STORE_ID` | yes | The authorization service behind per-workspace permission checks; without them every guarded write is denied |
| `ANTHROPIC_API_KEY` | for AI | Key for the editor's AI routes (`/api/ai/*`) |
| `AI_DEFAULT_MODEL` | no | `HAIKU` (default) or `SONNET` for routes that do not pin a model |
| `ANALYTICS_PUBLIC_INGESTION_KEY` | for analytics | The PUBLIC `ap_live_` ingestion key published sites send events with; a secret-shaped value is refused. A site's own `apiKeyRef` can name a different variable holding its key. |
| `ANALYTICS_INGESTION_ENDPOINT` | for analytics | Where published sites send events |
| `ANALYTICS_TRACKER_SCRIPT_URL` | for analytics | The tracker script published pages load; without it pages publish their config but emit nothing |
| `ANALYTICS_PROJECT_ID` | no | Analytics project id tagged onto events |

A published site only injects analytics when its `lumitraEnabled` flag is set.

**One-off, for the demo seed only** (never stored): `DEMO_BASE_HOST`,
`DEMO_PUBLISHED_SUBDOMAIN`, `DEMO_DRAFT_SUBDOMAIN`, `DEMO_TENANT_GROUP_ID` (all
optional with defaults; see `scripts/seed-demo.ts`).

## Operator commands (from a checkout, against a forwarded database)

| Command | Use |
| --- | --- |
| `pnpm db:public` | The commerce public migrations alone (the start does this already) |
| `pnpm db:migrate-tenants` | The tenant fleet migration alone (the start does this already) |
| `pnpm exec tsx --conditions=react-server scripts/seed-demo.ts` | The demo site and catalog, once, on a fresh database |
| `pnpm db:backfill-demo` | Copy a pre-tenant `commerce` schema into the demo company schema; only for a database that still has one (a fresh deploy does not) |
