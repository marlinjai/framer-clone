---
type: plan
status: draft
date: 2026-10-25
title: "The catalogue: products and services per company, sold through the shop and invoiced in the Books"
summary: "Design for step 1 and 2 of the business platform plan: a company-level catalogue of products (options, variants, stock, collections) and services on the commerce engine, in a glass table with a side panel, replacing the Books' own product list; first proven on the owner's test jewellery company with sample products, checkout paid through Stripe Connect in test mode with a 1% platform fee, and the receipt created in the Books."
tags: [framer-clone, commerce, catalogue, books, stripe]
projects: [framer-clone]
---

# The catalogue

Parent: [one business platform](2026-10-25-business-platform-architecture.md), steps 1 and 2.

## Owner decisions (2026-10-25)

1. **Table and side panel**, as in Shopify and the Basis Camp admin, in the glass look: a table of products with
   photos, filters, bulk actions and quick inline edits; a row opens a large side panel with everything.
2. **A plain shop for the first proof:** products, variants, stock and collections. Personalisation, one-of-a-kind
   display and made-to-order come later.
3. **The catalogue is split per company**, as the Books are.
4. **The first proof is the owner's own test jewellery company** with sample products.
5. **Stripe Connect, 1% platform fee per payment**, in test mode for the proof.

## Decided while designing (say so if you disagree)

- **Company column.** Every catalogue table gains `tenant_id` (the auth-brain company id, uuid-checked) with
  composite foreign keys `(tenant_id, id)`, exactly as the Books tables, so companies in one organisation never
  see each other's products. Pre-launch: the demo rows are re-seeded, not migrated (no back-compat).
- **Per-site visibility (sales channels).** Products belong to the company; each site shows all of them unless a
  product is switched off for that site. One small table (`product_site_hidden`) instead of a full channel model.
- **One catalogue for products and services.** A `kind` on the product: `physical` or `service`. A service has exactly one
  implicit variant that carries its price and tax, no options and no stock, so every sellable item resolves to a
  variant; their booking fields (duration, buffers, booking mode, deposit, resources and skills) arrive
  with step 3 and are not built now.
- **The Books' own list is replaced.** `books_product` and its routes, panel and form go; invoice lines pick from
  the catalogue (a variant, or a service), keep copying values as today (`lineFromProduct`), and store the
  variant id as the only reference (one reference column on the invoice line, `variant_ref`; `ProductLineFields`
  and `pickProduct` carry it next to the copied values). The reference is informational: the line's copied
  values stay authoritative, so a later catalogue edit never changes an issued invoice.
- **Navigation.** A company-level area `/projects/catalog` next to Sites and Books, behind the existing `sites`
  grant, the same one that opens the shop on a site; no new grant is added, so the parent plan's list
  (`sites`, `books`, `booking`) stays as it is.

## Data model (additions to the commerce engine)

- `product`: `tenant_id`, `kind`, `product_type`, `tags text[]`, `seo_title`, `seo_description`, `tax_class`
  (standard, reduced, zero, as the Books), `price_basis` (net or gross); description as the Books' formatted
  text.
- `product_image`: per product, ordered, optional variant link; files through Storage Brain.
- `product_variant`: price and "compare at" price on its `price_set` as today, `track_stock`, `allow_backorder`
  (the engine's inventory policy), up to three options per product (enforced).
- `collection` and `collection_product` (ordered): manual collections first; rule-based ones later.
- Orders gain `tenant_id` too; `sales_document.source_order_id` finally gets written (see Receipt).

## The screens

- **Table:** photo, title, status, variants count, price range, stock sum, type, collections. Search, filters
  (status, type, collection, stock state) kept in the address, sort, row selection with bulk status change,
  bulk add to collection and bulk delete (archive), inline edits for price, stock and status on single-variant
  products, column show, hide and order kept per person. Empty state with "Add product" and "Add sample
  products". Built on the glass utilities; the rows virtualised past a few hundred.
- **Side panel** (wide, glass, the table stays visible behind it on large screens; full screen on phones):
  sections Photos (drop, reorder, set per variant), Details (title, formatted description, type, tags, status),
  Options and variants (an option editor generating the variant matrix, a variant table with SKU, price,
  compare-at, stock, photo), Collections, Tax, Search engine preview. Saving per field, as the invoice editor;
  undo for the last steps.
- **Collections:** a second tab with a list and a panel (title, description, image, ordered products).

## Checkout, payment and receipt (the proof)

1. The site's existing cart and checkout create the order (server-priced, stock reserved, one transaction), now
   stamped with the company.
2. **Payment through Stripe Connect in test mode:** a Checkout or Payment Element session as a direct charge on
   the company's connected account, `application_fee_amount` = 1% of the
   charged total (tax and the flat shipping line included, since it is what the customer pays), as an integer
   in the currency's minor unit, rounded half up, computed once and recorded on the order, as in the parent
   plan (decision 12). A 999-cent total gives a 10-cent fee (9.99 rounded half up). The payment layer stays behind
   the existing gateway interface (the fake gateway remains for tests).
3. **Company onboarding** with Stripe's hosted onboarding (test mode), from the catalogue's settings: "Connect
   payments". Status shown (not connected, pending, ready).
4. **Webhook** `payment_intent.succeeded` (verified signature, idempotent) marks the order paid and creates the
   receipt: an issued Books invoice from the order (lines from the order's snapshots, the order linked through
   `source_order_id`), numbered in the company's series and stored as PDF. 
5. **Order states.** `pending` (stock reserved, with an expiry of 30 minutes) goes to `paid` on the verified
   webhook, to `failed` on `payment_intent.payment_failed`, to `cancelled` when the customer abandons the
   checkout or cancels, and to `expired` when the reservation runs out; each of the last three releases the
   reserved stock in the same transaction. If `payment_intent.succeeded` arrives for an order that is already
   `failed`, `cancelled` or `expired`, the handler tries to re-reserve the stock: if that works the order
   becomes `paid` and the receipt is created; if not, the payment is refunded in full (the platform fee
   returns with it) and the order stays closed, with the customer told by email. A repeated webhook changes
   nothing.
6. Every path tested: forward, a declined card, the customer leaving and coming back, a webhook arriving twice
   or late.

## The test jewellery company

Acceptance criteria for the proof, none of which exists yet. A new auth-brain company ("Schmuck Testshop", marked as test data like Books Testfirma) with a site, sample
products (rings with size and metal options, necklaces, earrings, one archived product), two collections, Stripe
test onboarding done. To be proven in the browser: create and edit a product, buy it on the site with a test card, see
the 1% fee in Stripe's test dashboard and the receipt in the Books.

## Not in this design

Personalisation, one-of-a-kind display, made-to-order, rule-based collections, discounts and gift cards,
shipping rates and fulfilment (a flat shipping line for the proof), the service booking fields (step 3),
counter payments, the live Stripe account (opened before the first real payment, see the parent plan).

## Next

An implementation plan in slices (company column and re-seed; catalogue table and panel; Books lines from the
catalogue; Stripe Connect test mode and webhook; receipt from order; the test company proof), for the owner's
approval before building.
