---
title: Books, importing past invoices by uploading PDFs
summary: >
  A company uploads many of its past invoice PDFs at once in the Books; Claude reads each one,
  the user checks and corrects the extracted data in a table, and the confirmed rows are imported
  as historical documents with the original PDF as the document of record.
type: plan
status: decided
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

## Out of scope

Image-only scans are read by the model as well (it reads PDF pages as images), so no separate
OCR step. Offers and credit notes import later through the same staging table with a document
type field.
