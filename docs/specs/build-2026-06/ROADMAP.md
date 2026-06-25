---
type: roadmap
title: Build 2026-06 framer-clone-only sequence (Track 0 backend foundation, Track A CMS read-binding layer, Track B owned commerce engine, Track C storefront)
status: decided
date: 2026-06-16
summary: The re-scoped, framer-clone-ONLY build sequence. Track 0 stands up the Prisma/Postgres backend (framer-clone has none today), Track A is the self-contained CMS content tier + read-binding layer (importing adapter-prisma directly, NO doc-tier-core), Track B is the owned commerce engine (purpose-built Prisma, NOT data-table, the smallest-correct-v1), Track C is the storefront binding layer + components. lumitra-web offers/CRM is a SEPARATE parked workstream.
projects: [framer-clone]
---

# Build 2026-06 framer-clone-only sequence

> SUPERSEDES the prior P0-P6 ROADMAP (which sequenced lumitra-web offers as Slice 1 and a `@marlinjai/doc-tier-core` package in the Slice 2 chain). Per the 2026-06-16 re-scope, this workstream is framer-clone-ONLY. The four tracks below all land in `projects/framer-clone`. The 8 lumitra-web offers/CRM specs (`slice-1-offers-doc-tier/`) plus the dropped `slice2-doc-tier-shared-package` are PARKED to a separate lumitra-web workstream (banners added in-place); they are NOT dispatched from the framer-clone orchestrator. lumitra-web independently consumes the already-published `@marlinjai/data-table-adapter-prisma` if/when that workstream is picked up; the two never need a shared package (different data, confirmed by the re-scope).

## Post-build wave: Studio design refresh + CMS workspace (2026-06-19/20)

