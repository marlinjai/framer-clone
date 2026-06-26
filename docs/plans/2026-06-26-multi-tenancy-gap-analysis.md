---
type: plan
status: draft
title: Multi-Tenancy Gap Analysis (single-tenant slice -> Framer multi-tenant model)
summary: One consolidated code gap analysis for migrating framer-clone from the deployed single-tenant storefront slice to the multi-tenant Framer model (authenticated multi-user editor at app.lumitra.co/projects/<id>, random subdomains on a *.sites.lumitra.co wildcard). The data + scope + auth-scoping layers are already multi-tenant-correct; the gaps are routing surfaces, the editor shell, the publish-side subdomain allocator, the interim admin-secret removal, commerce tenancy, and wildcard DNS/TLS.
date: 2026-06-26
tags: [multi-tenancy, framer-clone, architecture]
projects: [framer-clone]
---

# Multi-Tenancy Gap Analysis: framer-clone

## Target vs Today

**Target (Framer multi-tenant model):**

- `app.lumitra.co` is the authenticated MULTI-USER editor/dashboard. Each project lives at `app.lumitra.co/projects/<projectId>`. Each user sees only their own projects (per-user or per-workspace isolation).
- Publish allocates a RANDOM unique subdomain on a wildcard: `<randomname>.sites.lumitra.co` (custom domains later via `SiteDomain.customHostname`).
- One Next app, host-routed: `EDITOR_HOST=app.lumitra.co` serves the editor, `*.sites.lumitra.co` serves the published site keyed by subdomain (`PUBLIC_SITE_BASE_HOST=sites.lumitra.co`).

**Today (deployed single-tenant slice):**

- `app.lumitra.co` serves ONE storefront (a hand-seeded `SiteDomain` with subdomain `app`). `EDITOR_HOST=editor.lumitra.co` is set but unexposed. `PUBLIC_SITE_BASE_HOST=lumitra.co`. The host config is effectively INVERTED versus target.
- The editor is a single client-only single-page application (SPA) at `/` that fabricates one in-memory demo project on every mount. No `/projects` routes exist.
- Publish writes the snapshot and flips `Site.status` to `published`. It never allocates a subdomain.

**The single most important finding:** the data model, the tenant-scope resolver, and the publish-write authorization are ALREADY multi-tenant-correct. The migration is overwhelmingly CODE on the routing and editor-shell surfaces plus an env/DNS/TLS flip, NOT a storage redesign. The one large genuinely-unbuilt data concern is commerce tenancy.

---

## Per-Subsystem: Exists vs Missing

### 1. Host routing + edge middleware

**Exists**

- `src/middleware.ts` is the whole host-routing brain. It runs in the edge runtime and makes a BINARY decision: read `process.env.EDITOR_HOST` (line 36), normalize the request Host (line 37, strip port, lowercase), compute `isEditorHost = !editorHost || host === editorHost.toLowerCase() || host === 'localhost' || host === '127.0.0.1'` (lines 42-46). The single `EDITOR_HOST` (plus localhost) is the editor, EVERY other host is a published site.
- The editor-vs-published action happens ONLY for the root path (lines 48-61). On a non-editor host, `/` is rewritten to `/__home` (`HOME_REWRITE_SENTINEL`) and this returns BEFORE the auth cookie check, so anonymous visitors are served, never bounced to login. Non-root published paths fall through to the `(site)/[...slug]` catch-all.
- Subdomain extraction is NOT in the middleware. It lives in `src/server/sites/publicResolver.ts` `parseSubdomain` (lines 61-87), which is already host-agnostic: with `baseHost` set it requires the host to end with `.<baseHost>` and returns the leftmost remaining label. `base='sites.lumitra.co', host='demo.sites.lumitra.co'` returns `demo` (verified by reading the file).
- The editor root `/` is deliberately NOT auth-gated (lines 57-60, comment: it "loads client-only and owns its own auth"). Only `/editor`, `/api/sites`, `/api/admin` paths hit the cookie-presence gate (lines 63-80).
- `HOME_REWRITE_SENTINEL` lives in a dependency-free module (`src/server/sites/homeSentinel.ts`) so the edge middleware can import it without pulling Prisma.

