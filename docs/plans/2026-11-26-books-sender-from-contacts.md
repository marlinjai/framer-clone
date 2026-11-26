---
type: plan
status: draft
date: 2026-11-26
title: "Books: the invoice sender comes from shared contacts"
summary: "Invoices read the business sender details (name, address, tax ids, bank details) from one organization in the shared contacts database instead of the separately maintained books_company_settings.sender_block. Books keeps a pointer to that contact; tax status, exemption note, payment terms, numbering and templates stay in Books. Issued documents keep their frozen sender snapshot. Draft: waits for the owner's decision on who may change what invoices print."
tags: [framer-clone, books, invoices, contacts, tenancy, bank-details, migration]
projects: [framer-clone, contacts, receipt-ocr-app]
---

# Books: the invoice sender comes from shared contacts

## Request

Marlin, 2026-11-26: invoices read the business sender details from shared contacts instead of
separately maintained Books settings. This replaces, for the sender only, resolution 4 of the Books
plan (`2026-08-15-books-receipts-invoices-integration.md`, "Sender block and tax status": the sender
is a company setting that an operator fills with `pnpm books:init-company`).

## Findings (2026-11-26, read-only)

- **One company is affected.** Five tenant schemas have the Books tables; one holds a settings row
  (Whiz-Art Media).
- **63 documents, all imported invoices, all with a frozen `sender_snapshot`.** No draft and no
  invoice issued by Books itself exists. An imported document is served from its original PDF.
- **Parity.** Whiz-Art Media's business contact (`01a21902-a113-76c5-9d09-388ce3cf5cff`) equals the
  sender block on all ten filled fields (name, street, postal code, city, country, VAT id, tax
  number, IBAN, BIC, bank name). The other eight are empty on both sides (second address line,
  email, phone, website, register court, register number, managing director, small business id).
- **Readers of the sender block:** `issue.ts`, `cancel.ts` (credit note, also inside the Correct
  flow), `render/store.ts` (draft PDF and the browser's draft render), `upload/service.ts` (twice:
  fallback for fields a historical PDF does not print), `payment/receiptReadiness.ts` (whether a
  shop may take money), `api/books/settings` with `BooksHome.tsx` (display), and the writers
  `settings.ts` and `initCompanyCli.ts`. Issued documents render from their snapshot only.
- **Ownership already lines up.** The contacts company id is the auth-brain company id that
  `BooksScope.tenantId` carries, taken from the verified session. Recipients are already read this
  way.

## Design

1. **A pointer, never a copy.** Additive tenant migration:
   `books_company_settings.sender_contact_id TEXT NULL`. One row per company, so each company names
   its own sender; a tenant group with several companies needs nothing more. Contacts gets no
   "this is us" marker: which contact is the sender is a Books relationship, like which contact is
   a customer.
2. **One source per company, never per field.** Pointer null: today's behaviour. Pointer set: every
   sender field comes from the contact, and an empty one is empty. No fallback to the old block, for
   any reason.
3. **One resolver** (`resolveSender(scope, settings)`) behind a `SenderDirectory` port beside
   `RecipientDirectory`, read through `contactsFor(handle, scope.tenantId)`, so another company's
   contact id reads as not found. A test fails when anything else reads `senderBlock`.
4. **Field mapping.**

   | Sender field | Contact |
   |---|---|
   | `legalName`, `addressLine1`, `addressLine2`, `postalCode`, `city`, `countryCode`, `vatId`, `email`, `phone` | the organization's fixed fields (`name`, ..., `country`, ...) |
   | `taxNumber`, `iban`, `bic`, `bankName` | custom fields `steuernummer`, `iban`, `bic`, `bankname` (text, exist for Whiz-Art Media) |
   | `website`, `registerCourt`, `registerNumber`, `managingDirector`, `smallBusinessId` | custom fields `website` (url), `registergericht`, `registernummer`, `geschaeftsfuehrung`, `kleinunternehmer_id` (text) |

   Custom field definitions are per company and hand made, so these keys become a reserved contract.
   The operator command that sets the pointer creates missing definitions and refuses, naming the
   key, when one exists archived or with another type. The resolver checks the same on every read.
   Fixed contact columns were rejected: they need a shared database migration, a package release and
   changes to both save paths of the receipts app.
   Books keeps `tax_status`, the exemption note, payment terms, number counters and templates.
5. **Validation at read**, because custom text accepts anything: the sender must be an organization
   of this company and not archived; an IBAN, when present, must pass the checksum already in
   `render/epcQr.ts` (today a wrong one only drops the payment code and would still print); a BIC,
   when present, must have a valid shape. Then the existing `senderMissingFields` rule.
6. **Errors name the next action, and nothing is written.** `SENDER_UNAVAILABLE` (contacts
   unreachable: try again), `SENDER_NOT_FOUND` (erased, merged away, moved or archived: the operator
   links another contact or restores it), `SENDER_INVALID` (field names only: correct the contact).
   Logs and events carry ids and field names, never values.
