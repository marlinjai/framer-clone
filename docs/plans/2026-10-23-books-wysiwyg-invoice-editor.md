---
type: plan
status: decided
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

## Products build notes (2026-10-23)

What was built (phase 4, the product and service list; branch `feat/books-products`):

- **Migration `015_books_products`**: a per-company table `books_product` (kind service or
  product, name, description, unit label, unit price in integer cents never negative, the basis
  the price is quoted in, net or gross, tax class standard, reduced or zero, a default discount in
  basis points, `archived_at`). A normal mutable table, archived instead of deleted. Lines COPY an
  item's values and never reference it (no foreign key, none ever added), so changing or archiving
  an item never changes a draft or an issued document; the migration header says so. No trigger
  and no new BK code (nothing to refuse beyond CHECKs and one unique index); no REVOKE (the app
  role reads, inserts and updates it like any mutable table).
- **Repository and routes**: `GET /api/books/products?q=&includeArchived=1&cursor=` (100 a page,
  live first, then by folded name), `POST /api/books/products`, `GET|PATCH|DELETE
  /api/books/products/<id>` (DELETE archives; `PATCH { archived: false }` restores, alone in its
  request). Read guard `viewBooks`, write guard `editBooks`; another company's id answers 404. A
  name a live item already has answers 409 `duplicate_product` (create, rename, restore).
- **Client**: `ProductView` and `ProductInput` in `src/lib/books/api.ts`, the calls and the
  message for `duplicate_product`; `lineFromProduct(product)` in `src/lib/books/products.ts`
  returns exactly the body of `POST .../lines` (kind, title, description, unitLabel, unitPrice,
  priceBasis, taxClass, discountBp) for phase 3's line search.
- **Management page**: the "Products and services" tab (`ProductsPanel.tsx`, `ProductForm.tsx`):
  search, create, change, archive, restore, show archived; prices typed in euros and shown in
  German format; errors under their field and tied to it; focus kept in place after each change.

Decided while building, say so if you disagree:

1. **A price has a basis (net or gross), and the server converts it.** A line's unit price is in
   the draft's basis; an item has no draft. The add-line route takes `priceBasis` with the
   `unitPrice` it describes and converts on the server under the draft's tax profile at that
   moment (`convertUnitPrice` in `totals.ts`, rounded as one unit's tax is). The client never
   converts (decision 3). A small business stores the price as it is (net equals gross). Under
   reverse charge a gross quote loses its German VAT (the customer accounts for it), a net price
   stays as it is.
2. **Names compare folded**: case, accents, compatibility forms and repeated spaces do not count,
   and "ß" is "ss" ("Beratung" and "BERATÚNG" are one name). The fold is the application's
   (`src/lib/books/searchKey.ts`, stored as `name_key` and `search_text`), as the database has no
   accent extension; `name_key` is bounded to 600 characters (a ligature can fold to 18 letters).
   The search matches every typed word in name and description.
3. **One name rule** for the form and the server (`productNameProblem`): 1 to 300 characters (a
   line title), at least one letter or digit, a bounded fold. The default unit is `Stk`, as a line's.
4. **A change sends only the fields that differ** from the item as opened (no version column: the
   list is not a legal record; two windows changing different fields both keep their change).
5. **The list cursor holds the sort key** (archived flag, folded name, id), so a page continues
   where the last ended even when that row was renamed or archived meanwhile.
6. **Shared list status moved** (`FirstPage`, `MoreRows`) from BooksHome into `ListStatus.tsx`;
   `Field` gained an error slot with `fieldA11y` (aria-invalid, aria-describedby).

Review: a fresh agent reviewed the full diff and found 13 issues (the net or gross price with no
server path, focus moved before the reloaded rows were shown, an unbounded fold overflowing the
index, a full-body PATCH overwriting another window, client and server name rules differing,
two default units, "19 % VAT" shown to a small business, busy buttons, Escape dropping typed
values, a truncated description, missing paging tests, archive touching an archived item, restore
not refolding); all fixed. Its re-review found 3 more (reverse charge kept the VAT in a gross
quote, `priceBasis` applied to a catalog price, another form replacing a typed one silently); all
fixed. WCAG 2.2 AA checked with the `wcag` skill (labels, errors tied to fields, focus order and
visibility, status messages, label in name, reflow at 320 px, target size).

Tests: `pnpm test` 2949 passed (225 files), `pnpm test:integration` 528 passed (48 files),
typecheck, lint, build and `db:codegen-commerce` (no diff) clean. New: the four stateful-flow
paths of the tab plus its details (`ProductsPanel.test.tsx`), the fold, the name rule and
`lineFromProduct` (`src/lib/books/__tests__/products.test.ts`), `convertUnitPrice`
(`totals.test.ts`), and on real Postgres (`books-products.itest.ts`): guards, company scoping,
uniqueness among live items, archive frees the name, search, paging, a line from an item unchanged
after the item is changed and archived, and the price conversion in both directions, for a small
business and under reverse charge.

Operator step: none by hand. The next deploy rolls migration `015_books_products` at boot (purely
additive: one new table and two indexes).