**Missing**

- Nothing in the routing CODE blocks the flip. Making `app.lumitra.co` the editor and `*.sites.lumitra.co` the published router is a PURE ENV change: `EDITOR_HOST=app.lumitra.co` + `PUBLIC_SITE_BASE_HOST=sites.lumitra.co`. Zero edits to `middleware.ts` or `parseSubdomain`.
- The matcher (lines 93-101) gates `/`, `/editor/:path*`, `/api/sites/:path*`, `/api/admin/:path*`. THREE of those four path families match no routes that exist on disk. The real surfaces are `/` (editor), `/api/projects/*` (incl. publish), `/api/cms/*`, `/api/commerce/*`, `/api/ai/*`. This is dead-matcher drift to reconcile.
- The multi-project editor routes do not exist, so on the editor host any non-root, non-`/preview`, non-`/api` path FALLS THROUGH to `(site)/[...slug]`, which calls `resolvePublishedSite('app.lumitra.co')`, gets null (host is not under `sites.lumitra.co`), and 404s. `app.lumitra.co/projects/<id>` would 404 until those routes are added.

### 2. Editor surfaces + Next app routing

**Exists**

- The editor is at `/` ONLY, single-project, client-only. `src/app/page.tsx` is a 9-line client component dynamic-importing `EditorApp` with `ssr:false`. There is no projectId in the path.
- The editor ALWAYS seeds one in-memory demo project, never loads from the database. `src/components/EditorApp.tsx:52-66` (verified): `rootStore.projectStore.createProject('Framer Clone Demo', ...)`, set current, set home page, `getHistoryStore()?.clear()`. No projectId is read, no `loadProject` is called.
- The Mobx-State-Tree (MST) store is ALREADY multi-project-ready: `ProjectStore` is `types.map(ProjectModel)` with `getProject`, `allProjects`, `removeProject`; `EditorUIStore` holds `currentProject` and `currentPage` `safeReference`s with setters. Only the seed populates it.
- Only four route families exist: `/` (editor), `/preview` (client-only preview reading the in-memory current project), `(site)/[...slug]` (storefront SSR), `/api/*`. No `/projects`, no `/projects/<id>`, no dashboard, no `/editor/*`.
- The persistence layer is already multi-tenant. `SiteRepository.listSites(scope)` (the dashboard query) and `loadProject(scope, siteId)` (the per-project editor load) BOTH already exist and are workspace-scoped (verified, repository.ts:77-146). They are called by NO route today.

**Missing**

- A per-user/workspace projects dashboard route (`src/app/projects/page.tsx`) that calls `getVerifiedSession` + `resolveActiveScope` + `listSites(scope)`.
- A per-project editor route (`src/app/projects/[projectId]/page.tsx`) that loads via `loadProject(scope, projectId)` server-side and hands the snapshot to the client shell.
- `EditorApp` must STOP seeding and START hydrating: replace `createProject('Framer Clone Demo')` with applying a loaded project snapshot and `setCurrentProject` to that id.
- An explicit server "create project" flow. Today `createProject` is a client-only MST action and the only server write (`/api/projects/publish`) upserts-by-id AND flips to published. There is no endpoint that creates a new empty DRAFT site row, so a "New project" button has nothing to call.
- A save/autosave-draft route. `/api/projects/publish` is the ONLY persistence path and it ALWAYS publishes. A loaded real project cannot be edited and persisted without going live. `saveProject` exists; the route does not. This must land BEFORE wiring load-by-id, or every save is destructive (publishes).
- Preview must become project-id-aware (`/projects/<projectId>/preview` or carry the id). Today it silently depends on the single seeded project being in memory.
- Dashboard/editor navigation chrome. `TopBar` renders a static read-only title and the PublishButton; no project switcher, no "back to projects", no workspace selector.

### 3. Auth, session, multi-tenant isolation

**Exists**

