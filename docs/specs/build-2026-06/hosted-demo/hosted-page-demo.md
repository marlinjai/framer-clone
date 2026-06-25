---
name: hosted-page-demo
track: hosted-demo
wave: 4
priority: P1
status: draft
type: plan
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2b-cms-datatable-grid-ui]
touchesSharedState: true
sharedState: [prisma/schema.prisma, src/middleware.ts, next.config.ts]
estimateDays: 8
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: Lead (Marlin to approve scope)
date: 2026-06-22
---

# Hosted-page demo: publish a page to a real subdomain (the next big demo)

> The next demo: edit a page in the builder, hit **Publish**, then visit a real subdomain on a
> phone and see the page render server-side with live CMS + commerce data, add to cart, place an
> order, and watch the analytics dashboard light up. This is the "right half" of the product
> (the left half: editor, CMS, commerce engine, in-editor preview, all exist). This spec is the
> sequenced plan to wire it, grounded in a code map of what exists vs what's missing (2026-06-22).

## Decided scope (Marlin, 2026-06-20/22)

- **Tenancy:** wildcard DNS infra now + a **single wired site** for the demo. The platform manages
  ONE wildcard record (`*.<sub>.<domain>` -> the Coolify server) + a wildcard TLS cert; customers
  manage no DNS. We wire one site's data, skipping the full E7 multi-tenant data chassis (additive
  later, the middleware already reads the subdomain). Customer-owned custom domains (CNAME + on-demand
  certs) are a separate, later feature.
- **Render mode:** SSR-on-request (the RSC route loads the snapshot and runs `hydrateBindings` live;
  CMS + commerce always fresh). NOT static export.
- **Commerce terminus:** checkout stops at order-created with a clean confirmation. No payment
  (Stripe stays deferred, E8).
- **Analytics:** basic tracker injected (live traffic dashboard). A/B testing deferred to a later demo.

## What already exists (the good news, verified 2026-06-22)

- `src/lib/renderer/publish/hydrateBindings.ts`: a PURE, Node-only function. Input = a serializable
  `ComponentNode` snapshot + page params + read repos. Output = a hydrated tree with CMS
  (Collection/RecordView) and commerce (ProductList/ProductDetail) children expanded into concrete
  primitive subtrees, and the 4 INTERACTIVE commerce kinds (`variant-selector`, `add-to-cart`,
  `cart-view`, `checkout-button`) left verbatim as runtime islands. It is written but NEVER CALLED.
- `getCmsRepository()` (`src/server/cms/`, `server-only`, Prisma): ready, RSC-callable, implements
  the `CmsReadRepository` `hydrateBindings` expects.
- `LumitraBindingModel` is already on `ProjectModel` (projectId / ingestionEndpoint / apiKeyRef /
  enabled). `analytics-platform` is cloned locally with published `@marlinjai/analytics-tracker` /
  `-react` + a `/api/collect` ingestion endpoint.

## What is missing (the build)

The page tree is MST client-only (no `Project`/`Page`/`Site` Prisma model); there is no public render
route, no `middleware.ts`, no publish write, no commerce READ repo, and no SSR-safe renderer (every
renderer is `'use client'` + `observer()` + hooks, by design for the live editor). The SSR check
classified this as "(B) mixed, need an SSR-safe render path", but LOW RISK: `hydrateBindings` already
does the hard data-expansion, so the new server renderer is a pure tree-walk over already-expanded
primitives + island emission, not a port of the client renderers.

## Critical path (sequenced build items)

