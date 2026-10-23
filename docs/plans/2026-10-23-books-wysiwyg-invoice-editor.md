---
type: plan
status: in-progress
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

### 1a. Actions live on the page too, but never in the PDF

Everything that is an action rather than content is an editing control placed on the page from
the layout map, never drawn into the PDF, so it can never print (asked by the owner on 2026-10-23,
pointing at sevdesk's "+ Position hinzufügen" row):

- **Adding lines:** "+ Add line" sits directly under the line table's last row, as a ghost row
  where the next line would print, with "+ Choose product" beside it (if the product list is
  chosen) and "+ Discount on the invoice" (if that is chosen). A click adds an empty line at once,
  shown as an inline row with the cursor in its description; the redraw a moment later moves the
  totals, the tax lines and any page break to where they will print.
- **Each line on hover or focus:** a small toolbar in the margin beside the row: remove,
  duplicate, a drag handle to reorder (with move up and down as the single-pointer alternative),
  and a menu for the line's discount, tax rate and kind (service, product, text line).
- **Empty optional fields** (subject, reference number, closing text, a second address line) show
  as quiet placeholders where they would print ("+ Add a subject"), only while editing.
- **Keyboard:** Enter in a line's last field adds the next line; every control is reachable by Tab
  in reading order, so the mouse and the keyboard can do the same things.

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
page, with one addition: when `DocumentEditor.change()` reloads the server's details after a
`concurrent_edit`, the editor keeps the active field's identity and its unsaved local value, and
restores that value into the field after the reload, then commits it as a new PATCH against the
refreshed version (a rebase of the user's text onto the new draft, never a silent discard).
If the same field also changed on the server, the user's value is committed and the server's
earlier value stays in the undo history.

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

## Decided by the owner (2026-10-23)

The owner took every recommendation of the decision page (a local working file on the owner's
machine, `~/software-dev/decision-pages/2026-10-23-wysiwyg-invoice-editor.html`, not part of this
repository; the five decisions are recorded below):

1. **Edit on the real PDF page** (decision 1), not on an HTML imitation of the invoice.
2. **Formatted intro and closing texts now:** bold, italic, bullet lists and line breaks, drawn by
   the engine (italic needs the regular-italic and bold-italic file of each family, pinned by hash
   as the others; a family id gains files, so it gets a new id or the italic faces are added before
   any document uses italic: decided while building, written in the build notes).
3. **A product and service list now**, in this plan: a company list (name, description, unit,
   price, VAT class), a small page to manage it, and the search in a line that fills it.
4. **A discount on the whole invoice later**, as its own plan: it changes the tax arithmetic per
   rate and the completeness check (its own ROADMAP line).
5. **Text snippets and placeholders later**, after the editor is in daily use (its own ROADMAP
   line).

## Constraints for phase 4 (decided before building, so nothing is built around them)

- **Italic is embedded only when a document has italic text.** pdf-lib embeds every face it is
  given, used or not; embedding the italic faces always would change the bytes of every document,
  issued ones included, on their next re-render. A document without italic runs keeps exactly
  today's bytes (the golden tests assert it).
- **Formatted text stays plain to the legal checks.** Whatever stores bold, italic and lists (a
  small run model in the document, not free markup), the text the PDF yields when read back is the
  plain words, so `missingFields` is unchanged, and the undrawable-character check runs on the
  content, never on markup.
- **The subject is a template block and a document field.** sevdesk's "Betreff" prints where the
  layout says: a new optional `subject` block in the template model (palette, rules, engine,
  presets) and a `subject` column on `sales_document` (migration). The reference number already
  exists as the document's `contractReference` (printed in the document data as "Vertrag"); it is
  made editable on the page, not added again.
- **The engine stays browser-safe.** Audited 2026-10-23: the engine, the render model, `format`,
  `labels` and `epcQr` import nothing from Node; `logoImage.ts` (upload checks, `node:zlib`) is
  upload-side only and must stay out of the engine's imports; `previewSafe` gets a browser version
  that measures coverage from the fetched font bytes.

## Phases

| Phase | What | Size |
|---|---|---|
| 1 | The engine in the browser: a Web Worker build of `render/engine`, the fonts and logos as static or authenticated assets, a byte-identity test against the server render. | 2 days |
| 2 | Field-level layout map: the engine reports every editable field's rectangle, font, size, colour and alignment; tests per block type and across page breaks. | 2 days |
| 3 | The editor on the page: pdf.js pages with the field overlay, inline editors per field kind (text, multi-line text, date, number, select), Tab order, commits as today, undo and redo, figures from the server, the toolbar (customer, template, net or gross, Correct banner, Issue), the narrow-window form. | 6 days |
| 4 | sevdesk breadth: subject line and reference number on the draft (migration), payment terms on the page, formatted intro and closing texts (engine runs, the italic faces, an inline toolbar), the product and service list (table, management page, search in a line). | 5 days |
| 5 | Accessibility pass, a fresh review, browser proof on "Books Testfirma" (write, edit in place, issue, compare every page of the stored PDF with the final browser render). | 1 day |

Phases 1 and 2 can run in parallel; 3 needs both; 4 can start after 3's commit path exists.

## Test strategy

The four paths of the stateful-flow standard for the editor: forward (write an invoice on the page
from an empty draft and issue it; every page of the stored PDF equals the
final browser render apart from the draft stamp and the invoice number, the only allowed
differences); backtrack and revise (edit, undo, redo; a change refused as stale
reloads and keeps the field the user was in); resume (reload mid-edit: the draft is the server's;
the active field's unsaved value is kept in `sessionStorage` on every keystroke, flushed on
`pagehide`, and restored and committed after the reload, so a reload before the pause loses
nothing; a second test reloads after the commit); re-entry (open an issued invoice:
read-only page with "Correct..."; a new draft starts empty). Engine parity: browser and server
renders byte-identical for the presets and the probe documents. Field map: every field's rectangle
contains its drawn text, across page breaks and in every template preset.

## Phase 2 build notes (2026-10-23): the field map

Built on branch `feat/books-field-layout-map`. Decided while building, say so if you disagree.

**What exists now.** `renderTemplate` (`src/server/books/render/engine/index.ts`) returns, next to
the unchanged `blocks`, `tables` and `issues`, two new parts of the layout map:

- `fields: LayoutField[]`, the document's fields printed on the page (decision 5: not the
  template's labels, title, sender or bank line), in reading order (page, then region with the
  address before the document data, then top and left): `id`, `kind` (`text`, `multiline`,
  `date`, `number`, `money`, `select`, `readonly`), `source` (`document` or `line`, null when
  read-only), `documentField` (the request key it edits, typed as the union of the draft's and the
  line's keys, null when read-only), `valueUnit` (`thousandths`, `basisPoints`, `days`, `cents`
  for a `number` or `money` field), `recipientField` (which customer property an address line
  shows), `lineId`, `blockId`, `region`, `empty`, `room`, `rects` (one per page, points from the
  page's top left) and `style` (font family, bold, size, resolved `#rrggbb` colour, alignment,
  line height).
- `anchors.rows` (each line's row, one rectangle per page, the gap after it left out) and
  `anchors.addLine` (one row high, directly under the table's last row on the table's last page,
  with `room`, the free points before the totals or the page's end).

The ids: `recipient.line.<n>` (1-based, printed order), `meta.<item>` (the template's item names:
`number`, `issueDate`, `serviceDate`, `customerNumber`, `contract`, `recipientVatId`,
`dueDate`), `introText`, `outroText`, `line.<lineId>.<part>` (`title`, `description`,
`quantity`, `unit`, `unitPrice`, `discount`, `rate`, `amount`), `payment.terms`,
`payment.reference`, `taxNote`, `totals.<n>` (1-based, printed order). Empty slots:
`recipient.customer` (no customer yet), `meta.contract`, `introText`, `outroText`,
`line.<lineId>.description`.

How: the binder marks the chunks it builds with what they show (a mark is a rectangle inside a
chunk: field, row or add-line slot); marks never draw and never take space, and the map collects
them from every placed chunk after drawing (the footer and following-page header once per page,
the cells of a `columns` row lifted out with their offset). Blocks that print nothing (no
customer, no intro or closing text) leave a slot where their first line would print, recorded
beside the flow without moving it.

**Decided while building.**

1. *The model carries what the engine cannot know.* `ModelLine` gained `id`, `detailFields`
   (which of `details` is the description and which the discount line) and `rateByClass`;
   `RenderModel` gained `recipientFields` (which property each address line shows;
   `recipientEntries` replaces `recipientLines`), `paymentFields` (terms, due date, reference or
   bank for each payment line) and `servicePeriod`. Additive only; nothing that draws reads them,
   and the engine never recognises a field by its printed label.
2. *A `select` kind beside the five in the brief.* The tax rate is chosen through `taxClass` and
   the customer through PUT `.../customer`; neither is typed in.
3. *The recipient lines are read-only.* They are the customer's contact, and no request changes a
   contact's address (the customer routes take the customer type, VAT id, country and tax
   number; the draft takes only `customerId`). Each line says which property it shows
   (`recipientField`; `postalCity` is the postal code and city line, `name` includes the legal
   form when it prints with it), so phase 3 can offer "edit the contact" there. No slot for a
   second address line is offered for the same reason; decision 1a's "second address line"
   placeholder waits for an address endpoint (phase 3's call).
4. *Read-only where the API has no key:* the number and issue date (assigned at issue), the
   customer number and the recipient's VAT id (the customer's), the due date (follows from the
   payment terms; the editable surface is `payment.terms`, a `number` in days on
   `paymentTermsDays` while the line says "Zahlbar innerhalb von n Tagen", read-only once it shows
   the due date), `payment.reference` (not patchable today), the amounts, the totals, the tax note,
   and a line's rate when the tax class does not set it (a rate override, reverse charge, small
   business).
5. *A right-aligned field's rectangle is its alignment box,* not the glyphs: the whole column for
   quantity, price, rate and amount, from the label's end to the block's edge for a document data
   value, the value column for a total. An inline input with `align: right` in that box keeps the
   text where it prints while longer numbers are typed.
6. *Empty slots overlap what follows, and say so.* A typed value pushes what follows down, so the
   slot where it would print can cover the next thing on the page (an empty description slot
   covers the 6 pt gap and the top of the next row; an empty intro starts where the table
   starts; an empty closing text at the page's end is kept on the page, over the content above
   it). `room` gives the free points under the slot's top (0 when ink is already there), so
   phase 3 can draw a compact "+ Add ..." in the free space and open the full editor on click.
   Not offered: a subject (phase 4 adds the block), a discount (decision 1a puts it in the line's
   menu).
7. *Field ids are unique per template the save gate accepts* (`rules.ts` allows every block bound
   to document data once); the map keys a field by id and block, so an unchecked template with
   two such blocks gives two entries with the same id rather than one rectangle spanning both.
8. *`kind`, `source` and `documentField` stay three plain properties*, not a discriminated union:
   `readonly` exactly when the other two are null (documented on the type, asserted by the
   tests); a union would make every consumer narrow before reading a rectangle.
9. *The map is built on every render,* the issue path included, where it is discarded: it costs a
   pass over the placed chunks (grouped by page for the `room` lookups), small against embedding
   the fonts; an option to skip it would be a second code path for no measurable gain.

**Review.** A fresh agent reviewed the diff (only the diff, this plan and the goal). Fixed: the
byte test only compared two renders of the new code, now every preset, family, probe, issued and
draft must match `engineBytesGolden.json` (126 hashes rendered on the commit before the map);
the request keys were hand copies, now read from the route sources and `lineFieldsBody`; the
recipient lines claimed a `customer` source with keys no endpoint has, now read-only (decision
3); a slot pushed against the page's end reported room over printed content, now 0 (and `room`
counts content reaching into the slot, not only content starting in it); the payment lines and
the service period were recognised by their labels, now by the model; the rate claimed
`taxClass` where an override or the treatment sets it; number fields had no scale
(`valueUnit`); the tie-break of the field order used a locale comparison (the browser worker and
the server could differ); comments and a blank line. The re-review confirmed every fix and left
three notes, also fixed: the `room` comment says it measures boxes (trailing gaps count, so it
errs small), the line keys are checked against `lineFieldsBody` by the compiler, and the route
sources are found from the test file's own path.

