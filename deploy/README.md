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

### Who can use the editor

The editor works per company (an auth-brain tenant) and only for companies that
hold the auth-brain app grant `sites` (in 2026-10: lumitra-core and
whiz-art-media). The grant is managed in auth-brain, not here: granting it to a
company lists that company in the editor's chooser on the user's next request,
revoking it removes it, and a signed-in user without any such company sees
"Lumitra Sites is not enabled for your companies" with a link to the account
portal. The editor remembers the chosen company in the host-only
`framer_company` cookie; the older per-workspace `framer_ws` cookie is migrated
once and then deleted. A company's sites live in its workspace (`main`, or the
oldest one should a company ever have several).

## What is committed

| File | Purpose |
| --- | --- |
| `Dockerfile` | Three stages: dependencies (frozen lockfile), builder (Prisma client, Next standalone build, and `pnpm build:boot`, which bundles the commerce start step into one file), runtime (node, the Infisical CLI, a Prisma CLI sidecar under `/opt/prisma`, the standalone server, `commerce-migrate.cjs`, `entrypoint.sh`, `boot.sh`). Built for `linux/arm64`. |
| `entrypoint.sh` | Logs in to Infisical with the machine identity, then runs `boot.sh` inside `infisical run`, so every secret below is in the environment. Fails at once if the three Coolify variables are missing. PID 1 is `tini` (Dockerfile `ENTRYPOINT`), which reaps zombies and passes `docker stop`'s SIGTERM to `infisical run`; infisical forwards it to node and waits for node to exit, and node finishes its in-flight requests first, so a stop drains instead of killing. |
| `boot.sh` | The start sequence, see below. Runnable on its own for tests: `docker run --entrypoint ./boot.sh -e ...`. |
| `scripts/commerce-migrate.ts` | The commerce start step (source of `commerce-migrate.cjs`). Logic in `src/server/commerce/provisioning/deploy.ts`. |
| `prisma/sql/commerce-roles.sql` | Creates the two commerce roles with all their privileges. Applied once per database, as the database superuser, before the first start, and again whenever the file changes (it pins both roles to the shape it describes, taking away anything an earlier version granted). No passwords. |
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
   unset, still a placeholder or equal to the app URL, and unless both the login
   (`session_user`) and the effective role (`current_user`) are `commerce_ddl`
   without superuser, `BYPASSRLS`, `CREATEROLE`, a grant of `commerce_app`, or
   membership in `pg_read_all_data`, `pg_write_all_data`,
   `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`.
   It also checks, read only, that `commerce_app`'s default `search_path` is
   exactly `ext`, and otherwise fails with the administrator's repair command
   (re-applying the roles file). Both steps are idempotent and run under one Postgres
   advisory lock, so two containers starting at once queue instead of racing, and
   a start with nothing new applies nothing. Time budgets:
   - Waiting for that lock: 30 seconds. A start that would wait longer fails with
     `CommerceLockTimeoutError` naming the lock, inside Coolify's health-check
     window rather than after it.
   - Lock waits inside the migrations (the DDL's table locks): 5 seconds. A
     migration whose table is busy with the old container's shop traffic gives up
     and fails the start (retry the deploy) instead of queueing an exclusive lock
     that would stall every shop request behind it.
   - Each migration statement: no limit by default, so a legitimate long migration
     (a backfill, an index build) is not killed. Set
     `COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS` (whole milliseconds, `0` for none) to
     bound it; a malformed value fails the start. A deploy that runs a long
     migration also needs Coolify's health-check start period raised for that
     deploy, or Coolify marks the new container unhealthy while it migrates.
3. `node server.js`, the Next standalone server on port 3000, bound to `0.0.0.0`.

What the start does NOT do: seed the demo. `scripts/seed-demo.ts` creates the demo
site and catalog and is not repeatable, so it is a one-off operator step (RUNBOOK,
step 10). A company's own `tg_<id>` schema is created when it creates its first
project in the editor (`src/app/api/projects/route.ts`, owner connection), before
the site row is written. Every later project of that company costs one read of
the registry and nothing else: no lock, no DDL. Only a company without a complete
schema runs the full provision, under a provisioning lock that serializes
companies provisioning at the same moment, with bounded waits of 10 seconds for
the lock and 30 seconds per statement. "Complete" means: the registry row is
`active`, the `tg_<id>` schema exists, and every commerce tenant migration is
recorded for it; a row still `provisioning`, a dropped schema or a missing progress
row all count as a miss and are provisioned again. If it fails, project creation
answers 500 with `commerce_not_configured` (owner URL unset),
`commerce_misconfigured` (`commerce_app`'s default `search_path` is not `ext`; the
repair command is in the server log, and a retry only helps after it ran) or
`commerce_provision_failed` (cause in the server log only) and writes nothing, so a
retry is clean. A company whose commerce an operator has suspended
(`tenant_groups.status = 'suspended'`) gets 403 `commerce_suspended` and nothing is
provisioned, because provisioning would quietly reactivate it; only an operator
lifts a suspension. The
registry slug is the company's display slug plus its tenant-group id, so two
companies with the same display slug never block each other.

## Commerce database roles (required)

The shop module keeps each company's data in its own Postgres schema, `tg_<hex32>`,
and needs two roles besides the database's bootstrap user (which owns the Prisma
tables and is `DATABASE_URL`):

