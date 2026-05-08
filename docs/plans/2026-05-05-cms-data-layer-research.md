---
title: CMS and Data Layer Research for Framer-Clone-Built Apps
type: plan
status: draft
date: 2026-05-05
tags: [research, cms, data-table, data-layer, multi-tenancy, framer-clone, bubble-killer]
projects: [framer-clone, data-table, storage-brain, auth-brain]
summary: Research session on how framer-clone should provide a CMS and runtime data layer to apps that customers BUILD with framer-clone (the Bubble-killer thesis). Recommendation: ship Shape A (a hosted multi-tenant Postgres-backed data service powered by data-table's adapter-prisma), reuse storage-brain for files but require a workspace-scope tightening, and make end-users of customer-built apps live in a per-app users table inside the customer's workspace until auth-brain Phase 3.5 (OIDC for end-users) is real.
---

# CMS and Data Layer Research for Framer-Clone-Built Apps

> Strategic research doc. Not a build plan. Captures how the framer-clone-as-Bubble-killer thesis lands a CMS / runtime data layer for apps that NON-DEVELOPERS build, and whose END-USERS write data. Conclusion at the bottom.

## Revisions: 2026-05-05 (senior-review and phasing)

The original recommendation below remains the architectural target. This section overrides it where noted.

### A. Phasing: Framer parity first, Bubble-killer second

The strategic thesis has been refined: ship Phase 1 (Framer parity) before Phase 2 (Bubble-killer expansion). Phase 1 is investor-demoable and matches a market that's already proven (Framer raised at high valuations, Webflow IPO'd at ~$4B+). Phase 2 expands into the Bubble market once Phase 1 has real customers.

**Phase 1 (Framer parity, ~5 to 8 months) is in scope:**
- CMS service `cms.lumitra.co` for site-owner-managed collections (this plan)
- Schema-per-tenant from Day 1 (see Revision B)
- Read-only data-bindings: Collection, RecordView, TableView, page params
- Static HTML publish with read-binding hydration
- File uploads via storage-brain (existing two-tier model, no end-user enhancements)
- Site-owner auth via auth-brain v1 (cookie SSO)
- Editor multiplayer (separate plan: `2026-05-05-editor-multiplayer-research.md`)
- AI agent Pattern A inline assistant (separate plan: `2026-05-05-ai-agent-layer-research.md`)
- Lumitra Studio Phases A and B

**Phase 2 (Bubble-killer expansion, ~4 to 6 more months) is OUT of v1:**
- `app_users` table per workspace and end-user session issuance (Option B from research question 2)
- Write data-bindings: Form, LoginForm, OwnerOnly, RelationField, FileField, SubmitButton
- Storage-brain enhancements (`metadata.owner_id`, public/private flag, end-user-scoped signed URLs, per-`owner_id` rate limits)
- AI agent Pattern B (full-app scaffolding with schema generation)
- Stripe Connect for customer-to-end-user billing

**Phase 1 must DESIGN the Phase 2 seams without BUILDING them.** See Revision F for the eight design-now-build-later decisions.

### B. Tenancy isolation default: schema-per-tenant from Day 1 (overrides research question 4)

The original plan recommended row-level isolation with workspace_id filtering and noted per-tenant schemas as a future scale mitigation. **Reverse this.** Schema-per-tenant is the default from Day 1. Reasons:

1. Single-tenant restore ("Acme accidentally deleted their Contacts collection, restore from yesterday") is operationally tractable with `pg_dump <schema>`. Row-level requires a separate recovery instance.
2. Compliance audits (SOC 2, ISO 27001, DSGVO) get a clean answer (data is physically isolated at the database namespace level) instead of a query-enforcement story.
3. The "real tables per collection" architecture creates a flat global namespace under row-level isolation. By 10K tables (1000 customers x 10 collections), `pg_class` queries get noticeably slow and autovacuum work multiplies. Schema-per-tenant groups each customer's tables, which Postgres handles more gracefully.
4. Per-tenant export becomes `pg_dump tenant_acme` instead of custom export logic.
5. Future move to "this customer is on its own database" (enterprise tier) is just `pg_dump | pg_restore` of one schema.

**Cost of doing this Day 1:** roughly 2 to 3 extra weeks for schema-routing infrastructure and a migration runner that applies DDL across N schemas.

**Cost of retrofitting later:** multi-month migration project moving live customer data, with downtime risk.

The "1000+ customers triggers per-tenant schemas" caveat in Recommendation paragraph 1 below goes away because we already have it from the start.

`adapter-prisma` will need a `searchPath` parameter (Prisma supports this via connection options). Each request resolves the workspace, looks up its tenant_group / tenant via auth-brain, sets `search_path` to `tenant_<id>`, then runs the data-table operation.

### C. Auth timeline correction (overrides research question 2 caveat estimate)

Research question 2's recommendation (Option B: framer-clone runtime issues end-user sessions) is the right call. The timeline estimate is wrong. The plan said "2 to 3 weeks of focused work." Realistic breakdown for production-grade end-user auth:

| Feature | Weeks |
|---------|-------|
| Signup, login, logout (email/password) | 1.5 |
| Email verification (send + click-back + mark verified) | 0.5 |
| Password reset via one-time email token | 0.5 |
| Rate limiting (per-IP, per-email, per-account) | 0.5 |
| Audit log | 0.3 |
| Cookie domain handling for customer subdomains | 1.0 |
| Per-customer auth config (which methods this app offers) | 1.0 |
| CSRF, security headers, session rotation | 0.5 |
| Account deletion + GDPR data export | 0.5 |
| Email deliverability setup (DKIM, SPF, DMARC, anti-spam) | 0.5 |
| Bot protection (captcha) | 0.5 |
| OAuth callbacks if Google login is offered | 1.5 |
| Polish, edge cases, end-to-end tests | 1.0 |