- Auth-brain is the identity owner. framer-clone models NO identity (no users, memberships, sessions, workspaces, tenants in the schema, grep-confirmed in the maps). The single SDK client is `src/lib/auth-brain.ts`, fail-closed (401/timeout/5xx map to null on verify).
- Request guards in `src/lib/auth-api.ts`: `getVerifiedSession(req)` (full `SessionVerifyResponse` with workspaces + tenants + active_workspace), `authenticateRequest(req, workspaceId, action)`, `authenticateAccountRequest(req)` (session-only, the "list my sites" guard).
- Per-resource authorization via OpenFGA: `FRAMER_PERMISSIONS` maps app verbs to workspace roles (`viewSite=viewer`; `editSite`/`publishSite`/`manageDomain=admin`), fail-closed.
- Scope is ALWAYS server-derived. `src/server/sites/scope.ts` `resolveScopeForWorkspace(session, workspaceId)` and `resolveActiveScope(session)` produce `TenantScope { workspaceId, tenantGroupId }` from the verified session, never from client input.
- ONE route uses the real auth-brain path end to end: `/api/projects/publish` (verified, reading route.ts:74-134): `getVerifiedSession` -> `resolveActiveScope` -> `authenticateRequest('publishSite')` -> `saveProject` + `publishProject`, with a full `{ error: { code, message } }` envelope on 401/403/400/404/500.

**Missing**

- A second, PARALLEL interim auth system still guards EVERYTHING else and must be REMOVED, not supplemented. `src/server/auth/guard.ts` is a single hard-coded admin principal behind `FRAMER_CLONE_ADMIN_SECRET` with one constant `INTERIM_WORKSPACE_ID = 'ws_interim_default'`. It guards `/api/cms/collections/*`, all 40 CMS write server actions (`src/server/cms/actions.ts`), and `/api/commerce/orders` (hard-coded `STOREFRONT_PRINCIPAL` + `INTERIM_WORKSPACE_ID`). In multi-tenant this is a global super-admin that can write to the one constant workspace regardless of who is logged in: a hard isolation hole. These must switch to `getVerifiedSession` + `resolveScopeForWorkspace` + `authenticateRequest` threading the real per-request workspaceId.
- An account-level "list my sites" route. `authenticateAccountRequest` exists for exactly this; no route consumes it.
- A cookie-domain strategy for the editor-vs-sites split (see cross-cutting risks).

### 4. Publish flow + SiteDomain (subdomain assignment)

**Exists**

- `src/app/api/projects/publish/route.ts` is the only publish endpoint. Verified: it calls `saveProject` then `publishProject` and NEVER touches `SiteDomain`. The response returns only `{ siteId, status, publishedPages }`, not the live URL.
- `publishProject` (verified, repository.ts:257-264) is a bare status flip: `updateMany({ where:{ id, workspaceId }, data:{ status:'published' } })`, idempotent on re-publish, scoped by id AND workspaceId.
- `SiteDomain` (verified, schema.prisma:294-323): `subdomain String? @@unique`, `customHostname String? @@unique`, `verificationStatus DomainVerificationStatus @default(pending)` (enum `pending|active|failed`), `isPrimary`. Both unique constraints are global. Partial uniqueness (NULLs allowed many times) is Postgres default.
- The ONLY code that writes a `SiteDomain` today is the seed `src/lib/renderer/server/seedDemoSite.ts` (hand-chosen subdomain `demo`/`draftdemo`/`app`). Subdomains are never generated.
- `resolvePublishedSite` keys ONLY on subdomain and serves only `Site.status === 'published'`. It does NOT consult `verificationStatus` (owned subdomains are trivially active) and does NOT read `customHostname`.

**Missing**

- A subdomain GENERATOR: a pure, testable function producing a random URL-safe human-readable label (Framer-style `word-word-NNNNNN` or a `customAlphabet` nanoid). No such function and no dependency exist (`package.json` has only `uuid` + `@prisma/client`; the only randomness in use is `crypto.randomUUID`). It must lowercase, exclude reserved labels (`www`, `app`, `editor`, `api`, `admin`), and obey DNS label rules.
- Publish-time domain provisioning. Add `ensureSiteDomain(scope, siteId)` called from the publish route AFTER `publishProject`: on first publish generate a unique subdomain and insert a `SiteDomain` (verificationStatus `active`, isPrimary true, stamped workspaceId+tenantGroupId); on re-publish, no-op so the URL is stable.
- Collision handling that is DB-enforced, not check-then-insert (avoid time-of-check-to-time-of-use). Insert and catch Prisma `P2002` on the unique index, regenerate, bounded retries, loud 500 if exhausted.
- An UNPUBLISH path. `publishProject` only ever sets `published`. There is no `unpublishProject(scope, siteId)` and no route. Decision: keep the `SiteDomain` row on unpublish (recommended, so re-publish reuses the slug).
- Return the live URL from publish so the editor can show "live at `<name>.sites.lumitra.co`". Requires `PUBLIC_SITE_BASE_HOST` available server-side.
- `customHostname` resolution, onboarding (domain-control validation, per-domain TLS), and `isPrimary` enforcement are all deferred to the custom-domains plan.