| Role | URL variable | What it may do |
| --- | --- | --- |
| `commerce_app` | `COMMERCE_APP_DATABASE_URL` | Low privilege, used by every storefront and editor request. Reads and writes rows inside the company schemas, but may not change or delete a placed order, its lines, a credit note or a stock movement (insert and read only). Creates nothing. Its default `search_path` is exactly `ext`, which the app checks on first commerce use and refuses to run otherwise. |
| `commerce_ddl` | `COMMERCE_OWNER_DATABASE_URL` | Owner, not a superuser. Owns `ext`, the registry and every company schema; runs the start step and the first-project provisioning. Holds `CREATE` on the database and on `public`, and nothing over any role: no `CREATEROLE`, no grant of `commerce_app`. Provisioning only reads `commerce_app`'s `search_path` (`@marlinjai/tenant-db` 0.2, `appRoleBootstrap: 'verify'`), which the roles file sets as the superuser. A wrong value fails the start step, and a project create answers 500 `commerce_misconfigured` with nothing created and the repair command in the server log. |

**The owner URL lives in the running server, on purpose.** First-project
provisioning runs inline in the project-create request, so
`COMMERCE_OWNER_DATABASE_URL` is in the environment of the Next.js server process,
not only of the start step. That is acceptable because the owner role is bounded:

- It can: create schemas in this database, create and change tables in the
  schemas it owns (`ext`, the commerce registry tables in `public`, every
  `tg_<id>`), and grant on those objects.
- It cannot: read or change the Prisma tables (sites, CMS, data tables) owned by
  the database's bootstrap user, create, alter or drop any role (so it can neither
  mint a login role nor reset `commerce_app`'s password or `search_path`), become
  or inherit `commerce_app`, create temporary tables, create databases, read
  server files, bypass row security, or act as a superuser. The start step refuses
  any owner URL that is not exactly this role (see the start sequence above).

A leaked owner URL therefore exposes the shop data of every company and the shop
schema, not the rest of the database or the server. Moving provisioning off the
request path (a job seam) would let the owner URL leave the server process; that
is the deferral noted in the route.

**No superuser fallback.** The infra RUNBOOK allowed `COMMERCE_OWNER_DATABASE_URL`
to fall back to the database's bootstrap user if the non-superuser owner did not
work. It works (`roles.itest.ts`), and `deploy.ts` now refuses a superuser owner
URL at start, also one hidden behind a role switch in the URL (tested in
`concurrency.itest.ts`), so that fallback is no longer accepted and is dropped from
the RUNBOOK.