Total: **8 to 11 weeks**, not 2 to 3. Excludes MFA (another 2 weeks if shipped in v2).

This is Phase 2 scope per Revision A. Phase 1 site-owner auth is auth-brain v1's responsibility, not framer-clone's.

**Build vs buy is a real open question for Phase 2.** Clerk or Supabase Auth could shortcut the 8 to 11 weeks at the cost of a vendor dependency. Not yet evaluated. Add to Phase 2 research backlog.

### D. Data-binding layer subsection (expands research question 5 stub)

Research question 5 said "Stateful with a runtime contract (Form, Collection, LoginForm): need a runtime data-binding layer that the headless renderer can resolve. This is a larger architectural addition." That sentence hides 12 to 13 weeks of polished engineering. Real breakdown:

| Piece | What it is | Weeks |
|-------|-----------|-------|
| Template / expression language | Parse and evaluate `{{row.name}}` syntax. Pick one (Bubble has its own; Plasmic uses JS expressions). | 2.0 |
| Editor binding UX | "Bind to..." dropdown lists collections > columns. Right-sidebar shows what's bound. Autocomplete. | 2.0 |
| Visual filter / sort / limit builder | Customer wants "Contacts where status=active sorted by name". UI surface in the editor. | 1.5 |
| Form component with field-bound inputs | Form knows the collection, fields know columns, Submit button knows the action. | 1.5 |
| Collection component with row template repeat | Repeats child template per row, passes row data into binding scope. | 1.0 |
| Loading / error / empty states | Each data-bound component has at least 3 states the customer designs. Editor exposes this. | 1.0 |
| Pagination | Cursor-based or page-based. | 1.0 |
| Validation rules | Required fields, type validation, custom rules. UI to declare them, runtime to evaluate. | 1.0 |
| Routing and page params | RecordView at `/contacts/:id` reads `:id` from URL, fetches that row. | 0.5 |
| Reactivity strategy | Polling for v1 (every 5s refetch). Plan for live subscriptions in v2. | 1.0 |

Total: **12 to 13 weeks** for a credible MVP of the runtime data-binding layer. Excludes optimistic updates (another 2 to 3 weeks).

In Phase 1, only the read-side of this lands: Collection, RecordView, TableView, expression evaluation, filter/sort/limit, loading/error/empty states, pagination, routing, polling-based reactivity. That's roughly 8 of the 12 to 13 weeks. Form, validation, and write-bindings land in Phase 2.

The data-binding layer is the load-bearing piece of the customer's building experience. Bubble has spent years polishing this. Phase 1's read-only subset has to feel right or the whole product feels rough.

### E. Real-time on published apps: explicit scope

Phase 1 ships polling-based reactivity (refetch every ~5 seconds). NOT push-based real-time. Reasons:

- 90% of Phase 1 use cases (content sites, marketing pages, blogs) do not need push-based reactivity.
- Building Postgres-WAL-based real-time from scratch is months of work.
- Supabase Realtime conflicts architecturally with the "real tables per collection" pattern (see real-time research from session transcript).