The original 27-spec build (Tracks 0/A/B/C below) is COMPLETE on main. A follow-on design + UX
wave then landed on branch `feat/cms-grid-studio-refresh` (PR #30):

- `cms-content-tier/slice2b-cms-datatable-grid-ui.md` (completed): the CMS editing UI rebuilt onto
  the full `@marlinjai/data-table-react` grid via an admin-guarded server-actions adapter.
- the "Studio" design system: iris `--brand` + `--status-*` + `--warning` tokens on the shadcn
  Tailwind-v4 theme; whole-editor accent migration + chrome token-polish.
- item detail panel + reserved Draft/Published "Status" field; collection settings (icon + slug).
- `editor-chrome/editor-chrome-redesign.md` (completed): Layers tree + Properties panel to the
  Studio mockup, MST preserved, with an accessible right-sidebar collapse toggle.
- `cms-content-tier/slice3-cms-workspace-phase1.md` (completed): the full-screen `[rail | grid]`
  content workspace (collections navigator + reused `CmsGrid` + per-collection item counts).
- `cms-content-tier/slice4-content-agent-phase2.md` (completed): the right-rail natural-language
  content agent (Anthropic tool-use loop over the CMS adapter, SSE streaming, per-mutation
  AgentRun/AgentChange inverses, one-click Undo all).

The hosted-page demo (publish a page to a real subdomain) is specced in
`build-2026-06/hosted-demo/hosted-page-demo.md` and its RENDER half SHIPPED as an autonomous
orchestrator wave on 2026-06-25 (PRs #36-#41): the CI test gate, the commerce read repo, the content
agent, publish-write, the SSR render layer, and host-aware root routing. See the reality update in
`docs/plans/2026-06-23-framer-hosting-platform-foundation.md` for the full PR map and the locked
decisions (Option A subdomain for the demo, SSR-on-request, checkout stops at order-created).

## Post-demo roadmap (2026-06-25)

Filed from the hosted-demo build wave. Sequenced after the demo goes live.

| Item | What | Plan / source | Status |
|------|------|---------------|--------|
| `framer-prod-provision` | Deploy + wildcard DNS + wildcard cert + analytics-key wiring for the Option A demo. irreversible_ops: needs Marlin's domain/subdomain + analytics project/key + his DNS/Coolify/Infisical hands. | `hosted-demo/hosted-page-demo.md` item #7 + [[framer-clone-runtime-infra-provisioning]] | PARKED (flash session) |
| Custom domains (B) | Connect a customer-owned domain to a published site: `customHostname` resolution + per-domain TLS (Coolify LE or Cloudflare for SaaS) + in-editor DCV onboarding. | `docs/plans/2026-06-25-framer-custom-domains.md` | draft (background, post-demo) |
| Multi-site editor | Editor at `/projects/<id>` (load-by-siteId + site picker + new-site flow + the P1c site->workspace provisioning the single-site demo skipped). Multi-SITE UX on the already-shipped tenant layer, NOT new tenancy. | custom-domains plan (folded) | draft (background) |
| Auto subdomain slug | Generate a unique default `SiteDomain.subdomain` per site on first publish (Framer's `fuzzy-flows-876416` pattern). | custom-domains plan (folded) | draft (small) |
| CMS/commerce-write auth migration | Migrate the interim `requireAdmin` + stub `can()` (`src/server/auth/guard.ts`) on the CMS/commerce write routes to real auth-brain authorization (the publish path already uses it). Filed as an open_thread on PR #39. | this row | draft (security follow-up) |
| variant-selector scope refinement | A `variant-selector` nested-scope contract test is coupled to `hydrateBindings`' `toEqual` shape; refine the scope threading. Filed as an open_thread on PR #40. | this row | draft (minor) |

## The single most important pre-dispatch decision

The published `@marlinjai/data-table-adapter-prisma@0.2.1` (the latest/only version) leaks unrewritten `workspace:*` specifiers in its dependencies, so `pnpm add @marlinjai/data-table-adapter-prisma@0.2.1` fails hard with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. This is verified against the live npm registry. Track A's entire CMS chain cannot install until this is resolved. Two paths (Marlin decides BEFORE the orchestrator is fed): (A) republish `0.2.2` from the data-table monorepo via `pnpm publish` (rewrites `workspace:*` to real semver, ~30-minute one-PR task, fixes the defect at source, also unblocks the parked lumitra-web offers workstream), or (B) vendor `adapter.ts`/`ddl.ts` into `src/server/cms/vendor/` (in-scope, immediate, manual-sync cost). RECOMMEND path A. `@marlinjai/data-table-react@0.3.1` is published correctly and is NOT affected (the TableView spec installs cleanly).

## Track sequence (authoritative, framer-clone-only)

| Track | What ships | Depends on | Repo |
|-------|-----------|-----------|------|
| **Track 0: backend foundation (HARD GATE)** | Turns framer-clone from a backendless Next.js app into a Postgres-backed server. `@prisma/client` + `prisma` + `server-only`; `prisma/schema.prisma` seeded with the adapter-prisma 8 `dt_*` models (single file, single schema, NOT multiSchema); the `getPrismaClient()` server-only singleton reading `DATABASE_URL` (Infisical/Coolify, never `.env`); the `src/server/**` boundary + `src/app/api/*` conventions; AND the test substrate (node-env vitest `projects` form + Dockerized-Postgres harness). OWNS `prisma/schema.prisma` creation; commerce models are appended later onto the SAME file/datasource. This single Track 0 ALSO serves the commerce engine as its `b0`. | nothing (framer-clone at HEAD 00956c5; zero Prisma/Postgres today) | framer-clone |
| **Track A: CMS content tier + read-binding layer** | Self-contained framer CMS, NO `@marlinjai/doc-tier-core`. `src/server/cms/` importing `@marlinjai/data-table-adapter-prisma` DIRECTLY (via the Track-0 resolution path) + the 13->8 column-type map. `PrismaDataSourceProvider` over `/api/cms/*` read routes, swapped in at the two root mounts (InMemoryProvider kept as the test double). React-free read-binding resolver (Node-evaluable). Collection / RecordView renderers + scope threading; TableView (data-table-react read-only) as a split-out leaf. loading/empty/error states. Content-type management UI (define an Events collection). Editor binding picker (one new MST `setQuery` action, the ONLY mst-tree touch). hydrateBindings helper + preview parity (static-publish wiring gated on the static-html wave). Interim `can()`-shaped admin guard on mutation routes; reads public for v1. | Track 0 | framer-clone |
| **Track B: owned commerce engine (smallest-correct-v1)** | `src/server/commerce/` purpose-built Prisma (NOT data-table, whose `transaction()` is a verified no-op): the inventory ledger FIRST (inventory_item/inventory_level with generated available_quantity / stock_movement append-only / reservation) + the guarded conditional decrement with the 3 stacked guards inside a real READ COMMITTED `prisma.$transaction`; the typed catalog (variant<->option_value matrix with composite FK + option_signature trigger); pricing + the full German tax model (tax_class/tax_region/vat_id/customer_type/reverse_charge/net-gross/Kleinunternehmer + Storno/Gutschrift CreditNote); minimal orders (Order OWNS the order-level tax fields). withTenant SET LOCAL collapsed to a constant schema; commerce_app/commerce_ddl role topology. Reads via plain REST/polling, advisory-only availability. NO CRDT/Hocuspocus/multi-tenant chassis/Stripe/tax-engine/carrier. The `prisma`-schema writers (track0 -> b2 -> b3 -> b4 -> b5 -> b6) form a strict SERIAL chain so no two Workers edit `prisma/schema.prisma` concurrently. | Track 0 (shared Prisma datasource + Postgres + test substrate) | framer-clone |
| **Track C: storefront binding + components (PUBLISH)** | Storefront read components bound to the owned commerce engine: product list/grid, product detail, variant selector, cart, checkout. They REUSE the Track A binding machinery (resolver, scope frames, picker, registry) via a PARALLEL `CommerceDataSource` seam alongside `DataSourceProvider`, resolving typed commerce DTOs against `/api/commerce/*` REST reads. Cart is client-side selection state; the order-create POST is the ONE storefront write seam (client sends intentions, server is the sole author of money + stock via b6's atomic transaction). Checkout STOPS at order-created; payment is OUT (E8). Register the components as bindable canvas blocks; publish as `@marlinjai/*` if/when they stabilize. | Track A (binding layer + resolver + renderers) AND Track B (commerce catalog + inventory REST reads) | framer-clone |

## Track leaf specs

### Track 0 + Track A (track `cms-content-tier`, 11 specs, 37 days)

| Order | Spec | dependsOn | shared_state | days |
|-------|------|-----------|--------------|------|
| 0 | `track0-backend-foundation` | (none) | prisma (OWNS schema.prisma), lockfile, next-config, vitest-config | 4 |
| A1 | `slice2-read-binding-resolver-runtime` | (none) | vitest-config | 4 |
| A2 | `slice2-cms-server-adapter-and-repo` | track0 | lockfile | 3 |
| A3 | `slice2-admin-guard-stub` | track0 | (none) | 1 |
| A4 | `slice2-prisma-datasource-provider` | cms-server-adapter | (none) | 2 |
| A5 | `slice2-read-only-data-components` | resolver-runtime, prisma-datasource-provider | (none) | 5 |
| A6 | `slice2-tableview-renderer` | read-only-data-components | lockfile | 2 |
| A7 | `slice2-data-loading-empty-error-states` | read-only-data-components | (none) | 2 |
| A8 | `slice2-content-type-management-ui` | cms-server-adapter, prisma-datasource-provider, admin-guard-stub | (none) | 5 |
| A9 | `slice2-editor-binding-picker` | read-only-data-components, content-type-management-ui | mst-tree (ONLY) | 6 |
| A10 | `slice2-publish-read-binding-hydration` | read-only-data-components, data-loading-empty-error-states, cms-server-adapter | (none) | 3 |

`slice2-read-binding-resolver-runtime` is a second parallel root (no deps). `slice2-editor-binding-picker` is the ONLY spec touching `mst-tree`. Track 0 OWNS `prisma/schema.prisma` creation.

### Track B (track `commerce-engine`, 7 specs, 28 days; Track 0 IS its b0)

| Order | Spec | dependsOn | shared_state | days |
|-------|------|-----------|--------------|------|
| B1 | `b1-commerce-module-skeleton` | track0-backend-foundation | (none) | 2 |
| B2 | `b2-inventory-ledger-schema` | b1 | prisma, migrations | 4 |
| B3 | `b3-guarded-reservation` | b2 | prisma, migrations | 4 |
| B4 | `b4-catalog-schema` | b3 | prisma, migrations | 5 |
| B5 | `b5-pricing-and-tax` | b4 | prisma, migrations | 5 |
| B6 | `b6-minimal-orders` | b5 | prisma, migrations | 4 |
| B7 | `b7-commerce-rest-reads` | b4, b3, b5 | (none) | 4 |

The schema chain is strictly serial (track0 -> b2 -> b3 -> b4 -> b5 -> b6) so the `prisma` shared-state never has two concurrent writers. b6 OWNS the Order model + its order-level German tax fields (b5 owns only catalog-side tax_class + pricing + CreditNote). The reserve transaction is READ COMMITTED (the oversell proof depends on it). b7 depends on b5 because the DTO carries `resolvedPriceCents`.

### Track C (track `storefront`, 9 specs, 37 days)

| Order | Spec | dependsOn | shared_state | days |
|-------|------|-----------|--------------|------|
| C1 | `trackc-commerce-data-source-seam-and-dtos` | b4, b2, track0 | (none) | 4 |
| C2 | `trackc-commerce-http-provider-and-read-routes` | seam-and-dtos, b7 | (none) | 4 |
| C3 | `trackc-commerce-binding-scope-frame-and-resolver` | seam-and-dtos, slice2-read-binding-resolver-runtime | binding-types | 3 |
| C4 | `trackc-storefront-product-list-and-detail-renderers` | scope-frame-resolver, http-provider, slice2-read-only-data-components, slice2-data-loading-empty-error-states | (none) | 5 |
| C5 | `trackc-variant-selector-component` | product-list-and-detail-renderers | (none) | 4 |
| C6 | `trackc-client-cart-state-and-cart-view` | variant-selector-component | (none) | 5 |
| C7 | `trackc-order-create-checkout-stop` | client-cart-state, b6, b3, slice2-admin-guard-stub | (none) | 5 |
| C8 | `trackc-register-storefront-components-as-bindable-blocks` | product-list-detail, variant-selector, client-cart, order-create-checkout | component-registry | 3 |
| C9 | `trackc-commerce-binding-preview-and-publish-hydration` | register-storefront-components, slice2-publish-read-binding-hydration | hydrate-bindings | 4 |

Track C reuses the Track A binding machinery; C3 edits the shared `src/lib/bindings/types.ts` scopeHint union (additive; the picker default-branches on unknown hints). C9 extends the CMS-owned `hydrateBindings` signature additively. C8 must extend the closed `ComponentCategory` union + the hard-coded `ComponentsPanel` category enumeration.

## Combined

27 leaf specs, 102 engineer-days. `slice2-read-binding-resolver-runtime` and `track0-backend-foundation` are the two parallel-safe roots. Track A begins meaningfully after Track 0's `prisma/schema.prisma` + DATABASE_URL + the adapter resolution land; Track B begins after Track 0's schema merge; Track C begins after Track A's binding layer + Track B's catalog/inventory REST reads.

## Deferred tail (gated epics, NOT dispatched in this workstream)

| Epic | Title | dependsOn | gated |
|------|-------|-----------|-------|
| E4 | framer-clone editor multiplayer cutover + MST<->Yjs binding spike | Track A + the existing wave-1/2/3 multiplayer specs | YES: the binding spike must PROVE OUT (does MobX reactivity flow cleanly through a Yjs-backed projection?); Marlin reviews; wave-0-synthesis decisions 7/8/9 confirmed; Hocuspocus scaffolded + load-tested on the NON-money editor/catalog domain. Hocuspocus is in ZERO package.json today (framer-clone ships only `yjs ^13.6.30`). |
| E5 | CRDT catalog co-editing CONTENT plane | Track B + E4 | YES: gated on E4 proving out AND Hocuspocus load-tested on the non-money catalog domain. `catalogDocShape.ts` + room=catalog:<id> + the draft-Y.Doc->Postgres commit boundary, CONTENT ONLY (title/description/labels; NEVER sku/price/stock). |
| E6 | authoritative stock broadcast (advisory-only) | Track B inventory ledger + E5 (the socket) | no (beyond E5 shipping): pg_notify on commit -> sendStateless typed channel -> read-only AuthoritativeStockStore (seq>stored, gap-detect refetch, NO merge on the stock path). The guarded reserve stays the sole authority. |
| E7 | multi-tenancy chassis (tenant two) | Track B + an auth spine (P2) | YES: a real SECOND tenant existing AND a validation gate passed. Flips withTenant from constant to real SET LOCAL search_path; tenant registry + auth-brain outbox provisioning consumer + N-schema migration runner; PgBouncer server_reset_query. Re-opens the single-schema-vs-multiSchema decision deferred from Track 0. |
| E8 | payment/tax/carrier providers + checkout | Track B (orders) + E7 (per-tenant provisioning) | YES: real-customer pull + an ASSIGNED Stripe Connect owner + a one-page plan. Stripe Connect on controller properties (Express-style, embedded components, NO Express->Custom migration); EU VAT/tax engine + OSS accumulation off the owned ledger; carrier. Each an idempotent signature-verified webhook + reconciliation writing authoritative rows. |

The existing AI Pattern A track (the `/api/ai/edit` SSE scaffold + the MST snapshot serializers, HEAD 00956c5/bb767a3) proceeds INDEPENDENTLY on the editor/MST track; it touches `mst-tree` so it serializes with `slice2-editor-binding-picker` and E4, but it is NOT a prerequisite for and NOT blocked by the data engines.

## Hard non-creep guarantees baked into this sequence

- `withTenant(prisma, schema, fn)` is the SET LOCAL search_path SIGNATURE collapsed to a constant schema for v1. The chassis (registry + outbox consumer + N-schema runner) is E7, never before.
- data-table is NEVER the system of record for stock/money. Every commerce spec uses purpose-built Prisma; none import adapter-prisma (its `transaction()` is a verified no-op at `adapter.ts:894`).
- Oversell is structurally impossible: 3 stacked guards (guarded UPDATE WHERE available>=needed under READ COMMITTED + CHECK(reserved<=stocked) + UNIQUE(request_id)).
- The order-create write uses a real `prisma.$transaction`, NOT `adapter.transaction()`. Money + stock are server-authoritative; the client sends only variantId+quantity intentions.
- `available_quantity` reads are ADVISORY-ONLY; no client path treats a read availability number as permission to sell.
- One early slice owns each shared shape: Track 0 owns `prisma/schema.prisma` creation; the commerce schema writers form a serial chain; `slice2-editor-binding-picker` is the sole `mst-tree` writer.

## References

- Re-scope brief (2026-06-16): framer-clone-only Track 0 -> A -> B -> C; drop doc-tier-core; park lumitra-web offers.
- Critiques (3 reviewers): adapter-prisma `workspace:*` blocker (republish/vendor); b2/b4 + b5/b6 serialization/ownership fixes; b0 test-harness; storefront dependency-ID reconciliation; ComponentCategory/panel edits; shared-state flags.
- `knowledge-base/research/2026-06-01-owned-realtime-commerce-architecture.md` (commerce doc) sections 3-8.
- `docs/specs/build-2026-06/ORCHESTRATION-LOOP.md` (how this sequence is fed to the autonomous orchestrator; the `prisma` shared-state now points at `framer-clone/prisma/schema.prisma`).
- `docs/specs/STATUS.md` (the wave ledger this complements).