**A direct connection.** The owner URL must reach Postgres directly (as the
RUNBOOK's container-network URL does) or through a session-mode pooler, never a
transaction-mode PgBouncer: the start step and provisioning rely on session
advisory locks and session settings. The bounded waits are set with `set_config`
after connecting rather than as startup parameters, so a pooler that rejects
unknown startup parameters is not the failure mode.

`prisma/sql/commerce-roles.sql` sets all of this up on Postgres 16 or later and is
safe to run again. It also takes `CREATE` on `public` and `TEMPORARY` on the
database away from every role (`PUBLIC`), which matters for databases restored from
older dumps; nothing in the app needs either. It creates both roles without a login; the RUNBOOK's
`07-commerce-roles.sh` then gives each a login with a freshly generated password and
writes both URLs into Infisical without printing them. The integration test
`src/server/commerce/provisioning/__tests__/roles.itest.ts` proves the whole chain
on a fresh Postgres 16: the file twice, the start step, a company provisioned twice
and a placed order, with `commerce_ddl` as a non-superuser without `CREATEROLE` or
any grant over `commerce_app`, and the append-only rules holding for
`commerce_app`. It also proves that re-applying the file to a database shaped by the
earlier version takes both powers away, and that a wrong `commerce_app`
`search_path` stops the start step and a provision with the named error, creating
nothing.

**Upgrading a live database from the earlier roles file.** Until October 2026 the
file gave `commerce_ddl` `CREATEROLE` and an admin grant over `commerce_app`. The
start step now refuses an owner that still holds either, so re-apply the file as
the database superuser BEFORE deploying a build that contains this change, and
deploy right after it. The two belong back to back: an older build (tenant-db 0.1)
running against the re-applied database still tries `ALTER ROLE commerce_app` on
every first-project provision, so until the new build is live a company's first
project answers 500 (rolled back, nothing created; existing shops are unaffected).
Rolling back to such an older build needs the old grants restored first, as the
superuser: `ALTER ROLE commerce_ddl CREATEROLE;` and
`GRANT commerce_app TO commerce_ddl WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;`.

```sh
psql -v ON_ERROR_STOP=1 -U <bootstrap superuser> -d <database> -f prisma/sql/commerce-roles.sql
```

It leaves both logins and passwords alone. Check the result with
`SELECT rolcreaterole FROM pg_roles WHERE rolname = 'commerce_ddl'` (expect `f`)
and `SELECT count(*) FROM pg_auth_members WHERE roleid = 'commerce_app'::regrole
AND member = 'commerce_ddl'::regrole` (expect `0`). A deploy that runs first fails
its start step with exactly that instruction.

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
| `COMMERCE_OWNER_DATABASE_URL` | yes | Same database as `commerce_ddl` (never a superuser, refused at start), a direct connection; the start step and first-project provisioning, so it is in the server process environment. The start fails without it, and project creation answers 500 `commerce_not_configured`. |
| `COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS` | no | Bound on each commerce migration statement at container start, in whole milliseconds; unset or `0` means no limit (the default) |
| `EDITOR_HOST` | yes | Host that serves the editor (`app.lumitra.co`); every other host is treated as a published site. With `NODE_ENV=production` the container refuses to start when it is unset or blank (`boot.sh`, and again in `src/instrumentation.ts`) |
| `PUBLIC_SITE_BASE_HOST` | yes | Parent domain of published sites (`sites.lumitra.co`); the label in front of it selects the site |
| `AUTH_BRAIN_URL` | no | auth-brain base URL for session checks and the login redirect; defaults to `https://auth.lumitra.co` |
| `OPENFGA_API_URL`, `OPENFGA_STORE_ID` | yes | The authorization service behind the permission checks (run on the active company's workspace); without them every guarded route answers 503 `authz_unavailable` |
| `OPENFGA_API_TOKEN` | yes in production | OpenFGA's pre-shared key, sent as a Bearer token on every check. The suite's OpenFGA answers 401 without it, and every guarded route then answers 503 `authz_unavailable`; the start logs a warning when `OPENFGA_API_URL` is set and this is not |
| `OPENFGA_AUTHORIZATION_MODEL_ID` | no | Pins checks to one authorization model; unset uses the store's latest model |
| `ANTHROPIC_API_KEY` | for AI | Key for the editor's AI routes (`/api/ai/*`) |
| `AI_DEFAULT_MODEL` | no | `HAIKU` (default) or `SONNET` for routes that do not pin a model |
| `ANALYTICS_PUBLIC_INGESTION_KEY` | for analytics | The PUBLIC `ap_live_` ingestion key published sites send events with; a secret-shaped value is refused. A site's own `apiKeyRef` can name a different variable holding its key. |
| `ANALYTICS_INGESTION_ENDPOINT` | for analytics | Where published sites send events |
| `ANALYTICS_TRACKER_SCRIPT_URL` | for analytics | The tracker script published pages load; without it pages publish their config but emit nothing |
| `ANALYTICS_PROJECT_ID` | no | Analytics project id tagged onto events |
| `CUSTOM_DOMAIN_TARGET_HOST` | for custom domains | The DNS-only (never Cloudflare-proxied) name customers CNAME their domain to, e.g. `domains.lumitra.co`. Unset (or without an IPv4 below) means custom domains are off: the editor lists existing domains and adding or verifying answers 503 `custom_domains_not_configured` |
| `CUSTOM_DOMAIN_TARGET_IPV4` | for custom domains | Comma-separated public IPv4 address(es) of the shared server, shown as the A record for a root domain and the only addresses a domain may resolve to. Also the address the certificate probe connects to |
| `CUSTOM_DOMAIN_TARGET_IPV6` | no | Comma-separated IPv6 address(es) Traefik answers on. Unset means "no AAAA record allowed": a customer AAAA record pointing elsewhere is reported, because Let's Encrypt would try it first and fail |
| `CUSTOM_DOMAIN_DNS_SERVERS` | no, recommended | Resolver IPs for the ownership check, e.g. `1.1.1.1,8.8.8.8`, so a TXT record a customer just added is not hidden by the container resolver's negative cache |
| `CUSTOM_DOMAIN_TLS_PROBE` | no | `off` skips the certificate probe that moves a domain from verified to active (it then stays verified) |
| `CUSTOM_DOMAIN_SYNC_TOKEN` | for custom domains | Bearer token (at least 32 characters, generated) the host timer presents to `GET /api/internal/custom-domains/hostnames` and `POST /api/internal/custom-domains/recheck`. Unset means both answer 503, the proxy keeps its last file and live domains are not re-checked |

A published site only injects analytics when its `lumitraEnabled` flag is set.

**One-off, for the demo seed only** (never stored): `DEMO_BASE_HOST`,
`DEMO_PUBLISHED_SUBDOMAIN`, `DEMO_DRAFT_SUBDOMAIN`, `DEMO_TENANT_GROUP_ID` (all
optional with defaults; see `scripts/seed-demo.ts`).

## Custom domains: what the server side needs

Published sites can answer on a customer's own domain (plan
`docs/plans/2026-06-25-framer-custom-domains.md`). The app verifies ownership
over DNS and serves verified hostnames; certificates come from Traefik on the
shared server. The app never writes proxy configuration: the host runs
`deploy/custom-domains/sync-traefik.sh` every minute (systemd units next to it),
which fetches the verified hostnames from the token-guarded feed, re-validates
each line, and writes `framer-clone-custom-domains.yml` into Traefik's watched
file-provider directory (`/data/coolify/proxy/dynamic/`) with one http redirect
router and one https router (`certResolver: letsencrypt`, priority 1) per
hostname. The script refuses the feed (and keeps the current file, exit 1) when
the answer is not text/plain, does not match its `x-content-sha256` /
`x-hostname-count` headers, or contains one invalid or blocked line.

**Drop protection.** A drop is held when the feed has more than 5 fewer routes
than the high-water mark (the largest count written in the last 24 hours) AND
fewer than half of it. While held, removals wait but additions still go live
(the file gets the union of current and new routes) and the run exits 3, which
the journal shows. If the drop is genuine (many domains really disconnected),
confirm it once on the server:

    touch /var/lib/framer-clone-custom-domains/force-once

The next run (within a minute) applies the drop, deletes the flag and resets the
high-water mark. The flag lives in the unit's state directory, not under /etc,
because the unit keeps /etc read-only.

**Re-check.** A separate unit and timer (`framer-clone-custom-domains-recheck`,
every 10 minutes) calls `POST /api/internal/custom-domains/recheck`, which
re-checks live domains that are due (routing only, every six hours, three
definitive failures in a row release a domain). If more than half of a pass
fails at once (at least 5 checked), nothing is counted and the call answers 503
`recheck_circuit_open`, which fails the unit: check the `CUSTOM_DOMAIN_TARGET_*`
values. The ordered operator steps live in the infra RUNBOOK.

## Operator commands (from a checkout, against a forwarded database)

| Command | Use |
| --- | --- |
| `pnpm db:public` | The commerce public migrations alone (the start does this already) |
| `pnpm db:migrate-tenants` | The tenant fleet migration alone (the start does this already) |
| `pnpm exec tsx --conditions=react-server scripts/seed-demo.ts` | The demo site and catalog, once, on a fresh database |
| `pnpm db:backfill-demo` | Copy a pre-tenant `commerce` schema into the demo company schema; only for a database that still has one (a fresh deploy does not) |
