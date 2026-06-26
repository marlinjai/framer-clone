---
type: plan
status: draft
title: Multi-Tenancy Phase 2 Implementation Plan (orchestrator-ready spec DAG)
summary: Orchestrator-ready, dependency-ordered spec DAG to take framer-clone from the deployed single-tenant storefront slice to the Framer multi-tenant model (authenticated multi-user editor at app.lumitra.co/projects/<id>, random subdomains on a *.sites.lumitra.co wildcard). Decomposes into 23 independently-implementable specs across 5 waves, each with id, goal, files, deps, and verifiable acceptance criteria. Code lands first under the current (inverted) env, then a hands-on infra flip (DNS + wildcard TLS + Coolify + env) cuts over without breaking the live deploy.
date: 2026-06-26
tags: [multi-tenancy, framer-clone, plan]
projects: [framer-clone]
---

# Multi-Tenancy Phase 2 Implementation Plan

Companion to the gap analysis (`docs/plans/2026-06-26-multi-tenancy-gap-analysis.md`). That doc proved the data model, the tenant-scope resolver (`src/server/sites/scope.ts`), and the publish-write authorization (`/api/projects/publish`) are ALREADY multi-tenant-correct. This plan is the build: routing surfaces, the multi-project editor shell, the publish-side subdomain allocator, removing the interim admin secret, threading tenancy through the render path, the separable commerce-tenancy decision, and the env/DNS/TLS cutover.

## Target vs Today (one paragraph)

Target: ONE Next app, host-routed. `EDITOR_HOST=app.lumitra.co` serves the authenticated multi-user editor; each project at `app.lumitra.co/projects/<projectId>`; each user sees only their own projects. Publish allocates a RANDOM unique label on a wildcard, `<randomname>.sites.lumitra.co` (`PUBLIC_SITE_BASE_HOST=sites.lumitra.co`); custom domains later via `SiteDomain.customHostname`. Today it is deployed INVERTED single-tenant: `app.lumitra.co` serves ONE seeded storefront (subdomain `app`, `PUBLIC_SITE_BASE_HOST=lumitra.co`), `EDITOR_HOST=editor.lumitra.co` is set but unexposed, the editor is a client-only SPA at `/` that fabricates one in-memory demo project, and publish never allocates a subdomain.

## Core sequencing principle (read before scheduling)

1. ALL app-side code (Waves 1 to 4) lands and deploys UNDER THE CURRENT ENV (`EDITOR_HOST=editor.lumitra.co`, `PUBLIC_SITE_BASE_HOST=lumitra.co`). Nothing in Waves 1 to 4 changes the live `app.lumitra.co` storefront behavior, so each PR is safe to merge and deploy continuously. The editor surfaces become reachable at `editor.lumitra.co/projects` (already an `EDITOR_HOST`) without touching the public host.
2. The host flip (`EDITOR_HOST=app.lumitra.co`, `PUBLIC_SITE_BASE_HOST=sites.lumitra.co`) is config + DNS + TLS only and is the LAST step (Wave 5), a hands-on session with Marlin. It is GATED on the `/projects` routes existing (MT-09/MT-10), the middleware matcher being reconciled (MT-16), the subdomain allocator shipping (MT-06/MT-07), the render path threading tenancy (MT-13), the interim admin secret being gone (MT-14), and the cookie-domain decision being made (open decision D2).
3. Flipping `EDITOR_HOST` to `app.lumitra.co` BEFORE the `/projects` routes and cookie decision exist would expose an un-gated editor at the public app root. Do not reorder Wave 5 ahead of Waves 1 to 3.

## Wave + spec overview

| Wave | Specs | Theme | Can run in parallel |
|------|-------|-------|---------------------|
| 1 | MT-01, MT-02, MT-03, MT-04, MT-05 | Leaf building blocks (pure fns, additive selects, parameterization, two write routes) | all 5 parallel |
| 2 | MT-06, MT-07, MT-08, MT-09, MT-10, MT-11, MT-12 | Editor shell + dashboard + publish allocation | MT-06/07 parallel to MT-08..12 |
| 3 | MT-13, MT-14, MT-15, MT-16, MT-17 | Render-path tenant correctness + auth hardening + matcher | MT-13/15/17 parallel; MT-14 parallel; MT-16 after routes |
| 4 | MT-18 | Commerce tenancy (large, separable, gates multi-tenant commerce ONLY) | single big spec |
| 5 | MT-19, MT-20, MT-21, MT-22, MT-23 | Infra cutover (DNS + wildcard TLS + Coolify + env flip + docs), hands-on with Marlin | sequential ops |

Dependency edges (spec -> depends on): MT-06 -> MT-01; MT-07 -> MT-06; MT-09 -> MT-05; MT-10 -> MT-04, MT-08; MT-11 -> MT-10; MT-12 -> MT-09, MT-07; MT-13 -> MT-02, MT-03; MT-14 -> MT-03; MT-16 -> MT-09, MT-10; MT-17 -> MT-07, MT-13; MT-18 -> MT-13, MT-14; MT-20 -> MT-19; MT-21 -> MT-19, MT-20; MT-22 -> MT-07, MT-09, MT-10, MT-16, MT-21, D2; MT-23 -> (folds into MT-22).

---

## Wave 1: leaf building blocks (5 specs, all parallel, zero cross-deps)

