---
type: plan
status: decided
date: 2026-11-27
title: "Agent catalogue tools, and the shop catalogue per project (site)"
summary: "MCP tools on the Lumitra Sites agent endpoint that read and write a shop catalogue (products, variants, options, prices in whole cents, tax class, stock through the stock ledger, collections) through the repository functions the editor uses, with the editor's access rule and the company, tenant group and site verified from the key on every call. Decided by Marlin on 2026-11-28: the whole catalogue per project (site) instead of per company, accepting the costs laid out here (migration of the existing company catalogue and the test companies, Books and Stripe staying per company); stock shared between two sites is out of scope until a real customer needs it. Build order: the read tools first, then the per-project scope change and the write tools; the production run of the catalogue migration needs Marlin's one-line yes."
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

## Decided by Marlin: the shop catalogue per project (site)

**Decided 2026-11-28 (01:25, relayed by the Fritzenkoetter concept session):** the whole catalogue (products,
variants, prices, stock and collections) belongs to the project (site), not to the company. Marlin accepts the
consequences listed below: the existing company catalogue and the test companies are migrated, and Books,
contacts and Stripe stay per company.

- **Shared stock across two sites is out of scope for now.** Each site has its own single stock. Sharing is built
  the moment a real customer needs it (the later shared catalogue below); until then it is a dated ROADMAP line,
  not a build item.
- **Order:** land the read tools first (slice 1), then the per-project scope change and the write tools (slices
  2 and 3), one branch per phase of about 1,500 changed lines at most, focused checks, one review, with a Claude
  reviewer for the access and migration parts.
- **The migration of the existing company catalogue is a data move on production.** It is prepared and rehearsed
  on a copy; the production run waits for Marlin's one-line yes, sent through the coordinator.

The sections below are the analysis that led to the decision, kept as the record of what it costs.

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
customer needs it. Marlin chose per project on 2026-11-28; the build order below applies.

## What started before the answer (scope-neutral)

The read tools take a **required `siteId`** and answer "the catalogue of this site": today that is the company's
products not switched off for the site; after a per-project migration it is the site's own products. The same
contract holds under both models, so an agent written now keeps working. Nothing that creates or edits catalogue
data was built before the answer, because a create would mean "a product of every site" under one model and "a
product of this site" under the other. Slice 1 landed as #524.

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

1. **Done (#524)**: the operations layer with the verification above, the two read tools (`list_products`,
   `get_product`), the tool list test, the server instructions and the plugin README, unit tests and an
   integration test through the MCP route.
2. **Per project (decided 2026-11-28)**: 2a the migration, the assignment with its dry run, the storefront read;
   2b site deletion, the editor's catalogue in the project and the Books picker grouped by site.
3. **Writes**, scoped to the verified site, with the audit table.
4. **Collections**, then a product list bound to a collection on published pages.

### Slice 2a: how the assignment works (decided here, say so if you disagree)

- **Migration `033_catalogue_site`** is additive: a nullable `site_id` on `product` and `collection`, handles
  unique per company and site (company items, with no site, share one handle space), and a table
  `catalogue_per_site` with one row per company whose catalogue has been assigned, holding the run's report.
- **A NULL `site_id` has two meanings, told apart by `catalogue_per_site`.** For an assigned company it is a
  company item (Books only, on no shop). For a company not yet assigned it is a row from before, and the shop
  reads it the old way (the company's products not switched off for the site). One rule,
  `src/server/commerce/repository/siteCatalogue.ts`, serves the published shop, its checkout, the editor canvas
  and the agent read tools. So deploying 033 changes no live shop: each company switches when its assignment
  runs, one company at a time if wanted (`--company`).
- **The assignment** (`pnpm catalogue:assign-sites <tenant group> [--company <id>] [--apply]`, a dry run unless
  `--apply`, one transaction, the catalogue tables locked against writes meanwhile) follows point 5 above. The
  row of a product shown on several sites stays on the site that sold it most recently (orders on a site it is
  switched off for do not count). "Sold" means a completed sale: the order is not cancelled and its payment is
  paid, or it has no payment record (a free order, or one placed through the orders route without a checkout);
  a pending, failed, cancelled, expired or refunded payment does not count. Else the row goes to the oldest
  published one, else the oldest. Each copy keeps the handle,
  gets SKUs suffixed `-2`, `-3`, ... until they are free in the tenant group (no barcode), and an empty stock
  record per tracked SKU, so it starts at zero stock and checkout finds it. A collection goes to the sites
  of its products, an empty one to the oldest site. A company is marked even when it has no site, so from then on
  its NULL rows are company items. A main site that names no company refuses an applying run.
- **What the run may meet on production, and what happens** (from the review):
  - an old row that breaks a check 020 added without enforcing it on existing rows (a handle with uppercase,
    a title with a trailing space) aborts the run, and the dry run shows the same error, so it is fixed first;
  - a visitor whose cart holds a product whose row moved to another site gets the clear "unknown variant"
    answer at checkout (the cart is kept, the line no longer sold there says so and keeps its remove button, and the
    visitor adds the product again);
  - an editor save at the same moment can make Postgres abort one side; if it aborts the run, nothing is
    written and the run is repeated.

  So the run happens at a quiet hour, after a clean dry run.
- **A branch reads its main site's catalogue**: the editor canvas of a branch now uses the main site's id.
- **`product_site_hidden` stays** until every company is assigned (it is the input and the old rule); a later
  migration drops it.
- **The production run comes after 2b.** Once a company is assigned, a product created in today's company-wide
  editor has no site and so appears on no shop. The run therefore waits until the editor creates products in a
  project (2b), and needs Marlin's one-line yes. The rehearsal is `src/server/commerce/__tests__/catalogue-site.itest.ts`:
  a throwaway database with a one-site company, a three-site company (a product shown on two sites and sold on
  both, one switched off everywhere, a service on all three, a deleted product, collections) and a company
  without a site. It covers the dry run writing nothing, the per-company switch, each shop's exact list, the
  copies, and a second run changing nothing. Nothing is read from production.

### Slice 2b, part 1: site deletion takes its catalogue along (decided here, say so if you disagree)

`src/server/catalog/siteRetire.ts`, with its job kind `catalogue_retire` (`src/server/catalog/siteRetireJob.ts`):

- **What happens to the deleted site's rows.** A product that an order line or a Books document line names (`variant_ref`
  on any of its variants) is archived and kept whole (variants, prices, stock), so orders, receipts, invoices and the
  ledger keep pointing at real rows. Every other product is soft-deleted together with its variants and their stock items,
  which releases its SKUs (the SKU indexes are partial on `deleted_at`): another site of the company may reuse one and
  starts at zero stock, not at the deleted shop's count. Collections are archived and emptied (a collection has no
  `deleted_at`; archiving frees its handle). The site's `product_site_hidden` rows go. Rows without a site (company items,
  or the rows of a company not yet assigned) are never touched.
