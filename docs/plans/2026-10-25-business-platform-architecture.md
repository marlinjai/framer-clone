---
type: plan
status: decided
date: 2026-10-25
title: "One business platform: catalogue, bookings, quotes and invoices in framer-clone"
summary: "Architecture decision after the owner asked for a Shopify-grade products and services catalogue tied to bookings: framer-clone becomes the one platform (a modular monolith) for the catalogue, scheduling, requests, quotes, orders and invoices; lumitra-booking's slot engine and calendar sync are reused as packages, its appointments move over later; video rooms stay a separate service; contacts stays the customer master; products are sold as separate plans on one platform. First proof is instant booking for a single practitioner, then quotes, then team dispatch."
tags: [framer-clone, commerce, booking, books, architecture]
projects: [framer-clone, lumitra-booking]
---

# One business platform: catalogue, bookings, quotes and invoices

## Why

The owner, 2026-10-25: invoice drafts cannot be deleted; products and services live isolated in the Books;
the goal is a Shopify competitor whose products and services connect to bookings, with a catalogue
interface on the level of Framer and Shopify in the glass look, and invoices as the receipts of purchases.
He asked for a senior architect's view on one platform versus separate products, for businesses ranging
from a hairdresser (each employee has a calendar) through a tree care company (the owner assigns sub-teams
to jobs) to a vehicle workshop (requests by call, mail, form or walk-in; a quote of services and materials;
acceptance; invoice).

## What was checked (2026-10-25)

1. **Accounts in both apps.** Both key a business on the same auth-brain company id, so no mapping table is
   needed. framer-clone puts each organisation (auth-brain tenant group) in its own Postgres schema
   (`tg_<hex>`, a hard data wall, fails closed) with a `tenant_id` column for the company inside it.
   lumitra-booking keeps every business in shared `public` tables filtered by a `tenant_id` column, with no
   row-level security and no tenant group. Joining them is a data-storage move, not an identity problem.
2. **lumitra-booking's weight.** Used by two companies (lumitra-core, opuntia), one host with iCloud, the
   ŌPUNTIA call page prepared but not confirmed live; 28 commits. Its slot engine (`@marlinjai/booking-core`,
   pure, 524 lines with 1,270 lines of tests) and its calendar sync (CalDAV, Google, Microsoft; one small
   crypto helper to move out) can be imported as they are. The rest (service, db, web) is app code.
3. **Contacts.** `@marlinjai/contacts-core` is a shared library over one contacts database; Books customers
   and the receipts app use it, and it is the only customer list since 2026-10-09. Booking guests are not in
   it yet.
4. **Real clients.** No salon or studio prospect exists. ArboSano (tree care, 10 staff, quotes first, crews,
   probably on HERO today) pays for consulting; Basis Camp Berlin runs quotes and payments on its Medusa shop
   with no workshop scheduling; ŌPUNTIA needs bookings with deposits; Sharon's hypnosis practice needs
   session booking. The strategy docs sell agency services first and call booking alone "a crowded, cheap
   market", worth it "as a piece of the suite".
5. **Competitors.** Salon tools (Fresha, Treatwell, Shore, Salonized) stop at the register: no quotes, no
   dispatch, no B2B e-invoices. German trade tools (HERO, Plancraft, Craftnote, ToolTime) do quotes and crew
   planning but have no website, online booking or catalogue. Website builders (Wix, Squarespace, Shopify
   with apps) are weak on staff and resources and have no quotes. Square's bundle does not take cards in
   Germany. The most common complaints: commissions on new clients, per-seat price jumps, one-year
   auto-renewals.

## Decided (say so if you disagree)

1. **framer-clone is the one platform, built as a modular monolith.** Catalogue, resources and scheduling,
   requests, quotes, orders, invoices and sites share one app and one schema per organisation, in strict
   modules. Reason: the job record (request, quote, schedule, stock, invoice) must change in one transaction;
   split across apps it becomes calls that can half-fail, the failure class behind Basis Camp's wrongful
   refunds. A one-person team with agents also gains one deploy, one sign-in and one test suite.
2. **One work model with switchable steps:** Request, then (Quote), then Confirmed, then Scheduled, then Done,
   then Invoice. A service chooses its booking mode: book instantly, request a time, or request a quote.
   Underneath are resources (people, rooms, vehicles, equipment, each with a calendar), skills (who may do
   what), catalogue items and one job record. Presets per trade (practice or salon, field service, workshop)
   switch the steps on and use that trade's words.
3. **One catalogue.** Products and services in one company-level catalogue on the commerce engine, in its own
   area next to Sites and Books, with real tables (filters kept in the address, bulk edits, column layout,
   inline edits, as in the Basis Camp admin) in the glass look. Books' own `books_product` list is replaced:
   invoice lines pick from the catalogue (pre-launch, no data to keep).
4. **Reuse lumitra-booking's engine, not its app.** The slot engine and calendar sync become shared packages
   the scheduling module builds on. lumitra-booking's appointments move onto the platform once scheduling
   runs there (its two companies first); its app then becomes the Booking face of the platform.
5. **Video rooms stay their own service** (LiveKit, loosely coupled, different infrastructure).
6. **Contacts stays the customer master.** Booking guests and shop buyers become contacts; documents keep
   their snapshot of the recipient as they do today.
