---
title: Books, importing past invoices by uploading PDFs
summary: >
  A company uploads many of its past invoice PDFs at once in the Books; Claude reads each one,
  the user checks and corrects the extracted data in a table, and the confirmed rows are imported
  as historical documents with the original PDF as the document of record.
type: plan
status: in-progress
date: 2026-10-20
tags: [framer-clone, books, invoices, import, ai]
projects: [framer-clone]
---

# Books, importing past invoices by uploading PDFs

## Why

The operator import (`pnpm books:import`, built 2026-10-20 for the owner's invoices 1 to 61)
needs a hand-made JSON list and a terminal. Every other company that starts using the Books has
the same problem: years of invoices as PDFs, and a numbering series that has to continue where it
left off. The owner asked on 2026-10-20 for the editor to take many PDFs at once. This is that
feature. It builds on the import core of the operator import (one parsed record plus its PDF bytes
imported in one transaction with every check), so both paths write identical documents.

## What the user does

1. In `/projects/books`, "Import past invoices": drop or pick up to 50 PDF files at once
   (each at most 10 MB, `application/pdf` checked by magic bytes, not by name).
2. Each file is uploaded, hashed (SHA-256) and stored in a staging row, then read by Claude.
   Progress shows per file: uploaded, reading, ready to check, needs attention, duplicate.
3. A review table lists one row per file: invoice number, issue date, service date or period,
   recipient (name, address lines, country, VAT id), lines (description, quantity, unit, unit
   price, line total), total, currency, tax treatment, and the sender block as printed. Fields
   Claude was unsure about are marked. Each row opens the PDF beside the form for correction.
4. The user confirms rows (one by one or all that have no open problem). Confirmed rows import;
   rows with problems stay in the table until fixed or discarded.
5. Imported documents appear in the documents list marked "imported"; their PDF download serves
   the uploaded bytes, never a re-render.

## Decisions (decided, say so if you disagree)

1. **Staging in the tenant schema**: a migration adds `historical_import_item` (company, file
   bytes, size, SHA-256, status `uploaded | extracting | ready | needs_attention | imported |
   discarded`, the extracted record as JSONB, the user's corrected record as JSONB, problems as a
   JSONB list, the extraction model, timestamps, the imported document id). It is a working
   table, mutable until `imported`, after which the row is frozen by trigger like the Books
   tables. Bytes of a discarded item are cleared after 30 days; the bytes of an imported item
   move into `sales_document_file` and are cleared from staging in the same transaction.
2. **Extraction with Claude Sonnet 5.5** (`claude-sonnet-5-5`) reading the PDF directly as a
   document block, with a strict tool schema for the record and a per-field confidence. Sonnet,
   not Opus: invoices are short structured documents, and the user checks every row anyway.
   The model id sits in env like the other AI routes (`AI_INVOICE_EXTRACT_MODEL`, default
   Sonnet 5.5). The prompt treats the PDF as data, never as instructions. One extraction per
   file at a time per company, at most four in parallel per company, and a daily per-company
   ceiling (default 500 files) so a mistaken upload cannot run up a bill.
3. **Validation before import, as code, not by the model**: the line totals add up to the
   total, the number is present and unique among the company's documents and the other staged
   rows, dates are real dates and not in the future, the tax treatment is one the Books know.
   For a small-business invoice the section 19 note must be present on the PDF (reported, not
   blocking: it is a historical record). Every failure is a named problem on the row.
4. **Numbers and the counter**: the printed number is kept as printed. When it matches the
   company's invoice format, its value is checked against the counter like the operator import.
   A company whose highest imported number is at or above the counter's next value gets the
   counter raised to that number plus one, in the same transaction, upwards only (counters are
   never lowered, BK003), and the editor says so. Numbers that do not match the format import
   with their printed text and no counter effect.
5. **Duplicates**: a file whose SHA-256 is already imported or staged is shown as a duplicate
   and never extracted again (no model cost). A different file with an already imported number
   is a problem on the row, never an overwrite.
6. **Sender snapshot**: defaults to the sender block printed on the PDF as extracted (the
   company may have moved since), falling back to the company's current sender block for fields
   the PDF does not show.
7. **Recipients**: find-or-create through the shared contacts database and the Books customer,
   with the same matching rule as the operator import; the document's customer snapshot is the
   recipient as printed.
8. **Access**: the same guard as every Books route (editor host, session, active company with
   `sites` and `books`, workspace admin). Uploads and extraction count against the company.
9. **Privacy**: logs carry item ids, statuses, sizes and problem codes, never extracted values or
   file names. The extracted data is sent to the Anthropic API under the platform's existing
   processing terms, the same as the AI editor features.
10. **Interface states**: empty (explain what happens), uploading, partial failure (a file that
    fails to upload or extract shows why and offers retry), all ready, mixed, everything
    imported. Leaving and coming back shows the staged rows as they were (resume). Re-uploading
    a discarded file stages it again.

## Tests (the four paths of the stateful-flow standard)

- Forward: upload, extract (model stubbed at the client boundary), review, confirm, imported,
  PDF served byte-identical.
- Backtrack and revise: correcting a field re-runs validation and clears or adds problems;
  changing the number re-checks uniqueness and the counter effect.
- Resume: staged rows survive a reload and a new session; an extraction interrupted mid-way is
  retried, not lost.
- Re-entry: a duplicate upload after import is recognised by hash; a discarded file can be
  staged again; a failed import leaves the row in `ready` with the problem named.
- Plus: guard chain, daily ceiling, parallelism limit, prompt-injection text in a PDF does not
  change the output shape, counter raised upwards only.

## Build notes (2026-10-20)

Built on branch `feat/books-upload-import`. Where the code showed a better way than the
decisions above, the refinement is below with its reason; decided, say so if you disagree.

**What exists now.** Migration `010_books_upload_import`; the shared mapping from a printed
invoice to the import record (`src/server/books/importPrinted.ts`, used by `pnpm books:import`
and by the upload); the import core extended (`src/server/books/importInvoices.ts`); the upload
domain in `src/server/books/upload/` (`staging.ts` the staging rows and the extraction ledger,
`extract.ts` the model call, `validate.ts` the problems, `limits.ts` the spend bounds,
`service.ts` the operations, `views.ts` the JSON); the routes under `/api/books/imports`
(list and upload, `[id]` read and correct, `extract`, `recheck`, `confirm`, `discard`, `pdf`);
the page `/projects/books/import` (`ImportPanel.tsx`, `ImportRowEditor.tsx`), linked from the
Books home.

1. **009 is deployed, so the schema changes are `010_books_upload_import`.** It holds: imports
   may keep a printed number outside the company's number format (decision 4 needs it); a
   discount line may carry negative VAT on a VAT invoice (007's `tax_amount >= 0` CHECK moves into
   the line guard exactly as 009 moved the unit price and subtotal CHECKs, BK008); the staging
   table `historical_import_item` (decision 1); and an extraction ledger
   `historical_import_extraction`, one row per model call, which the daily ceiling counts
   (decision 2) and which records the spend. An imported staging row is frozen for every role,
   bytes are only ever cleared, never replaced, and a ledger row is finished once and never
   deleted (BK010, plus the house REVOKE of DELETE for the app role).
2. **Numbers (decision 4).** The import record carries the printed `documentNumber`; its counter
   value is derived from the company's own format (`{n}`, `RE-{n:4}`), and a number in another
   format is imported with its printed text and `number_value` NULL. Uniqueness holds on the
   printed text (007's index) and on the value. The counter policy is a mode of the core:
   `refuse` for `pnpm books:import` (unchanged), `raise` for the upload, which locks the counter
   row FOR UPDATE and raises it to the number plus one in the same transaction, upwards only
   (BK003 refuses a lowering). The review table shows the effect before the import
   (`counter_raised` with the new value) and the page says so after it.
3. **Tax treatments (decision 3, "one the Books know").** Every company, not only section 19
   ones, uploads past invoices, so the record now takes small business (section 19, tax 0),
   regular taxation (net lines with their printed rate and VAT; rates 19, 16, 7, 5 and 0 %, the
   2020 rates included) and reverse charge (section 13b, tax 0, the recipient's VAT id and a
   business required, the database twin agrees). Where a line prints no VAT, it is derived from
   its rate (the invoice's only printed rate when the line shows none) and adjusted to the
   printed VAT summary per rate; such lines and a VAT more than a cent off rate times net are
   warnings, never refusals. Invoices whose line prices include VAT are a named problem
   (`gross_priced_lines`): the user enters the net amounts per line in the table and imports
   it, so there is a way forward; reading gross prices back into nets would invent figures. The
   section 19 or reverse-charge notice missing from a PDF is a warning (`tax_note_missing`), as
   decided ("reported, not blocking").
4. **Staging and the bytes (decision 1).** The core gained an in-transaction hook: the upload marks
   its staging row `imported` (document id set, bytes cleared) inside the import's own
   transaction, so a failure leaves neither a document without its row nor the reverse. A
   discarded row's bytes are cleared AT ONCE rather than after 30 days: the repository has no
   scheduler, and clearing on a later visit would keep the invoices of a company that never
   comes back; nothing reads a discarded row's bytes (the same file can be staged again). Open
   rows per company are bounded at 200 files and 512 MB together, and the review table lists
   every open row (no cap) and the newest 100 imported ones with the number imported in all.
5. **Upload transport.** One PDF per request, sent as the request body (`content-type:
   application/pdf`, its name in `x-file-name`): fifty files of 10 MB are not one request. The
   edge middleware keeps a body only up to `middlewareClientMaxBodySize` (default 10 MB, so a
   10 MB file would have arrived cut off without an error); it is raised to 12 MB, and the route
   refuses a body shorter than its declared length (`upload_truncated`) instead of staging it.
6. **The model call (decision 2).** Claude Sonnet 5.5 by default; `AI_INVOICE_EXTRACT_MODEL` names
   a model id, mapped to the AI layer's model key, and an unknown id is refused as a
   configuration error (500 `extract_model_unknown`), never silently replaced. The PDF is a
   `document` block; the model answers through one strict tool whose input is the printed invoice
   plus the fields it was unsure about; the input is parsed again with zod whatever the model
   sent, so text inside a PDF can change transcribed values but never the shape or the action
   (tested with an injected field and another tool). Effort `low`: transcription of a short
   document that a person and the code check afterwards. Output ceiling 16k tokens, one repair
   turn for output of the wrong shape, a refusal and the token ceiling are named failures of the
   row, a PDF the API itself refuses (a 413, or a 400 about the document: damaged, encrypted,
   too long) is `unreadable` and not offered again, while any other 400 (an account or request
   problem) stays a retryable error, and every row the model has no reading of can be filled in
   by hand (an empty manual reading, keyed like any other, no model call). What the user typed by
   hand or corrected is never replaced by a reading nobody asked for (a queue, a resume): only
   the row's own "Read again" replaces it (`replace=1`), and filling a row in by hand takes it
   out of the reading queue. A failed reading again keeps the earlier reading and its status,
   the failure noted. The whole call is aborted after 8 minutes (the SDK's own timeout ends with
   the response headers, so a stalled stream would otherwise run on), and also when the client
   disconnects; the row then goes back to what it was (a reading and its correction kept). The fields the model reports
   as unsure are kept only when they name a field of the invoice, and NUL characters (which
   Postgres refuses in JSONB) are dropped from everything the model or the user sends. The model
   also reads the sender's printed tax number and VAT id, which the operator's JSON never had.
7. **Spend bounds (decision 2).** Four extractions in flight per company (process local, like the
   AI routes' per-user slot; the plan's unit is the company, so the per-company slot replaces the
   per-user one: one user uploading fifty files gets four in parallel, and a colleague of the same
   company shares them). One extraction per file at a time, durable: a claim on the staging row
   carrying the extraction's id (`claim_id`, which 010 ties to the `extracting` status), taken
   over after ten minutes (above the 8-minute budget of a call) so a crashed call is retried, not
   lost, and every write of the call that was taken over is conditional on its claim, so it
   writes nothing. The open-row bounds are counted and the row inserted under one company lock
   too. The daily ceiling
   (`BOOKS_IMPORT_DAILY_LIMIT`, default 500) counts the ledger's calls of the last 24 hours, a
   rolling window rather than a calendar day: no time-zone edge, a restart does not reset it, and
   a retry counts like a first attempt; the count and the new ledger row are written under one
   company lock, so parallel calls cannot pass it together, and the tokens of every attempt are
   recorded, also when a later one fails. An invalid setting stops reading, not the page.
8. **Validation (decision 3) is the import core's own preview.** A staged row is mapped with the
   shared mapping and previewed by the core with the `raise` policy, so the table refuses exactly
   what the import would (the record's rules, a number already in the books, the same original
   under another number, an ambiguous recipient, the counter); only the staging table adds the
   same number on two staged rows ("0062" and "62" count as the same). The outcome is a list of
   named problems (codes, field paths, counts; never values), blocking or not; the row is `ready`
   without a blocking one. Fields the model was unsure about are marked (a dashed amber frame,
   described to screen readers) until the user changes them. What is printed but not readable is
   warned, never dropped silently: a service date or period (a month such as "Februar 2023" is
   read as its first and last day), payment terms, a recipient VAT id. An invoice already in the
   Books with these exact bytes (imported meanwhile by another path) is not a problem to fix:
   confirming it marks the row imported and creates nothing.
9. **Sender (decision 6).** The printed sender, with the company's current sender block filling the
   name, address, country, tax number and VAT id where the PDF shows none; the number of filled
   fields is a warning (`sender_from_company`) and recorded in the document's event, and the
   event records the tax number and VAT id as printed only when the PDF showed them.
10. **Duplicates (decision 5).** One live staging row per file (a partial unique index on the
    SHA-256, discarded rows excepted, so a discarded file can be staged again); a file imported
    before, by an upload or by `pnpm books:import`, is found by the stored original's SHA-256. In
    both cases the upload answers `duplicate` and the model is never called.
11. **Recipients (decision 7).** The core's rule, unchanged; the legal-form list knows the common
    European forms (SARL, SAS, BV, AB, Oy and others), and a recipient with a VAT id is a business.
    The Books customer row is now written inside the import transaction.
12. **The stateful-flow keying.** A correction is stored with the extraction it corrects and the
    row's version; a correction of an older reading is refused (`stale_extraction`), reading again
    drops the old correction, a row loaded from storage shows a correction only when its key
    matches the current reading, and a correction identical to what is stored changes nothing.
13. **Privacy (decision 9).** Logs carry item ids, sizes, statuses, problem counts and HTTP status
    codes, never extracted values, file names or model output. An unexpected error on any Books
    route is logged by its kind, SQLSTATE, constraint, table and column and its stack frames,
    never its message (a database error's message can quote the row). The PDF beside the form is
    not sandboxed (browsers refuse to display a PDF in a sandboxed document), so it is served
    only under all of these (lead's conditions of 2026-10-20): behind the full Books guard for
    the row's company; only bytes that start with `%PDF-`, checked at upload and again when
    served; `Content-Type: application/pdf` always (never from the upload's name or type),
    `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="document.pdf"`
    (no user text), `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy:
    same-origin`, `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`. A file that is
    really HTML or SVG never renders as a document of the editor's origin.
14. **Time stamps compared in SQL.** A staging claim's age is compared in the database against a
    parameter of the same kind it was written with: a `TIMESTAMP` without time zone read back
    into JavaScript can carry the machine's offset, so comparing there took a fresh claim for a
    stale one (found by the resume test).
15. **Reverse charge is the EU case only.** The Books store reverse charge as section 13b UStG for a
    business in another EU country (the tax profile agrees). Three named problems, each with its
    own way forward: `reverse_charge_country_unknown` (the country is not printed: enter it),
    `reverse_charge_outside_eu` (a customer outside the EU: "VAT charged" at 0 %, not taxable in
    Germany) and `reverse_charge_domestic` (a German customer under domestic section 13b: not
    supported by this import, the row says to keep the invoice outside the Books and discard it;
    supporting it is a product and tax decision for the lead). VAT that does not add up is named,
    never absorbed: a VAT summary off from the lines by more than rounding
    (`tax_summary_mismatch`), VAT on a 0 % line (`line_tax_on_zero_rate`, also refused by the
    record schema), and a summary row in the editor with its rate or VAT left empty.
16. **The operator CLI after the shared core changed.** `pnpm books:import` now also imports
    regular-VAT and reverse-charge entries, and a section 19 invoice without the printed notice
    is a warning there too (it was refused). Its integer numbers keep their counter value under
    any number format, so the counter refusal and the date-order warning hold as before.

17. **Raising the counter is confirmed, value by value (lead's decision of 2026-10-20).** A raise
    cannot be undone (BK003), and a misread "9999" for "99" would push the company's next
    invoice number up for good. Whenever importing a row would raise the counter, the review
    table says so plainly before the import ("Your next invoice number will become X. It cannot
    be lowered later.") and asks for an explicit confirmation of that value, per row or, for
    "Import all ready", once for the highest value of the batch (each row then sends its own).
    The server requires the confirmation to name exactly the value the import would set
    (`counter_raise_unconfirmed` otherwise, with the value to confirm; a confirmation from before
    the number was changed is refused), and the core refuses any other raise inside its
    transaction (`confirmedCounterRaiseTo`), so a counter moved meanwhile is never followed
    unconfirmed.
18. **Numbers that jump far ahead block until confirmed.** A number that would raise the counter
    more than 50 above its current next value, or lies more than 50 above the highest number of
    the other open staged rows (the batch's sequence), is the blocking problem
    `number_jump`. The user confirms that the number is printed that way ("The number is right");
    the confirmation is stored for exactly that number (`number_confirmed` on the staging row, in
    010) and the problem returns when the number changes. "Import all ready" goes on after a failed
    row with the rows as they are then (never with versions that moved) and names every failure.

**Operator steps** (live actions, not done here): deploy, which rolls `010_books_upload_import`
across every tenant schema at boot; optionally set `AI_INVOICE_EXTRACT_MODEL` and
`BOOKS_IMPORT_DAILY_LIMIT` (defaults: Sonnet 5.5, 500); prove the first real upload in the
editor.

## Out of scope

Image-only scans are read by the model as well (it reads PDF pages as images), so no separate
OCR step. Offers and credit notes import later through the same staging table with a document
type field.