### MT-01 - Subdomain generator (pure, tested)

- Goal: a pure, deterministic-when-seeded function that produces a random, URL-safe, human-readable subdomain LABEL for publish-time allocation.
- Files/areas: new `src/server/sites/subdomain.ts`; `package.json` (add `nanoid` as a direct dep; only `uuid`/`uuidv4` exist today, no random word/id lib for labels); new `src/server/sites/__tests__/subdomain.test.ts`.
- Dependencies: none.
- Acceptance criteria:
  - Exports `generateSubdomain(): string` producing a lowercase DNS-label-safe slug, Framer-style `word-word-NNNNNN` OR a `customAlphabet` nanoid of length >= 8 over `[a-z0-9]` plus internal hyphens.
  - Output ALWAYS matches `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` (RFC-1035 label: <= 63 chars, no leading/trailing hyphen).
  - Exports `RESERVED_SUBDOMAINS` (at minimum `www`, `app`, `editor`, `api`, `admin`, `auth`, `mail`, `sites`) and `isReserved(label)`; `generateSubdomain` never returns a reserved label.
  - Pure: no Prisma, no `server-only`, no env reads. Importable from a Vitest unit test with zero DB.
  - Tests: >= 10k generated labels all pass the regex and none are reserved; a forced-collision path (inject a clashing first value) shows the function itself does NOT dedupe (dedup is the DB layer's job, asserted in MT-06).

### MT-02 - Public resolver carries the tenant

- Goal: stop dropping `workspaceId`/`tenantGroupId` when resolving a published site, so the render route can thread per-site tenancy. Additive only.
- Files/areas: `src/server/sites/publicResolver.ts` (the `findFirst` `select` and the `PublishedSite` interface).
- Dependencies: none.
- Acceptance criteria:
  - `PublishedSite` gains `workspaceId: string` and `tenantGroupId: string`.
  - `resolvePublishedSite` SELECTs `workspaceId` + `tenantGroupId` from the `Site` row and returns them.
  - Existing behavior unchanged: still keys on `subdomain`, still `status: 'published'` only, still returns null for draft/unknown.
  - A unit/integration test asserts the resolved object carries the seeded demo site's workspace + tenant_group.

### MT-03 - Parameterize the CMS workspace (remove the constant pin from read/write internals)

- Goal: make every CMS read/write take an explicit `workspaceId` argument instead of the module constant `CMS_WORKSPACE_ID = 'framer-clone'`, so the render path (MT-13) and the auth-hardened write path (MT-14) can pass the per-request session workspace. This is the shared refactor that unblocks both.
- Files/areas: `src/server/cms/repository.ts` (every `listTables(CMS_WORKSPACE_ID)` / `createTable({ workspaceId: CMS_WORKSPACE_ID })` call site), `src/server/cms/adapterClient.ts`, `src/lib/cms/constants.ts` (keep the constant ONLY as a dev/seed default, not a runtime pin).
- Dependencies: none.
- Acceptance criteria:
  - `getCmsRepository()` (or its methods) accept a `workspaceId` and pass it to `adapter.listTables(workspaceId)` / `createTable({ workspaceId })`; no read/write method hard-codes `CMS_WORKSPACE_ID`.
  - The client editing grid keeps a single source of truth for its `workspaceId` prop (still client-safe, no `server-only` import leak).
  - Existing tests pass when callers pass `CMS_WORKSPACE_ID` explicitly (behavior identical for the single tenant); a new test asserts two different `workspaceId` args isolate `listTables` results.
  - `grep -rn "CMS_WORKSPACE_ID" src/server/cms` shows it used ONLY as a default value, never as the effective runtime workspace inside a method body.

### MT-04 - Draft-save route (non-destructive persistence)

- Goal: a save path that persists the editor working copy WITHOUT publishing. Today `/api/projects/publish` is the ONLY persistence path and it always flips to `published`, so a loaded real project cannot be edited and saved without going live.
- Files/areas: new `src/app/api/projects/save/route.ts`; new `src/app/api/projects/__tests__/save.route.test.ts`.
- Dependencies: none (reuses `getVerifiedSession` + `resolveActiveScope` + `authenticateRequest('editSite')` + `saveProject`, all existing).
- Acceptance criteria:
  - `POST /api/projects/save` validates the same `project` snapshot schema as the publish route, resolves scope from the verified session, authorizes `editSite` (workspace.admin per `FRAMER_PERMISSIONS`), and calls `saveProject(scope, project)` ONLY (never `publishProject`).
  - A site saved via this route keeps `Site.status` unchanged (draft stays draft) - asserted against the repository contract (`saveProject` preserves status on update).
  - Full `{ error: { code, message } }` envelope: 401 no session, 403 no workspace / not admin, 400 malformed body, 404 cross-workspace id, 500 otherwise. Mirrors the publish route's failure contract.

### MT-05 - Create-project route (server-minted empty draft)

- Goal: an endpoint that creates a new empty DRAFT site row in the caller's active workspace and returns its id, so the dashboard's "New project" button has something to call. Today `createProject` is a client-only MST action; no server create exists.
- Files/areas: new `src/app/api/projects/route.ts` (`POST`); new test.
- Dependencies: none (reuses scope + auth + `saveProject`).
- Acceptance criteria:
  - `POST /api/projects` (optional `{ name }` body) mints a site id SERVER-SIDE (`crypto.randomUUID`), persists a minimal valid draft ProjectModel snapshot (one empty home page) via `saveProject(scope, ...)`, and returns `{ siteId }`.
  - The created row carries the session-derived `workspaceId` + `tenantGroupId` and `status = 'draft'` (the DB default on create).
  - Same error envelope as MT-04 (401/403/400/500).
  - A test asserts two different sessions create rows in DIFFERENT workspaces and neither can `loadProject` the other's id (returns `SiteNotFoundError`).

---

## Wave 2: editor shell, dashboard, publish allocation (7 specs)

### MT-06 - `ensureSiteDomain` + `unpublishProject` repository methods

- Goal: DB-enforced subdomain allocation on first publish, idempotent on re-publish, plus an unpublish path. The ONLY code that writes a `SiteDomain` today is the seed; subdomains are never generated.
- Files/areas: `src/server/sites/repository.ts`; tests in `src/server/sites/__tests__/`.
- Dependencies: MT-01.
- Acceptance criteria:
  - `ensureSiteDomain(scope, siteId): Promise<{ subdomain: string }>`: if the site already has a `SiteDomain` row with a non-null `subdomain`, return it unchanged (re-publish is a no-op, URL is STABLE). Otherwise generate via `generateSubdomain()`, INSERT a `SiteDomain` (`verificationStatus: 'active'`, `isPrimary: true`, stamped `workspaceId` + `tenantGroupId` from scope), and return it.
  - Collision handling is DB-enforced, NOT check-then-insert: catch Prisma `P2002` on the `@@unique([subdomain])` index, regenerate, bounded retry (>= 5 attempts), and throw a loud error (surfaced as 500) when exhausted. A test simulates a colliding label and asserts a retry resolves it.
  - Scoped: `ensureSiteDomain` for a site id in another workspace throws `SiteNotFoundError` (never allocates across the boundary).
  - `unpublishProject(scope, siteId)`: flips `Site.status` back to `draft` via scoped `updateMany`, throws `SiteNotFoundError` on zero rows. It does NOT delete the `SiteDomain` row (re-publish reuses the slug - decision recorded in Open Decisions D3).
  - The partial-unique gotcha is respected: the allocator ALWAYS writes a non-null label (NULL subdomains do not collide and would defeat enforcement).

### MT-07 - Publish route allocates the subdomain + returns the live URL; unpublish route

- Goal: wire `ensureSiteDomain` into publish AFTER `publishProject`, return the live `<name>.sites.lumitra.co` URL, and add an unpublish endpoint.
- Files/areas: `src/app/api/projects/publish/route.ts`; new `src/app/api/projects/unpublish/route.ts`; tests.
- Dependencies: MT-06.
- Acceptance criteria:
  - After `saveProject` + `publishProject`, the publish route calls `ensureSiteDomain(scope, project.id)` and returns `{ siteId, status, publishedPages, subdomain, liveUrl }` where `liveUrl = https://<subdomain>.<PUBLIC_SITE_BASE_HOST>` (server-read env; falls back gracefully when unset so local dev still returns the subdomain).
  - Re-publishing the same site returns the SAME `subdomain`/`liveUrl` (idempotent, asserted in a test).
  - `POST /api/projects/unpublish` resolves scope + authorizes `publishSite` + calls `unpublishProject`; returns `{ siteId, status: 'draft' }`; the `SiteDomain` row survives (asserted). A subsequent re-publish returns the original slug.
  - Failure envelopes match the existing publish route (401/403/400/404/500); an exhausted-collision allocation surfaces a loud 500, never a silent success.

### MT-08 - EditorApp hydrates a loaded snapshot (stop seeding the demo)

- Goal: rework the editor shell to apply a server-loaded project snapshot instead of fabricating `createProject('Framer Clone Demo')` on every mount.
- Files/areas: `src/components/EditorApp.tsx` (lines 52-66 init block), `src/app/page.tsx` wiring.
- Dependencies: none structurally (pairs with MT-10).
- Acceptance criteria:
  - `EditorApp` accepts a `projectSnapshot` (a `ProjectSnapshotOut`) prop. On first init it applies the snapshot into `projectStore`, calls `setCurrentProject(<loaded id>)` and `setCurrentPage(<home>)`, then `getHistoryStore()?.clear()`. It NO LONGER calls `createProject('Framer Clone Demo')`.
  - When no snapshot is provided (e.g. a standalone dev mount), it falls back to the current seed behavior so local `/` dev is unchanged (guarded, not removed).
  - The MST store is already multi-project-ready (`ProjectStore` is `types.map`, `EditorUIStore` holds `currentProject`/`currentPage` `safeReference`s) - no store changes required; a test asserts hydrating snapshot A then snapshot B switches `currentProject` cleanly.

### MT-09 - Per-user/workspace projects dashboard route

- Goal: a server-component dashboard listing only the caller's projects, with a "New project" button.
- Files/areas: new `src/app/projects/page.tsx`; new `src/app/projects/__tests__/` (or integration coverage).
- Dependencies: MT-05.
- Acceptance criteria:
  - Server component: `getVerifiedSession` (off `next/headers` cookies) -> `resolveActiveScope` -> `listSites(scope)`; renders one link per site to `/projects/<siteId>` plus name/status/updatedAt. `listSites` already exists and is workspace-scoped.
  - No valid session redirects to the auth-brain login with a `return_to` of the dashboard URL (consistent with the middleware bounce contract).
  - "New project" posts to `POST /api/projects` (MT-05) and navigates to `/projects/<newId>`.
  - Per-user isolation is satisfied by Open Decision D1 (recommended: each user gets a personal workspace from auth-brain, zero schema change; `resolveActiveScope` then yields that user's workspace and `listSites` already isolates). The dashboard never reads a client-supplied workspace.
  - A test/integration asserts a session for workspace A sees ONLY workspace-A sites.

### MT-10 - Per-project editor route

- Goal: `app.lumitra.co/projects/<projectId>` loads the real project server-side and hands the snapshot to the editor shell.
- Files/areas: new `src/app/projects/[projectId]/page.tsx`.
- Dependencies: MT-04 (so saves are non-destructive), MT-08 (hydration shell).
- Acceptance criteria:
  - Server component: resolve scope, call `loadProject(scope, projectId)` (exists, workspace-scoped), serialize to a snapshot, render `EditorApp` (client, `ssr:false`) with that snapshot.
  - A `projectId` not in the caller's workspace renders a 404 (`loadProject` throws `SiteNotFoundError`, caught -> `notFound()`), never another tenant's project.
  - The editor's save/publish buttons target the loaded project's id (saves go to `/api/projects/save`, publish to `/api/projects/publish`).
  - An integration test loads a seeded project by id and asserts the rendered shell carries that project's pages.

### MT-11 - Project-id-aware preview

- Goal: preview a SPECIFIC project rather than relying on the single seeded in-memory project.
- Files/areas: new `src/app/projects/[projectId]/preview/` route (or carry the id into the existing `/preview`); update preview client to read the loaded project.
- Dependencies: MT-10.
- Acceptance criteria:
  - `/projects/<projectId>/preview` renders the loaded project's current page in the client preview frame, scoped + auth-gated like the editor route.
  - The legacy `/preview` either redirects to the id-aware route or is removed (pre-MVP, no back-compat per project memory).
  - A test asserts previewing project A does not leak project B's content.

### MT-12 - Editor/dashboard navigation chrome + optional list route

- Goal: a project switcher, a "back to projects" link, and a workspace selector in `TopBar`; surface the publish live URL.
- Files/areas: `src/components/TopBar.tsx`; optional new `src/app/api/projects/list/route.ts` (uses `authenticateAccountRequest`, the existing-but-unused account guard) if the switcher needs a client fetch.
- Dependencies: MT-09, MT-07.
- Acceptance criteria:
  - `TopBar` shows the current project name, a "back to /projects" control, and (when the session has >1 workspace) a workspace selector that re-scopes via `resolveScopeForWorkspace` (already supports a chosen workspace).
  - After publish, the editor displays "live at `<name>.sites.lumitra.co`" using the `liveUrl` from MT-07.
  - If a client-side switcher list is added, `GET /api/projects/list` uses `authenticateAccountRequest` + a workspace-scoped `listSites`; it returns ONLY the caller's sites (test-asserted).

---

## Wave 3: render-path tenant correctness + auth hardening (5 specs)

### MT-13 - Thread per-site tenancy through the render path (correctness, not optimization)

- Goal: the SSR render must derive BOTH the CMS workspace (column isolation) AND the commerce tenant/schema (`SET LOCAL search_path` isolation) from the RESOLVED site row, not from module constants. Without this, N published sites on the wildcard all render ONE global tenant's CMS collections + commerce catalog. This is a hard isolation bug for any second tenant.
- Files/areas: `src/app/(site)/[...slug]/page.tsx`, `src/lib/renderer/server/renderPublishedPage.tsx`, `src/server/cms/repository.ts` consumer (`getCmsRepository(workspaceId)`), the commerce repo factory (`getCommerceServerRepository` + `withTenant` schema arg).
- Dependencies: MT-02 (resolver carries tenant), MT-03 (CMS workspace param).
- Acceptance criteria:
  - The render route passes `site.workspaceId` into the CMS read repo so `listTables`/reads isolate by the resolved site's workspace (the two engines use DIFFERENT mechanisms, so BOTH must be carried).
  - The render route passes a commerce tenant/schema derived from the resolved site into `getCommerceServerRepository` / `withTenant`. UNTIL MT-18 lands, the derivation maps every site to the single shared `commerce` schema (documented limitation: multi-tenant commerce is BLOCKED to one tenant until Wave 4; CMS-only multi-tenant sites are fully isolated and may ship now).
  - An integration test seeds TWO published sites in two workspaces, each with its own CMS collection content, and asserts each subdomain renders ONLY its own CMS data (the regression this spec exists to prevent).
  - No module-constant workspace (`CMS_WORKSPACE_ID`) reaches a render-path query.

### MT-14 - Remove the interim admin secret; switch all writes to real auth-brain scope

- Goal: delete the parallel single-secret super-admin that currently guards everything except `/api/projects/publish`, and replace it with `getVerifiedSession` + `resolveScopeForWorkspace` + `authenticateRequest`. In multi-tenant the interim guard is a global super-admin that writes to one constant workspace regardless of who is logged in - a hard isolation hole.
- Files/areas: delete `src/server/auth/guard.ts` and `src/server/auth/adminAction.ts`; update `src/app/api/cms/collections/route.ts`, `src/app/api/cms/collections/[id]/route.ts` (+ `rows`/`rows/[rowId]`), `src/server/cms/actions.ts` (all `requireAdminAction()` call sites, ~40), `src/app/api/commerce/orders/route.ts` (the hard-coded `STOREFRONT_PRINCIPAL` + `INTERIM_WORKSPACE_ID`), `src/app/api/ai/cms-agent/route.ts` + `undo/route.ts` (`verifyAdminCookie`). Reconcile the three divergent constants (`CMS_WORKSPACE_ID`, `INTERIM_WORKSPACE_ID`, `DEFAULT_WORKSPACE_ID`) to session-derived scope.
- Dependencies: MT-03.
- Acceptance criteria:
  - `grep -rn "requireAdmin\|requireAdminAction\|verifyAdminCookie\|INTERIM_WORKSPACE_ID\|STOREFRONT_PRINCIPAL\|FRAMER_CLONE_ADMIN_SECRET" src` returns ZERO matches outside deleted files / docs.
  - Every CMS write route + server action resolves scope from the verified session and authorizes `editSite` (workspace.admin), threading the real `workspaceId` into `getCmsRepository(workspaceId)` / `getCmsAdapter()`.
  - `/api/commerce/orders` create authorizes against the real session/workspace, not the hard-coded storefront principal. (Storefront order creation by anonymous buyers is a product decision - see Open Decision D4; the spec must NOT leave a constant-workspace super-principal.)
  - Each switched route returns the Track-0 `{ error: { code, message } }` envelope (401/403/400/404/500).
  - Tests: a CMS write with a workspace-A session cannot mutate workspace-B collections; an unauthenticated CMS write returns 401.

### MT-15 - Dedicated `(site)` layout + storefront 404

- Goal: decouple the published storefront (and its 404) from the editor's root layout, which today ships "Create Next App" metadata, `html.light`, and data-table CSS to every storefront and `notFound()`.
- Files/areas: new `src/app/(site)/layout.tsx`; a storefront-styled `not-found.tsx` under `(site)`.
- Dependencies: none (logically grouped with render).
- Acceptance criteria:
  - The `(site)` route group has its own layout with per-site metadata hooks and NO editor chrome / data-table CSS.
  - A 404 on a sites host renders the storefront 404, not the editor layout.
  - The editor root layout (`src/app/layout.tsx`) no longer styles storefront output; a snapshot/integration test asserts the storefront HTML head no longer contains the editor metadata.

### MT-16 - Reconcile the middleware matcher + gate `/projects` + encode the cookie decision

- Goal: fix dead-matcher drift and gate the real authoring surfaces. The current matcher gates `/`, `/editor/:path*`, `/api/sites/:path*`, `/api/admin/:path*` - THREE of those four match no routes on disk; the real surfaces are `/`, `/projects/*`, `/api/projects/*`, `/api/cms/*`, `/api/commerce/*`, `/api/ai/*`.
- Files/areas: `src/middleware.ts` (the `matcher` array and, if D2 requires, the cookie handling); update `src/middleware.test.ts`.
- Dependencies: MT-09, MT-10 (the routes must exist before gating them).
- Acceptance criteria:
  - Matcher gates `/projects/:path*` and the authoring `/api/*` families that need it; removes the dead `/editor`, `/api/sites`, `/api/admin` entries; leaves public read/render paths open (`(site)` catch-all, `/preview` public variants, `/api/health/*`, `/api/cms`+`/api/commerce` reads).
  - On the editor host, an unauthenticated `/projects` (and `/projects/<id>`) bounces to the auth-brain login with a correct `return_to` (the current un-gated `/` exemption must NOT leak to the dashboard).
  - The cookie-domain behavior implements Open Decision D2 (host-only editor cookie vs distinct sites-zone cookie). The middleware does not transmit the editor session to `*.sites.lumitra.co`.
  - `src/middleware.test.ts` already encodes the TARGET arrangement (`EDITOR='app.lumitra.co'`); update/extend it so the matcher + gating tests pass with the reconciled routes.

### MT-17 - Host-keyed render cache invalidated on publish

- Goal: stop doing O(pages) Postgres work + full hydration on every storefront hit. `force-dynamic` + React `cache()` gives ZERO cross-request caching today.
- Files/areas: `src/app/(site)/[...slug]/page.tsx` (or the resolver) using `unstable_cache`/`cacheTag` keyed by host; `src/app/api/projects/publish/route.ts` (+ unpublish) calling `revalidateTag`.
- Dependencies: MT-07 (publish is the invalidation trigger), MT-13 (tenancy must be correct BEFORE caching, or a cache poisons cross-tenant).
- Acceptance criteria:
  - Published-site resolution is cached per host with a tag like `site:<subdomain>`; publish and unpublish call `revalidateTag('site:<subdomain>')` so a re-publish is reflected on the next request.
  - Only the MATCHED page snapshot is loaded/hydrated per request where feasible (not ALL pages for every hit).
  - A test asserts: publish -> request renders new content; second identical request does not re-run the DB read (cache hit); unpublish/republish invalidates correctly. Caching must be tenant-safe (key includes the host, so cross-tenant bleed is impossible).

---

## Wave 4: commerce tenancy (1 large, separable spec)

### MT-18 - Multi-tenant commerce

- Goal: make commerce isolation per-tenant. Today Product/ProductVariant/Price*/Inventory*/Reservation/Order/OrderLineItem/CreditNote (~14 tables, `prisma/schema.prisma:438-1048`) carry NO `workspace_id`/`tenant_group_id`; isolation is schema-per-tenant via `withTenant`'s `SET LOCAL search_path`, and v1 uses ONE shared `commerce` schema for everyone. A multi-tenant storefront with commerce would share one catalog + order ledger across all tenants. This is the single largest unbuilt data concern; it GATES multi-tenant commerce ONLY (CMS-only multi-tenant sites ship without it, after Wave 3).
- Files/areas: `prisma/schema.prisma` (commerce models + a tenant-schema registry, or new `workspace_id` columns + migration), `src/server/commerce/withTenant.ts`, `src/server/commerce/repository/*`, `src/server/commerce/order/*`, `src/server/commerce/inventory/*`, the render-path commerce derivation from MT-13, a migration runner.
- Dependencies: MT-13 (the render seam that threads commerce tenant), MT-14 (orders now auth on the real session).
- Recommended approach (ONE, with rationale): per-tenant Postgres schema via a tenant-schema REGISTRY + provisioning + an N-schema migration runner (extend the existing `withTenant(prisma, schema, fn)` seam, which already takes an explicit schema and allowlists it). Rationale: the commerce engine was BUILT for `SET LOCAL search_path` isolation; reusing that seam is far less invasive than adding `workspace_id` + a filter to ~14 tables and every query/aggregate/sequence (`order_number_seq`, generated columns). The cost is a provisioning + migration-runner story (create schema on first commerce-enable, run migrations across N schemas on deploy), which is real but contained to commerce.
- Acceptance criteria:
  - A tenant-schema registry maps a site's tenant (from the resolved Site row, MT-13) to a Postgres schema; `getCommerceServerRepository` + order/inventory paths run under that schema, not the constant `COMMERCE_SCHEMA`.
  - First commerce-enable for a tenant provisions its schema and runs the commerce migrations; a documented runner applies new commerce migrations to ALL tenant schemas on deploy.
  - An integration test seeds two tenants, creates a product + an order in each, and asserts neither tenant can read the other's catalog or order ledger; the `order_number_seq` is per-tenant.
  - Removing the shared-schema assumption is complete: `grep` shows no order/inventory path pinned to a single constant schema at runtime.
  - This spec may land AFTER the CMS-only multi-tenant cutover; the plan does NOT block Wave 5 CMS-only go-live on it, but multi-tenant COMMERCE go-live is gated here.

---

## Wave 5: infra cutover (5 specs, hands-on with Marlin, LAST)

All app-side waves are deployed first. This wave is irreversible-ops (DNS + cert + Coolify fqdn + env) and must be a hands-on session. The subdomain allocator (MT-06/07) and routes (MT-09/10/16) are already live before this runs.

### MT-19 - Wildcard DNS + editor record (Terraform)

- Goal: add `*.sites.lumitra.co` (the published-sites wildcard) and confirm/keep `app.lumitra.co` (now the editor) in Terraform. Today there is exactly ONE record: `app` A -> `server_ip`, `proxied=false` (`infra/deployments/framer-clone/main.tf:22-31`).
- Files/areas: `infra/deployments/framer-clone/main.tf` (new `module "framer_clone_sites_dns"` call using `../../modules/cloudflare/dns-record` with `subdomain = "*.sites"`; the existing module supports one record per call), `outputs.tf` if needed.
- Dependencies: none (but sequence after app-side, before MT-22).
- Acceptance criteria:
  - A `*.sites.lumitra.co` DNS record exists (A -> `server_ip`, or per the TLS decision in MT-20) and is applied via `infra/scripts/tfrun.sh` (NOT the non-existent `deploy.sh` the docs reference).
  - `app.lumitra.co` continues to resolve to the server (kept as the editor host).
  - `terraform plan` shows only the intended additions, no destroy of the live `app` record before the env flip.

### MT-20 - Wildcard TLS for `*.sites.lumitra.co` (ONE approach, recommended)

- Goal: issue a wildcard certificate. The current HTTP-01 path (`proxied=false`) CANNOT mint wildcards.
- SUPERSEDED for the chosen path by "Decisions resolved with Marlin (2026-06-26)": the perf decision selects `proxied=true` + Cloudflare ACM (~$10/mo) for global CDN edge caching, with this DNS-01 wildcard demoted to the ORIGIN cert behind Cloudflare (Full-strict). The `proxied=false` variant below is the free, no-CDN fallback.
- Recommended approach (Option B from the gap analysis): Let's Encrypt DNS-01 wildcard via Coolify/Traefik using a SCOPED Cloudflare API token (Zone:DNS:Edit on `lumitra.co`), record stays `proxied=false` (true origin TLS). Rationale: free, matches the existing self-hosted-cert philosophy, arbitrary subdomain depth, no Cloudflare Advanced Certificate Manager cost. Reserve Option A (Cloudflare-proxied edge TLS / Cloudflare for SaaS) for the later `customHostname` phase. The depth `*.sites.lumitra.co` is exactly why DNS-01 is needed (free Universal SSL covers `*.lumitra.co` only, not the second level).
- Files/areas: Coolify proxy/Traefik DNS-01 config (manual); an Infisical PLACEHOLDER secret for the scoped Cloudflare token (scaffold `CF_DNS_API_TOKEN=PLACEHOLDER_REPLACE_IN_UI` via the proxy-write pattern; Marlin fills the real value, never committed, never in Claude's context); runbook in `deploy/README.md`.
- Dependencies: MT-19.
- Acceptance criteria:
  - A valid `*.sites.lumitra.co` certificate is issued and served (e.g. `openssl s_client -connect anything.sites.lumitra.co:443` shows the wildcard cert).
  - The scoped Cloudflare token lives in Infisical (placeholder scaffolded by the worker, real value set by Marlin); NO token literal in any committed file.
  - Renewal path documented (single shared cert, ~90-day renew, monitored).

### MT-21 - Coolify app answers for the wildcard + editor host

- Goal: tell the Coolify application to also serve `*.sites.lumitra.co` and `app.lumitra.co`, binding the wildcard cert. The Coolify app is NOT Terraform-managed (the provider cannot create application resources), so this is a Coolify MCP/UI op.
- Files/areas: Coolify application domains (via Coolify MCP / UI); runbook entry in `deploy/README.md`.
- Dependencies: MT-19, MT-20.
- Acceptance criteria:
  - The Coolify app lists `app.lumitra.co` and `*.sites.lumitra.co` as fqdns and binds the wildcard cert.
  - A request to an arbitrary `<x>.sites.lumitra.co` reaches the app (404s pre-allocation, which is correct - no SiteDomain row yet).
  - The op is documented in the runbook (it is not in version control, so the runbook is the record).

### MT-22 - The env flip + demo-seed migration + redeploy (the cutover)

- Goal: flip the host config to the target and migrate the existing seeded demo WITHOUT breaking it.
- Files/areas: Infisical (`env=prod`): `EDITOR_HOST=app.lumitra.co`, `PUBLIC_SITE_BASE_HOST=sites.lumitra.co` (via the secrets-proxy / `! infisical secrets set` pattern, never a Bash literal); the demo seed (`src/lib/renderer/server/seedDemoSite.ts`) and/or a one-off allocation so the demo site gets a `sites.lumitra.co` subdomain; redeploy.
- Dependencies: MT-07, MT-09, MT-10, MT-16, MT-21, and Open Decision D2 (cookie).
- Acceptance criteria:
  - After the flip: `app.lumitra.co/` serves the editor dashboard (host matches `EDITOR_HOST` -> `isEditorHost` true); `app.lumitra.co/projects` requires auth.
  - The existing demo storefront is reachable at `<label>.sites.lumitra.co` - either the existing `demo` SiteDomain row works under the new wildcard (host `demo.sites.lumitra.co`, `parseSubdomain('demo.sites.lumitra.co','sites.lumitra.co') -> 'demo'`, verified against `publicResolver.ts:71-80`), or the demo is re-seeded/allocated onto the sites zone. The stale `app` SiteDomain row becomes inert (app.lumitra.co is now the editor) and is documented/removed; it is NOT relied upon.
  - Publishing a NEW project from the editor allocates `<random>.sites.lumitra.co` and the live URL loads over the wildcard cert.
  - Rollback is a single Infisical revert (`EDITOR_HOST=editor.lumitra.co`, `PUBLIC_SITE_BASE_HOST=lumitra.co`) + redeploy; the flip is config-only, no code rollback needed.
  - The cutover is verified live (not just tests): editor at `app.lumitra.co`, a published site at `<x>.sites.lumitra.co`, a draft/unknown subdomain 404s.

### MT-23 - Doc + config drift (folds into MT-22's PR)

- Goal: fix the docs/config that still describe the inverted single-tenant layout as correct.
- Files/areas: `deploy/README.md` (rewrite the host layout to the target; fix the `deploy.sh` reference -> `infra/scripts/tfrun.sh`), `.env.example` (add `PUBLIC_SITE_BASE_HOST`, update the `EDITOR_HOST` note that currently says it must NOT be `app.lumitra.co`), `.github/workflows/deploy.yml` (the hardcoded `health_url: https://app.lumitra.co/api/health/db` still works since the editor host stays reachable, but document why).
- Dependencies: folds into MT-22.
- Acceptance criteria:
  - `.env.example` documents `EDITOR_HOST=app.lumitra.co` and `PUBLIC_SITE_BASE_HOST=sites.lumitra.co` as the target.
  - `deploy/README.md` no longer claims app.lumitra.co is the storefront and no longer references a non-existent `deploy.sh`.
  - The health-check URL is confirmed correct for the post-flip layout.

---

## Cut-over without breaking the live deploy (summary)

1. Waves 1 to 4 ship continuously under the CURRENT env. The live `app.lumitra.co` storefront keeps working the entire time (none of these specs change `EDITOR_HOST`/`PUBLIC_SITE_BASE_HOST`). The new editor surfaces are reachable at `editor.lumitra.co/projects` (already an `EDITOR_HOST`) for internal verification before go-live.
2. The interim admin secret removal (MT-14) and render tenancy threading (MT-13) are deployed and verified against the single live tenant BEFORE any second tenant exists - they are no-ops for one tenant but close the holes the moment the wildcard opens.
3. Wave 5 is the single hands-on flip. The existing seeded demo: its `demo` SiteDomain row keeps resolving under the new `*.sites.lumitra.co` wildcard (host `demo.sites.lumitra.co`), so the demo content survives; the apex `app` SiteDomain row goes inert (app.lumitra.co becomes the editor) and is documented/removed, not depended on.
4. Rollback is a one-line Infisical env revert + redeploy. The flip carries no code rollback.
5. Multi-tenant COMMERCE go-live is gated on MT-18; multi-tenant CMS-only go-live is not. The wildcard can open with CMS-only sites fully isolated while commerce stays single-tenant until Wave 4 lands.

---

## Decisions resolved with Marlin (2026-06-26)

These SUPERSEDE the body where they conflict (notably MT-20 TLS and the old D2 framing). The orchestrator builds to these; do not relitigate.

### Hosting architecture: interim now, edge north-star
- BUILD NOW (Option A): published sites served by the EXISTING Coolify Next app, SSR by host, on the `*.sites.lumitra.co` wildcard. Reuses the live, proven deploy; fits the dynamic commerce/CMS render; fastest path to first tenants.
- NORTH-STAR (Option B, NOT now): Cloudflare-for-SaaS + edge Worker + R2/KV pre-built hosting (the 2026-06-23 hosting-foundation plan, P3). Trigger to migrate: per-site traffic / tenant count strains the single origin, custom domains at volume, or Framer-grade global static perf.
- KEEP THE SERVING-LAYER SEAM CLEAN so B is a later swap of only the serving layer: publish writes a portable site snapshot + `SiteDomain`; render resolves by host. Do not couple the editor/publish/data model to the Coolify-SSR serving layer.

### Performance approach (the "SSR is slower than pre-built" answer): two cache layers, no Option B needed
- Origin page cache: MT-17 (host-keyed render cache, invalidated on publish). Build once, serve the saved page to all later visitors until re-publish.
- Edge cache: FRONT `*.sites.lumitra.co` WITH CLOUDFLARE'S CDN (`proxied=true`) so cached pages serve from the Cloudflare data center nearest each visitor (global speed without building Option B). Dynamic commerce islands (cart/checkout) stay client-side and call the origin, so they never block first paint.
- TLS reconciliation (SUPERSEDES MT-20): `proxied=true` for a SECOND-LEVEL wildcard (`*.sites.lumitra.co`) needs Cloudflare Advanced Certificate Manager (ACM, ~$10/mo) for the EDGE cert (free Universal SSL covers `*.lumitra.co` only, not `*.sites.lumitra.co`), PLUS an origin cert for Full-strict (the Let's Encrypt DNS-01 wildcard from MT-20 becomes the ORIGIN cert behind Cloudflare, or use a Cloudflare Origin CA cert). The free `proxied=false` DNS-01-only path remains available but gives NO global CDN (origin-only, single-region). RECOMMENDED: `proxied=true` + ACM for the global perf. CONFIRM the ~$10/mo ACM line item.

### Resolved D0-D6
- D0 domain: CONFIRMED `sites.lumitra.co`.
- D1 ownership: PERSONAL workspace per user (Option a; zero schema change).
- D2 cookie / session isolation: CORRECTED. The `.lumitra.co` apex `lumitra_session` cookie is INTENTIONAL for suite-wide SSO (studio, analytics, email-editor depend on it); do NOT make the editor cookie host-only (that breaks suite SSO). Instead: the published-site plane derives tenancy from the HOST and NEVER trusts the apex session as authorization for published-site/shopper actions (the cookie is httpOnly, so untrusted-site JS cannot read it; the server simply ignores it for authz). Consumer/shopper (CIAM) auth is a SEPARATE plane, NOT bolted into auth-brain (on custom domains the central cookie is third-party / broken on Safari/Brave anyway; future BUY/embed per the hosting-foundation red-team). Net: MT-16 makes published-site requests ignore the apex session for authz; NO auth-brain cookie-domain change is required.
- D3 unpublish: KEEP the `SiteDomain` row (stable re-publish URL).
- D4 anonymous orders: resolve the tenant from the storefront HOST (not a session); the anonymous buyer attaches to a lightweight per-order guest customer (email), upgradeable to accounts later. Pairs with MT-14 + MT-18.
- D5 wildcard TLS: see the perf reconciliation above (`proxied=true` + ACM recommended for the CDN; the DNS-01 wildcard is the Full-strict origin cert).
- D6 commerce tenancy: CONFIRMED per-tenant schema (reuse the `withTenant` `SET LOCAL search_path` seam).

### Upstream plans this sits under (do not contradict)
- `docs/plans/2026-06-23-framer-hosting-platform-foundation.md` , tenant isolation, the `site_*` tables, on-publish tracker injection, the P3 edge north-star.
- `docs/plans/2026-06-25-framer-custom-domains.md` , custom domains: Coolify per-host cert now / Cloudflare-for-SaaS later, DCV verification, `SiteDomain.customHostname`.

### Analytics cross-origin (add to acceptance)
The analytics ingest endpoint must accept events (CORS) from `*.sites.lumitra.co` AND future custom domains, since published sites POST events cross-origin. The on-publish tracker injection (foundation plan; wired in framer #45) already injects the public `ap_live_` key.