7. **Issue, cancel, correct.** The sender is read before the Books transaction, like the recipient,
   and passed into `cancelInvoiceIn`. The early return for an already issued or cancelled document
   stays ahead of the read, so a retry never needs contacts. Issue also refuses with
   `CONCURRENT_EDIT` when the sender contact's version differs from the one the confirmed draft
   showed, so nobody issues bank details they did not see. The `issued` event records the contact id
   and version. The two databases share no transaction: the snapshot is what was read.
8. **History.** The snapshot keeps its version 1 shape. No backfill, no change to any issued
   document; an older build still reads new snapshots. Proof at each gate: one fingerprint over
   number, status and `sender_snapshot` of all issued documents, equal before and after.

### What changes for availability (amends the Books plan)

- The Books plan promises that cancelling never depends on the contacts database. With a linked
  sender it does, because a credit note is a new document with a current sender. It fails closed and
  can be retried.
- Shop payment readiness deliberately ignores contacts today. With a linked sender it reads it and
  gains the blocker `sender_unavailable`: during a contacts outage a buyer reads the existing "This
  shop cannot take payments yet. Nothing has been charged." before any money moves. A payment
  already taken whose receipt cannot be issued stays on the existing retry path; the build must
  prove this with a test.

### Stateful flow cases the tests cover

Forward (link, draft, issue); change the contact after the draft render (issue refused, the new
render shows it); unlink and relink another contact; resume a draft after an outage; issue or cancel
again after success with contacts down; erased, archived, merged or foreign-company sender; a
conflicting field definition; an invalid IBAN.

## Decision for Marlin: who may change what invoices print

Today only an operator with server access can change the sender. After the switch, these can change
the IBAN that invoices and their payment code carry, or remove the sender contact: anyone holding
`receipts.row.write` in a workspace of the company (contact edit, archive, merge, erase, field
definitions), and any server code that holds the contacts connection string. The threat is a wrong
or hostile bank account on a real invoice. Who currently holds that right for Whiz-Art Media was not
checked.

- **A (recommended): Books confirms bank changes.** Books stores a fingerprint of the payment fields
  (name, IBAN, BIC, bank name) approved for the pointer. When the contact differs, issuing and
  shop payments are refused until a user with a new owner-or-admin Books right sees old and new in
  Books and confirms. It covers every writer, needs nothing in the receipts app and stores no second
  copy. It protects each company against its own other members and against another app's mistake.
  Cost: one screen, one right, one more column.
- **B: the receipts app restricts the sender contact** to owners and admins. It needs the receipts
  app to learn which contact is the sender and does not cover other writers.
- **C: no extra protection.** Reasonable only while everyone with that right may also change where
  customers pay. The checksum still catches typing errors.

Until decided, nothing is built. With A, the approval is part of the first build part.

## Build parts, each its own branch

0. **Prerequisite (contacts and receipts).** `merge` in contacts-core 0.5.0 drops the deleted
   contact's custom fields. The fix is merged (contacts pull request 21) and not released. Publish a
   patch and upgrade the receipts app, which has the merge button, before invoices depend on those
   fields. Merging the receipts upgrade deploys it.
1. **Books reads through the resolver**, pointer null everywhere: migration, port, mapping,
   validation, errors, all readers, the settings screen (shows "from contact" with where to edit it),
   the operator command (`--sender-contact <id>`, `--dry-run` parity report that prints field names
   only, `--unlink`), tests, the single-reader check. The tenant migration takes the next free
   number at build time: held pull request 418 (form notification mail) already carries one past
   `030_books_contact_person` and the checkout session migration, so agree the order with its owner.
2. **Cleanup, a later release**, after at least one invoice issued from the contact: stop writing
   and requiring `sender_block` for linked companies, require a sender contact when a new company is
   initialised, then drop the column.

framer-clone has no single check command found in this investigation; part 1 first confirms what
`ci.yml` runs and uses exactly that. Review: a Claude reviewer for the access, approval and snapshot
parts, Mercury for the rest.

## Production gates (each needs Marlin's yes)

1. **Deploy part 1** (manual `deploy` workflow). It applies the additive migration. Before it: same
   day backup of the Books database, dry run on a restored copy, snapshot fingerprint.
   Rollback: redeploy the previous image; it ignores the new column.
2. **Link Whiz-Art Media** (one production write). Before it, the same day: parity report with zero
   differences, fingerprint. After it: a draft's render shows the sender, readiness is ready, the
   fingerprint is unchanged. Rollback: `--unlink`, which returns to the stored block.
3. **Part 2's column drop**, much later, with its own backup.

`sender_block` is frozen from the moment of linking. If the contact changed since, unlinking or
redeploying an older image prints the old values: run the parity report first and update the stored
block with the operator command when it differs.

## Not in this plan

The recipient side, customer tax fields, templates, tax status, number counters, backfilling or
re-rendering issued documents, and any change to contacts-core beyond the already merged fix.
