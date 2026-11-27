---
type: plan
status: draft
date: 2026-11-27
title: "Agent catalogue tools, and whether the shop catalogue belongs to the project (site) or to the company"
summary: "MCP tools on the Lumitra Sites agent endpoint that read and write a shop catalogue (products, variants, options, prices in whole cents, tax class, stock through the stock ledger, collections) through the repository functions the editor uses, with the editor's access rule and the company, tenant group and site verified from the key on every call. Open for Marlin, who leans toward it: the whole catalogue per project (site) instead of per company. This plan lays out that model with a two-shop example, its costs (shared stock, Books, Stripe, existing data and the stock ledger, erasure) and a later shared catalogue. Only scope-neutral work (the read tools named by site, the access layer) starts before the answer."
tags: [framer-clone, commerce, catalogue, mcp, agents]
projects: [framer-clone]
---

# Agent catalogue tools

Asked by Marlin on 2026-11-27: site agents must be able to manage the shop catalogue through the agent tools.
Trigger: a prospect, Konditorei Fritzenkoetter, gets a shop on Lumitra Sites' own engine, and today no agent can
create its products. The catalogue is editable only signed in to the editor (`/projects/catalog`), and the MCP
endpoint (`src/server/mcp/tools.ts`, the Lumitra Sites agent tools) has nothing for products, prices or stock.

