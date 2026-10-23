---
type: plan
status: draft
date: 2026-10-23
title: "Books: write the invoice on the invoice (a WYSIWYG document editor)"
summary: "Replace the form-based invoice editor with editing directly on the real A4 page: every field (recipient, dates, subject, texts, each line) is edited in place over the PDF the invoice will be printed as, laid out by the company's template, redrawn within a fraction of a second by the layout engine running in the browser. Adds sevdesk's breadth where it is missing: subject line, reference number, payment terms on the page, formatted intro and closing texts, a product and service list with search, and a total discount."
tags: [framer-clone, books, invoices, editor, wysiwyg, pdf, sevdesk]
projects: [framer-clone]
---

# Books: write the invoice on the invoice

## Why

The owner, 2026-10-23, after the template composer went live, showing the current invoice editor
next to sevdesk's: "I rather imagined a pixel perfect WYSIWYG editing experience closer to sevdesk
but even more WYSIWYG."

Today an invoice is written in a form (customer, service date, a table of lines, "Add line") and
seen only through "Preview PDF". sevdesk is also a form, a richer one: recipient with address and
country, invoice data (number, dates, delivery period, reference number, payment terms), a subject
line, a formatted intro text with text snippets and placeholders, positions with product search,
unit, VAT and discount per line, gross or net, a total discount, a closing text. "Even more
WYSIWYG" than that means the page you edit IS the invoice: the A4 page in the company's layout,
where you click the address and type, click a line's quantity and change it, and see the totals,
the tax note and the page breaks move as they will print.

## What exists (read before the design)

- The invoice editor (`src/app/projects/books/DocumentEditor.tsx`): customer picker, service date
  or period, lines (kind, title, description, quantity, unit, price, discount, tax class), net or
  gross, payment terms in days, intro and closing text (plain), the Correct flow banner, "Preview
  PDF" and "Issue...". Every change is a server call with the draft's version (optimistic
  concurrency, 409 `concurrent_edit` reloads); the server computes all figures (`totals.ts`, the
  tax engine), the client never does tax arithmetic.
- The layout engine (`src/server/books/render/engine/`, composer plan decision 10): bind, paginate,
  draw; deterministic; free of Node imports by design so it can run in the browser; returns the PDF
  and a layout map (every block's page and rectangle). The template composer
  (`/projects/books/templates/<id>`) already shows the real PDF with pdf.js and an overlay from that
  map.
- Drafts preview their template's current version; issue freezes it (`TemplateSnapshotV2`) and the
  server renders, checks (`missingFields`) and stores the PDF of record in the issue transaction.
- Not there: a subject line ("Betreff"), a reference number field on the draft, a product or
  service list, a total discount, formatted texts.

## Decisions (decided, say so if you disagree)

### 1. The real page is the editor; fields are edited in place over it

The editor shows the draft as the real PDF, in the company's template, page by page (pdf.js, as
the composer). Every editable field has a precise rectangle on the page: the engine's layout map is
extended from blocks to FIELDS (the recipient's lines, each document data item, the subject, the
intro and closing text, each line's description, quantity, unit, price, discount and tax rate, the
payment terms). Hovering shows an outline; a click (or Tab, in reading order) opens an inline
editor exactly on that rectangle, in the document's font, size, colour and alignment, so the text
stays where it was while it is typed. The field's own value is drawn by the editor while it has
focus; everything else is the PDF.

Why not an HTML imitation of the invoice: two renderers drift (a line breaks at another word, a
page breaks elsewhere), and the composer plan's founding rule is that screen and paper cannot
differ. Here the paper IS the screen; only the one field being typed in is drawn by the browser,
and it is replaced by the real PDF the moment the user pauses.

### 2. The engine runs in the browser for editing; the server stays the renderer of record