### 5. Prisma data model

**Exists**

- The site IS the project. There is NO `Project` entity; one ProjectModel equals one `Site` row (schema comment, verified). The MST ProjectModel is the working copy; `Site` + `SitePage` rows are the source of truth.
- HARD isolation is wired into the model: ALL FOUR `site_*` tables (`Site`, `SitePage`, `SiteDomain`, `SiteExperiment`) carry BOTH `workspace_id` AND `tenant_group_id`, both indexed. These are opaque strings stamped from the session, not foreign keys into this app.
- `SiteRepository` enforces the boundary on every read and write; a cross-workspace id throws `SiteNotFoundError`.

**Missing**

- No per-user ownership on `Site` (only `workspace_id`, no `userId`/`ownerId`). "Each user sees only their own projects" works ONLY if auth-brain gives each user a personal workspace, OR a `Site.ownerUserId` column + filtered `listSites` is added (product decision).
- COMMERCE TABLES ARE NOT TENANT-SCOPED AT THE COLUMN LEVEL. Product, ProductVariant, Price*, Inventory*, Reservation, Order, OrderLineItem, CreditNote (schema:438-1048) carry NO `workspace_id` and NO `tenant_group_id`. Commerce isolation is schema-per-tenant via `withTenant` `SET LOCAL search_path`, and v1 uses ONE shared `commerce` schema for everyone. A multi-tenant storefront with commerce today would share one catalog and order ledger across all tenants. This is the single largest data-model gap (the per-tenant schema registry + provisioning + N-schema migration runner are deferred to E7).
- Three divergent single-tenant workspace constants to reconcile to session-derived scope: `CMS_WORKSPACE_ID = 'framer-clone'`, `INTERIM_WORKSPACE_ID = 'ws_interim_default'`, `DEFAULT_WORKSPACE_ID = 'default'`. The CMS read/write path is pinned to `CMS_WORKSPACE_ID`, NOT the session, so CMS content is single-tenant regardless of who is logged in.
- No reserved/blocked-subdomain mechanism at allocation time (there is no allocation code at all yet).

### 6. Published-site render / SSR

**Exists**

- `(site)/[...slug]/page.tsx` is `force-dynamic` + `nodejs`. `resolvePublishedSite(host)` is wrapped in React `cache()` so `generateMetadata` and the body share ONE database read per request (request-scoped dedupe, not a persistent cache).
- `renderPublishedPage.tsx` runs `hydrateBindings` for LIVE CMS + commerce expansion per request, with repos INJECTED by the route (`getCmsRepository()`, `getCommerceServerRepository()`), keeping the seam server-only-free and unit-testable.
- Draft-vs-published is enforced in `resolvePublishedSite` (`status: 'published'`). A draft/archived/unknown subdomain 404s.

**Missing (highest priority for correctness)**