- **Durable, as the form purge.** The site row (public schema) and the catalogue (tenant schema) are two connections, so
  the delete route writes a `catalogue_retire` job BEFORE the site row goes (if it cannot, nothing is deleted), retires
  at once after the commit, and the job, ten minutes later, is the backstop: it acts only once the site row is gone, looks
  again for two hours while a delete has not committed, retries without giving up, and is counted by the job watchdog's
  "stuck" figure with the form purges. The shared "is the site gone" look moved to `src/server/commerce/jobs/siteGone.ts`.
- **Whose rows.** The company is the delete request's active company from the verified session (its workspace is the one
  the site is deleted from), carried as the job's tenant; every statement filters on that company and the site id.
  Protects against an admin of one company naming another company's site id (in the same tenant group) to retire its
  catalogue: nothing of the other company's is touched (proven by forged rows in the integration test).
- **An accepted race.** An order whose request resolved the site just before the delete committed can land after the
  retirement looked for references; its product is then soft-deleted instead of archived. The order line keeps its own
  snapshot and its `variant_ref` still names the soft-deleted row, so nothing issued breaks.
- **The owner is told** in the delete dialog that the project's products and collections go with it and that ordered or
  invoiced products are kept archived.

Proof: `src/server/catalog/__tests__/siteRetire.itest.ts` (the job a no-op while the site exists, the job alone retiring
after the delete, archive versus soft-delete, SKU reuse at zero stock, a second run changing nothing, another site's,
another company's and siteless rows unchanged) and the delete route's unit tests.

### Slice 2b, part 2: the editor's catalogue per site (decided here, say so if you disagree)

- **One catalogue at a time.** The Catalog area (`/projects/catalog`) keeps its place and gets a "Catalog of" picker:
  each main site of the company, plus the items without a site (`?site=company`, labelled "Company items (invoices
  only)" once the company is assigned, "Shared by all sites" before). The address keeps the choice; no address opens the
  first site (the company items when the company has no site, with a note pointing at creating one); a site the company
  does not have (deleted, another company's, a branch) says so and shows the first site. Switching drops the open panels.
  A separate page per project was not built: the picker covers it with less code, and a link from a project can pass `?site=`.
- **Writes land in the catalogue shown.** Creating a product, a collection or the sample products requires `siteId` in
  the body (a site of the company, or null for a company item; a missing one is refused, so no client silently makes an
  item that shows on no shop). Lists take `site` or `companyItems=1`. Every site id is verified by one resolver,
  `src/server/catalog/http/site.ts`: looked up in the session company's own workspace and tenant group, a branch resolves
  to its main site, anything else answers `unknown_site` (404). Protects against a member of one company naming another
  company's site to read or create in its catalogue. Repository functions take the verified site as a separate argument
  (`createProduct(scope, input, { siteId })`), never from the input, so slice 3's agent tools reuse them unchanged.
- **A collection holds only products of its own catalogue** (the same site, or both without one), refused as
  `wrong_site` (409) from all three sides: the collection's product list, the product's collections, and the bulk "add to
  collection". The panel and the collection picker offer only matching ones. `collectionOnSite`, the twin of
  `productOnSite`, lives in `siteCatalogue.ts`.
- **The per-site switch is refused where it does nothing** (`site_owned`, 409): for a product with a site, and for any
  product of an assigned company; the meta answer carries `assigned`, and the panel shows a sentence instead of the switch.
- **Handles stay unique per company across sites for new rows** (`freeHandle` unchanged): never a collision, at the cost
  of `ring-2` on a second site when made in the editor. The database allows the same handle per site, so an explicit
  handle may repeat on another site.
- **Other insert paths, decided:** the test shop seed (`seedTestShop`, an operator script for the test jewellery company)
  and the demo seed (`seedDemoSite`, dev and smoke tests) keep creating rows without a site: their companies are not
  assigned, so those rows show on every site the old way, and the assignment places them like any other.
- **The assignment copes with the mixed state** the per-site editor creates before the production run (a company not
  yet assigned, with stamped rows next to rows without a site): a row that would land on a site where a stamped row holds
  its handle takes the next free `-2`, `-3` there (listed in the report as `handlesRenamed`), and a stamped collection's
  membership of a product without a site follows the product to its row on that site or goes
  (`stampedCollectionMembers`). Rehearsed in `catalogue-site.itest.ts`.

Part 3 (its own branch): the Books invoice picker grouped by site.

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
