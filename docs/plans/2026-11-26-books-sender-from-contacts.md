---
type: plan
status: decided
date: 2026-11-26
title: "Books: the invoice sender comes from shared contacts"
summary: "Invoices read the business sender details (name, address, tax ids, bank details) from one organization in the shared contacts database instead of the separately maintained books_company_settings.sender_block. Books keeps a pointer to that contact; tax status, exemption note, payment terms, numbering and templates stay in Books. Issued documents keep their frozen sender snapshot. Decided 2026-11-27: no extra approval step while the company has one user; a Books confirmation of bank changes must be built before any company with more than one user, or any client company, has a linked sender."
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
   **Archiving is a dead end today:** contacts-core has `createField`, `listFields` and
   `archiveField` and no way to restore, and an archived key cannot be created again or take new
   values. One click on `iban` in the receipts field screen would then block the company's invoices
   for good. So contacts-core gains `restoreField(key)` (clears `archived_at`, no migration) with a
   way to call it from the receipts field screen, and `SENDER_INVALID` names that action.
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
   stays ahead of the read, so a retry never needs contacts. The `issued` event records the contact
   id and version. The two databases share no transaction: the snapshot is what was read.
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

## Decision: who may change what invoices print

Today only an operator with server access can change the sender. After the switch, these can change
the IBAN that invoices and their payment code carry, or remove the sender contact: anyone holding
`receipts.row.write` (granted to every workspace member) in a workspace of the company (contact
edit, archive, merge, erase, field definitions), and any server code that holds the contacts
connection string. The threat is a wrong or hostile bank account on a real invoice.

**Checked 2026-11-26 (counts only, auth-brain):** Whiz-Art Media has one user in total: one company
owner, who is also the one workspace admin and the one tenant group owner. Service keys and server
code were not counted.

- **C (chosen, 2026-11-27): no extra guard.** The only person who can edit the contact is the person
  who may change where customers pay, so a guard would protect against nobody today. The checksum
  still catches typing errors. **Condition:** A is built before a second user gets access to a
  company with a linked sender, before a company that already has more than one user links one, or
  before a client company links one.
- **A: Books confirms bank changes.** Books stores a fingerprint of the payment fields (name, IBAN,
  BIC, bank name) approved for the pointer. When the contact differs, issuing and shop payments are
  refused until a user with a new owner-or-admin Books right sees old and new in Books and
  confirms. With it, issue also refuses when the sender changed after the draft was shown. Covers
  every writer. Cost: one screen, one right, one or two columns, its own build branch.
- **B: the receipts app restricts the sender contact** to owners and admins. It needs the receipts
  app to learn which contact is the sender and does not cover other writers.

**Decided by Marlin, 2026-11-27: C**, with its condition (on the roadmap). A and B are not built now.
The production gates below stay separate decisions.

## Build parts, each its own branch

Each branch stays at about 1,500 changed lines at most.

0. **Merge fix release (contacts and receipts).** `merge` in contacts-core 0.5.0 drops the deleted
   contact's custom fields. The fix is merged (contacts pull request 21) and not released. Publish a
   patch (no new migration, so the receipts start-up `migrate` has nothing to apply) and upgrade the
   receipts app, which has the merge button. Merging that upgrade deploys receipts. Does not wait
   for this plan.
1. **`restoreField` (contacts and receipts):** the package method, its release, and the restore
   action on the receipts field screen.
2. **Books resolver, not wired:** tenant migration for the pointer, `SenderDirectory` port,
   mapping, validation, errors and their tests. The migration takes the next free number, checked
   again at build time against `main` and open pull requests (pull request 418 merged and holds
   `032_form_notification`).
3. **Books readers switched,** pointer null everywhere: issue, cancel, correct, draft rendering,
   upload fallback, payment readiness, the settings screen (shows "from contact" with where to edit
   it), the operator command (`--sender-contact <id>`, `--dry-run` parity report that prints field
   names only, `--unlink`), the single-reader check and the flow tests. Gate 1 follows this part.
4. **Only when A's condition is met:** approval column, right, screen and tests.
5. **Cleanup, a later release,** after at least one invoice issued from the contact: stop writing
   and requiring `sender_block` for linked companies, require a sender contact when a new company is
   initialised and remove `--unlink` (linking another contact stays), then drop the column. The drop
   needs every settings row in every tenant schema to have a `sender_contact_id`, because an
   unlinked company still prints from the block. A company still unlinked is linked first, with the same
   parity report as gate 2 and under A's condition. The migration runs per tenant schema, so it
   checks its own schema and fails there, dropping nothing, while a pointer is null; the check
   across all schemas is gate 3's count, before the deploy.

framer-clone has no single check command found in this investigation; part 2 first confirms what
`ci.yml` runs and uses exactly that. Review: a Claude reviewer for the access and snapshot parts,
Mercury for the rest.

## Production gates (each needs Marlin's yes)

1. **Deploy parts 2 and 3** (manual `deploy` workflow). It applies the additive migration. Before it: same
   day backup of the Books database, dry run on a restored copy, snapshot fingerprint.
   Rollback: redeploy the previous image; it ignores the new column.
2. **Link Whiz-Art Media** (one production write). Before it, the same day: parity report with zero
   differences, fingerprint. After it: a draft's render shows the sender, readiness is ready, the
   fingerprint is unchanged. Rollback: `--unlink`, which returns to the stored block.
3. **Part 5's column drop**, much later, with its own backup and, the same day, a count of settings
   rows without a sender contact across all tenant schemas, which must be zero.

`sender_block` is frozen from the moment of linking. If the contact changed since, unlinking or
redeploying an older image prints the old values: run the parity report first and update the stored
block with the operator command when it differs.

## Not in this plan

The recipient side, customer tax fields, templates, tax status, number counters, backfilling or
re-rendering issued documents, and any change to contacts-core beyond the merged fix and
`restoreField`.
<!-- ci-replay touch -->