- PER-REQUEST TENANT SCOPING IN HYDRATION. `resolvePublishedSite` SELECTs id/name/analytics/pages but DROPS `workspaceId` and `tenantGroupId` (verified, publicResolver.ts:108-119). The render route then hydrates CMS via the constant `CMS_WORKSPACE_ID` and commerce via the constant `COMMERCE_SCHEMA`. Result: N published sites on the wildcard would ALL render ONE global tenant's CMS collections + commerce catalog. The resolver must select the workspace/tenant out of the Site row, and the render route must thread BOTH a workspaceId (CMS isolates by column) AND a tenant/schema (commerce isolates by `SET LOCAL search_path`) into hydration. The two engines use DIFFERENT tenancy mechanisms, so both must be carried.
- Caching for many sites. `force-dynamic` + `cache()` gives zero cross-request caching; every hit runs `findUnique` + `findFirst` loading ALL pages plus full hydration. For a wildcard serving many sites this is O(pages) Postgres work per request. Add a host-keyed cache (`unstable_cache`/`cacheTag`) invalidated by `revalidateTag` on publish, and load only the MATCHED page snapshot.
- A dedicated `(site)/layout.tsx`. Today the storefront AND `notFound()` inherit the editor's root layout (`src/app/layout.tsx`: "Create Next App" metadata, `html.light`, data-table CSS). Multi-tenant needs per-site metadata/theming and a storefront-styled 404 decoupled from editor chrome.
- Per-site analytics key resolution. `resolvePublicIngestionKey` falls back to one shared `ANALYTICS_PUBLIC_INGESTION_KEY` env, so many sites would emit under one key. The per-site Infisical-by-ref resolution is a declared-but-unbuilt seam.

### 7. Infra/deploy for wildcard multi-tenancy

**Exists**

- A SINGLE Cloudflare DNS record: `infra/deployments/framer-clone/main.tf:22-31` declares one `app` A record to `var.server_ip`, `proxied = false`. tfstate confirms exactly 1 record. No wildcard, no `sites.lumitra.co` record.
- TLS today is per-host Hypertext Transfer Protocol challenge (HTTP-01) via Coolify/Traefik, possible because the record is `proxied = false` (grey cloud, origin sees traffic directly). HTTP-01 CANNOT issue wildcard certs.
- The Coolify app is NOT Terraform-managed (the SierraJC provider cannot create application resources). Adding domains is a Coolify MCP/UI operation.
- Host routing is fully implemented in code (middleware + parseSubdomain) and ready for the flip. The current inverted host values live ONLY in Infisical (env=prod), so flipping them is an Infisical edit + redeploy, no code change.
- The Infisical project + app machine identity are Terraform-managed; only 3 plain env vars sit on the Coolify app, everything else is Infisical.

**Missing**

- A wildcard DNS record `*.sites.lumitra.co` (a new `module "framer_clone_sites_dns"` call, the existing single-record module supports it, one call per record). Plus an editor record for `app.lumitra.co`.
- Wildcard TLS for `*.sites.lumitra.co`. The current HTTP-01 path cannot mint wildcards. Both options below are net-new (see cross-cutting risks).
- The Coolify app must be told to ALSO answer for `*.sites.lumitra.co` and bind the wildcard cert (manual MCP/UI op, not in version control).
- The `EDITOR_HOST` + `PUBLIC_SITE_BASE_HOST` flip (Infisical `secrets set` + redeploy).
- Doc drift to fix in the same change: `deploy/README.md` documents the inverted single-tenant layout as correct and references a non-existent `deploy.sh` (the real wrapper is `infra/scripts/tfrun.sh`). `.env.example` is missing `PUBLIC_SITE_BASE_HOST`. `deploy.yml:95` hardcodes `health_url: https://app.lumitra.co/api/health/db`.

---

## Consolidated: What Must Be Built

Ordered by dependency. The host flip is config-only but is GATED on the routes + cookie decision existing first.

### A. Editor and routing surfaces (largest code area)