Phase 2 may add push real-time via Postgres `LISTEN`/`NOTIFY` + SSE on top of the existing CMS service (~2 to 3 weeks) OR pull in Supabase Realtime as a channel layer specifically for that use case (decision deferred until customer interviews show it's needed).

**Editor multiplayer is a different question** (CRDT-backed collaboration in the canvas editor) and is covered by `2026-05-05-editor-multiplayer-research.md`. Does not depend on this plan.

### F. The eight design-now-build-later decisions for Phase 1

These are Phase 2 architectural seams that need to be present in Phase 1 to avoid expensive retrofit:

1. **Schema-per-tenant from Day 1** (see Revision B). Non-negotiable.
2. **CMS service auth layer designed for two principal types, only one implemented.** The auth middleware accepts either a site-owner cookie (auth-brain) or an end-user session token (Phase 2 stub returning 401 in v1). Routes are tagged with their accepted principal types. Cost now: zero design-time, Phase 2 fills in the stub. Retrofit cost without it: API redesign.
3. **Storage-brain `metadata.owner_id` reserved.** Optional metadata column already exists. Phase 1 leaves it null. Phase 2 starts populating it. Cost now: trivial. Retrofit cost without it: minor but real.
4. **Storage-brain `is_public` flag added Day 1.** Defaults to true (matching today's behavior). Phase 2 starts using false for end-user-private files. Cost now: 0.5 to 1 day. Retrofit cost without it: API contract break for existing consumers (receipts-app, etc.).
5. **Component registry shape allows write-bindings.** Don't build Form / LoginForm in Phase 1, but design the registry's binding-language schema so read-bindings AND write-bindings are different modes on the same primitive. Cost now: design decision. Retrofit cost: registry-format breaking change.
6. **AI agent tool surface includes Phase 2 tool stubs.** Tool schemas are defined now; only Pattern A's tools are wired up in Phase 1. Cost now: trivial. Retrofit cost: tool-API evolution for the agent.
7. **`app_users` schema documented but not built.** Per-workspace table, OIDC-shaped columns. Document the schema in this plan's Phase 2 section. When Phase 2 builds it, the migration is trivial. Cost now: 1 to 2 hours of design.
8. **Editor multiplayer rooms are workspace-scoped from Day 1.** Yjs document's room ID = workspace ID. Site owners and team members editing the same project share the room. Phase 2 doesn't change this; end-users of customer-built apps are not in the editor at all. Independent of Phase 1 vs Phase 2 split.

### G. Multi-tenant Postgres operations is a permanent ops tax

The original plan hand-waved this as "operational maturity around multi-tenant Postgres that Marlin's team does not have today." A senior dev review concretizes the ongoing cost:

- Per-customer monitoring and slow-query attribution
- PgBouncer (or equivalent) connection pooling to handle 100+ tenant connection concurrency
- Resource governance (`statement_timeout`, query result-size limits, query analyzer for expensive queries)
- Schema migrations across N tenant schemas during low-traffic windows
- GDPR right-to-be-forgotten across shared infrastructure
- Disaster recovery runbooks (RTO, RPO, regional standby)
- On-call when 1000 customers depend on uptime
- Per-tenant restore from backup (a runbook before the first customer asks)

Estimate: 1 week of operational tooling at the start, then ~10 to 20 percent of one engineer's time forever. Real ongoing cost, not a one-time setup.

### H. Soft dependency cycle requires request-scoped tokens, not a global service-account key

The original plan's framer-clone-runtime-reads-app_users service-account approach is too broad: a global service-account key with read access to ALL workspaces' `app_users` exposes every customer's user data if the runtime is compromised. **The right shape:** auth-brain issues a per-customer-app token at publish time, scoped to a single workspace, embedded in the published app's deployment. The runtime can only read `app_users` for its bound workspace. Tokens are rotatable. Cost: 1 to 2 weeks. Phase 2 dependency.

### Summary of timeline corrections

- Phase 1 (Framer parity): 5 to 8 months
- Phase 2 (Bubble-killer expansion): 4 to 6 more months
- **Total realistic build: 9 to 14 months** (down to 9 to 12 if Phase 2 starts before Phase 1 fully polishes, up to 14 if integration debt accumulates)

Original plan's implicit "few months for the CMS service" reflected only the happy-path engineering. The corrections above bring it in line with reality.

---

## Why we are even asking this

Three forces created the question:

1. **The strategic thesis** (`memory/project_strategic_thesis_bubble_killer.md`) says framer-clone is positioned as a Framer-quality visual builder for non-developers building APPS, not sites. Bubble's wedge is that a non-developer can build a real app with logins, a database, and forms, all in one tool. Framer-clone has the visual canvas. It does not have the data layer or the end-user auth path.
2. **The Data Brain track is dead.** Data Brain (the planned generic multi-tenant database HTTP service) was archived 2026-03-22. The decision note in `knowledge-base/research/2026-03-08-byos-bring-your-own-infrastructure.md:21` is explicit: BYOS is deferred, Data Brain's HTTP API layer is no longer pursued, all current consumers use `adapter-d1` or `adapter-prisma` directly. We need to understand WHY before recreating it.
3. **auth-brain v1 covers framer-clone customers, NOT their app's end-users.** The auth-brain spec at `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` only handles `*.lumitra.co` cookie SSO for suite users. End-users of an app a customer builds in framer-clone live in a different identity space. Phase 3.5 (OIDC Provider, Month 8 to 10, see spec section 6.1) is the eventual home, but that ships months after the data-layer story has to exist.

The question is whether to revive a hosted data service under a different name (Shape A), or to make framer-clone a thin BYOD harness (Shape B), and how the answer maps onto the auth-brain three-tier hierarchy.

## Current data-layer primitives in the suite

Useful before evaluating shapes.

### data-table runtime table creation (the Marlin lead)

The package at `projects/data-table/` is a Notion-style component library with a 41-method `DatabaseAdapter` interface. The architecture doc at `projects/data-table/docs/architecture.md:169` to `:267` describes exactly the runtime-table-creation behaviour Marlin referenced. The shape:

- Each user-created "table" becomes a real SQL table whose name is the `tbl_<id>` table ID (`adapter-prisma/src/ddl.ts:21` `createRealTable`). Identifiers are sanitized via `safeTableName` / `safeColumnName` from `adapter-shared` to prevent SQL injection.
- System columns (`id`, `_archived`, `_created_at`, `_updated_at`, `parent_row_id`) are always created. Each user column is added as a real `TEXT` column via `ALTER TABLE ... ADD COLUMN` (`ddl.ts:61`).
- Type-aware filtering uses CAST expressions plus expression indexes (`((col_x)::NUMERIC)` for number, `::TIMESTAMPTZ` for date) created via `createExpressionIndex` (`ddl.ts:91`). Column-type changes (e.g. number to text) are metadata-only: no DDL, no data migration. This is the architectural payoff of TEXT-everywhere with expression indexes.
- DDL plus metadata writes are wrapped in a Postgres transaction via `atomicDDL` (`ddl.ts:138`), so a half-applied schema change cannot leave the system inconsistent. PostgreSQL is the only adapter that gets full transactional DDL today; D1 has a table-rebuild fallback (`adapter-d1/src/ddl-compat.ts`).
- Multi-select, relation, and file values are NOT stored in the per-table real table. They go into shared junction tables: `dt_row_select_values`, `dt_relations`, `dt_files` (see `adapter-prisma/prisma/schema.prisma:51` to `:85`). The per-row real-table query joins these in batch via `batch-loader` from `adapter-shared`.
- Formula and rollup columns are NOT stored at all. They are computed post-query by `FormulaEngine` (65 built-in functions, `core/src/formula/`) and `RollupEngine` (14 aggregations, `core/src/rollup/`).
- Lazy migration: tables created before the real-table change live as JSON blobs in `dt_rows`. On first access, the adapter checks `dt_tables.migrated`, copies data into a freshly-created real table, marks the row migrated, and from that point on all reads / writes hit the real table. Original `dt_rows` data is preserved for rollback.
- Workspace scoping: every `DtTable` has a `workspaceId` column (`schema.prisma:13`). `listTables(workspaceId)` (`adapter.ts:181`) filters by it. There is NO tenant_group or tenant scoping today. The adapter assumes a single Postgres database per deployment with workspace as the only multi-tenancy boundary.

This is mature, production-shaped code. It is the right engine for "framer-clone customer creates a new collection at runtime in their app". The work needed is upstream (HTTP layer, three-tier auth scoping, end-user auth) not in the table-creation primitive itself.

### storage-brain tenancy

Storage-brain at `projects/lumitra-infra/storage-brain/docs/public/architecture.md` is a two-tier model: `tenant > workspace`. `tenants` rows hold the API key hash and global quota (`architecture.md:76`). `workspaces` rows belong to a tenant and have their own quota (`:89`). `files` rows reference both `tenant_id` and a nullable `workspace_id` (`:103`).

Auth happens via API key hash lookup at the tenant level. Workspace selection is a parameter on each upload request. There is no tenant_group. There is no concept of "different end-users inside the same workspace each owning their own files".

A `StorageBrainFileAdapter` already exists (`projects/data-table/packages/file-adapter-storage-brain/`) and bridges data-table's file-column type to storage-brain. This means file-typed columns in a runtime-created table already flow through storage-brain today (in dev / test setups).

### auth-brain three-tier model

The auth-brain spec (`auth-brain-design.md:171` to `:432`) defines:

- `tenant_groups`: optional parent layer (holdings, agencies, chains). Self-recursive via `parent_group_id`.
- `tenants`: customer organizations / billing entities. Always belong to exactly one `tenant_group`. Slug is unique, used in `<slug>.lumitra.co` subdomain.
- `workspaces`: project sub-units inside a tenant. Slug unique per tenant.
- `workspace_memberships`: user-to-workspace with role `admin | member | viewer`.

Spec section 1.6 (`:136` to `:148`) is non-negotiable: apps NEVER query memberships directly. Always go through `auth.can(user, action, resource)`. This is what makes the model ReBAC-ready when OpenFGA gets wired in.

Spec section 7 (`:817` to `:875`) defines the per-scope role list. For workspaces: `admin` (full content control), `member` (read/write per app rules), `viewer` (read-only, deferred to v1.5). Apps export a permission registry (`framer-clone/src/permissions.ts`) mapping action names like `cms.collection.create` to required minimums like `workspace.admin`.

Implication for any data layer: framer-clone's CMS data is always scoped to a `workspaces.id` UUID, and every read / write must go through an `auth.can(...)` check that the SDK consumes from a registry. No direct membership queries.

### Why Data Brain was archived

Reading the historical notes (`knowledge-base/research/2026-03-04-lumitra-cloud-architecture-analysis.md`, `2026-03-08-byos-bring-your-own-infrastructure.md`, `2026-03-08-prisma-real-tables-database-adapter.md`, `2026-02-20-multi-tenancy-hierarchy.md`), the failure mode was:

- Data Brain was conceived as a generic, multi-tenant, BYOS-capable, HTTP-fronted database service for arbitrary suite apps to share.
- The complexity surface (BYOS credentials, per-tenant adapter resolution, schema evolution as an HTTP contract, real-time sync, hosted dashboard) was huge for a 1-person team.
- Each consuming app (Receipt OCR, framer-clone) ended up needing different adapter semantics anyway: Receipt OCR wanted Prisma directly, the visual builder wanted edge D1, etc. The HTTP indirection was paying for nothing.
- Decision (2026-03-22): kill the HTTP service, keep `adapter-prisma` and `adapter-d1` as direct in-process libraries.

The lesson for the Bubble-killer thesis: a generic shared HTTP database service for the whole suite is the wrong shape. A purpose-built data service for ONE consumer (framer-clone-built apps) with a tightly-bounded surface (CMS-style collections, not arbitrary SQL) is a different thing and is the actual question on the table.

## Research question 1: How do Bubble, Webflow, Glide, Plasmic, Adalo do this?

Brief survey from public docs and behaviour on each platform.

### Bubble

Hosted single-instance app database per Bubble app. Customers visually design "Data Types" (Bubble's term for collections) and "Fields". Schema lives in Bubble's managed Postgres (since 2023; previously bespoke). End-users of a Bubble-built app sign up via Bubble's built-in user system, which is a `User` table that's just another data type with a few special fields. Permissions ("Privacy Rules") are row-level expressions (`Current User is Owner` etc.). Bubble's "API Connector" lets builders expose REST endpoints, but the primary path is in-app data binding through visual workflows.

Key shape: hosted multi-tenant Postgres, schema-per-app, end-users are first-class rows in the app's User table. No BYOD by default. Privacy Rules are evaluated at query time on the server. This is Shape A.

### Webflow Logic / Webflow CMS

Webflow CMS is content-shaped: collections of structured content (blog posts, products), edited by the site owner, READ by end-users. Webflow Logic adds form submissions and basic conditional flows but is not a general-purpose database. End-user-writable data lives in Webflow Forms or in a third-party integration (Memberstack for memberships, Xano / Airtable for data).

Webflow effectively says: "we're a CMS, not an app database. If you need user-writable data, integrate." Bubble customers do not switch to Webflow because of this gap.

### Glide

Hosted, but the data layer is a Glide-managed table (Glide Tables) OR a connected Google Sheet / Airtable / SQL database. Schema is visual. End-users authenticate via Glide's own auth (email magic links, Google, etc.). Permissions are row-owner based.

Shape A by default (Glide Tables) with optional BYOD. Notable: Glide's BYOD path through Google Sheets is the dirty-hack-but-it-works origin story for the platform.

### Plasmic

Plasmic is a visual builder more in Builder.io's lane: it's a CMS dropped into the customer's existing app. Plasmic doesn't ship its own runtime database; it ships React components that the customer then wires to whatever data layer they own. Their CMS feature is content-shaped (similar to Webflow CMS), not user-writable.

Plasmic is explicitly NOT a Bubble competitor. Confirms that "visual builder + integrate-with-existing-stack" is a different market than "build me a whole app with users and data".

### Adalo

Hosted database per app, similar to Bubble but mobile-first. End-users sign up via Adalo's user system. Schema visually edited. Confirms Shape A is the dominant pattern for the no-code-app-builder category.

### Pattern across all five

The platforms that win the "non-developer builds a whole app" market (Bubble, Glide, Adalo) ALL ship a hosted, managed, schema-per-app database with end-users as first-class rows. The platforms that don't (Webflow, Plasmic) target a different customer who already has a data layer.

If framer-clone's positioning is Bubble-killer, the data shape has to be Shape A. Shape B (BYOD only) puts framer-clone in Plasmic / Builder.io territory, which is a different market.

## Research question 2: Tenancy mapping

Three-tier auth-brain hierarchy plus end-users of customer-built apps. The candidate identity spaces:

| Identity | Lives where (today) | Lives where (Phase 3.5+) |
|----------|---------------------|--------------------------|
| Framer-clone customer (the builder) | `auth-brain.users` | same |
| Customer's tenant_group / tenant / workspace | `auth-brain.tenant_groups` etc. | same |
| End-user of a customer-built app | does not exist yet | `auth-brain.users` via OIDC realm? per-app users table? |

The mapping question: where does an end-user of a customer-built app live, both today and after Phase 3.5?

### Option A: End-users live in auth-brain

Treat every end-user of every customer-built app as an `auth-brain.users` row. Pre-3.5, they get a session cookie scoped to the customer's published-app domain (not `*.lumitra.co`). Post-3.5, the customer's published app becomes an OIDC client of `auth.lumitra.co` (the OIDC Provider added in Phase 3.5).

Pros: one identity table, one audit log, MFA / password-reset / OAuth-Google flows reused for free, OIDC-shaped from day 1 (spec enterprise seam #3, `:159`).
Cons: pollutes `auth-brain.users` with potentially millions of end-users per customer, mixing them with suite users in the same table. Audit log becomes massive. Tenant-namespacing of end-users requires a new column (`origin_tenant_id` or similar) that's not in the v1 spec. End-user signup flows require non-`*.lumitra.co` cookie domains, which auth-brain v1 explicitly does not support.

This is the "right long-term" answer but requires meaningful changes to auth-brain that are not in the v1, v1.5, or v2 roadmap.

### Option B: End-users live in a per-workspace `app_users` table managed by framer-clone

Every customer-built app has its own end-user table inside its workspace's data layer (just another data-table collection, with a fixed shape: id, email, password_hash, email_verified, etc.). Framer-clone runtime ships a tiny session library that issues cookies on the customer's published-app domain.

Pros: zero auth-brain changes. Auth-brain stays focused on suite users. Each customer's end-users are physically isolated by workspace. Framer-clone owns the entire end-user UX (signup form, login form, password reset email template) and can iterate quickly. Simple migration story when Phase 3.5 ships: the `app_users` table becomes the source of truth that the customer-app OIDC client federates against, OR the customer can opt to migrate their end-users into the new realm.

Cons: framer-clone is now in the auth business (sessions, password hashing, email-verification flows, rate-limiting). This is not nothing. But the surface is small (sign up, log in, reset password, verify email) and auth-brain v1 has already documented all the patterns (rate-limit table shape, audit-log shape, password storage shape) that framer-clone can copy.

### Option C: End-users live in auth-brain Phase 3.5 OIDC realm with a per-tenant scope

Wait for Phase 3.5. Don't ship end-user auth in framer-clone published apps until then.

Pros: zero new code in framer-clone.
Cons: blocks the entire Bubble-killer thesis until Month 8 to 10. The lead-capture validation spike (per the strategic thesis) cannot ship without end-user auth. Unacceptable timeline.

### Recommendation: Option B today, with a clear migration to a hybrid in Phase 3.5

Build a minimal end-user auth path inside framer-clone's runtime. Keep its schema OIDC-shaped from day 1 (the v1 enterprise seam #3 from auth-brain spec applies to us too). When Phase 3.5 ships, give customers an opt-in toggle: "use Lumitra OIDC realm for end-users" (federate via auth-brain) vs "keep using the built-in app_users table". Both keep working forever.

This keeps the dependency unblocked, respects what auth-brain v1 actually delivers, and creates a clean migration without forcing a rewrite.

## Research question 3: storage-brain compatibility

storage-brain is two-tier (tenant > workspace). auth-brain is three-tier (tenant_group > tenant > workspace). The gap matters because storage-brain's `tenants.id` does not align with `auth-brain.tenants.id`: storage-brain pre-dates auth-brain's three-tier model.

### Mapping options

**(a) Storage-brain `tenant` = auth-brain `tenant`, storage-brain `workspace` = auth-brain `workspace`.** Means a storage-brain tenant is created for each auth-brain tenant on first use, and storage-brain workspaces are created for each auth-brain workspace. tenant_group has no presence in storage-brain. Quota enforcement is per-tenant and per-workspace, which lines up with how billing should land.

**(b) Storage-brain `tenant` = auth-brain `tenant_group`, storage-brain `workspace` = auth-brain `tenant`.** Loses workspace-level isolation, breaks the model. Don't do this.

**(c) Storage-brain `tenant` = framer-clone-as-app, storage-brain `workspace` = auth-brain `workspace`.** This is what storage-brain is doing TODAY in dev: one API key for all of framer-clone, workspace = whatever. Loses per-tenant quota and per-tenant rate-limiting. Don't do this in production.

**Recommendation: (a).** When auth-brain creates a tenant (via signup or invitation), an outbox event fires (`outbox_events`, spec `:421`). A storage-brain provisioning consumer drains the event, calls `POST /api/v1/admin/tenants` on storage-brain, stores the resulting API key in auth-brain's `tenants` row (or a sibling `tenant_external_ids` table). Same pattern when a workspace is created. This is the same provisioning seam mail-brain uses (spec section 5).

### Gaps to close before storage-brain is ready for customer-built apps

1. **Per-end-user file ownership.** Today storage-brain has no concept of "which end-user uploaded this file". Files belong to a workspace. When a customer-built app has 10,000 end-users uploading profile pictures, all those files are commingled at the workspace level. Storage-brain needs a free-form `owner_id` column (or use the existing `metadata` JSONB) for the customer's `app_users.id`. Quota per end-user is then a customer-level enforcement decision, not storage-brain's job.
2. **Signed-URL scoping by end-user.** Currently signed download URLs are tenant-scoped. For end-user-private files, the signing logic needs an end-user-id claim. Could be done by the customer-built app's runtime: framer-clone runtime requests a signed URL from storage-brain with end-user-id baked into the signed URL's HMAC payload, then validates the inbound request's end-user session matches.
3. **Public-vs-private file flag.** Today every file is signed-URL-only. A customer-built app needs both: public-by-URL files (avatar, product photo) and private-to-end-user files (uploaded receipts, contracts). Storage-brain has the primitives (signed URLs already exist) but the API doesn't yet expose a "make this file public-by-URL" toggle.
4. **Rate-limiting on the upload-request endpoint.** A customer-built app's end-users uploading directly through framer-clone's runtime to storage-brain creates a rate-limit edge case: storage-brain's per-tenant rate limit is shared across all end-users. Need per-`owner_id` rate limits (or framer-clone runtime enforces them).

None of these are blockers for a validation spike (1 customer, ~10 end-users, ~100 files). All four are required before any real customer ships an end-user-facing app at scale.

**Verdict:** storage-brain CAN serve as the file backend, but with these four enhancements. Do not let a customer ship to production end-users on storage-brain as it stands today.

## Research question 4: Two integration shapes for data-table

### Shape A: Hosted multi-tenant data service

Stand up a new service: `cms.lumitra.co` (working name, not committed). Architecture:

- Single Cloudflare Worker (or Hetzner Coolify Node.js) HTTP service in front of a single shared Postgres (Hetzner-managed).
- Imports `@marlinjai/data-table-adapter-prisma` directly. No fork.
- Auth: every request carries an auth-brain session cookie OR an end-user session token. The service resolves `(workspaceId, endUserId?)` from the token, then calls into adapter-prisma with workspace scoping.
- Schema is workspace-scoped: `dt_tables.workspace_id` is the auth-brain `workspaces.id` UUID. Per-table real tables are still named `tbl_<id>`, where `<id>` is unique across the entire database (so no per-workspace naming collision).
- Permission registry: `cms.collection.create`, `cms.collection.delete`, `cms.row.read`, `cms.row.write`, `cms.row.write_own`, etc. Scoped per workspace via `auth.can()`.
- End-user writes go through a different code path: framer-clone's runtime presents an end-user session token (issued by the per-app `app_users` flow), and the service applies row-owner predicates ("can this end-user read row X" requires `row.owner_id = endUserId` OR `row.public = true`).
- File columns delegate to storage-brain (per Research question 3 mapping).

Pros: 
- Bubble-shaped customer experience: customer creates a collection in framer-clone's editor, end-users immediately read / write through the published app, no DB credentials anywhere.
- Reuses 95% of `adapter-prisma` and the Notion-style data-table editing UX in the editor.
- Single deployment, single migration story, single backup story. Operationally tractable for a 1-person team.
- Schema evolution is metadata-only most of the time (column type changes are TEXT-everywhere with expression indexes).
- Clean alignment with auth-brain's three-tier model: workspace_id is the natural data-scoping boundary.

Cons:
- We are operating a multi-tenant Postgres. Quota, isolation, noisy-neighbour, backup-per-tenant all become our problem. Postgres can hold thousands of tenants on shared hardware, but the operational discipline is non-trivial.
- "Real tables" architecture means N customers x M collections each = N*M physical Postgres tables. At 1000 customers averaging 10 collections, that's 10k tables. Postgres handles this, but `pg_class` queries get slow, autovacuum work multiplies, and `information_schema.columns` lookups (used by `getTableColumnNames`, `ddl.ts:152`) become noticeable. Mitigation: per-tenant Postgres schemas (`SET search_path TO tenant_<id>`) or sharded databases per tenant_group at scale. Both are deferable.
- This IS what Data Brain was, conceptually. The difference: Data Brain tried to be a general-purpose multi-tenant database for ANY app in the suite. The new shape is purpose-built for ONE consumer (framer-clone-built apps), with a fixed bounded API (CMS-style collections, not arbitrary SQL). Smaller surface, narrower contract, clearer success criteria.

### Shape B: Component library, BYOD per workspace

Customer brings their own Postgres (or any data-table-supported adapter), supplies a connection string per workspace, framer-clone's published runtime configures the adapter against the customer's database.

Pros:
- No data-plane operations for us. Customer owns their data.
- Aligns with archived BYOS research (`knowledge-base/research/2026-03-08-byos-bring-your-own-infrastructure.md`).
- Enterprise-friendly long-term (data residency, compliance).

Cons:
- Non-developer customer experience is broken on day 1. The Bubble-killer thesis depends on "no setup, you just build". Asking a non-developer to provision a Postgres on Neon / Supabase / Hetzner before they can build a form is the antithesis of the positioning.
- Credential management complexity (encryption at rest, rotation, validation) re-introduces all the BYOS surface that Data Brain's archive note explicitly retired.
- Schema evolution becomes per-customer-database: framer-clone's editor has to coordinate DDL against an arbitrary customer-managed Postgres, with all the firewall / version-skew / connection-pool failures that implies.
- This is Plasmic's positioning, not Bubble's. Different market.

### Pick

**Shape A.** Marlin's strategic thesis explicitly targets non-developers. The Bubble market validates the willingness-to-pay for a hosted data layer. Shape B works for enterprise but does not move the needle on the validation spike that the thesis hinges on. Shape A revives the operational shape of Data Brain ONLY for framer-clone-built apps, with a much narrower API (collection CRUD, not arbitrary SQL), and lessons from the Data Brain archive applied (no BYOS, no general-purpose-multi-suite ambition, no HTTP indirection beyond what's needed for the customer's published app).

A future Shape B addon ("connect your own Postgres" toggle per workspace, enterprise tier) is plausible 12+ months out without invalidating Shape A's architecture. The adapter pattern in `data-table` makes this clean: BYOD is just a different `DatabaseAdapter` instance, swap at the workspace level.

## Research question 5: Component registry implications

What new framer-clone canvas components are needed to make a data-bound app? Sketch only, not implementation.

Today's registry (`src/lib/componentRegistry.ts:33`): Text, Button, Image, Container, Stack, Grid, Flex, Card. All layout primitives. Zero data-bound components.

To ship a Bubble-grade app you need (rough categorization):

| Category | Component | What it binds to |
|----------|-----------|-------------------|
| **Data display** | `Collection` (was: `List` / `Repeater`) | A collection ID + filter / sort / limit. Renders a child template per row. |
| | `RecordView` | A single row by ID (typically from URL params or selection state). |
| | `TableView` | data-table's TableView wrapped as a canvas component, with columns picked from a collection. |
| | `BoardView` / `CalendarView` | Same wrap, less common as primary surfaces. |
| **Data input** | `Form` | A collection ID + an action: create, update, delete. Children are field components. |
| | `TextField` | One column of one collection (or a transient form value). |
| | `SelectField` | Bound to a select-typed column or to a static option list. |
| | `RelationField` | Bound to a relation column, picker-style. |
| | `FileField` | Bound to a file column, uploads via storage-brain. |
| | `SubmitButton` | Submits the parent `Form` action. |
| **Auth gating** | `LoginGate` | Wraps children, hides them unless end-user is logged in. |
| | `LoginForm` / `SignupForm` | Pre-built bindings against the `app_users` table. |
| | `LogoutButton` | Trivial. |
| | `OwnerOnly` | Wraps children, shows them only if `current end-user = row.owner_id`. |
| **Navigation / state** | `PageRoute` | A page bound to a URL pattern with parameters (`/products/:id`). |
| | `Link` / `NavButton` | Routing primitives that already half-exist today. |

That's roughly 15 new registry entries. They split cleanly into three groups by implementation complexity:

1. **Layout-only wrappers** (LoginGate, OwnerOnly): trivial, no state.
2. **Bound to data-table primitives** (TableView, BoardView): wrap the existing data-table components, hide adapter wiring, expose `collectionId` as a prop on the canvas.
3. **Stateful with a runtime contract** (Form, Collection, LoginForm): need a runtime data-binding layer that the headless renderer (`src/lib/renderer/HeadlessComponentRenderer.tsx`) can resolve. This is a larger architectural addition.

The Collection / Form / LoginForm components are the load-bearing ones. Without them, the canvas can render data but cannot accept user input or paginate. They are also the components that establish the data-binding shape for everything else (`{{collection.row.fieldName}}` template syntax, or whatever the binding language ends up being). Ship those first; the rest are derivatives.

This is overlapping with `docs/plans/2026-04-19-drag-drop-unification.md` and `2026-04-20-preview-mode.md` indirectly: the canvas has to know which components are containers and which are data-binding boundaries, and the preview mode has to be able to fetch real data (today it doesn't).

Recommendation: do NOT add data-bound components to the registry until Shape A's HTTP service is operational and the binding language is committed. Adding `Form` to the canvas without a real data layer behind it is decorative work that has to be redone.

## Research question 6: AI feasibility check

Schema design ("what fields does my Contacts collection have") is exactly the kind of step where a non-developer gets stuck in Bubble. Bubble's own UX is a mediocre form builder; users routinely create wrong-shaped tables and have to redo them.

A reasonable AI-prompt path:

1. User types: "I want a Contacts table with their name, email, phone, the company they work for, and any notes I add."
2. AI returns a proposed schema:
   - `name` (text, primary)
   - `email` (text, unique-validation suggestion)
   - `phone` (text)
   - `company` (relation to Companies collection? OR text? defaults to relation if Companies exists, else text and offers to create Companies)
   - `notes` (text, multi-line)
3. User accepts; framer-clone runtime calls `cms.collection.create` with this schema.

The data-table `DatabaseAdapter` already exposes `createTable` plus `createColumn` (one call per column) which fits a programmatic generation step cleanly. The AI's job is the natural-language-to-schema transform plus polite proposal of relations / select-options that the user did not explicitly request.

This overlaps materially with `docs/plans/ai-driven-page-generation.md` and the unfiled AI agent layer plan. Treat schema-from-prompt as one tool the AI agent layer exposes, not as a separate feature. The infrastructure (data-table adapter, HTTP service, permission registry) is the same either way.

**Verdict:** AI-driven schema design is genuinely high-value for the non-developer audience and is the kind of differentiator Bubble does not have. It's also the cheapest possible feature to add ON TOP of Shape A (the AI does the natural-language step, the existing adapter does the rest). Do not treat it as essential for v1, but plan the API surface assuming AI-driven schema-creation will be the dominant entry point within 6 months.

## Recommendation

**I recommend Shape A: a hosted multi-tenant Postgres-backed CMS service (working name `cms.lumitra.co`) powered by `@marlinjai/data-table-adapter-prisma`, scoped to auth-brain workspaces, with end-users of customer-built apps living in a per-workspace `app_users` collection until auth-brain Phase 3.5 (OIDC) is real, with file uploads federated to storage-brain after closing four enumerated gaps.**

Specifically:

1. **Stand up `cms.lumitra.co`** as a thin Hono service over `adapter-prisma`, single shared Hetzner Postgres, per-tenant database isolation deferred until the first customer hits the multi-tenant pg_class scale problem (estimated 1000+ customers). API surface is bounded: collection CRUD, column CRUD, row CRUD, relation CRUD, view CRUD. NOT arbitrary SQL. NOT BYOS. 
2. **Workspace scoping is the only data-scoping boundary.** auth-brain provides `workspaces.id` from the session; the CMS service trusts the session-verification result and applies it as a `WHERE workspace_id = $1` filter on every read / write. tenant_group and tenant scoping fall out automatically because workspace memberships transitively depend on tenant memberships per spec section 7.
3. **End-user auth lives in framer-clone's runtime, against a per-workspace `app_users` table.** Schema is OIDC-shaped from day 1 (`id`, `email`, `email_verified`, `name`, `picture`, `locale`, `password_hash`, MFA columns null but present), exactly as auth-brain's enterprise seam #3 prescribes for itself. Sessions issued on the customer's published-app domain. When auth-brain Phase 3.5 ships, customers can opt in to "use Lumitra OIDC realm for end-users", federating their `app_users` against `auth.lumitra.co`. Both paths coexist forever.
4. **storage-brain remains the file backend** but four enhancements ship before any customer goes live: per-end-user `owner_id` on files, end-user-scoped signed URLs, public-vs-private file flag, per-`owner_id` rate-limiting. Provisioning is via auth-brain outbox events, same pattern mail-brain will use.
5. **Component registry additions are deferred** until Shape A's HTTP service is real and the binding language is committed. Add `Collection`, `Form`, `LoginForm` first when the time comes. Everything else (`OwnerOnly`, `RecordView`, `RelationField`) is a derivative of those three.
6. **AI-driven schema design lands as a tool inside the AI agent layer**, not a standalone feature. The CMS service's `createColumn` / `createTable` API is what the AI calls. No special infrastructure needed.

The reasoning, condensed: Bubble, Glide, and Adalo all win their market with a hosted, schema-per-app database (Shape A). Plasmic and Webflow target a different customer with BYOD or read-only-CMS positioning (Shape B). Framer-clone's strategic thesis is explicitly the Bubble-shaped market, so Shape A is the only structurally correct answer. The Data Brain archive lesson does NOT contradict this: Data Brain failed because it tried to be a generic multi-suite database service; the new service is purpose-built for ONE consumer with a tightly-bounded API. The auth-brain three-tier model maps cleanly to workspace-scoped data, and the end-user-auth gap is bridgeable today (per-app `app_users` table) with a clean migration path to Phase 3.5 OIDC. Storage-brain serves files with four bounded enhancements.

**Caveats:**

- Shape A requires operational maturity around multi-tenant Postgres that Marlin's team does not have today. The first 50 customers can ride on a single Hetzner Postgres without issues. Beyond ~500, expect to either adopt per-tenant schemas (`SET search_path`) or shard by tenant_group. Do not pre-build either; add when measured pain shows up.
- Putting framer-clone in the auth business (issuing sessions for end-users of customer-built apps) is non-trivial. Estimate 2 to 3 weeks of focused work to ship a defensible signup / login / password-reset / email-verification flow, copying patterns directly from auth-brain's v1 design (rate limits, audit shape, password storage). Do not skip the rate-limiting and audit-log pieces; backfilling them is painful per the auth-brain enterprise-seams principle.
- The `app_users` table living inside the customer's workspace creates a soft dependency cycle: framer-clone runtime authenticates end-users by reading `app_users` from `cms.lumitra.co`, which in turn requires a session to read. Resolve with a service-account API key for the framer-clone runtime that has read-only access to `app_users` in any workspace it serves, separately from the customer's session. Document this as a privileged integration and audit accordingly.
- The validation gate from the strategic thesis ("2-week spike: lead-capture app end-to-end") can be done WITHOUT the full Shape A buildout. A spike-shaped path: Postgres on local Docker, single hard-coded workspace, no auth-brain integration, no storage-brain integration, just data-table + adapter-prisma + a hand-written Hono server. Use this to validate the DX claim. Only commit to the full Shape A build after the spike confirms the positioning.
- All four storage-brain gaps are tractable but they touch the storage-brain API contract. Coordinate with whoever owns storage-brain (Marlin) before any framer-clone code depends on the new fields.
- Phase 3.5's OIDC story is in the auth-brain v2 roadmap (spec section 12.3, `:1074`). If that timeline slips, the `app_users` path absorbs the slip without panic. This is the single most important reason to recommend Option B for end-user auth instead of Option C.

## References

- Strategic thesis: `~/.claude/projects/-Users-marlinjai-software-dev-ERP-suite-projects-framer-clone/memory/project_strategic_thesis_bubble_killer.md`
- auth-brain v1 spec: `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` (sections 1.6, 2.2, 6.1, 7)
- data-table architecture (real tables, lazy migration, adapter split): `projects/data-table/docs/architecture.md`
- data-table Prisma adapter DDL: `projects/data-table/packages/adapter-prisma/src/ddl.ts`, `:21`, `:61`, `:91`, `:138`
- data-table Prisma schema: `projects/data-table/packages/adapter-prisma/prisma/schema.prisma`
- data-table Prisma adapter `createTable` / `listTables`: `projects/data-table/packages/adapter-prisma/src/adapter.ts:91`, `:181`
- storage-brain architecture and tenancy: `projects/lumitra-infra/storage-brain/docs/public/architecture.md`
- storage-brain file adapter for data-table: `projects/data-table/packages/file-adapter-storage-brain/src/adapter.ts`
- Data Brain archive context: `knowledge-base/research/2026-03-04-lumitra-cloud-architecture-analysis.md`, `2026-03-08-byos-bring-your-own-infrastructure.md`, `2026-03-08-prisma-real-tables-database-adapter.md`, `decisions/2026-02-20-multi-tenancy-hierarchy.md`
- Framer-clone component registry: `projects/framer-clone/src/lib/componentRegistry.ts`
- Renderer-research stylistic precedent: `projects/framer-clone/docs/plans/2026-05-01-framework-agnostic-renderer-research.md`
- Adjacent plans (sequencing context): `projects/framer-clone/docs/plans/ai-driven-page-generation.md`, `2026-04-19-drag-drop-unification.md`, `2026-04-20-preview-mode.md`, `2026-05-02-event-layer-and-activity-feed.md`
