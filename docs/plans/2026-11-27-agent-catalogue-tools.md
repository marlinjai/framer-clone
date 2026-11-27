---
type: plan
status: draft
date: 2026-11-27
title: "Agent catalogue tools: site agents manage products, variants, prices, stock and collections"
summary: "MCP tools on the Lumitra Sites agent endpoint that read and write the company catalogue (products, variants, options, prices in whole cents, tax class, stock through the stock ledger, collections) through the same repository functions the editor's catalogue uses, with the editor's access rule (viewSite to read, editSite to write), the company and tenant group taken only from the verified key, idempotent creates and stock moves, and an audit row per write. One open question for Marlin: are collections per project (site) or per company."
tags: [framer-clone, commerce, catalogue, mcp, agents]
projects: [framer-clone]
---

# Agent catalogue tools

Asked by Marlin on 2026-11-27: site agents must be able to manage the shop catalogue through the agent tools.
Trigger: a prospect, Konditorei Fritzenkoetter, gets a shop on Lumitra Sites' own engine, and today no agent can
create its products. The catalogue is editable only signed in to the editor (`/projects/catalog`), and the MCP
endpoint (`src/server/mcp/tools.ts`, the Lumitra Sites agent tools) has nothing for products, prices or stock.

Parents: [the catalogue design](2026-10-25-catalogue-design.md) (the company catalogue this writes to),
[the agent plugin plan](2026-11-02-lumitra-sites-agent-plugin.md) (the MCP endpoint and its key rules),
[the business platform plan](2026-10-25-business-platform-architecture.md) (one catalogue per company).

## Open question for Marlin: collections per project (site) or per company?

Everything in slices 1 and 2 below is independent of this answer; only slice 3 waits for it.

**What a collection is today.** A company-level, manually ordered list of products (`collection`,
`collection_product`, migration 020), edited in the catalogue's Collections tab and used as a filter and a bulk
action ("add to collection") in the product table. **No published page reads collections**: the shop's product
list component lists the company's whole catalogue (published, not archived) minus the products switched off for
that site (`product_site_hidden`, the per-site visibility of the catalogue design). So the choice changes the
admin and future site features, not anything a visitor sees today.

**Option A: collections stay per company** (no change). One "Torten" collection serves every site of the company.
Which products a site shows stays the per-site switch. Cheapest; but a company with two sites (a café site and a
catering site) cannot group the same cakes differently per site.

**Option B: collections per project (recommended, and the Fritzenkoetter lead's and Marlin's lean).** Products,
variants, prices and stock stay per company (one stock, one Books ledger, one Stripe Connect account); a
collection belongs to one site and groups that site's products for display.
- Schema: a tenant migration adds `collection.site_id` (TEXT, the main site's id; sites live in the public
  schema, so no foreign key, as `product_site_hidden.site_id`), the live-handle unique index becomes
  (company, site, handle), and a `NOT VALID` check refuses new collections without a site.
- Existing rows: a backfill script (as `catalogue:assign-company` did for 020) copies each existing collection,
  with its members and order, to every site of the company, then validates the check. Copying, not moving, so
  nothing is lost; on production this concerns the test jewellery company's two sample collections only.
- Branches: a collection keys to the main site, never a branch id; on a branch the editor and the agent work on
  the main site's collections.
- Visibility: `product_site_hidden` stays the rule for which products a site sells; collections only group. (A
  later step could let a site sell exactly its collections' products; not proposed here.)
- Editor: the Collections tab and the table's collection filter and bulk action get a site picker (the catalogue
  page is company level today); the product panel's Collections section shows them per site.
