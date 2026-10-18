---
type: plan
status: completed
title: "Commerce data layer migration: Prisma → @marlinjai/tenant-db (schema-per-tenant-group, compliance-grade isolation)"
summary: "Migrate the framer-clone commerce data layer off Prisma multiSchema onto @marlinjai/tenant-db (Kysely over postgres.js, tg_<hex32> schema-per-tenant-group). Delivers a DB-enforced tenant data-segregation control (SOC2 CC6.1/CC6.3, HIPAA 164.312(a), ISO A.8.3) with an isolation.spec crown-jewel test as audit evidence. Money/stock-critical: preserves READ COMMITTED guarded-decrement semantics throughout."
date: 2026-06-27
tags: [multi-tenancy, commerce, tenant-db, kysely, prisma-migration, schema-per-tenant, compliance, soc2, hipaa, iso27001, isolation, postgres]
projects: [framer-clone]
---

# Commerce data layer migration: Prisma → `@marlinjai/tenant-db`

> **Reality (2026-10-17): completed.** CM-01 to CM-13 are merged or on their final branch. CM-10
> (pull request #92) moved every storefront route, the render path and the editor commerce routes
> onto the company's own `tg_<hex32>` schema, failing closed for a site without a tenant group.
> CM-13 (branch `feat/commerce-cm13-guards-prisma-teardown`) finished the plan:
>
> - **Guards in CI.** `pnpm lint:guards` runs `scripts/check-guards.mjs`, vendored from tenant-db
>   (the npm package ships only `dist/`), over all of `src` and `scripts`, as a step of the CI
>   verify job. KNOWN_TENANT_TABLES is read from the 19 `CREATE TABLE` statements of
>   `src/server/commerce/migrations/tenant`. Deviations from upstream, all stricter or more
>   precise: no core-package exemption for G1; `SET LOCAL search_path` and
>   `set_config('search_path', ...)` banned too (G2); G3 covers every SQL tag (Kysely `sql` under
>   any alias, postgres.js `tx` / `owner` / anything from `postgres()`), accepts a schema
>   qualifier only when it is interpolated, catches a quoted bare `"order"`, skips `ORDER BY`
>   and string values, and flags unreadable raw SQL (`sql.raw(`, `sql.table(`, `.unsafe(`). The
>   tenant DDL itself is not scanned (bare names are the runner's contract, section 4.2). Two
>   narrow allowances are listed in the script header (the backfill may use `.unsafe(` on the
>   legacy schema; the CMS seam `src/server/cms/withTenant.ts` may use `SET LOCAL`), and the
>   deliberate public / legacy decoy tables in the isolation suites carry a disable comment.
> - **Prisma out of commerce.** The 19 commerce models and 9 enums are gone from
>   `prisma/schema.prisma` (`schemas = ["public"]`), with every Prisma commerce repository, the
>   Prisma reserve and createOrder paths and their hand-written `SET LOCAL search_path` lines. The
>   Kysely code carries the canonical names (`createOrder`, `reserve`, `commerceReadRepository`,
>   `getCommerceServerRepository`, ...). Every legacy suite was ported to the tenant schema, so
>   money and stock coverage did not drop; the one guarantee not ported is the old
>   `reserved <= stocked` CHECK, which migration 006 removed on purpose for backorder.
> - **No Prisma migration, deliberately.** The historical migrations that created the shared
>   `commerce` schema stay in `prisma/migrations`, and none drops it: a database that still holds
>   commerce rows keeps them until `backfill-demo` has copied them into the company schema and the
>   company verifies green (section 9, step 4), and a deploy must never drop that data blindly.
>   With `commerce` no longer in `schemas`, Prisma does not diff it, so `prisma migrate dev` does
>   not propose the drop either (checked with `prisma migrate diff`: no difference; with
>   `commerce` still listed it would emit 19 `DROP TABLE` statements). Production holds no such
>   database today (retired 2026-09-10 without backups), so section 9's demo verification has
>   nothing left to verify; the one leftover is that a fresh database gets an EMPTY legacy
>   `commerce` schema from those migrations, recorded on the "Running again" roadmap line.
> - **Bug found and fixed on the way.** `provisionTenant` grants UPDATE and DELETE on all tables
>   after the migrations ran, which silently undid the append-only REVOKEs (orders, order lines,
>   credit notes, credit note refs, stock movements). `provisionCommerceTenant` now re-applies
>   them in the same provisioning transaction (`commerceProvisionOptions` in
>   `src/server/commerce/provisioning/provision.ts`); the ported `createOrder` and `pricing`
>   suites caught it.
>
> **Reality (2026-10-19): least-privilege owner.** Section 4.1 described `bootstrapAppRole`
> running `ALTER ROLE commerce_app SET search_path = ext` on every provision, which forced
> `commerce_ddl` to hold CREATEROLE plus an ADMIN grant over `commerce_app`. With
> `@marlinjai/tenant-db` 0.2 every provision passes `appRoleBootstrap: 'verify'`: it only reads
> the value, which `prisma/sql/commerce-roles.sql` sets as the superuser, and a wrong value fails
> with `AppRoleSearchPathError` (rolled back; 500 `commerce_misconfigured` on project create, a
> failed container start at boot). The roles file now takes CREATEROLE and the grant away on
> re-apply, and the start step refuses an owner that still holds either.
>
> Nothing in this plan remains open. Isolation stays schema-per-tenant-group on auth-brain tenant
> groups (confirmed by Marlin 2026-10-15), not one database per company.

## 1. Goal + decision context

Migrate the framer-clone **commerce** data layer off Prisma (`adapter-prisma` + 19 `@@schema("commerce")` models + the inert `withTenant` `SET LOCAL search_path` seam) onto **`@marlinjai/tenant-db`**: Kysely 0.27 over postgres.js, with one **`tg_<hex32>` Postgres schema per tenant-group**, provisioned/migrated by the shared runner, isolated by `withSchema` identifier rewriting (not connection `SET`), and backstopped by a per-tenant low-privilege role whose default `search_path = ext`.

This was **DECIDED by Marlin on 2026-06-27**: do it now, the ideal way. Scope is commerce only. CMS stays on its logical (`workspace_id` column) tier for this migration (see §9 for the optional convergence path).

**Why Prisma is out (proven, not theoretical).** The original MT-18 plan kept Prisma and relied on `prisma.$transaction(tx => tx.$executeRawUnsafe('SET LOCAL search_path TO "${schema}"'))`. A Docker probe proved Prisma multiSchema hard-qualifies every query with the model's `@@schema` (`"commerce"."table"`), so `SET LOCAL search_path` is a **no-op**: the qualified identifier always wins, the search_path never takes effect. This is exactly why the platform standard (`knowledge-base/standards/platform-data-layer.md`, 2026-06-08) retired Prisma for tenant data. The framer-clone `commerce/withTenant.ts` seam "works" today only because there is a single physical `commerce` schema and the model qualification points at it: the moment you need a *dynamic* per-tenant schema, the Prisma seam cannot deliver it.

**Why `tenant-db`.** `tenantDb(base, tgId)` returns a new immutable Kysely instance whose compiled SQL is schema-qualified (`tg_<id>.<table>`). No session state, so a pooled/Hyperdrive connection carries zero residual schema, and isolation is **safe by construction, not safe-if-you-never-forget**. The resolver (`tenantSchema`), factories (`tenantDb`/`globalDb`), provisioning runner (`provisionTenant`/`migrateAllTenants`), and CI guards already exist and ship with 104 tests in auth-brain. framer-clone does the four mechanical per-app things only (RECON 3 §0).

**The compliance driver.** Schema-per-tenant-group + per-schema least-privilege grants is **one foundational, auditable technical control: tenant data segregation enforced by Postgres, not by application discipline.** It maps to SOC2 CC6.1/CC6.3/C1, HIPAA 164.312(a)(1)/(c)(1), ISO/IEC 27001:2022 A.8.3/A.8.22. The logical tier (a `WHERE workspace_id = ?` filter) is a control that depends on app code being correct, so a single bad filter silently leaks and auditors weight it weaker. The physical tier moves enforcement into the platform: even a wrong filter cannot reach another tenant because the role has **no privilege** on the other schema. Commerce is money/stock and order-ledger data: this is the surface where a paying customer demands hard isolation and right-to-erasure (GDPR Art. 17). It is hard-to-retrofit once a shared ledger exists, which is why it is Day-1 work. Honest boundary in §7.

---

## 2. Where commerce is today (the migration source)

Single Postgres DB, two named schemas (`schemas = ["commerce","public"]`, multiSchema preview), one `PrismaClient` (`src/server/db.ts`). All 19 commerce models carry `@@schema("commerce")`; **none carry `workspace_id` or `tenant_group_id`** (commerce is at neither tier today: no logical column, and the physical seam is inert because `resolveCommerceSchemaForSite()` maps every site to the constant `COMMERCE_SCHEMA = 'commerce'`).

The blast radius (RECON 2): 5 repo files (`catalog.ts`, `order.ts`, `pricing.ts`, `read.ts`, plus the `reserve.ts` inventory heart), the `createOrder.ts` orchestrator, 4 API routes (`products`, `products/[handle]`, `inventory`, `orders`), the seed (`seedDemoSite.ts`), 9 raw-SQL sites, and the structural DDL (generated column, 3 triggers, 1 sequence, CHECKs, partial-unique indexes, REVOKEs) that was never Prisma-generated and lives only in migration SQL.

---

## 3. Target architecture

### 3.1 Consuming `@marlinjai/tenant-db` (separate repo)

framer-clone is **not** in the auth-brain pnpm workspace (`pnpm-workspace.yaml = packages/*`). Per the package-naming standard, cross-repo consumers pin a published semver range, not `workspace:*`.

- **Intended path (CM-01):** publish `@marlinjai/tenant-db` to npm (`publishConfig.access:public` is already set, `prepublishOnly` builds). It is currently a publish-READY but NOT-published package (`npm view` → 404). Then framer-clone adds `"@marlinjai/tenant-db": "^0.1.0"`.
- **Until published:** a pnpm `file:`/`link:` to the local checkout is acceptable for dev, but the convention is publish-then-pin. CM-01 owns the publish so every downstream spec can `pnpm add` a real version.

We consume the barrel + the `./node` subpath (framer-clone commerce runs in the Node/SSR runtime, not Workers). No Workers factory is needed for commerce.

### 3.2 The `tg_<id>` schema model, keyed on `tenantGroupId`

The physical wall is the **tenant-group** (the company/legal/billing boundary), never the workspace. Each tenant-group gets one `tg_<hex32>` schema (hyphens stripped from the UUID, derived from hex only, never echoed). The registry is the runner's `public.tenant_groups (id, slug, schema_name, status)` + per-schema `__tenant_db_migrations`. We do **not** build a second registry (the existing spec's `cms_core.tenant_schemas` + `ddlVersion` is replaced by `tenant_groups`).

Naming reconciliation, locked: `tg_<hex32>` (not `tenant_<id>`), `public.tenant_groups` (not `cms_core.tenant_schemas`), `ext`-only role-default backstop (not `SET LOCAL ... , public`, which is precisely the decoy-leak vector the isolation test traps).

### 3.3 Base handle + per-request scoped handle

- **Startup (once):** build the base singleton with `createNodeDb({ connectionString })` using the **low-privilege app role** (`commerce_app`, role-default `search_path = ext`). Replaces the single `PrismaClient` in `src/server/db.ts`. Immediately `await assertBackstop(base)` to fail fast if a deploy accidentally points Kysely at the owner role (whose path includes `public`, re-opening the bare-name leak).
- **Per request at the edge:** `const db = tenantDb(base, tgId)` where `tgId = assertTenantGroupId(site.tenantGroupId)`. **One immutable scoped handle per request**, threaded into every repo. Never re-derive per query (RECON 1 §2).

### 3.4 Rewiring the render path (MT-13 seam already built)

`src/server/commerce/tenant.ts` `resolveCommerceSchemaForSite(site: Pick<PublishedSite,'workspaceId'|'tenantGroupId'>)` is the single declared chokepoint and already takes `site.tenantGroupId`. Today it returns the constant `COMMERCE_SCHEMA`. It becomes the place that yields a `TenantGroupId`:

```
// src/server/commerce/tenant.ts (rewired)
export function resolveTenantGroupForSite(site): TenantGroupId {
  return assertTenantGroupId(site.tenantGroupId);
}
```

`getCommerceServerRepository(prisma?, schema)` (`read.ts:339-365`) is replaced by `getCommerceServerRepository(db: Kysely<CommerceDB>)`, where `db` is already the scoped `tenantDb(base, tgId)` handle. The wrapper stops calling `withTenant(prisma, schema, …)` per method (that whole pattern dies): the read repo methods take `(db, args)` and the handle is already schema-qualified. The render entry `src/app/(site)/[...slug]/page.tsx:137-140` changes from `getCommerceServerRepository(undefined, resolveCommerceSchemaForSite(site))` to `getCommerceServerRepository(tenantDb(base, resolveTenantGroupForSite(site)))`.

The `CommerceServerRepository` type contract (declared type-only in `hydrateBindings.ts:113-129`: `listProducts`, `getProductByHandle`, `listVariants`, `getPrices`, `getAvailability`) is **preserved byte-for-byte** so `renderPublishedPage` and `hydrateBindings` do not change. The reads-only advisory-availability contract is a structural pin we honor.

### 3.5 The D4 orders route resolves tenant-group from the host

`src/app/api/commerce/orders/route.ts` is the one storefront write seam, already gated on `resolvePublishedSite(host)` → 403 if not a published site. `PublishedSite` (`publicResolver.ts:37`) already selects/returns `workspaceId` + `tenantGroupId`. The route derives `const tgId = resolveTenantGroupForSite(site); const db = tenantDb(base, tgId)` and threads `db` into `createOrder(db, cart)` and the resolveLines/readback paths. The `.strict()` zod body (rejects any price/stock/total key) is unchanged. The 3 unauthenticated read routes (`products`, `products/[handle]`, `inventory`) resolve the same way from their host gate.

---

## 4. Provisioning + per-tenant migrations (mirror auth-brain)

We mirror `provisionTenant` / `migrateAllTenants` exactly (RECON 1 §3, §4; RECON 3 §4). framer-clone supplies its own `TENANT_MIGRATIONS` set (replacing the example `workspaces/memberships/outbox_events`) and runs the public migrations once.

### 4.1 Roles + connection strings

Two roles, mirroring the existing `prisma/sql/commerce-roles.sql` intent but for the tenant-db model:
- **`commerce_app`** (LOGIN, low-privilege): the app's base handle. Gets per-schema `USAGE` + `SELECT,INSERT,UPDATE,DELETE` + sequence `USAGE,SELECT` via `grantSchemaToAppRole`, and role-default `search_path = ext`, set once by the superuser in `prisma/sql/commerce-roles.sql` and only verified by `bootstrapAppRole` on each provision (see the 2026-10-19 reality note). The append-only REVOKEs (`stock_movement`, `credit_note`, `credit_note_ref`, `order`, `order_line_item`) are applied per-schema inside the tenant migrations so they have teeth (the app role is non-owner).
- **`commerce_ddl`** (owner): holds DDL + advisory-lock privilege. The runner's `createMigrationClient(ownerConnString, { max:1 })` uses this. Passed as `appRole` to `provisionTenant`. NEVER the app role.

Two `DATABASE_URL`s in Infisical: app role for the pool, owner role for the runner/provisioner.

### 4.2 The commerce DDL as per-tenant migrations (the non-Prisma structure MUST be reproduced per schema)

The migration set `tenant/` is **raw postgres.js DDL** with **bare table names** (the runner injects `SET LOCAL search_path = ${schema}, ext` before each `up`). These bodies port 1:1 from the existing commerce migration SQL (RECON 2 §4): they were hand-written, never Prisma-generated, so this is the easy part. Every structural guarantee is per-schema:

| Migration id | Carries (per RECON 2 §4) |
|---|---|
| `001_inventory_ledger` | `inventory_item`, `stock_location`, `inventory_level` (incl. **GENERATED `available_quantity INTEGER GENERATED ALWAYS AS (stocked_quantity - reserved_quantity) STORED`**), `stock_movement`; CHECK `reserved_quantity <= stocked_quantity`, `stocked_quantity >= 0`, `reserved_quantity >= 0`; partial-unique `inventory_item_sku_active_key WHERE deleted_at IS NULL`; REVOKE UPDATE,DELETE ON `stock_movement` FROM commerce_app |
| `002_guarded_reservation` | `reservation`, `fulfillment_location_default` + FK; **DEFERRED CONSTRAINT TRIGGER** `stock_movement_transfer_balance` + fn `assert_transfer_group_balanced()` (transfer group = exactly 2 rows summing to 0 at COMMIT) |
| `003_catalog` | `product`, `product_option`, `product_option_value`, `product_variant` (incl. **trigger-maintained `option_signature TEXT`**), `product_variant_option`; **BEFORE INS/UPD trigger** `product_variant_option_signature` + fn `compute_variant_option_signature()`; **AFTER INS/UPD/DEL trigger** `product_variant_option_signature_matrix` + fn `refresh_variant_option_signature()`; composite-FK target unique `product_option_value(id, option_id)`; **composite FK** `product_variant_option(option_value_id, option_id) → product_option_value(id, option_id) ON UPDATE RESTRICT`; **6 partial-unique indexes** WHERE `deleted_at IS NULL` (`product.handle`, `product_option(product_id,title)`, `product_option_value(option_id,value)`, `product_variant.sku`, `product_variant.barcode`, `product_variant.option_signature`) |
| `004_pricing_and_tax` | `price_set`, `price`, `price_rule`, `price_list`, `credit_note`, `credit_note_ref`; CHECK `price.amount >= 0`, `credit_note.amount >= 0`, min/max-quantity band, `currency_code ~ '^[A-Z]{3}$'`; REVOKE UPDATE,DELETE on `credit_note`, `credit_note_ref` |
| `005_minimal_orders` | `order`, `order_line_item`; **`CREATE SEQUENCE order_number_seq`** (now per-schema, see §5); CHECK money `>= 0`, `currency_code ~ '^[A-Z]{3}$'`, **accounting identity `total = subtotal + tax_amount`**, line-item `tax_rate <= 10000`, `quantity > 0`; REVOKE UPDATE,DELETE on `order`, `order_line_item` |
| `006_enums` (or inline) | the 9 commerce enum types created per-schema (or as `ext`-level domains): `StockMovementType`, `ProductStatus`, `PriceListStatus`, `PriceListType`, `OrderStatus`, `CustomerType`, `NetOrGross`, `VariantRefSource`, `TaxTreatment`. Enums are schema-scoped types in Postgres, so they live in each `tg_<id>` schema (bare names under the injected search_path). |

UUID DEFAULTs use `ext.gen_uuid_v7()`; `updatedAt` triggers use `ext.touch_updated_at()` (both installed by the public `001_ext_schema` migration). This is the single most important property: **every per-tenant schema is structurally identical and self-contained**, so `pg_dump -n tg_x` extracts one customer with its own constraints, triggers, sequence, and migration history.

A primary motivation realized here: the Kysely migration runner **removes the Prisma drift hazard entirely**. The old setup required hand-deleting destructive DROPs (`available_quantity`, `option_signature`, RESTRICT→CASCADE flip) from every `prisma migrate dev` output. There is no datamodel-vs-DB diff anymore.

### 4.3 `provisionTenant` wired into org onboard

After a `public.tenant_groups` row would be created, call `provisionTenant(ownerSql, { tenantGroupId, slug, appRole: 'commerce_app', tenantMigrations: COMMERCE_TENANT_MIGRATIONS, seed? })`. Everything (advisory xact lock via FNV-1a/64 `advisoryKeyFor`, `CREATE SCHEMA IF NOT EXISTS`, inline migrations under the held lock, verify-all-ids, per-schema grants, `bootstrapAppRole` ext-default, `status='active'` only after verify) runs in ONE owner transaction. Atomic + locked + idempotent (re-runnable). The no-appRole path is forbidden in prod (it skips grants + the ext backstop): we always pass `appRole`.

`migrateAllTenants(ownerSql, { tenantMigrations: COMMERCE_TENANT_MIGRATIONS })` is the fleet runner for shipping new commerce DDL: batched, resumable, re-derives + tamper-checks each schema_name. This is how `006`/future commerce migrations roll across all existing tenant-groups.

### 4.4 Public migrations

Run `migratePublic(ownerSql)` once: `001_ext_schema` (the `ext` schema, pgcrypto, `gen_uuid_v7`, `touch_updated_at`) and `002_tenant_groups` (the registry). framer-clone owns no public commerce tables (commerce is 100% per-tenant).

---

## 5. The data-layer rewrite (every source mapped to its Kysely replacement)

Generate the typed `Database` interface (`CommerceDB`) with kysely-codegen against a provisioned `tg_*` schema. **Global tables get the `public.` prefix key; commerce tables get bare keys** (so `tenantDb(...).selectFrom('product')` compiles and a missing-qualifier on a global is a type error). The GENERATED `available_quantity` and trigger-maintained `option_signature` are typed as `Generated<number>`/`Generated<string>` so Kysely never tries to INSERT them.

Each repo function changes signature from `(tx, args)` to `(db: Kysely<CommerceDB>, args)`. Structured builders replace Prisma calls; the handful of raw fragments that must stay interpolate `tenantSchemaRef(tgId)` (NOT bare table names). The "real `prisma.$transaction` is the system of record" property is preserved by using `db.transaction().execute(...)` (the `adapter-prisma` no-op transaction is gone for good).

### 5.1 Repo method mapping

| Source (RECON 2 §2) | Kysely replacement |
|---|---|
| `catalog.createProduct/addOption/addOptionValue/addVariant` (`tx.*.create`) | `db.insertInto('product'|'product_option'|...).values(...).returningAll().executeTakeFirstOrThrow()` inside the order/seed tx; `addVariant` omits `option_signature` (trigger sets it) |
| `catalog.setVariantOptions` (`deleteMany` + loop `create`) | `db.deleteFrom('product_variant_option').where('variant_id','=',id)` then bulk `insertInto(...).values(rows)`; composite FK + AFTER trigger still authoritative (no JS re-check added) |
| `catalog.count` | `db.selectFrom('product').select(db.fn.countAll().as('c'))...` |
| `order.nextOrderNumber` (RAW `nextval`) | RAW: `` sql`SELECT nextval(${tenantSchemaRef(tgId)} || '.order_number_seq')` `` — **the sequence is now per-schema** (§4.2 `005`), so the `'"commerce"."order_number_seq"'` constant is replaced by a `tenantSchemaRef`-qualified reference, OR `nextval` resolves bare under the injected path inside a migration-style call. Use `tenantSchemaRef` explicitly in app code (G3-safe) |
| `order.insertOrder/insertLineItem` | `db.insertInto('order'|'order_line_item').values(...).returningAll().executeTakeFirstOrThrow()` |
| `order.findByRequestId` | `db.selectFrom('order').selectAll().where('request_id','=',requestId).executeTakeFirst()` |
| `pricing.createPriceSet/addPrice` | structured inserts (after `assertIntegerCents` boundary guard, kept) |
| `pricing.resolvePrice` (read: `priceSet.findUnique` + `price.findMany` include priceList) | `selectFrom('price_set')...` + `selectFrom('price').leftJoin('price_list',...)`; **all tie-break logic stays in JS, integer compares only** |
| `read.listProducts` (count + findMany w/ `PRODUCT_INCLUDE`, take, cursor) | `selectFrom('product')` count + paginated select; the options→values + variants graph assembled via grouped selects or `jsonAgg` (Kysely `jsonArrayFrom` helper) to reproduce `PRODUCT_INCLUDE` shape exactly |
| `read.getProductByHandle` (`findFirst handle, deletedAt:null`) | `selectFrom('product').where('handle','=',h).where('deleted_at','is',null).executeTakeFirst()` (findFirst because handle is partial-unique) |
| `read.listVariants` (`VARIANT_INCLUDE`) | structured select + nested `jsonArrayFrom` for options→optionValue, product.taxClass |
| `read.getPrices` | `productVariant.findUnique` (taxClass) + `price.findMany where priceSet.variantId` → two structured selects |
| `read.getAvailability` | `productVariant.findUnique` + `inventoryItem.findFirst(sku, deletedAt:null)` (SKU bridge) + `inventoryLevel.findMany`; **`stocked - reserved` still computed in JS** (the model omits the GENERATED column) OR read `available_quantity` directly (see `inventory/route` below) |

### 5.2 Raw-SQL sites (RECON 2 §3) → Kysely `sql` with `tenantSchemaRef`

All 9 sites currently interpolate an allowlisted `'"commerce"."table"'` constant. The port replaces that constant with `tenantSchemaRef(tgId)` (the schema is now per-tenant, not a fixed string). G3 bans bare `inventory_level`/`stock_movement`/etc. in `sql\`\``, so every one MUST use `tenantSchemaRef`. `$N` bind params for values stay; `$executeRaw*` affected-row count → `result.numAffectedRows` (bigint).

| # | Site | Kysely port |
|---|---|---|
| 1 | `withTenant.ts:96` `SET LOCAL search_path` | **DELETED.** The whole `withTenant` seam is removed: isolation is now `withSchema` in the handle, not a per-request `SET`. (G2 bans runtime `SET search_path` in app code; legal only in migrations.) |
| 2 | `createOrder.ts:289,435` 2 hand-rolled `SET LOCAL` | **DELETED.** Replaced by opening `db.transaction().setIsolationLevel('read committed').execute(...)` on the already-schema-qualified `db`. See §5.4 |
| 3 | `order.ts:46` `nextval(order_number_seq)` | `` sql`SELECT nextval(${tenantSchemaRef(tgId)} || '.order_number_seq') AS nextval` `` |
| 4 | `reserve.ts:358` guarded UPDATE `reserved=reserved+$1 … WHERE (stocked-reserved) >= $1` | `` sql`UPDATE ${tenantSchemaRef(tgId)}.inventory_level SET reserved_quantity = reserved_quantity + ${n}, version = version + 1 WHERE … AND (stocked_quantity - reserved_quantity) >= ${n}` `` ; branch on `numAffectedRows === 0n` |
| 5 | `reserve.ts:468` `SELECT … FOR UPDATE ORDER BY inventory_item_id ASC` (kit lock order) | raw `sql` with `tenantSchemaRef`, `FOR UPDATE` preserved verbatim |
| 6 | `reserve.ts:671` release UPDATE | raw, `numAffectedRows` branch |
| 7 | `reserve.ts:704` fulfill UPDATE | raw, `numAffectedRows` branch |
| 8 | `reserve.ts:743` adjust UPDATE | raw, `numAffectedRows` branch |
| 9 | `inventory/route.ts:61` `SELECT available_quantity` | `db.selectFrom('inventory_level').select('available_quantity').where('inventory_item_id','=',$).where('location_id','=',$)` — reads the GENERATED column directly (structured, no raw needed) |

### 5.3 Generated / trigger / sequence columns

- **GENERATED `available_quantity`**: typed `Generated<number>`, never inserted/updated; read directly (site #9) or computed in JS (`read.getAvailability`).
- **trigger-maintained `option_signature`**: typed `Generated<string>`, never written by `addVariant`; BEFORE/AFTER triggers (per-schema, §4.2 `003`) remain authoritative.
- **`order_number_seq`**: now **per-tenant** (one sequence per `tg_<id>` schema). Order numbers are monotonic *within* a tenant-group, which is correct (each tenant has its own order series). `nextOrderNumber` qualifies it via `tenantSchemaRef`.

### 5.4 Money/stock-critical transaction semantics (port EXACTLY)

- **READ COMMITTED is mandatory.** The guarded-decrement proof requires it: a blocked UPDATE re-evaluates its WHERE against the winner's committed row and cleanly matches **zero** rows (REPEATABLE READ/SERIALIZABLE would raise 40001, breaking the `{ ok:false, shortages }` contract). Kysely: `db.transaction().setIsolationLevel('read committed').execute(async (trx) => …)`. This single call replaces both the `prisma.$transaction(fn, { isolationLevel })` AND the hand-rolled `SET LOCAL search_path` (the schema qualification is already baked into `trx`, derived from the scoped `db`). This collapses the "single most error-prone port" (RECON 2 callout 1) into one idiomatic Kysely construct.
- **3 stacked guards preserved:** (1) guarded `UPDATE … WHERE (stocked-reserved) >= needed` row-lock serialization (loser matches 0 rows via `numAffectedRows`); (2) DB CHECK `reserved <= stocked` backstop (in `001`); (3) UNIQUE(request_id) on `stock_movement` + `reservation` for idempotency.
- **P2002 → pg error code re-detection.** Prisma's `PrismaClientKnownRequestError` is gone. `isRequestIdUniqueViolation` / `isOrderRequestIdConflict` re-detect on the raw postgres.js error: `err.code === '23505'` + `err.constraint_name` matching `stock_movement_request_id_key` / `reservation_request_id_key` / `order_request_id_key`. The `DuplicateRequestError` sentinel + `*WithRetry` fresh-tx re-read flow is preserved byte-for-byte (the aborted tx is 25P02-locked, so retry opens a NEW transaction).
- **Order-level mirror** (`createOrder.ts`): `OrderShortageError`, `isReserveDuplicate` (name-tag), `isOrderRequestIdConflict` (now pg-code), `resolvePriorOrder` fresh-tx re-read. `createOrder` calls the INNER `reserve(trx, …)` so a shortage rolls back the whole order.
- **Server-authoritative money** unchanged: integer cents, `assertNonNegativeIntCents`/`assertPositiveInt`/`assertIntegerCents` mirror DB CHECKs; `cart.clientTotal` accepted-but-ignored.
- **Kit lock-ordering** (`lockLevelsAscending`, `ORDER BY inventory_item_id ASC FOR UPDATE`) preserved; per-component `request_id = "${kitRequestId}:${itemId}"`.

### 5.5 Seed rewrite

`seedDemoSite.ts` uses real seams (`catalogRepository`, `pricingRepository`) PLUS 3 direct `prisma.stockLocation/inventoryItem/inventoryLevel.create` calls that ran without `withTenant` (relying on `@@schema` qualification). The Kysely port routes ALL writes through the scoped `db = tenantDb(base, tgId)` handle, so the 3 direct creates become schema-qualified `db.insertInto(...)` like the rest. No write may bypass the handle.

---

## 6. The crown-jewel isolation test (compliance evidence)

Mirror auth-brain's `tests/isolation.spec.ts` verbatim, adapted to commerce. This is **the single highest-leverage compliance artifact** (SOC2 Type II operating-effectiveness evidence: automated, repeatable, CI-run on every deploy).

Setup (Testcontainers `postgres:16-alpine`): `migratePublic(owner)`, then `provisionTenant` for `TG_A` and `TG_B` with `COMMERCE_TENANT_MIGRATIONS`. Seed DISTINCT, role-tagged commerce data per schema: `TG_A` gets product `WIDGET_A` + a variant + a price + inventory + an order `ORDER_A`; `TG_B` gets `WIDGET_B` + `ORDER_B`. **Plant the DECOY:** same-named `public.product` + `public.order` (+ `inventory_level`) holding `DECOY_PUBLIC` rows that carry BOTH tenant-groups' identifiers, the trap for any unqualified query that falls back to the default path.

Run the **actual commerce repo functions** scoped to `tg_a` and assert:
- `listProducts(tenantDb(base, TG_A))` returns exactly `TG_A`'s products, zero `TG_B`, zero DECOY.
- A read **handed a `TG_B` handle for a `TG_A` order id returns ZERO** (proving the **schema wall**, not the logical filter).
- `getAvailability` / raw guarded UPDATE via `tenantSchemaRef` touch only `tg_a`'s `inventory_level`.
- Symmetry: `tg_b` sees only `tg_b`. Total across both = exactly the seeded sum, zero decoys on any path.
- **The hazard-proof:** a deliberately BARE `FROM inventory_level` raw fragment (guard-disabled fixture, `// tenant-db-guard-disable-next-line G3`) is asserted to LEAK to the public DECOY, pinning WHY G3 + `tenantSchemaRef` exist.
- **The grant proof (commerce-specific compliance):** open a connection as `commerce_app` scoped to `tg_a`, attempt to read `tg_b.order` directly, assert Postgres raises `permission denied for schema tg_b` (or `relation does not exist`). This proves the wall is enforced by **grants, not app discipline**: the auditable control.

Every converted commerce repo (catalog, order, pricing, read, reserve) gets an isolation-style assertion. CI runs `check-guards.mjs` over `src/server/commerce/**` with `KNOWN_TENANT_TABLES` extended to the commerce tables (`product`, `product_option`, `product_option_value`, `product_variant`, `product_variant_option`, `price_set`, `price`, `price_rule`, `price_list`, `credit_note`, `credit_note_ref`, `inventory_item`, `stock_location`, `inventory_level`, `stock_movement`, `reservation`, `fulfillment_location_default`, `order`, `order_line_item`).

---

## 7. Compliance boundary (honest scope)

**What this migration delivers as a control.** One foundational, auditable technical control: **tenant data segregation enforced by the database engine** (per-tenant `tg_<id>` schema + per-schema least-privilege `commerce_app` role + the `ext`-locked role default + the isolation test as repeatable evidence). Maps to:
- **SOC 2 (AICPA TSC):** CC6.1 (restrict logical access), CC6.3 (least privilege), CC6.6 (boundary protection), C1.1/C1.2 (segregate confidential customer data). The isolation CI test is **Type II operating-effectiveness** evidence across the observation window.
- **HIPAA Security Rule:** 164.312(a)(1) Access Control, 164.308(a)(4) Information Access Management (isolate functions / minimum-necessary), 164.312(c)(1) Integrity.
- **ISO/IEC 27001:2022 Annex A:** A.8.3 Information access restriction, A.8.2 Privileged access rights, A.8.12 Data leakage prevention, A.8.22 Segregation.

**One-line framing:** "Schema-per-tenant-group + per-tenant grants + the isolation test is a foundational, auditable data-segregation control (SOC2 CC6.1/CC6.3, HIPAA 164.312(a), ISO A.8.3), and the strongest single piece of operating-effectiveness evidence we can produce. It is a prerequisite for, not equivalent to, certification."

**Explicitly OUT of scope (the other ~90% of an audit, named so the boundary is honest):** audit logging / tamper-evident access records (SOC2 CC7.2-7.3, HIPAA 164.312(b), ISO A.8.15/A.8.16); encryption at rest/in transit + KMS (CC6.7, 164.312(a)(2)(iv)/(e), A.8.24); access reviews / joiner-mover-leaver (CC6.2-6.3, A.5.18); change management / secure SDLC (CC8.1, A.8.32); vendor / subprocessor management + DPAs (CC9, A.5.19-5.22 — Hetzner, Coolify, Cloudflare, Infisical, auth-brain); risk-assessment program (ISO Cl.6, CC3, 164.308(a)(1)); incident response + backup/DR + breach notification (CC7.4-7.5, 164.308(a)(6)/(7), A.5.24-5.30); HR/personnel security + training (CC1, A.6); physical security (A.7, 164.310, delegated to Hetzner); documented policies + ISMS governance (ISO Cl.4-10, CC1-CC5); BAAs (HIPAA legal); and the audit engagement itself. This migration touches none of those.

---

## 8. Orchestrator-ready decomposition

Each spec is sized for a single autonomous Worker slice. The risky schema/migration/transaction specs are isolated. Acceptance criteria are verifiable (tests/CI/compile).

### CM-01 — Publish `@marlinjai/tenant-db` + add the dependency
- **Goal:** make the target package consumable cross-repo.
- **Files:** `auth-brain/packages/tenant-db/package.json` (verify `publishConfig`, `files`, build); framer-clone `package.json`, `pnpm-lock.yaml`.
- **Deps:** none.
- **Accept:** `npm view @marlinjai/tenant-db@0.1.0` resolves; framer-clone `pnpm add @marlinjai/tenant-db@^0.1.0` installs; a throwaway `import { tenantSchema } from '@marlinjai/tenant-db'` type-checks. (If publish is blocked, fall back to a tracked `file:`/`link:` and note it; the API surface is identical.)

### CM-02 — Roles + base connection + backstop
- **Goal:** create `commerce_app`/`commerce_ddl` roles, the Node base singleton, startup `assertBackstop`.
- **Files:** new `src/server/commerce/db.ts` (`createNodeDb` base + `assertBackstop`), `prisma/sql/commerce-roles.sql` → adapted role SQL, Infisical placeholders for app + owner `DATABASE_URL` (scaffold `COMMERCE_APP_DATABASE_URL=PLACEHOLDER_REPLACE_ME`, `COMMERCE_OWNER_DATABASE_URL=PLACEHOLDER_REPLACE_ME`).
- **Deps:** CM-01.
- **Accept:** base handle builds; `assertBackstop(base)` passes against a role whose default path is `ext` and throws `BackstopError` against the owner role (unit test with a Testcontainer).

### CM-03 — Public migrations + registry bootstrap
- **Goal:** run `migratePublic` (ext schema, pgcrypto, `gen_uuid_v7`, `touch_updated_at`, `tenant_groups`).
- **Files:** new `src/server/commerce/provisioning/public.ts` (wraps `migratePublic`), a `pnpm db:public` script.
- **Deps:** CM-02.
- **Accept:** against a fresh Testcontainer, `migratePublic` creates `ext` + `public.tenant_groups` + `public.tenant_migration_progress`; idempotent on re-run.

### CM-04 — Commerce per-tenant migration set (HIGH RISK, isolate)
- **Goal:** author `COMMERCE_TENANT_MIGRATIONS` (`001`-`006`) reproducing all DDL from RECON 2 §4 with bare table names.
- **Files:** new `src/server/commerce/migrations/tenant/{001_inventory_ledger,002_guarded_reservation,003_catalog,004_pricing_and_tax,005_minimal_orders,006_enums}.ts` + `index.ts`.
- **Deps:** CM-03.
- **Accept:** `provisionTenant(owner, { tenantGroupId: TG_A, slug, appRole, tenantMigrations })` against a Testcontainer creates `tg_<id>` with: GENERATED `available_quantity`, `option_signature` triggers firing, per-schema `order_number_seq`, all CHECKs (incl. `total = subtotal + tax_amount`), 6 partial-unique indexes, composite FK `ON UPDATE RESTRICT`, deferred transfer-balance trigger, REVOKEs on append-only tables. A direct-SQL probe asserts each structure exists in `tg_<id>`. Re-run is idempotent.

### CM-05 — `CommerceDB` typed interface (kysely-codegen)
- **Goal:** generate the typed `Database` with `public.`-prefixed globals + bare commerce keys; `Generated<>` on `available_quantity`/`option_signature`.
- **Files:** new `src/server/commerce/db-types.ts`, codegen config/script.
- **Deps:** CM-04.
- **Accept:** `tenantDb(base, tg).selectFrom('product')` compiles; `.selectFrom('users')` (a global) is a type error unless `public.`-qualified; a `type-discipline.test-d.ts` proves forgetting `public.` fails to compile.

### CM-06 — Catalog + pricing read repos → Kysely (gate with isolation test)
- **Goal:** port `catalog.ts` + `pricing.ts` to `(db, args)`.
- **Files:** `src/server/commerce/repository/catalog.ts`, `pricing.ts`; new `__tests__/catalog.isolation.spec.ts`, `pricing.isolation.spec.ts`.
- **Deps:** CM-05.
- **Accept:** isolation spec (TG_A/TG_B + public decoy + grant-denied probe) passes; `assertIntegerCents` boundary preserved; tie-break logic integer-only.

### CM-07 — Read repo (`read.ts`) → Kysely, preserve `CommerceServerRepository` contract
- **Goal:** port `listProducts/getProductByHandle/listVariants/getPrices/getAvailability`; rewrite `getCommerceServerRepository` to take a scoped `db`.
- **Files:** `src/server/commerce/repository/read.ts`, `src/server/commerce/index.ts` (barrel).
- **Deps:** CM-05.
- **Accept:** the type-only `CommerceServerRepository` (hydrateBindings.ts:113-129) still satisfied (compile + structural test); graph includes (`PRODUCT_INCLUDE`/`VARIANT_INCLUDE`) reproduced via `jsonArrayFrom`; isolation spec passes; `available_quantity` read directly.

### CM-08 — Inventory reserve heart (`reserve.ts`) → Kysely (HIGH RISK, isolate)
- **Goal:** port the 9 reserve methods + 5 raw UPDATE/SELECT sites, preserving READ COMMITTED + `numAffectedRows` guard + P2002 pg-code re-detection + kit lock-ordering.
- **Files:** `src/server/commerce/inventory/reserve.ts`; new `__tests__/reserve.concurrency.spec.ts`, `reserve.isolation.spec.ts`.
- **Deps:** CM-05.
- **Accept:** concurrency test proves two concurrent same-stock reservers serialize, loser gets `{ ok:false, shortages }` (zero matched rows, not a 40001); duplicate `request_id` → `DuplicateRequestError` → fresh-tx re-read of the winner, no double-decrement; kit lock acquired ascending; isolation spec passes.

### CM-09 — Order repo + `createOrder` orchestrator → Kysely (HIGH RISK, isolate)
- **Goal:** port `order.ts` (incl. per-tenant `order_number_seq` via `tenantSchemaRef`) + `createOrder.ts`; replace the 2 hand-rolled `SET LOCAL` with `db.transaction().setIsolationLevel('read committed')`.
- **Files:** `src/server/commerce/repository/order.ts`, `src/server/commerce/order/createOrder.ts`; new `__tests__/createOrder.isolation.spec.ts`.
- **Deps:** CM-07, CM-08.
- **Accept:** a full order placement reserves + writes order + line items atomically; shortage rolls back the whole order; `isOrderRequestIdConflict` re-detected on pg `23505`/`order_request_id_key`; `resolvePriorOrder` fresh-tx re-read; `total = subtotal + tax_amount` enforced; isolation spec passes.

### CM-10 — API routes rewired (render + D4 orders + read routes)
- **Goal:** thread `tenantDb(base, resolveTenantGroupForSite(site))` into the 4 routes + the SSR render path; delete `withTenant` + `resolveCommerceSchemaForSite` constant.
- **Files:** `src/app/api/commerce/{products,products/[handle],inventory,orders}/route.ts`, `src/server/commerce/tenant.ts`, `src/app/(site)/[...slug]/page.tsx`, `src/server/commerce/withTenant.ts` (DELETE).
- **Deps:** CM-06, CM-07, CM-08, CM-09.
- **Accept:** orders route still 403s non-published hosts + `.strict()` rejects price/stock/total keys; products/inventory routes resolve tg from host; SSR render uses the scoped handle; `withTenant.ts` removed and no import survives.

### CM-11 — Provision wiring into onboard + fleet runner
- **Goal:** call `provisionTenant(owner, { tenantGroupId, slug, appRole:'commerce_app', tenantMigrations })` on org onboard; expose `migrateAllTenants` as `pnpm db:migrate-tenants`.
- **Files:** new `src/server/commerce/provisioning/provision.ts`, onboard hook, `package.json` scripts.
- **Deps:** CM-04, CM-10.
- **Accept:** onboarding a new tenant-group creates an active `tg_<id>` with commerce tables + grants; `migrateAllTenants` rolls a new migration across all existing tenant-groups, resumable.

### CM-12 — Seed rewrite + demo tenant backfill
- **Goal:** port `seedDemoSite.ts` to the scoped handle (all writes, incl. the 3 ex-direct `prisma.*.create`); provision the existing demo tenant-group + migrate its current `commerce` data into its `tg_<id>` (see §9).
- **Files:** `src/lib/renderer/server/seedDemoSite.ts`, new `src/server/commerce/provisioning/backfill-demo.ts`.
- **Deps:** CM-11.
- **Accept:** seeding runs entirely through `tenantDb`; the demo storefront renders + checks out against `tg_<demo>`; the old `commerce` schema can be dropped after verification.

### CM-13 — CI guards + Prisma teardown
- **Goal:** wire `check-guards.mjs` over commerce src with the extended `KNOWN_TENANT_TABLES`; remove commerce models from `prisma/schema.prisma`; delete `adapter-prisma` from the commerce path.
- **Files:** new `scripts/check-guards.mjs` (vendored/configured), CI workflow, `prisma/schema.prisma` (drop the 19 commerce models + 9 enums), `src/server/db.ts`.
- **Deps:** CM-10, CM-11, CM-12.
- **Accept:** `pnpm lint:guards` over `src/server/commerce/**` passes (G1-G5, no bare commerce tables in `sql\`\``, no `.withSchema(` outside tenant-db, no runtime `SET search_path`); Prisma no longer references commerce; full commerce test suite green.

### Wave table

| Wave | Specs | Theme | Parallelism |
|---|---|---|---|
| W0 | CM-01, CM-02 | Dependency + roles/connection/backstop | CM-01 → CM-02 |
| W1 | CM-03, CM-04, CM-05 | Public migrations, per-tenant DDL (RISK), typed `CommerceDB` | CM-03 → CM-04 → CM-05 (serial; CM-04 isolated) |
| W2 | CM-06, CM-07, CM-08 | Read repos + reserve heart (RISK) | parallel after CM-05 |
| W3 | CM-09 | Order repo + createOrder (RISK) | after CM-07+CM-08 |
| W4 | CM-10, CM-11 | Routes + render rewire, provision wiring | CM-10 → CM-11 |
| W5 | CM-12, CM-13 | Seed/backfill, guards, Prisma teardown | CM-12 → CM-13 |

---

## 9. Sequencing vs the CMS-only Wave-5 go-live

**Commerce is NOT gated on, and does not gate, the CMS wildcard cutover.** The Wave-5 go-live (publish a CMS page to a real subdomain) ships CMS only; CMS stays on its logical (`workspace_id`) tier and is unaffected by this migration. So **this commerce migration runs in PARALLEL to (and may land after) the CMS wildcard cutover.** It must not block the demo.

**Back-compat for the existing single `commerce` schema (the seeded demo tenant).** Today every site resolves to the one constant `COMMERCE_SCHEMA = 'commerce'`. The existing commerce data is the seeded demo. The cutover keeps the old single tenant working THROUGHOUT:
1. CM-01..CM-11 land the new path **without removing the old `commerce` schema**. The new code is dark until wired.
2. CM-12 provisions a `tg_<demo>` schema for the demo tenant-group and **backfills** the current `commerce` rows into it (a one-shot `INSERT INTO tg_demo.<t> SELECT * FROM commerce.<t>` per table, run by the owner role, respecting FK order and the GENERATED/trigger columns: do not copy `available_quantity`/`option_signature`, let them regenerate).
3. The render path + routes (CM-10) flip to `resolveTenantGroupForSite(site)` only once `tg_<demo>` is verified to render + check out identically.
4. Old `commerce` schema is dropped in CM-13 **only after** the demo is verified on `tg_<demo>`. Until then both exist; a deploy rollback re-points to the old constant.

Because the demo currently has exactly one tenant-group, there is no fan-out risk: backfill is one schema copy. Pre-MVP, no external customers, so no migration window negotiation.

---

## 10. Risks + rollback

This is money/stock-critical. The existing commerce MUST keep working for the current single tenant throughout.

| Risk | Severity | Mitigation |
|---|---|---|
| Guarded-decrement semantics drift (wrong isolation level → 40001 instead of 0-rows) | CRITICAL | CM-08 concurrency test asserts the exact `{ ok:false, shortages }` contract under READ COMMITTED; `db.transaction().setIsolationLevel('read committed')` is mandatory and test-pinned |
| P2002 re-detection misses a constraint (double-decrement / duplicate order) | CRITICAL | re-detect on pg `23505` + exact `constraint_name` (`*_request_id_key`, `order_request_id_key`); CM-08/CM-09 tests force concurrent duplicates and assert no double-decrement |
| Per-tenant DDL diverges from the old commerce schema (missing CHECK/trigger/generated col) | HIGH | CM-04 probes every structure in `tg_<id>`; CM-12 backfill verifies the demo renders + checks out identically before old-schema drop |
| Cross-tenant leak via a bare raw fragment | HIGH | G3 + `tenantSchemaRef` everywhere; isolation spec's hazard-proof fixture pins the failure mode; grant-denied probe proves the wall |
| Backstop misconfig (app points at owner role, `public` on path) | HIGH | `assertBackstop(base)` at startup throws `BackstopError`; CM-02 tests both directions |
| `order_number_seq` per-tenant changes order-number expectations downstream | MEDIUM | numbers are per-tenant-group monotonic (correct); no global uniqueness was ever required across tenants |
| Half-converted repo set (footgun) | HIGH | coordinated cutover: new path dark until CM-10 flips routes; old `commerce` schema retained until CM-13 |
| Publish of tenant-db blocked | LOW | CM-01 falls back to tracked `file:`/`link:`; identical API |

**Rollback.** Until CM-13 drops the old `commerce` schema, rollback is a single revert of the route-wiring commit (CM-10): `resolveCommerceSchemaForSite` returns the `commerce` constant again, the old Prisma path (kept intact through CM-12) serves the demo, and the new `tg_<demo>` schema is harmless dead data. After CM-13, rollback requires re-creating the `commerce` schema from the retained backfill source, so CM-13 runs ONLY after the demo is verified green on `tg_<demo>` across a full place-order + render cycle. No destructive step (old-schema drop) happens until isolation + demo verification both pass.