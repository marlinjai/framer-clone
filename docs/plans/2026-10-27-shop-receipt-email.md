---
type: plan
status: in-progress
date: 2026-10-27
title: "The shop's receipt email through Lumitra Mail"
summary: "A paid shop order emails the buyer an order confirmation with a link to the receipt invoice, and a late payment that had to be refunded emails a notice, sent from the shop company's own Lumitra Mail workspace. framer-clone becomes Lumitra Mail's third trusted application, the owner connects the workspace once on the payments page, and an outbox retries until Lumitra Mail took the letter."
tags: [framer-clone, commerce, email, lumitra-mail]
projects: [framer-clone, email-editor]
---

# The shop's receipt email

Roadmap 3e (customer email from the shop). Parent: [the catalogue](2026-10-25-catalogue-design.md), "Checkout,
payment and receipt", items 4 and 5, where the receipt and the late refund were built without mail because the
app had no way to send any.

## What the buyer gets

1. **Order confirmation**, right after the payment is confirmed and the receipt issued: the order number, the
   total, the shop's name and a link to the receipt invoice (PDF).
2. **Late refund notice**, when a payment arrived after the order had closed and its stock was gone, so the
   payment was refunded in full (the catalogue design's late-success rule).

## Decided (2026-10-27, say so if you disagree)

1. **Lumitra Mail sends, from the shop company's own workspace.** framer-clone becomes Lumitra Mail's third
   trusted application (`sites`, after the dashboard and Lumitra Booking), with the same six operations Booking
   has: list the person's workspaces, read a workspace's sending accounts and its domains, add a language,
   create a `send` key for itself and revoke that key. Sending goes out with that key as a transactional letter
   (a mailing with one recipient, no topic), exactly as Booking's appointment mail. The service token is minted
   with `copy_secret op=generate` into Lumitra Mail (`SITES_SERVICE_TOKEN`) and framer-clone
   (`LUMITRA_MAIL_SERVICE_TOKEN`), and must differ from the dashboard's and Booking's (the service refuses to
   start otherwise).
2. **The owner connects once, on the payments page** ("Receipt email"): choose one of the company's workspaces
   and a sending account, then Connect. The workspace must belong to the shop's own company (its `company_id`
   equals the shop's): nothing else would stop shop A from sending as company B. Connecting installs the two
   templates (German and English), declares their inputs, and stores the key encrypted at rest (AES-256-GCM,
   `SHOP_MAIL_KEY`). Disconnecting revokes the key. Until a shop is connected nothing is sent, and the buyer is
   told nothing about email.
3. **The invoice travels as a link, not an attachment**: Lumitra Mail sends no attachments. The link is
   `https://app.lumitra.co/api/receipts/<token>`, the token an HMAC-SHA256 (`RECEIPT_LINK_KEY`, versioned) over
   the tenant group, the company and the document. It does not expire, because an invoice must stay retrievable;
   rotating the key revokes every link. The route answers only the stored document of record of an issued
   invoice, never a draft, with `no-store` and `nosniff`.
4. **An outbox, retried until Lumitra Mail took the letter.** A row per order and kind (`shop_mail`, migration
   `023_shop_mail`), written when the receipt is issued or the late refund made; sent right after, and on
   failure retried after 1, 5, 15 and 60 minutes, then every 6 hours for three days, then left `failed` with its
   reason. An in-process sweep every minute walks the tenant groups (started in `instrumentation.ts`, the Node
   server only). Kept off `order_payment`, whose guarded state machine is about money, not mail. A suppressed
   recipient (bounce, complaint) is recorded as `blocked`, never retried.
5. **Language** follows the published site's language (German or English); the templates exist in both.
6. **The thank-you page** says "A confirmation with your receipt is on its way to <email>" when the shop is
   connected, and nothing about email otherwise.
7. **The test company proves it** with a workspace of its own and a managed sending domain
   `testshop.lumitra.co` (the one free Resend domain slot Marlin set aside for building and testing on
   2026-10-18; DNS records written through the Cloudflare API), sending to an address on lumitra.co.

## Slices

1. Lumitra Mail: the trusted application `sites` (contract, service config, dashboard audit name), released and
   deployed.
2. framer-clone: migration, connector, gateway and templates, encryption, receipt link route, outbox and sweep,
   payments page card, thank-you text, tests for every path (connected, not connected, Lumitra Mail down then
   back, suppressed recipient, disconnect, a foreign company's workspace refused).
3. Proof on production with the test company: connect, buy, receive the email, open the receipt link.

## Open

- Volume: Resend's free plan carries 100 mails a day for every sender on the Lumitra account (roadmap item in the
  knowledge base). A real shop needs the Pro plan first (Marlin's decision 1 of 2026-10-18).