- Published pages: the payoff is a product list bound to one collection of its site ("show the Torten
  collection here"), a small follow-on of slice 3.

**Option C: company collections with an optional site.** `site_id` nullable: empty means usable on every site.
Most flexible, but two kinds of collection in every list and picker, for a need nobody has yet.

**Recommendation: B.** It matches how a company with several sites presents itself, the shared stock and
accounting stay single, and since no published page reads collections yet, the move costs one additive migration,
a copy backfill and a site picker. Answer A, B or C; until then slice 3 is not started.

## Decided here (say so if you disagree)

1. **Same access rule as the editor's catalogue.** Reads need `viewSite`, writes `editSite`, checked through the
   key's caller (`authorizeKeyAction`): a key acts as at most a workspace admin, so writes need a company owner or
   admin key; a key whose company role is `member` or `viewer` reaches nothing. No new permission action is added
   (the catalogue design put the catalogue behind the `sites` grant and these two checks, and a new action would
   have to be added to the machine allow list with no different rule behind it).
2. **The company and tenant group come only from the verified key** (`key.tenantId`, `key.scope.tenantGroupId`),
   never from tool arguments; the handle is `commerceTenantDbChecked(tgId)` and the scope `catalogScope(...)`,
   exactly as the editor's guard (`src/server/catalog/http/route.ts`). A tenant group without a provisioned shop
   schema answers `catalog_not_provisioned` with the next step in it.
3. **No write path of its own.** A thin catalogue operations layer (`src/server/catalogOps/`) checks access,
   resolves the scope, maps `CatalogError` codes to tool errors and writes the audit row; every write calls the
   repository functions the editor's routes call (`createProduct`, `updateProduct`, `setOptions`, `updateVariant`,
   `setVariantStock`, and in slice 3 the collection functions). The tools live in their own file
   (`src/server/mcp/catalogTools.ts`), not in the 1,100-line `tools.ts`.
4. **Granular tools, each one transaction**, rather than one "create product with everything" tool: the
   repository functions each open their own transaction, so a composite tool would half-apply on a failure. Every
   step is either idempotent by key (create, stock moves) or declarative (an update sets values; repeating it
   changes nothing), so an agent that retries a whole sequence ends in the same state.
5. **Idempotent creates without a new table.** `create_product` requires an `idempotencyKey`; the product id is
   derived from (company, key id, idempotency key) by SHA-256 shaped as a UUID. A repeat hits the primary key and
   answers the existing product with `replayed: true`; a repeat with a different title or kind is refused
   (`idempotency_key_reused`). `createProduct` gains an internal `id` option for this (not reachable from HTTP).
6. **Stock only through the ledger, two tools.** `adjust_stock` (a signed delta, "20 delivered", "3 broken")
   with a required `idempotencyKey`, booked as one `adjust` movement whose `request_id` is
   `agent:<company>:<key id>:<sha256 of the idempotency key>`, so one company's key can never collide with, or
   silently swallow, another company's movement (the request id is unique per tenant group, not per company). A
   repeat with the same key and the same variant and delta is a no-op answering `replayed: true`; with a
   different variant or delta it is refused (`idempotency_key_reused`), instead of the ledger's silent no-op.
   `set_stock` is the editor's "set available to N" (`setVariantStock`), declarative and so safe to repeat.
   Lowering below what open orders reserved is refused, as in the editor. A direct count write does not exist.
7. **Create takes the product fields too.** `create_product` accepts the update fields (description, tax class,
   price basis, tags, SEO, unit label); they are validated before anything is written, then applied by
   `updateProduct` right after the create. A failure between the two leaves a product that a repeat of the same
   call completes (the create replays, the update is declarative).
8. **Options by name.** `set_product_options` takes the whole option list as the editor's options editor does;
   the operations layer fills in the ids of options and values the agent names without an id by matching the
   stored ones case-insensitively, so a retried or re-sent list keeps every existing variant (its price, stock and
   SKU) instead of replacing them.
9. **Archive, never delete.** The catalogue has no hard delete; `update_product` with status `archived` (and
   back) is the only removal, so orders that reference a product keep their reference. Removing a variant happens
   only by removing its option value, as in the editor.
10. **Audit rows in the public schema.** A new Prisma table `catalog_operation_audits` beside
    `site_operation_audits` (which needs a site id): company, workspace, tenant group, actor kind and id, actor
    detail (service account, key name), the tool, and the product, variant or collection ids it touched. Ids
    only, never content or prices. Written after the write succeeds, as the site operations do.
11. **Out of this plan:** product photos (an agent cannot send a 2 MB image through a 2 MiB MCP body; it needs
    an import from a stock photo or a checked URL, its own small plan, roadmap line), per-site visibility
    (`product_site_hidden`, moves with slice 3 since it is the same site question), orders, payments, refunds and
    the Books (the brief's trigger names them; writing them stays a person's job, `editBooks` is never allowed for
    keys).