Typing needs the page back within a fraction of a second, not a server round trip (0.7 to 0.9 s
measured in the composer). The engine runs in a Web Worker in the browser with the same font files
(served as static assets, pinned by hash as on the server) and the same code, and redraws about
150 ms after the last keystroke (the engine renders a page in 50 to 80 ms on the server's CPUs). The
server still renders, checks and stores the PDF at issue, from its own data; the browser render is
a view. A test renders the same draft in the browser build and on the server and requires the same
bytes, so the two cannot drift.

### 3. Figures stay the server's

Amounts, tax per rate, totals, the tax note and the due date are computed by the server (`totals.ts`
and the tax engine) and come back with every saved change, as today. The browser draws the page
with the last figures it has and marks them as updating while a change is on its way, so a total is
never shown that the server did not compute. Text fields (address lines, subject, texts,
descriptions) redraw from the browser at once; amounts settle when the server answers (about 100
to 200 ms).

### 4. Saving: every field change is a draft edit, as now

A field commits on blur or after a pause, as a PATCH with the draft's version, exactly the current
contract; undo and redo work over those commits (the shared `SnapshotHistory`). Concurrency,
stale drafts, the Correct flow banner and Issue stay as they are, moved into a toolbar above the
page.

### 5. What is a field, and what is the template's

The page has two kinds of content, and the editor shows the difference: the DOCUMENT's content
(recipient, dates, subject, texts, lines, payment terms, reference) is edited in place; the
TEMPLATE's content (logo, sender line and columns, fixed labels, small print, colours) is not
editable on an invoice, shows a quiet "from the template" hint on hover, and offers "Edit layout"
(the composer). Legal labels stay fixed (composer decision 3).

### 6. Phones and narrow windows

An A4 page cannot be edited below about 900 px width. There the editor shows the same fields as a
single column form, the current editor's layout, with the page as a preview below. One component
tree, two arrangements.

### 7. Accessibility

The page is a picture; the fields are real form controls. Every field is reachable by Tab in
reading order and has a label ("Recipient, line 2", "Line 3, quantity"); the field list is also
available as a structured outline beside the page (as the composer's), so a screen reader user
edits the invoice without the canvas. WCAG 2.2 AA, checked with the `wcag` skill before the slice
merges.

## Questions for the owner (the decision page)

1. Formatted intro and closing texts (bold, italic, bullet lists, as sevdesk): yes now, or plain
   text with line breaks first.
2. A product and service list ("Produkt suchen"): a company list of items (name, description,
   unit, price, VAT class) that a line picks from and fills: now, or after the editor.
3. A total discount on the invoice ("Gesamtrabatt"): now, or later.
4. Text snippets and placeholders for intro and closing texts (sevdesk's "Textvorlage" and
   "Platzhalter", e.g. the customer's name): now, or later.

The recommendation is on the decision page with each question.

## Phases

| Phase | What | Size |
|---|---|---|
| 1 | The engine in the browser: a Web Worker build of `render/engine`, the fonts and logos as static or authenticated assets, a byte-identity test against the server render. | 2 days |
| 2 | Field-level layout map: the engine reports every editable field's rectangle, font, size, colour and alignment; tests per block type and across page breaks. | 2 days |
| 3 | The editor on the page: pdf.js pages with the field overlay, inline editors per field kind (text, multi-line text, date, number, select), Tab order, commits as today, undo and redo, figures from the server, the toolbar (customer, template, net or gross, Correct banner, Issue), the narrow-window form. | 6 days |
| 4 | sevdesk breadth: subject line and reference number on the draft (migration), payment terms on the page, then the owner's choices among questions 1 to 4. | 2 to 6 days |
| 5 | Accessibility pass, a fresh review, browser proof on "Books Testfirma" (write, edit in place, issue, compare the stored PDF with the last edited page). | 1 day |

Phases 1 and 2 can run in parallel; 3 needs both; 4 can start after 3's commit path exists.

## Test strategy

The four paths of the stateful-flow standard for the editor: forward (write an invoice on the page
from an empty draft and issue it; the stored PDF equals the last edited page apart from the
draft stamp and the number); backtrack and revise (edit, undo, redo; a change refused as stale
reloads and keeps the field the user was in); resume (reload mid-edit: the draft is the server's,
a field being typed in is not lost, it is committed on pause); re-entry (open an issued invoice:
read-only page with "Correct..."; a new draft starts empty). Engine parity: browser and server
renders byte-identical for the presets and the probe documents. Field map: every field's rectangle
contains its drawn text, across page breaks and in every template preset.