Parents: [the catalogue design](2026-10-25-catalogue-design.md) (today's company catalogue),
[the agent plugin plan](2026-11-02-lumitra-sites-agent-plugin.md) (the MCP endpoint and its key rules),
[the business platform plan](2026-10-25-business-platform-architecture.md) (which decided one catalogue per
company on 2026-10-25; the question below would revise that).

## Open for Marlin: the shop catalogue per project (site), or per company

Not decided. Marlin leans toward the whole catalogue per project (2026-11-27, through the Fritzenkoetter lead);
the coordinator asks him the consolidated question. Until he answers, nothing in this plan's build commits to
either model (see "What starts now").

### Today: per company

Products, variants, prices, stock and collections belong to the company (`tenant_id` on every catalogue table,
migration 020). Every site of the company shows every published product unless it is switched off for that site
(`product_site_hidden`). One stock per item, one Books, one Stripe Connect account. No published page reads
collections yet: the shop's product list shows the company's catalogue minus the switched-off products.

### The proposal: per project

Every product (with its options, variants, prices, stock and images) and every collection belongs to exactly one
site of the company. A site's shop and its editor see only that site's catalogue. What stays per company: the
Books (invoice numbers, receipts, customers), contacts, the Stripe Connect account, and the company erasure.

### A concrete two-shop example

Konditorei Fritzenkoetter runs two sites: the pastry shop (order cakes for pickup) and a catering site (platters
for events). Both sell the Schwarzwälder Kirschtorte; the shop also sells strawberry jam in jars, 40 jars on one
shelf.

| | Per company (today) | Per project (proposal) |
|---|---|---|
| The cake | one product, one price, shown on both sites (or switched off on one) | two products, one per site; each can have its own price (38 EUR pickup, 45 EUR catering), photos, text and variants |
| The jam, 40 jars, if both sites sell it | one product, one stock of 40; a sale on either site lowers it | two products with two stocks; the 40 jars must be split by hand (say 25 and 15), or one site does not track stock and can oversell |
| Collections | "Torten" is one list for both sites | each site groups its own products ("Torten" on the shop, "Platten" on catering) |
| Books | both sites' receipts in one Books, one number series | the same: one Books, one series; a receipt line points at the site's own variant |
| Stripe | one account, both sites pay into it | the same |
| An agent working on the shop | sees and can change the catering prices too | sees and changes only the shop's catalogue |

Made-to-order cakes do not track stock, so for Fritzenkoetter's cakes per project costs nothing; the jam is where
it shows.

### What the proposal changes and costs

1. **Shared physical stock is lost.** One item sold on two sites becomes two products with two stocks. Stock
   stays in the ledger (`inventory_item`, `inventory_level`, `stock_movement`, keyed by SKU, and a SKU stays
   unique within the organisation), so the two products get two SKUs and two stock counts. Only the later shared
   catalogue (below) brings one stock back.
2. **Books.** Receipts, customers and invoice numbering stay per company (one legal seller, one GoBD-compliant
   number series). The invoice line picker (`GET /api/books/catalogue`) lists the items of all the company's
   sites, grouped by site. A company that uses only the Books has no site, yet invoices services from the
   catalogue today (the Books' own list was folded into the catalogue in October): those items need a home
   without a site. Proposed: they stay company items (no site), offered only to the Books. So "everything per
   project" is in fact "everything sold on a site per project".
3. **Stripe Connect stays per company** (one account per company, fixed once set, migration 022): the company is
   the seller of record. A site that must pay out to a different bank account under a different legal entity is a
   different company in auth-brain, not a different site.
4. **Contacts stay per company** (`@marlinjai/contacts-core`, one customer list): a customer who buys on both
   sites is one contact.
5. **Existing catalogue data and the stock ledger** (production holds the test jewellery company's products and
   any demo products; the exact counts are read by a dry run before anything is written):
   - a company with one site: every product and collection goes to that site;
   - a company with several sites: a product goes to the sites that show it today (not switched off); the
     original row, with its id, SKU, stock history and order references, goes to the site that sold it most
     recently (orders carry `site_id`), else the oldest site; every further site gets a copy with new ids, a new
     SKU and zero stock, listed in the dry run's report so the owner can set the stock;
   - collections are copied to each site whose products they contain;
   - a company with no site keeps its items as company items (point 2);
   - orders, receipts and invoice lines keep pointing at the originals, which keep their ids, so nothing issued
     changes;
   - `product_site_hidden` is the input of the assignment and is dropped afterwards (pre-launch, no back-compat).
   Done by an additive migration (a nullable `site_id` on `product` and `collection`, handles unique per company
   and site) and a backfill script with a dry run, as `catalogue:assign-company` did for 020. Running it on
   production is a release step, Marlin's.
6. **Deleting a site** must now take its catalogue along: its products and collections are soft-deleted (the
   catalogue has `deleted_at`), and those an order references are archived and kept, so receipts and the ledger
   stay intact. Today deleting a site leaves the catalogue untouched because it is the company's.
7. **Company erasure** is unchanged: it deletes by company (`tenant_id`), and every catalogue row keeps its
   company column. Its coverage list (`ERASURE_COVERAGE`) and tests gain the new column; nothing per site is
   personal data.
8. **The editor.** The catalogue moves from the company area (`/projects/catalog`) into the project (a site's
   own catalogue page, or the same page with a site picker); bulk actions, filters and the product panel work per
   site. The published shop's product list reads its site's products instead of "company minus switched off".
9. **Permissions do not get finer.** A company's sites all live in one editor workspace, and the access rule is
   the workspace role, so a person or key that may edit one site's catalogue may edit every site's of that company.
   Per-site people would be an auth-brain model change, outside this plan.

### A later shared catalogue, if ever needed

The proposal keeps the door open without moving data again: a company item (no site, point 2) can be offered to
several sites through a small link table (company, product, site). Visibility becomes "the site's own products,
plus company items listed for the site", one product and one stock across those sites. Purely additive: a new
table, one more condition in the storefront read, a "share with sites" control in the editor.

### Recommendation

Per project matches how Marlin wants Sites projects to work and keeps an agent on one site from touching
another's prices. Its real cost is shared stock between sites; the shared catalogue above covers that when a
customer needs it. If Marlin chooses per project, the build order below applies; if per company, slice 2 is
dropped and the write tools act on the company catalogue.

## What starts now (scope-neutral)

The read tools take a **required `siteId`** and answer "the catalogue of this site": today that is the company's
products not switched off for the site; after a per-project migration it is the site's own products. The same
contract holds under both models, so an agent written now keeps working. Nothing that creates or edits catalogue
data is built before the answer, because a create would mean "a product of every site" under one model and "a
product of this site" under the other.

## How the company and the site are verified (reads and writes)

On every call, in order, first failure wins:

1. The key is verified (`verifyCompanyKey`): a company key with the `sites` grant, mapped by the server to its
   company's workspace and tenant group. Nothing the request names is read for this.
2. The action: `viewSite` for reads, `editSite` for writes, through the key's caller (`authorizeKeyAction`), the
   rule the editor's catalogue routes use. A key acts as at most a workspace admin, so writes need an owner or admin
   key; a key whose company role is `member` or `viewer` reaches nothing.
3. The site: the `siteId` argument is looked up through the site repository scoped to the key's workspace and
   tenant group (`getSite`, the site operations' own read). A site of another company is `not_found`, never
   `forbidden`. A branch id resolves to its main site (`branchOfSite`); the catalogue keys to the main site. The
   site's stamped company (`sites.company_id`) must be the key's company; an unstamped site in the key's own
   workspace is accepted under the existing rule (the workspace belongs to one company, checked at step 1).
4. The shop schema: `commerceTenantDbChecked(key.scope.tenantGroupId)`; not provisioned answers
   `catalog_not_provisioned`.
5. The rows: every query filters on the key's company, and (after a per-project migration) on the verified site.
   Another company's or another site's product id answers `not_found`.

## Live shop changes (separate from authorization)

Authorization above decides who may change a catalogue. Separately, this plan proposes **no extra confirmation**
before an agent publishes a product or changes a price: an admin key equals a person with `editSite`, who has no
such step either; every write is reversible (archive, the old price) and audited; Fritzenkoetter's shop is not
live. This proposal is not an approval to change any live shop: before an agent works on a shop that already
sells, Marlin decides whether those two changes need a person's yes (the site publish's confirmation exists to
reuse).

## Decided here (say so if you disagree)

1. **No new permission action**: `viewSite` and `editSite`, as the editor; a new action would need adding to the
   machine allow list with no different rule behind it.
2. **No write path of its own**: a thin catalogue operations layer (`src/server/catalogOps/`) does the checks
   above, maps `CatalogError` codes to tool errors and writes the audit row; writes call the repository functions
   the editor's routes call. The tools live in their own file (`src/server/mcp/catalogTools.ts`).
3. **Granular tools, each one transaction** (the repository functions each open their own), not a composite
   "create everything" tool that could half-apply. Every step is idempotent by key or declarative, so a retried
   sequence ends in the same state.
4. **Idempotent creates without a new table**: `create_product` requires an `idempotencyKey`; the product id is
   derived from (company, key id, idempotency key) by SHA-256 shaped as a UUID. A repeat answers the existing
   product with `replayed: true`; a repeat with a different title or kind is refused (`idempotency_key_reused`).
5. **Stock only through the ledger.** `adjust_stock` (a signed delta) with a required `idempotencyKey`, booked as
   one `adjust` movement whose `request_id` is `agent:<company>:<key id>:<sha256 of the key>`: the request id is
   unique per organisation, not per company, so the company in it keeps one company's key from colliding with, or
   silently swallowing, another's movement. A repeat with the same variant and delta is a no-op (`replayed: true`);
   a different one is refused, instead of the ledger's silent no-op. `set_stock` is the editor's "set available to
   N", declarative. Lowering below what open orders reserved is refused. No direct count write exists.
6. **Create takes the product fields too** (description, tax class, price basis, tags, SEO, unit label),
   validated before anything is written and applied right after the create; a repeat completes a half-done one.
7. **Options by name**: the operations layer fills in the ids of options and values named without an id from the
   stored ones (case-insensitive), so a re-sent list keeps every variant's price, stock and SKU.
8. **Archive, never delete**, as the catalogue already does; orders keep their references.
9. **Audit rows in the public schema**: a Prisma table `catalog_operation_audits` beside `site_operation_audits`
   (which needs a site id and would mix two feeds): company, workspace, tenant group, site, actor, the tool, the
   ids touched. Ids only, never content or prices. Written after the write succeeds, as the site operations do.
10. **Out of this plan**: product photos (a 2 MB image does not fit the 2 MiB MCP body; it needs an import from a
    stock photo or a checked URL, its own roadmap line), orders, payments, refunds and the Books (writing them
    stays a person's job; `editBooks` is never allowed for keys).
11. **Collections are left out of reads until the answer**, including a product's `collections` field.

## Protections, and who each protects against

| Protection | Protects against | State |
|---|---|---|
| Key verification and the `sites` grant | anyone without a company key, a company without Lumitra Sites | exists (agent plugin) |
| `viewSite` / `editSite` on the key's role | a member, viewer or billing account's key changing or reading the catalogue | built, the editor's rule |
| Company and tenant group from the key only | another company of the same organisation (one schema holds several companies) and every other organisation (its own schema) | built |
| Site looked up in the key's workspace, branch to main site | an agent naming another company's site | built |
| Site filter on rows (per-project model only) | an agent on one site changing another site's catalogue of the same company | built with the migration |
| Another company's or site's id answers `not_found` | an agent probing which ids exist elsewhere | exists in the repository, kept |
| Idempotency keys (create, adjust) | duplicate products or double-booked stock when an agent or the network retries; not an attacker | built |
| Company in the stock request id | one company's key turning another company's stock movement into a no-op | built |
| Per-key read and write rate limits | a runaway agent loop | exists (reused) |
| Audit row per write | (not a guard) lets the owner and the operator see what an agent changed | built |
| A person's yes before a product goes live or a live price changes | a confused or prompt-injected agent changing a shop that sells | **not built**, see "Live shop changes"; Marlin decides before any live shop |

## Tools

Answers are the endpoint's usual text plus structured content, prices in whole cents (EUR), refusals with the
catalogue's own codes in lower case (`not_found`, `duplicate_handle`, `duplicate_sku`, `shape`, `kind_locked`,
`stock_not_tracked`, `sku_required`, `stock_below_reserved`, `invalid_input` with the field issues).

- Reads (slice 1, every one with a required `siteId`): `list_products` (search, status, kind, product type, stock
  state, sort, a cursor), `get_product` (options, variants with SKU, price, compare-at price, tracking and
  available stock, tax class, price basis, SEO), `list_product_types`.
- Writes (slice 3): `create_product`, `update_product` (fields; status draft, published or archived),
  `set_product_options`, `update_variant` (price, compare-at, SKU, barcode, tracking, backorder), `adjust_stock`,
  `set_stock`.
- Collections (slice 4): `list_collections`, `get_collection`, `create_collection`, `update_collection` (including
  archive), `set_collection_products`, `set_product_collections`.

## Slices (each one branch, about 1,500 changed lines at most)

1. **Now**: the operations layer with the verification above, the three read tools, the tool list test, the
   server instructions and the plugin README, unit tests and an integration test through the MCP route.
2. **After the answer, per project only**: 2a the migration, the backfill with its dry run, the storefront read
   and site deletion; 2b the editor's catalogue in the project and the Books picker grouped by site.
3. **Writes** (site-scoped under per project, company-scoped under per company) with the audit table.
4. **Collections**, then a product list bound to a collection on published pages.

## Proof

Integration tests through the real MCP route (`/api/mcp`) and the real key verification, on a throwaway database
(the integration Docker Postgres) with a provisioned shop schema, connected as the low-privilege commerce role:
- reads: a product read back through `list_products` and `get_product` for a site of the key's company; a site of
  another company answers `not_found`; a second company in the same tenant group and a key of a second tenant
  group (its own schema) see nothing; a key whose company role is `member` gets `forbidden`;
- writes (slice 3): create a product with options, variants, prices and stock, read it back, repeat the create
  and the stock move with the same keys (nothing doubles), a reused key with another payload is refused, and the
  refusals for another company and for a `member` key write nothing (row counts unchanged).

The repository has no `AGENTS.md` and no single check command; CI runs the guard check (`pnpm lint:guards`),
typecheck, lint, three unit shards, the build and two integration shards. Before each push: typecheck, lint, the
changed unit tests, and the touched integration files through the hermes slot (`hermes-slot run`).

## Never

Production data, a test purchase on production, the private Fritzenkoetter draft (write stop in force), deploys
or releases (Marlin's).
