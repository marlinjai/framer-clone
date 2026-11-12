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
development). `localhost` and `127.0.0.1` count as the editor host only outside
production: in production they are published hosts, so a server action that Next
forwards between workers (that hop arrives as `Host: localhost:<port>`) gets a 404;
keep each server action imported by the pages that call it. Phase 1 of the RUNBOOK has explicit records for `app.lumitra.co` and
`demo.sites.lumitra.co`; phase 2 adds the `*.sites.lumitra.co` wildcard so every
publish gets a live address.

**No cache may sit in front of site hosts without a purge.** Every one of these
records, and the custom-domain target, is DNS only (`proxied = false` in the infra
repository's `deployments/framer-clone/main.tf`), and custom domains must point at
the origin's address. Uploaded site images (`/site-images/*`, the favicon and
sharing images) are served `public, max-age=31536000, immutable`, and deleting an
unused one is correct only because nothing between the visitor and this app keeps a
copy. Turning on Cloudflare proxying, or any other edge cache, for `*.sites.lumitra.co`,
`demo.sites.lumitra.co` or customer domains therefore needs a purge of
`/site-images/<file>` on every host of the site whenever an image is deleted
(`DELETE /api/projects/<id>/images/<sha256>`), before or together with that change.

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
companies provisioning at the same moment, with bounded waits: as long as that
queue moves, at most about 40 seconds, but 10 seconds behind one provision that
keeps the lock, and 30 seconds per statement; a request that waits too long
answers 503 `commerce_busy` (retry in a moment). "Complete" means: the registry row is
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
| `commerce_app` | `COMMERCE_APP_DATABASE_URL` | Low privilege, used by every storefront and editor request. Reads and writes rows inside the company schemas, but may not change or delete a placed order, its lines, a credit note or a stock movement (insert and read only). Creates nothing. In `public` it reads only the ids of `tenant_groups`, for the job worker. Its default `search_path` is exactly `ext`, which the app checks on first commerce use and refuses to run otherwise. |
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
| `SITES_ERASURE_WEBHOOK_SECRET` | for erasure | The secret auth-brain signs its `tenant.erased` webhook with (HMAC-SHA256 over the raw body), shared with auth-brain's registration of `POST /api/internal/erasure`. Unset means that endpoint answers 503 and deletes nothing, so auth-brain keeps retrying. After setting it in Infisical, restart or redeploy the app before registering the webhook; the running process keeps its old environment until then. The erasure runs on `COMMERCE_OWNER_DATABASE_URL` (plan `docs/plans/2026-11-05-company-erasure-consumer.md`) |
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
| `ANALYTICS_TRACKER_SCRIPT_URL` | for analytics | The Lumitra Analytics tracker module, `https://analytics.lumitra.co/sdk/tracker.js` (served with `Access-Control-Allow-Origin: *`, which a cross-origin module import needs). Published pages never carry it in their HTML: the consent banner imports it with `import()` only after the visitor accepts, calls its `init({ projectId, apiKey, endpoint })` with the site's public config and then `enableTracking()` for clicks and scroll; declining loads nothing. It must be the ES module build that exports `init` (a classic script would not run). Until 2026-10-24 production pointed at `cdn.lumitra.co`, which does not resolve |
| `ANALYTICS_PROJECT_ID` | no | Analytics project id tagged onto events |
| `CUSTOM_DOMAIN_TARGET_HOST` | for custom domains | The DNS-only (never Cloudflare-proxied) name customers CNAME their domain to, e.g. `domains.lumitra.co`. Unset (or without an IPv4 below) means custom domains are off: the editor lists existing domains and adding or verifying answers 503 `custom_domains_not_configured` |
| `CUSTOM_DOMAIN_TARGET_IPV4` | for custom domains | Comma-separated public IPv4 address(es) of the shared server, shown as the A record for a root domain and the only addresses a domain may resolve to. Also the address the certificate probe connects to |
| `CUSTOM_DOMAIN_TARGET_IPV6` | no | Comma-separated IPv6 address(es) Traefik answers on. Unset means "no AAAA record allowed": a customer AAAA record pointing elsewhere is reported, because Let's Encrypt would try it first and fail |
| `CUSTOM_DOMAIN_DNS_SERVERS` | no, recommended | Resolver IPs for the ownership check, e.g. `1.1.1.1,8.8.8.8`, so a TXT record a customer just added is not hidden by the container resolver's negative cache |
| `CUSTOM_DOMAIN_TLS_PROBE` | no | `off` skips the certificate probe that moves a domain from verified to active (it then stays verified) |
| `CUSTOM_DOMAIN_SYNC_TOKEN` | for custom domains | Bearer token (at least 32 characters, generated) the host timers present to `GET /api/internal/custom-domains/hostnames`, `POST /api/internal/custom-domains/recheck`, `POST /api/internal/commerce/expired-payments` and `POST /api/internal/commerce/jobs/run`. Unset means all four answer 503, the proxy keeps its last file, live domains are not re-checked, the expired payment sweep is off (each order's expiry job still closes it) and the job watchdog is off (the poller still runs) |

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

## Abandoned checkouts: the expired payment sweep

A pending payment holds its stock for 30 minutes. Each order that opens a payment
writes a `payment_expiry` job in `commerce_job`, due when the hold ends, and the
poller (see below) closes the payment then, so that job is the first place to look
when a hold did not end: a `dead` one counts in the watchdog's `deadUnacknowledged`
and means stock held past its window. A new order also closes its own company's
expired payments first, and a payment closes its own order if that ran out, never
another order. Orders from before this job get theirs from the worker's backfill.

Beside the job, until its removal in slice B3R, a host timer closes expired payments
across all companies:
`deploy/commerce/framer-clone-commerce-expired-payments.timer`, every 5 minutes,
calls `POST /api/internal/commerce/expired-payments`. With nothing due a call
costs one indexed query per tenant group. It runs on `coolify-shared-host` and
reuses the custom-domain token, so nothing new is needed in Infisical.

To install, as root on `coolify-shared-host`, from `deploy/commerce/` at
`origin/main` once the route is deployed (the header file
`/etc/framer-clone/custom-domains.header` is already there):

    install -m 0644 framer-clone-commerce-expired-payments.service framer-clone-commerce-expired-payments.timer /etc/systemd/system/
    systemctl daemon-reload
    systemd-analyze verify /etc/systemd/system/framer-clone-commerce-expired-payments.service
    systemctl start framer-clone-commerce-expired-payments.service   # {"tenantGroups":...,"closed":...,"failed":0,...}
    systemctl enable --now framer-clone-commerce-expired-payments.timer

The answer lands in the journal (`journalctl -u
framer-clone-commerce-expired-payments.service -n 5 -o cat`). A failing unit means
503 `custom_domains_not_configured` or 401 (the token), or 500
`expired_payment_sweep_failed`: some payments or a whole tenant group could not be
closed, the rest were, the app log names them (`[payments]`) and the next run
tries again.

## The shop's job engine: poller and watchdog

Durable shop work (`commerce_job` in every company schema) is run by a poller in
each server process: `startCommerceWorker` (`src/server/commerce/jobs/runtime.ts`),
started at boot, a pass over every row of `public.tenant_groups` every 30 seconds.
It needs nothing on the host, is safe with any number of app copies (the claim
hands each job to one of them), and never fails a start. With nothing due a pass
costs one registry read and one indexed query per group, plus an hourly cleanup. On SIGTERM it stops
claiming; a handler still running is cut off with the process, and its job becomes
due again when its 10 minute lease ends.

The worker reads the registry as `commerce_app`, which holds only `SELECT (id)` on
`public.tenant_groups`. The start step grants that on every start, so a deploy
needs no manual step. If the registry is not owned by `commerce_ddl` the grant only
warns: the app starts and the pass and the route below report `permission denied`.

The host timer is the watchdog, not the worker:
`deploy/commerce/framer-clone-commerce-jobs.timer`, every 5 minutes, calls
`POST /api/internal/commerce/jobs/run`, which runs one pass and answers
`{ tenantGroups, skipped, ran, failed, deadUnacknowledged, findingsOpen, oldestDueSeconds }`.
It answers 500 `commerce_jobs_unhealthy` with that report under `error.report` only
when a pass failed or the oldest due job is over 10 minutes late. A dead job is a
count, so one dead row cannot keep the monitor red. `findingsOpen` stays 0 until
Stripe reconciliation exists. It uses the same token and header file as the expired
payment sweep, so nothing new is needed in Infisical.

To install, as root on `coolify-shared-host`, from `deploy/commerce/` at
`origin/main` once the route is deployed:

    install -m 0644 framer-clone-commerce-jobs.service framer-clone-commerce-jobs.timer /etc/systemd/system/
    systemctl daemon-reload
    systemd-analyze verify /etc/systemd/system/framer-clone-commerce-jobs.service
    systemctl start framer-clone-commerce-jobs.service   # {"tenantGroups":...,"ran":...,"failed":0,...}
    systemctl enable --now framer-clone-commerce-jobs.timer

The answer lands in the journal (`journalctl -u framer-clone-commerce-jobs.service
-n 5 -o cat`). A failing unit means 503 `custom_domains_not_configured` or 401 (the
token), or 500 `commerce_jobs_unhealthy`: the app log names the group
(`[commerce-job]`). After a deploy rollback the jobs of a kind the older build does
not know stay pending by design, so the lateness 500 fires until the newer build is
back. To reach Marlin, add an Uptime Kuma monitor on the same route (a POST with the
header); the timer alone only reaches the journal.

**Installed 2026-11-02.** The timer runs on `coolify-shared-host` (first pass: 4 groups, 0 failed, 0 dead). Three Uptime Kuma
monitors watch the route, all every 5 minutes, alerting by Telegram: id 39 "Lumitra Shop: job watchdog
(app.lumitra.co)" is red on any non-2xx, id 40 "Lumitra Shop: dead jobs unacknowledged = 0" is red when
`deadUnacknowledged` is above 0, so a receipt job that died alerts, and id 41 "Lumitra Shop: every paid order has
an invoice" is red unless `receipts` is `"ok"` (a JSON query `$.receipts == "ok"`), so a paid order still without
an invoice alerts. Each monitor call runs one pass, which is cheap and safe beside the timer. **Rotation:** the monitors read a copy of `CUSTOM_DOMAIN_SYNC_TOKEN`, stored in
the infra Infisical project at prod `/monitoring` as `FRAMER_CLONE_COMMERCE_WATCHDOG_TOKEN`. After rotating
`CUSTOM_DOMAIN_SYNC_TOKEN`, copy it again with `copy_secret` (overwrite), update the header file on the host and
edit monitors 39, 40 and 41, or all three turn red with 401.

## Rolling back past the published copy

Migration `20261102200000_site_revisions` needs no reversing: older code ignores the table and the column. **That is
the danger of a code rollback past it**, because older code serves `site_pages`, the working copy
(plan `docs/plans/2026-11-01-immutable-published-copy.md`):

- **Saved drafts go live** on every site, at once, including work deliberately not published.
- **Rollbacks made in the Published versions dialog are undone**, because older code never reads the pointer.
- **Rolling forward again hides what was published meanwhile:** older code writes rows and leaves
  `sites.published_revision_id` alone, so visitors get the older frozen revision and the owner's publish has vanished.

So prefer a fix forward. If the code must go back, note the time. Before rolling forward again, take each site published
during that window and either republish it, or clear `published_revision_id` for it, which puts it back on the legacy
path (it serves its rows until its next save or publish freezes them). Which sites: `status = 'published'` with
`updated_at` after the noted time.

## Site branches

Site branches (`docs/plans/2026-11-10-site-branches.md`) are off unless `SITE_BRANCHES_COMPANIES` is set on the app:
unset or empty is off for everyone, `*` is on for every company, or a comma separated list of auth-brain company ids.
Turning it off hides branches without deleting them. Two requests still work then, because they only end something:
discarding a branch and revoking its public preview link (a person who is signed in and may edit the site). A link that
is not revoked shows again the day the switch returns. It is not set on production until the feature's last slice (S9).
The same switch decides what an agent is offered: the branch tools of the MCP endpoint (`create_branch`, `merge_branch` and
the others) are in the tool list and callable only for a key of a company in the list. The public plugin (0.4.0) already
ships the work-on-a-branch skill; it checks the tool list first and works on the site directly while the tools are absent.

**Public preview links (slice S8).** A person who may edit a site can give an open branch a public address,
`preview-<token>.PUBLIC_SITE_BASE_HOST` (production: `preview-<token>.sites.lumitra.co`), which shows the branch
read only to anyone who has it. It needs nothing new on the server: the address is one label under the wildcard record
and certificate that published sites already use, and no site can be given a label that starts with `preview-`.
**The certificate for `*.PUBLIC_SITE_BASE_HOST` must stay one wildcard certificate** (issued by DNS validation, as
it is today): the secret of a preview is its hostname, and a certificate issued for a single preview host would
publish that hostname in the public certificate transparency logs. Never route a preview label through a router
that asks for its own certificate. To check: `openssl s_client -connect <any label>.sites.lumitra.co:443
-servername <any label>.sites.lumitra.co` must show `*.sites.lumitra.co` as the name, for a label never used
before. Without `PUBLIC_SITE_BASE_HOST` no link can be made. A link shows nothing once it is revoked or expired, once its
branch is merged or discarded, and while `SITE_BRANCHES_COMPANIES` does not list the branch's company. Migration
`20261112120000_site_branch_previews` is additive (one table, one unique index on `site_branches` that every row
satisfies) and needs no reversing; older code ignores the table, so after a code rollback every preview address answers
404 until the code is rolled forward again.

Migration `20261111000000_site_branches` is additive (one nullable column on `sites`, one table, constraints every
existing row satisfies) and needs no reversing. Migration `20261112000000_site_branch_merge_undo` (slice S7) adds four nullable columns to `site_branches` and needs
no reversing either; older code ignores them. Migration `20261112180000_site_branch_backstops` (the whole-feature
review) adds a second foreign key and a trigger on `site_branches` and one stored generated column, `base_name`; it
needs Postgres 15 or later (the foreign key clears one column of two on delete), is additive, and older code ignores
all three. Prisma's schema does not name the second key or the generated column: both exist in the database only, so a
schema comparison (`prisma migrate diff`) reports them as differences that are meant to be there.

Migration `20261112200000_site_models` (the 3D model store, plan `docs/plans/2026-11-02-3d-scene-primitive.md`, slice S2)
is additive: one new table, `site_models`, with its constraints and a cascading foreign key to `sites`, and no existing
row or table touched. Nothing reads or writes it until the model upload and serving routes exist and are enabled (a
separate, gated step), so older and newer code behave the same on it. **It is applied by the boot of whichever
deployment first contains it (`prisma migrate deploy`), so any deployment from a commit at or after it carries it: it
is not applied to production by merging, and applying it needs its own authorization.** Refresh the migration
inventory and every gate at the exact release commit. Reversing it: `rollback.sql` beside the migration (run by hand
in one transaction, with no `migrate resolve`: that command refuses a migration that applied, error P3012) drops only that
table and forgets only that migration's history row, so a redeploy applies it again; object-storage blobs are not touched. Both directions are tested on a scratch database
(`src/server/models/__tests__/prismaModels.itest.ts`).
Migration `20261112300000_site_model_coordination` (the upload and blob-cleanup coordination protocol of the same plan,
"Coordinating uploads and blob cleanup") is additive too: three columns on the unread `site_models` table (`state`,
default `'ready'`, so every existing row stays ready; `pending_until` and `attempt`, both null, with a `CHECK` that a ready
row carries neither and a pending row both), one partial index, and one new empty table, `model_blob_tombstones`. No
existing column is changed or dropped and no row is touched or rewritten (the new `state` default is a constant, so
Postgres 11 or later adds it without rewriting the table). Nothing reads or writes any of it until the model upload and
cleanup routes exist and are enabled (a separate, gated step); the code that uses it is wired to nothing. **Applied by
the boot of whichever deployment first contains it, so any deployment from a commit at or after it carries it; merging
applies nothing, and applying it needs its own authorization; the migration inventory is refreshed at the exact release
commit.** Reversing it: `rollback.sql` beside it (by hand, one transaction, safe to run twice, no `migrate resolve`)
drops the tombstone table and the three columns, discards pending rows with their column and forgets only its own history
row; leaving the columns and the empty table in place after a code rollback is the default. Both directions, the
fresh chain and the production-like chain (applied on top of a table that already holds a row) are tested on scratch
databases (`src/server/models/__tests__/coordinationPostgres.itest.ts`).

**Before rolling the code back past the first of the two with open branches**, merge or
discard them: older code does not know the column and lists each open branch as one more draft site in its company's
dashboard. It cannot publish one or give it a domain (a `CHECK` constraint and a trigger refuse that whatever code
runs), so visitors are never affected; the extra entries go away when the code is rolled forward again.

**Erasing personal data while rolled back misses branch copies.** Older code's erase does not know the copies a
branch keeps (its fork point, the site as it was before a merge, branch names and review notes). So: merge or discard
every branch before the rollback, and run no erase while it lasts. If an erase had to run anyway, note the time and
repeat the same search and erase on each affected site once the code is forward again; the new code reaches them.
A record whose branch older code deleted as a site is closed as discarded by the database (a trigger), so it keeps no
copy and frees its name.

## Migration rollbacks

`20261104000000_site_last_write_key` (the editor autosave's attempt keys, plan
`docs/plans/2026-11-04-editor-autosave.md`) adds two nullable columns, `sites.last_write_key` and `sites.last_write_version`.
Older code ignores them, so **a code rollback needs nothing, and the default is to leave the columns where they are**: a
nullable column nobody reads costs nothing, and the migration stays recorded as applied, so the next deploy has nothing to
redo. Do not drop anything to "tidy up" after a rollback.

**Dropping the columns is destructive and needs its own explicit authorization** (the attempt keys of every site are lost,
and the autosave of the previous image has no use for them either way). If it is authorized, do both steps in ONE
transaction, after the application runs the previous image:

```sql
BEGIN;
ALTER TABLE "sites" DROP COLUMN "last_write_key", DROP COLUMN "last_write_version";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104000000_site_last_write_key';
COMMIT;
```

The second statement is what makes the next deploy apply the migration again. **Do not use `prisma migrate resolve
--rolled-back` for this:** it works only on a migration Prisma recorded as FAILED, and for one that applied it stops with
`P3012: cannot be rolled back because it is not in a failed state`. And do not drop the columns alone: Prisma still has
the migration recorded as applied, answers "No pending migrations to apply", and the columns stay gone while newer code
expects them. (Both outcomes were checked on a throwaway Postgres 16 with the full migration chain, 2026-11-12: the
`resolve` was refused with P3012; the columns-only drop left them gone after a deploy; the single transaction above made
the next `prisma migrate deploy` apply the migration again and the two columns came back.)

`migrate resolve --rolled-back <name>` is for the other case: a migration Prisma marked as failed (error P3009 at boot),
once its partial effect has been undone by hand; until then every later deploy refuses to migrate.

The same shape applies to any additive migration of this file's family (`site_branches` and its follow-ups): leave the new
tables and columns in place on a code rollback; a destructive removal is a separate, explicitly authorized step that also
deletes the migration's `_prisma_migrations` row in the same transaction. `site_models` carries that as a script,
`prisma/migrations/20261112200000_site_models/rollback.sql` (run by hand in one transaction; leaving the empty table in place
is the default).

## Erasing personal data: one container only

The owner's erase tool (plan `docs/plans/2026-11-01-immutable-published-copy.md`, "Erasing personal data from the
history") rewrites the database in one transaction, which every container sees at once. The copies a container keeps
for itself are cleaned only in **the container that ran the erase**: the origin cache (`unstable_cache`, revalidated
and its files under `.next/cache/fetch-cache` deleted) and the expanded page trees in memory.

**So the app must run as a single container while erasing is in use.** With a second replica, that replica keeps
serving its cached copy of the site, the erased value included, with no time limit (the cache entries carry no
`revalidate`), until it restarts. The app cannot reach other instances: there is no shared cache handler and no list of
running instances. Before scaling out, add one (a shared cache handler for Next, for example on Redis, plus a broadcast
for the in-memory trees), or restart every replica after each erase. The same limit already applied to publish and
rollback, where it only delays an update; for an erase it is a privacy failure.

The company erasure (`POST /api/internal/erasure`, plan `docs/plans/2026-11-05-company-erasure-consumer.md`) has the
same limit: its rows are gone for every container, but only the container that received auth-brain's delivery
purges its cached copies of the company's sites (at once and again five seconds later). With a second replica, that
replica keeps serving the erased company's cached pages until it restarts.

Migration `20261102230000_site_erasures` is additive. Erase only once every container runs the new code: an older
container neither refuses Save from editor tabs loaded before the erase nor knows the new cache key.

## Operator commands (from a checkout, against a forwarded database)

| Command | Use |
| --- | --- |
| `pnpm db:public` | The commerce public migrations alone (the start does this already) |
| `pnpm db:migrate-tenants` | The tenant fleet migration alone (the start does this already) |
| `pnpm exec tsx --conditions=react-server scripts/seed-demo.ts` | The demo site and catalog, once, on a fresh database |
| `pnpm db:backfill-demo` | Copy a pre-tenant `commerce` schema into the demo company schema; only for a database that still has one (a fresh deploy does not) |
| `pnpm csp:report` | What the report-only policy of published pages would block: count, directive, blocked host, last seen and the sites loading it, highest first. A count is of reports, not visitors or requests: a report can come from an early check before any fetch, so it does not always mean a request happened. Counts are leads and can be forged, so check a host before acting on it. The command warns for a site whose hosts reached the cap. Rate-limited and failed reports are logged once a minute as `[csp-report] last minute`. Holds no visitor data (`src/lib/site/cspReportOnly.ts`, `src/server/sites/cspReports.ts`); whether to enforce is open, see open question 1 of `docs/plans/2026-11-02-selector-styling.md` |