1. `src/app/projects/page.tsx`: server-component dashboard. `getVerifiedSession` + `resolveActiveScope` (or iterate the session's workspaces) + `listSites(scope)`, render links to `/projects/<siteId>`, plus a "New project" button.
2. `src/app/projects/[projectId]/page.tsx`: server-loads via `loadProject(scope, projectId)`, hands the snapshot to the client editor shell.
3. Rework `EditorApp` to hydrate the passed snapshot instead of `createProject('Framer Clone Demo')`. Set `currentProject`/`currentPage` from the loaded project.
4. `POST /api/projects` (create): mint a site id SERVER-SIDE within the active workspace, insert an empty DRAFT site row, return the id for the dashboard to navigate to.
5. `POST /api/projects/save` (draft save): call `saveProject` WITHOUT `publishProject`. Land this BEFORE load-by-id so editing a loaded site is non-destructive.
6. Make preview project-id-aware (`/projects/<projectId>/preview`).
7. TopBar chrome: project switcher, "back to projects", workspace selector (the session can carry several; `resolveScopeForWorkspace` already supports a chosen one).

### B. Publish-side subdomain allocation

8. A pure subdomain generator (reserved-label denylist, DNS-label-safe, lowercase).
9. `ensureSiteDomain(scope, siteId)` repository method: first-publish generates a unique label and inserts a `SiteDomain` (verificationStatus `active`, isPrimary true, scoped ids); re-publish is a no-op. DB-enforced collision retry on `P2002`, bounded, loud failure.
10. Call it from the publish route after `publishProject`; return the live `<name>.sites.lumitra.co` URL in the response and surface it in `PublishButton`.
11. `unpublishProject(scope, siteId)` + a route (retain the SiteDomain row).

### C. Multi-tenant correctness on reads

12. `resolvePublishedSite` must SELECT `workspaceId` + `tenantGroupId` and the render route must thread BOTH the workspaceId (CMS) AND the tenant/schema (commerce) into `hydrateBindings`. Without this, all wildcard sites render one tenant's data. This is a correctness bug for any second tenant, not an optimization.
13. Remove the interim admin secret. Switch `/api/cms/*` (incl. the 40 CMS server actions) and `/api/commerce/orders` to `getVerifiedSession` + `resolveScopeForWorkspace` + `authenticateRequest`, threading the real workspaceId into `getCmsAdapter()` / `withTenant`. Delete `requireAdmin`/`requireAdminAction`/`verifyAdminCookie` and the three workspace constants.
14. Reconcile the middleware matcher to real routes: add `/projects/:path*` (gated) and the real `/api/*` authoring routes; remove the dead `/editor`, `/api/sites`, `/api/admin` entries. Decide `/` on the editor host (dashboard or redirect to `/projects`); do NOT let the current un-gated `/` exemption leak to the dashboard.
15. A dedicated `(site)/layout.tsx` + storefront 404, decoupled from editor chrome.
16. Host-keyed render cache invalidated on publish (scale, not correctness, but required for many sites).

### D. Commerce tenancy (the large, separable decision)

17. Either build the E7 per-tenant-schema registry + provisioning + N-schema migration runner, OR add `workspace_id` columns + filters across the ~14 commerce tables. Both are large. This GATES shipping multi-tenant commerce; multi-tenant CMS-only sites can ship before it.

### E. Infra (config + DNS + TLS, the hands-on session with Marlin)

18. Wildcard DNS `*.sites.lumitra.co` (Terraform module call) + editor record.
19. Wildcard TLS (decision below).
20. Coolify app: add the `*.sites.lumitra.co` domain + bind the wildcard cert (manual MCP/UI, documented in the runbook).
21. Flip `EDITOR_HOST=app.lumitra.co` + `PUBLIC_SITE_BASE_HOST=sites.lumitra.co` in Infisical, retire the storefront-on-`app` seed assumption, redeploy.
22. Update `deploy/README.md`, `.env.example`, `deploy.yml` health URL.

---

## Cross-Cutting Risks and Decisions

### Wildcard TLS (the central infra fork)

The current HTTP-01 (`proxied=false`) path cannot issue a wildcard cert. Two net-new options:

- **Option A: Cloudflare-proxied edge TLS** (orange cloud, `proxied=true` on the wildcard). Cloudflare terminates TLS at the edge; origin uses a Cloudflare Origin CA cert or Full mode. GOTCHA: free Universal SSL covers `lumitra.co` + `*.lumitra.co` only, NOT the second-level `*.sites.lumitra.co`. An edge cert for `*.sites.lumitra.co` needs Advanced Certificate Manager / Total TLS (paid, around 10 USD/month) OR a first-level wildcard apex. Pros: Cloudflare DDoS/CDN, instant new-subdomain coverage, no origin wildcard cert. Cons: paid for the depth, and proxied changes how the origin sees client IP/host (the middleware already reads `x-forwarded-*`).
- **Option B: Let's Encrypt DNS-01 wildcard via Coolify + a scoped Cloudflare API token** (Zone:DNS:Edit on `lumitra.co`). Traefik performs the DNS-01 challenge and issues a single `*.sites.lumitra.co` cert; record stays `proxied=false` (origin TLS). Pros: free, true origin TLS, arbitrary depth. Cons: a new scoped Cloudflare token (scaffold an Infisical PLACEHOLDER for Marlin to fill, never commit a real token), Coolify wildcard-cert config is manual proxy-level work, and one shared cert with ~90-day renewals is a single point to monitor.

**Recommendation:** Option B for `*.sites.lumitra.co` (free, matches the existing self-hosted-cert philosophy), reserving Option A (Cloudflare for SaaS) for the later `customHostname` phase.

This step is irreversible-ops (DNS + cert + Coolify fqdn) and is explicitly parked for a hands-on session with Marlin. The app-side subdomain allocator can land and be unit-tested WITHOUT the DNS flip.

### Auth/session cookie-domain across editor vs *.sites (the security decision the target hinges on)

`lumitra_session` is set by auth-brain (`auth.lumitra.co`), NOT by this app. For the editor at `app.lumitra.co` to read it, the cookie needs `Domain=.lumitra.co`. But that scope would ALSO transmit the editor session cookie to every tenant storefront at `*.sites.lumitra.co` (anonymous, tenant-influenced content): a session-leakage risk. Decide one of: a host-only cookie on the editor host; a distinct cookie domain for the sites zone; or putting published sites on a different registrable domain. This is an auth-brain cookie-config decision external to framer-clone and MUST be resolved before opening the wildcard sites zone.

### Subdomain uniqueness

`SiteDomain.subdomain` is globally `@@unique` and the public read depends on it (one host, one site, no workspace filter). The `@@unique` is a PARTIAL unique on a nullable column (many NULLs allowed), so the allocator must ALWAYS write a non-null label to get enforcement. Collision handling must be DB-enforced (insert + catch `P2002` + retry), never check-then-insert. Re-publish must reuse the same label for a stable public URL.

### Tenant scoping on every query (the correctness trap)

The `site_*` write path is already session-scoped and correct. The DANGER is the READ path: `resolvePublishedSite` currently drops the tenant, and CMS + commerce hydration read MODULE CONSTANTS, not the resolved site's tenant. Shipping the wildcard before fixing item 12 means every published site renders one global tenant's CMS + commerce data. The interim admin secret (item 13) is the matching write-side hole. Both must be closed as part of going multi-tenant, not deferred (per the no-tech-debt and production-grade rules). CMS isolates by a `workspace_id` column; commerce isolates by Postgres schema via `SET LOCAL search_path`. A correct render must derive BOTH from the one resolved Site row.

### Per-user vs per-workspace ownership

"Each user sees only their own projects" is satisfiable two ways: (a) auth-brain gives each user a personal workspace (zero schema change, the model is ready), or (b) add `Site.ownerUserId` for finer per-user filtering inside a shared workspace. Pick (a) unless shared-workspace multi-user is a near-term requirement.

### Sequencing note

Wildcard DNS + TLS is necessary but NOT sufficient: a published site with no `SiteDomain` row still 404s. Sequence the app-side subdomain allocator (B) WITH the infra flip (E). And flipping `EDITOR_HOST` to `app.lumitra.co` without the `/projects` routes + cookie decision in place would expose an un-gated editor at the app root.

---

## Positive Findings (cheap-path observations)

- The host-routing logic was built apex-agnostic on purpose. The flip is config-only.
- The middleware tests already encode the TARGET arrangement (`EDITOR='app.lumitra.co'`); only the committed deploy env/docs are inverted, not the code.
- `listSites` (dashboard query) and `loadProject` (per-project load) already exist, workspace-scoped, just unused by any route.
- The `site_*` data model, `scope.ts`, and the publish-write authorization are already multi-tenant-correct.

The migration is mostly routing + editor-shell code, the publish subdomain allocator, removing the interim admin secret, the render-path tenant threading, and an env/DNS/TLS flip. The one genuinely large unbuilt data concern is commerce tenancy, which is separable and gates multi-tenant commerce only.
