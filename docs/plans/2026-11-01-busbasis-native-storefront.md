---
type: plan
status: draft
date: 2026-11-01
title: "Expressing the BusBasis storefront fully in framer-clone (no Vercel storefront, no Medusa)"
summary: "framer-clone will not edit frontends it does not host. The way BusBasis could reach framer-clone is to live in it: the site served by framer-clone, its shop on framer-clone's own commerce engine, Medusa retired. This plan records what that takes, feature by feature, against the code on 2026-11-01. About 19 to 27 agent weeks. Whether and when BusBasis moves is open."
tags: [framer-clone, busbasis, medusa, commerce, parity, storefront]
projects: [framer-clone]
---

# Expressing the BusBasis storefront fully in framer-clone

> **Update 2026-11-01 (Marlin):** the complete primitives plan comes first, and BusBasis may well stay
> on Medusa long term. This gap list remains useful as a map of shop capabilities, not as a scheduled
> migration.

## Decision and what follows from it

**2026-11-01, Marlin:** framer-clone does not edit a Next.js frontend it does not host. It replaces
the direction of the [external frontend research](2026-10-26-external-frontend-visual-editing-research.md).
The hosted iframe canvas and the headless delivery API will not be built.

If BusBasis (the business is Basis Camp Berlin, basiscampberlin.de) ever works in framer-clone, it
does so as a normal framer-clone site: framer-clone serves the pages, and the shop runs on
framer-clone's own commerce engine.

This document is the gap list for that move, not a commitment to it. Until a move is decided, the
2026-10-25 [platform plan](2026-10-25-business-platform-architecture.md) stands ("Basis Camp stays on
Medusa"), and the BusBasis team keeps its Puck homepage editor, which is finished and lives inside
the storefront.

## Why not keep Medusa behind a framer-clone frontend

A Medusa connector was evaluated on 2026-10-26 and ruled out. On 2026-06-01 the commerce engine was
chosen over Medusa because Medusa needs one running server per shop
(`knowledge-base/research/2026-06-01-owned-realtime-commerce-architecture.md`). For BusBasis alone
that cost would not arise, since its server already exists. The connector is still the wrong
investment:

- every shop feature would be built twice, once per engine;
- it serves exactly one customer;
- it is thrown away if BusBasis later moves anyway.

## What already exists

Checked on `origin/main` (`e11538c`) on 2026-11-01. These parts need adapting at most:

- products, variants, options, collections, tags and per-site visibility;
- stock levels, reservations, and the backorder flag per variant;
- product list, product page, variant picker, cart and checkout on published pages;
- Stripe Connect payments, proven on production in the sandbox (orders ORD-000001 to ORD-000006);
- a receipt invoice in the Books for every paid order, and the receipt email through Lumitra Mail;
- German VAT, sitemap, redirects, forms, custom domains.

## What is missing

The Medusa side comes from a code inventory of 2026-10-26. The estimates are judgement, in agent
weeks of five working days, for one focused stream with review.

| Area | What BusBasis uses today | framer-clone today | Effort |
|---|---|---|---|
| Shopper accounts | Register, login, password reset, profile, addresses, order history, guest cart transfer, order transfer by link | No shopper login at all; the buyer is stored on the payment | 2 to 3 weeks |
| Shipping and checkout | Shipping options with calculated prices, warehouse pickup with cash, bulky goods ("Sperrgut") and on-request products that show a form instead of add to cart, free shipping nudge, promo codes | No shipping and no discounts; the cart lives in the browser | 3 to 4 weeks |
| Payment methods | SEPA direct debit (order created at payment start, cancelled on failure), card, PayPal, Klarna, on BusBasis's own Stripe account | Stripe Connect hosted checkout with the 1% fee; delayed SEPA settlement not checked yet | Inside shipping and checkout |
| Order work | Own order list with notes and favourites, shipped and delivered emails, Stripe reconciliation with alerts | No order list; the fulfil step exists but nothing calls it; no owner refunds | 2 to 3 weeks |
| Finding products | Categories nested four levels, Meilisearch with facets, related products, stock display settings | Collections and tags only; search only in the admin | 2 to 3 weeks |
| Offers | Offer numbers, status flow with stock reservation, PDF, email, accept link, invoice | The Books know an offer type, but no screen or flow; quotes are item 4 of the platform plan | 2 to 3 weeks |
| Back office | Suppliers with purchase prices, services as offer lines, legacy customers linked to accounts | Service products exist; suppliers do not; customers live in the shared contacts database | 2 weeks |
| Site and design | Navigation, footer, homepage sections, banner, hero alert, FAQ, shop kill switch, dark look, animations | Needs reusable components, behaviour primitives such as an accordion and a mobile menu (see the [complete primitives plan](2026-11-01-complete-primitives.md)), the navbar and section components (roadmap line "Builder UX gaps"), the published copy, and image storage: catalogue images are bytes in Postgres, capped at 2 MB, and there is no Storage Brain client yet | 3 to 4 weeks |
| Company setup | Team logins | Auth-brain company, an editor role without publish, invites | 1 to 2 weeks |
| Move and cutover | About 1,859 variants, around 50 customers with orders by July 2026, order numbers above 258, offers | No product import; needs import of history, redirects from the `/de/...` addresses, and a domain switch without losing search rankings | 2 to 3 weeks |

**Total: about 19 to 27 agent weeks** (4 to 6 months for one stream, less with parallel agents).

Three parts are smaller than the first estimate of 2026-10-26 suggested:

- **German and English is not needed for parity.** The storefront ships German only:
  `src/i18n/request.ts` hard-codes the locale and nothing loads `messages/en.json`.
- **Search can stay small.** At this catalogue size, Postgres text search with facets is the first
  thing to try, without running Meilisearch.
- **Several Medusa features are unused** and need no counterpart: returns, exchanges, claims, order
  edits, customer groups, price lists, gift cards, a tax provider.

## Useful regardless of BusBasis

Most of the table is ordinary shop capability that any framer-clone shop would need: accounts,
shipping, discounts, an order list, categories, search and quotes. Only suppliers, the legacy customer
link, the data import and the cutover are BusBasis specific. So the work can go ahead as shop features
for every customer, in that order, with the move decided last.

## How it would be built

Measured on 2026-10-27: an agent at its checks needs 3 to 5 GB of memory at peak, so the Mac can carry
2 to 3 at once and hermes 4 to 5. Parallel work would run on hermes in waves. Database migration
numbers, `componentRegistry.ts` and the shared commerce types stay with one sequential agent, because
parallel agents collide there at merge time whatever the hardware.

## Open

- **Whether and when BusBasis moves.** This is Marlin's call and a conversation with the BusBasis team.
  It means moving a live business with real customers and retiring its system.
- **Shopper login:** a framer-clone account per shop or auth-brain. Passwords from Medusa may not carry
  over, in which case every customer resets theirs at the move.
- **Payments:** BusBasis would become a connected account paying the 1% platform fee, which it does
  not pay today.

## Reality

- 2026-11-01: written from the 2026-10-26 evaluation and inventories, corrected against `e11538c`. No
  implementation.