| # | Item | What it builds | Touches | Size |
|---|------|----------------|---------|------|
| 1 | **Publish persistence** | A `PublishedSite` Prisma model: `id`, `subdomain` (unique), `projectSnapshot` (jsonb: pages + component trees + route params + SEO + the LumitraBinding), `publishedAt`. Single-site demo: one row per published project. | `prisma/schema.prisma` (+ migration) | S |
| 2 | **Publish write + button** | `POST /api/projects/publish` (admin-guarded): serialize the MST project to a stable JSON snapshot (reuse the `pageTree` serializer shape), upsert `PublishedSite` by subdomain. A "Publish" button in the editor top bar that calls it and surfaces success/failure loudly. | `src/app/api/projects/publish/`, top bar | S-M |
| 3 | **Commerce read repo** | `getCommerceServerRepository()` implementing the `CommerceServerRepository` interface `hydrateBindings` expects: `listProducts` / `getProductByHandle` / `listVariants` / `getPrices` / `getAvailability` as read-only Prisma queries (advisory availability from the inventory ledger). Today only write/tx-bound commerce repos exist. | `src/server/commerce/` | M |
| 4 | **ServerComponentRenderer** | An SSR-safe, snapshot-based renderer: takes the hydrated `ComponentNode` tree (from `hydrateBindings`), renders primitives to RSC/HTML via a SERVER-importable component map (the current dispatch reads `window.__componentRegistry`, which does not exist server-side, so primitives get a server render map), and emits the 4 interactive commerce kinds as client-component islands that hydrate via the existing HTTP commerce data source. No MST, no `observer()`, no hooks. | `src/lib/renderer/server/` (new) | M |
| 5 | **Public RSC route** | `app/(site)/[[...slug]]/page.tsx` (server): resolve the site (from the Host header set by middleware), load its `PublishedSite` snapshot + the matched page + route params, call `hydrateBindings(snapshot, params, { cmsRepo: getCmsRepository(), commerceRepo: getCommerceServerRepository() })`, render via `ServerComponentRenderer`, return HTML + islands. SEO/OG from the snapshot metadata. | `src/app/(site)/` | M |
| 6 | **Host -> site routing** | `src/middleware.ts`: parse the subdomain from `Host`, look up the site, rewrite to the `(site)` route with the resolved site id on a header. Demo: one subdomain -> the single `PublishedSite`. Forward-compatible to multi-site. | `src/middleware.ts`, `next.config.ts` | S |
| 7 | **Prod infra** | Via the `scaffold-project` skill: Infisical project + Postgres on Hetzner/Coolify; `DATABASE_URL` + `FRAMER_CLONE_ADMIN_SECRET` + `ANTHROPIC_API_KEY` + the analytics ingestion key; Coolify Next app (standalone output / Dockerfile); **wildcard DNS** `*.<sub>.<domain>` + **wildcard TLS via DNS-01** (a DNS-provider API token in the deploy); `prisma migrate deploy`. | infra, Infisical, Coolify, DNS | M-L |
| 8 | **Analytics injection** | Inject `@marlinjai/analytics-tracker` into the published page `<head>` when the snapshot's LumitraBinding is `enabled`, with the site's `projectId` + ingestion endpoint (key server-side ref, never a literal). Verify events land in the analytics dashboard. | published route `<head>`, dep add | S |

**Interactive islands:** the 4 commerce islands hydrate client-side via the existing
`useCommerceDataSource()` HTTP provider hitting the prod `/api/commerce/*` reads, and checkout POSTs
to `/api/commerce/orders` (stops at order-created). Confirm the HTTP commerce provider is configured
for same-origin on the published page.

## The one risk, verified

The "are the renderers SSR-safe" risk is RESOLVED: they are not (client-coupled by design), but we do
NOT port them. `hydrateBindings` pre-expands data components into primitive subtrees, so item #4 only
needs to (a) render primitives server-side via a server component map and (b) emit 4 island types.
That is a new ~300-500 line tree-walk, not a renderer rewrite. The remaining real work is the commerce
read repo (#3) and the infra (#7).

## Test plan (headless `.test.ts(x)`)

- `PublishedSite` persistence + the publish write (snapshot round-trips; admin-guarded; upsert by subdomain).
- `getCommerceServerRepository`: each read method against a seeded DB (or fake) returns the expected DTOs.
- `ServerComponentRenderer`: a hydrated tree of primitives renders to the expected HTML; each of the 4
  interactive kinds emits its island marker; unknown node types degrade gracefully (no throw).
- Public route: given a seeded `PublishedSite`, the route resolves it, hydrates, and returns HTML
  containing the CMS/commerce data (use a fake repo set); a missing site -> 404.
- middleware: subdomain parsing maps to the right site; unknown subdomain -> 404/landing.

## Manual verification (the demo itself)

- Provision prod (scaffold-project), migrate, set the wildcard DNS + cert.
- In the builder: bind an Events collection to a gallery + a product list to the commerce catalog;
  hit Publish.
- On a phone, open `demo.<sub>.<domain>`: the page renders server-side with live CMS + commerce;
  add a variant to cart; checkout; see "order placed"; confirm the order + the no-oversell reservation.
- Open the analytics dashboard: the demo's pageviews/events are live.

## Out of scope (deferred, each its own slice)
- A/B testing (canvas-authored variants + server-side assignment) — the next demo.
- Real payment (Stripe) — E8.
- Multi-tenant data chassis (E7) — wire the second site.
- Customer-owned custom domains (CNAME + on-demand certs).
- Static export / ISR caching (SSR-on-request first; add caching once it is live).

## Open decisions for Marlin
1. The demo domain + subdomain label (which apex do we point the wildcard at?).
2. Which analytics project/key to bind for the demo.
3. Whether to do a tiny "fake pay" confirmation step or leave checkout at the plain order-created
   confirmation (current plan: plain confirmation).