12. **Collections stay out of slices 1 and 2 entirely**, including the `collections` field of a product read,
    so nothing an agent learns now changes meaning after the answer.

## Protections, and who each protects against

| Protection | Protects against | State |
|---|---|---|
| Key verification and the `sites` grant | anyone without a company key, a company without Lumitra Sites | exists (agent plugin) |
| `viewSite` / `editSite` on the key's role | a key of a member, viewer or billing account changing the catalogue | built, the editor's rule |
| Company and tenant group from the key only | another company of the same organisation (one schema holds several companies) and every other organisation (separate schema) | built |
| Another company's id answers `not_found`, never `forbidden` | an agent probing which product ids exist elsewhere | exists in the repository, kept |
| Idempotency keys (create, adjust) | duplicate products or double-booked stock when an agent or the network retries; not an attacker | built |
| Company in the stock request id | one company's key turning another company's stock movement into a silent no-op | built |
| Per-key read and write rate limits | a runaway agent loop | exists (reused) |
| Audit row per write | (not a guard) lets the owner and the operator see what an agent changed | built |
| A person's yes before a product goes live or a live price changes | a confused or prompt-injected agent changing a shop that already sells | **not built**: an admin key equals a person with editSite, who has no such step either; every write is reversible and audited; Fritzenkoetter's shop is not live. Revisit before an agent manages a live shop |

## Tools

All answers are the endpoint's usual text plus structured content, prices in whole cents (EUR), refusals with the
catalogue's own codes in lower case (`not_found`, `duplicate_handle`, `duplicate_sku`, `shape`, `kind_locked`,
`stock_not_tracked`, `sku_required`, `stock_below_reserved`, `invalid_input` with the field issues).

Slice 1, reads:
- `list_products`: search, status, kind, product type, stock state, sort, a cursor; the editor table's list
  (`listProducts`), without collections.
- `get_product`: one product with options, variants (SKU, price, compare-at price, tracking, available stock),
  tax class, price basis and SEO fields (`getProduct`), without collections.
- `list_product_types`: the company's product types (`listProductTypes`).

Slice 2, writes:
- `create_product`, `update_product` (fields, status draft, published or archived), `set_product_options`,
  `update_variant` (price, compare-at, SKU, barcode, stock tracking, backorder), `adjust_stock`, `set_stock`.

Slice 3, after the answer: `list_collections`, `get_collection`, `create_collection`, `update_collection`
(including archive), `set_collection_products` (members and order), `set_product_collections`, and per-site
visibility (`set_product_sites`); with option B also the migration, the backfill, the editor's site picker and the
product list bound to a collection.

## Slices (each one branch, about 1,500 changed lines at most)

1. **Read tools** (plan included): the operations layer with access and scope, the three read tools, the tool
   list test, the server instructions and the plugin README, unit tests and an integration test through the
   MCP route.
2. **Product, variant, price and stock writes**: the six write tools, the derived-id create, the ledger-keyed
   adjust, options by name, the audit table (one additive Prisma migration), unit and integration tests.
3. **Collections** (waits for the answer): with option B split into 3a (migration, backfill, editor site picker)
   and 3b (the collection tools and the collection-bound product list).

## Proof

Integration tests through the real MCP route (`/api/mcp`) and the real key verification, on a throwaway database
(the integration Docker Postgres) with a provisioned shop schema, connected as the low-privilege commerce role:
- create a product with options, variants, prices and stock, read it back, repeat the create and the stock move
  with the same keys (nothing doubles), and a reused key with a different payload is refused;
- a second company in the same tenant group reads none of it and its writes on these ids answer `not_found`
  with nothing written; a key of a second tenant group (its own schema) likewise;
- a key whose company role is `member` gets `forbidden` on every write and on reads, with row counts unchanged.

The repository has no `AGENTS.md` and no single check command; CI runs the guard check (`pnpm lint:guards`),
typecheck, lint, three unit shards, the build and two integration shards. Before each push: typecheck, lint, the
changed unit tests, and the touched integration files through the hermes slot (`hermes-slot run`). Gap reported to
the coordinator, not fixed here.

## Never

Production data, a test purchase on production, the private Fritzenkoetter draft (write stop in force), deploys
or releases (Marlin's).