7. **Sell separate plans, deploy one platform:** booking only, shop, Books, website, switched on per company
   through the auth-brain app grants that already exist (`sites`, `books`, `booking`). Flat plan prices with
   monthly cancellation; no marketplace commission on new clients (the Treatwell model reviewers complain
   about). The platform earns a small, visible fee on each online payment instead (decision 12).
8. **An invoice is the receipt of an order or a completed job,** created by the platform through the existing
   `sales_document.source_order_id`; hand-written invoices stay possible.
9. **Invoice drafts become deletable.** A draft has no number and is not a bookkeeping record; issued
   documents stay undeletable (GoBD). This reverses decision 8 of the Books integration plan for drafts only,
   and is built separately, ahead of this plan. **Event invariant:** deleting a draft deletes
   its lines and its `sales_document_event` rows (`draft_created`, `customer_set`) in the same transaction;
   no tombstone is kept, because a draft was never issued and carries no number. The migration relaxes the
   delete guards on `sales_document`, `sales_document_line` and `sales_document_event` (migration 007) for
   rows whose document is still a draft, and keeps them for every issued or cancelled document. Before it
   is built, the accounting owner confirms that draft data and its events fall outside the retention duty
   (GoBD, section 147 AO).
10. **Out of the first versions:** payments at a counter (they make the system a cash register under
    KassenSichV, with a certified TSE and registration at the tax office) and medical practices (health data
    is a special category under GDPR Article 9).
11. **Order of work** (first proof changed by the owner, 2026-10-25):
    1. the catalogue with products, variants and services;
    2. **the first proof: the owner's own test jewellery shop** with sample products, sold on its site through
       the cart and checkout, paid through Stripe Connect in test mode (no live account needed), with the
       receipt created in the Books;
    3. instant booking for one practitioner, paid online, with the receipt in the Books (Sharon's practice
       or ŌPUNTIA's calls);
    4. quotes of services and materials, accepted online, turning into the invoice (reference: the Basis
       Camp offers module);
    5. team scheduling and dispatch (reference: a field-service crew; ArboSano is not a customer for this,
       owner 2026-10-25).
    Basis Camp stays on Medusa; moving it is not part of this plan.

12. **Payments run on Stripe Connect** (owner, 2026-10-25), so the platform takes a fee of **1% per payment**
    (owner, 2026-10-25), shown as its own line in the business's payout report, on every purchase in
    every store and booking. Each business is its own connected account and the seller of record (direct
    charges): its customer pays the business, the receipt is the business's own invoice in the Books, and
    the platform's fee is taken per payment as an application fee. Businesses join through Stripe's hosted
    onboarding, so identity checks and payouts stay with Stripe, the licensed payment institution.

    The provider comparison of 2026-10-25 (Stripe Connect, Mollie Connect, Adyen for Platforms, PayPal,
    Mangopay and others) confirms Stripe for the start:
    - **Stripe Connect, direct charges, full-dashboard accounts the business owns, "Stripe handles
      pricing":** the platform pays Stripe nothing (no per-account, payout or onboarding fees), the business
      pays Stripe's own rates (EEA cards 1.5% + €0.25, SEPA Direct Debit €0.35) plus the platform fee, and
      carries its own chargebacks. No licence is needed while money never passes through the platform's own
      bank account (to be confirmed by a lawyer before launch). Portability is not assumed: Stripe allows only
      one platform to control a connected account at a time, so whether a business can take its account to
      another platform depends on the account type and platform-control state, to be confirmed with Stripe
      before launch.
    - **Mollie Connect** is the fallback: also free for the platform, 0.3 points dearer on cards, and the
      most portable (the business owns its Mollie account).
    - **Adyen for Platforms** (sales-led, minimum monthly invoice) and Stripe's "you handle pricing" (about
      €770 a month of platform costs for the same 10 businesses and 600 card payments of €50: €600 of
      processing at 1.5% + €0.25 each, $2 per active account about €20, 0.25% of €30,000 in payouts €75, and
      €0.25 on each of about 300 daily payouts €75; dollars treated as euros) only pay off at large volume.
    - Worked example, 10 businesses at €3,000 a month in €50 card payments with a 1% platform fee: each
      business pays €90 a month (3.0%) on Stripe, €99 on Mollie; the platform nets €300 a month either way.

13. **The payment layer stays provider-neutral** (the shop's test gateway already sits behind an interface),
    and building runs on the test gateway and Stripe's test mode. The live platform account is opened only
    before the first real payment, and only once its legal entity is chosen: a Stripe platform account
    cannot move to another company, so connected businesses would have to sign up again. Whiz-Art Media may
    hold it for one or two proof customers if Lumitra has no company of its own by then.

## Open for the owner

- **The legal entity** that holds the Stripe platform account (it invoices the fees to the businesses).
  Whiz-Art Media is the only company today; whether and where Lumitra becomes its own company is an
  international tax question for a tax adviser (a company managed from Germany is taxed in Germany, §10 AO,
  and the foreign-company rules of §§7 to 14 AStG apply). Needed only before the first live payment.
- **The account itself:** creating it and passing Stripe's platform review need the owner's identity.
- **The first booking customer:** Sharon's practice or ŌPUNTIA.

## Next

The brainstorm continues at the catalogue: what a product and a service carry (for a service: duration,
buffers, booking mode, resources and skills, price and deposit), and the table and editor design. That
becomes its own design document before any building.