**Tests.** `src/server/books/__tests__/engineFields.test.ts`: for the three presets in all three
font families, the seven probes, issued and draft (126 renders), the PDF's hash equals the pinned
one; every field's rectangles lie on the page and above the footer, one per page in page order;
the text read back from the PDF whose origin lies in a field's rectangles is exactly the field's
text from the model and lies wholly inside them (measured with the same faces); every editable
field names a request key and a scale where it needs one, every read-only one none; each line's
fields lie inside its row; the add-line slot is on the table's last page under the last row, as
wide as the table, and nothing printed starts inside its `room`; no drawn text reaches into an
empty slot's free room. Plus: a long description and a long intro each get one rectangle per
page, the empty slots of a draft with their `room`, a slot pushed over content has no room, the
customer slot when there is no customer, payment lines inside a `columns` cell, a document data
value too wide for its line, the request keys against the route schemas, the rate's read-only
cases and the scales, reading order, the styles. A mutation check (the meta value's rectangle
widened over its label) fails the suite.

**No PDF byte changed.** Before and after the change, every preset in every font family with
every probe, issued and draft, with and without the preview stamp (252 renders) gave the same
SHA-256 of the PDF and of the block part of the map; `dejavuGolden.json`, `legacyV1.test.ts` and
the engine's determinism tests pass unchanged, and the 126 pinned hashes keep it that way.

**Looked at.** The rectangles drawn as outlines over the PDF (`__tests__/fieldOverlay.ts`, a
test-only helper; `FIELD_OVERLAY_DIR=<dir> pnpm vitest run engineFields`), rasterized with
`sips`, for Klassisch (issued, and a draft with the empty slots) and a three-page Modern sample
in Noto Serif whose last line's description runs over all three pages: every rectangle sits on
its text, the description and its row have one rectangle on each page, the add-line slot sits
under the last row on page 3 above the totals.
