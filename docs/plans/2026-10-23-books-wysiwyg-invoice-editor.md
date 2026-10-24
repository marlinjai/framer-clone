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

## Phase 1 build notes (2026-10-23): the engine in the browser

**What was built.** The layout engine now draws a DRAFT in a Web Worker in the browser, byte for
byte as the server's draft PDF route draws it. The server stays the only renderer of record: issue,
the completeness check and the stored PDF are unchanged.

- `src/lib/books/engine/`: the client API phase 3 calls (`index.ts`):
  `fetchRenderInput(documentId, { signal? }): Promise<RenderInputPayload>` and
  `renderDraftInBrowser(payload, { signal? }): Promise<{ bytes: Uint8Array; layout: LayoutMap; renderMs: number }>`,
  plus `browserRenderSupported()`, `disposeBrowserRenderer()`, `BrowserRenderError` (a `code` per
  failure: `render_input_failed`, `invalid_input`, `font_fetch_failed`, `font_hash_mismatch`,
  `logo_fetch_failed`, `logo_hash_mismatch`, `render_failed`, `worker_unsupported`, `worker_failed`,
  `aborted`). One worker per page (`render.worker.ts`), renders in order, `signal` cancels (a render
  not yet started is skipped, a late answer dropped). The payload may be edited locally before a
  render (phase 3 types into it); dates may be `Date`s or ISO strings.
- `render/draftRender.ts`: the ONE draft path both sides call (render model, "?" for characters
  the family cannot draw, engine, "ENTWURF" stamp); `store.ts documentPdf` now calls it too, so
  server and browser cannot drift in what they do, only in the resources they pass.
- `render/previewSafe.ts`: the "?" replacement with the coverage passed in (`canDraw`); the
  server's `drawable.ts previewSafe` and `fonts.ts undrawable` delegate to it unchanged.
- `render/fontPins.ts`: the pin table (`FONT_FILES`), Node-free; `fonts.ts` re-exports it and stays
  the server's loader.
- `GET /api/books/documents/<id>/render-input`: `{ format: 1, documentId, documentVersion,
  fontFamily, input, template, logos: [{ sha256, contentType }] }`, exactly what the draft PDF route
  renders with (live sender, the customer's current contact, the lines and the server's figures,
  the current version of the draft's template, the logos it names that the company has). Same read
  guard and company scoping as the PDF route: another company's, an unknown or a malformed id 404,
  `private, no-store`.
- `GET /api/books/fonts/<sha256>`: the pinned files by digest, through the server's loader (which
  checks the pin), `public, max-age=31536000, immutable`, behind the read guard; any other digest 404.

**Decided while building, say so if you disagree.**

1. *Issued documents are refused by the render-input route* (409 `not_renderable`), imported ones
   too. Phase 3 shows an issued invoice from its stored PDF of record; drawing it in the browser
   would need the issue-time paths (`withOnlyLogo`, the drawable check) for no caller, and invite a
   view that could pass for the record.
2. *Fonts by digest through a route, not copied into `public/`.* One source of the files
   (assets/fonts, already traced into the standalone build for every Books route, so
   `next.config.ts` needed no tracing change), a URL that names exactly one file (so `immutable` is
   true, and phase 4's italic faces get their own URLs), and the server's pin check on the way out.
   `public` caching although guarded: the fonts are open-licensed and the same for everyone, so a
   shared cache serving them gives nothing away.
3. *Logos are listed, not embedded,* in the render input: the browser fetches each once through the
   existing asset route, checks it against its hash and keeps up to 8. A logo the template names
   and the company does not have is drawn empty with `LOGO_ASSET_MISSING` in the layout issues,
   exactly as on the server; a listed logo that cannot be fetched is an error, never a page without it.
4. *Coverage in the browser* is built with fontkit from the fetched, verified bytes with the
   server's rule (both faces must draw the code point), through the shared `previewSafe.ts` body.
5. *The page bundle carries no engine:* `index.ts` reaches only the client and the payload reader;
   pdf-lib, fontkit and qrcode load in the worker's own chunk (asserted by the import-graph test).
6. *The browser parity harness* (`src/app/dev/books-engine`, `pnpm harness:books-engine`) is
   built only with `BOOKS_ENGINE_HARNESS=1` (`pageExtensions` `*.harness.tsx`, its own `distDir`
   `.next-harness`, the font and asset routes rewritten to stand-ins because they need a session);
   a normal build contains none of it. A local Books session was not available, so layer (b) runs
   the real worker chunk webpack emits, in headless Chrome, against server-computed digests rather
   than through the session-guarded routes; the route chain itself is proven in Node by
   `books-render-input.itest.ts`.

**Tests.**

- `src/lib/books/engine/__tests__/parity.test.ts` (layer a): through the browser entry (fonts
  fetched and checked, coverage from the fetched bytes, payload through JSON with dates revived):
  every preset (Klassisch, Modern, Kompakt) x every probe document x every family, draft (same
  bytes as the draft PDF route's path) and not draft (the fetched fonts draw the issued bytes);
  undrawable characters; a logo; a missing logo; the layout map; every unhappy path by its code.
- `importGraph.test.ts`: walks the worker's and the page's value imports with the TypeScript
  parser; fails on a `node:` import or Node built-in, on `fonts.ts` or `logoImage.ts`, on a package
  outside pdf-lib, @pdf-lib/fontkit, qrcode and zod, on a value use of `Buffer`, `process` or
  `require`; and on the page entry reaching the engine.
- `client.test.ts`, `worker.test.ts`: ordering, cancel before and after start, abort during the
  body read, a dead worker, no Worker support, an answer for another document, the error envelope.
- `books-render-input.itest.ts`: real routes and a real tenant schema: the render-input answer drawn
  by the browser entry, fonts and logo through the real route handlers, equals the PDF route's
  bytes and `x-books-sha256` in all three families with a logo and undrawable characters, with the
  built-in layout, after a change and on a second read; the guard (other company, unknown and
  malformed id 404, no viewBooks 403, issued 409); the font route (every pin, headers, 404s, 403).
- Layer (b), real browser: the production webpack build of the worker in headless Chrome 152 (the
  automation browser), 78 cases (3 presets x 3 families x 7 probes, PNG and JPEG logos, undrawable
  characters, the latency drafts): 78 of 78 SHA-256 equal to the server's, no errors.
- Unchanged: `dejavuGolden.json`, `legacyV1.test.ts`, the engine determinism tests.

**Measured latency** (headless Chrome 152 on the MacBook, 50 runs after 5 warm-up runs,
`renderDraftInBrowser` wall clock in the page; the worker's own time is within 0.5 ms of it):

| Draft | DejaVu Sans p50 / p95 | Noto Sans p50 / p95 | Noto Serif p50 / p95 |
|---|---|---|---|
| 1 page | 18.7 / 20.2 ms | 93.2 / 95.7 ms | 92.2 / 94.8 ms |
| 3 pages | 30.3 / 31.9 ms | 118.0 / 121.1 ms | 118.4 / 120.8 ms |

All inside the 150 ms budget. Noto costs about 75 ms more per render because both faces are
embedded whole on every render (`EMBED_SUBSET`, the Phase 5 fix); caching the embedded font
streams per family (as `images.ts` does for logos) would remove most of it, but it is engine work
that must be proven byte-identical, so it is left for whoever next touches the engine (not needed
for the budget).

**Review.** A fresh reviewer read the full diff with only the plan and the goal. Fixed: a worker
kept cancels of renders already started forever; an abort while the render input's body was read
surfaced as `invalid_input`; the render-input route loaded every logo's bytes to return hashes
(now `templateAssetRefs`, hashes only); the worker's logo cache was unbounded (now 8, least
recently used out); an answer for another document id is refused; wrong file names in comments;
the harness asset stand-in answered any kind; `.next-harness` in `.dockerignore` and tsconfig.
Kept on purpose: `public` caching of the font route (decision 2). The fixes were reviewed again.

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

## Phase 3 build notes (2026-10-23): the editor on the page

Where it lives: `src/app/projects/books/invoice/` (`InvoicePage.tsx` the page and its actions,
`InlineEditor` inside it; `fields.ts` the field to value and value to request mapping;
`useDraftPage.ts` the render input, the local redraw and the font faces; `StoredPdf.tsx` an issued
or imported document's stored PDF). `DocumentEditor.tsx` shows the page instead of the recipient,
lines and totals sections when the window is at least 1024 px wide, the browser can run the engine
(a Web Worker) and the draft is not an import; "Use the form" switches back and is remembered per
browser (storage access guarded, it is a convenience only).

What a person can do on the page:

- Click or Tab to any printed field the layout map marks editable and type in place: the editor
  takes the field's font (the same font files as CSS faces), size, colour and alignment at the
  current zoom. Enter commits a one-line field, Ctrl or Cmd plus Enter a multi-line one, Escape
  leaves it, leaving the field commits. Text fields redraw on the page while typing (150 ms after
  the last key); figures wait for the server's answer, which recomputes amounts, tax and totals.
- Empty fields show where they would print ("Add an intro text"); where the slot has no room (an
  empty line description right above the next row) a small "+" sits in the left margin instead,
  never over printed text.
- The address chooses the customer (the address itself comes from the contact). Computed figures,
  the sender and the small print are not fields.
- Each row has an actions menu at the right margin: move up or down, duplicate, add or change the
  discount, the VAT class, remove. "Add line" opens inputs placed on the table's columns, Enter in
  the price adds it and starts the next; "Choose product" adds from the product list.
- Undo and redo (buttons, Ctrl or Cmd plus Z, Shift plus Z, Ctrl plus Y) replay each change as a
  draft edit with the current version; a removed line comes back at its place.
- A change refused because the draft changed elsewhere (409) reloads the draft and keeps the typed
  value open in the field.
- An issued invoice shows its stored PDF, the document of record, read-only and never drawn again.

Proven 2026-10-23 in headless Chrome against a local stand-in for the Books API (the real page,
the real engine and pdf.js): 22 fields on the probe draft, quantity edit recomputed by the server,
intro text typed and saved, a line added, a product picked, a line removed and undone back to its
place, the customer changed, focus returned to the edited field, the issued view drawn from the
stored PDF. Tests: `invoice/__tests__/InvoicePage.test.tsx` covers the four stateful-flow paths
(forward; backtrack and revise including undo, redo and a stale-version refusal; resume from the
server's answer; re-entry through the form preference, a narrow window and an issued invoice).

Fresh review (2026-10-23, an agent given only the diff), every finding fixed in the same change:
quantities of 1000 and more opened as "1.000", which reads back as 1 (the form had the same bug;
both now start from `quantityInput`, without thousands dots); a failing undo step blocked the
stacks (now taken off with a spoken note); undo steps followed a line's old id after it was added
back (steps now follow the line through an alias); a refused save reopened the field and the next
blur overwrote the newer change (leaving the field now sends nothing, Enter compares with what is
saved now, and any version this page did not produce ends the history); focus could be pulled to
a stale field and was lost after menus, Escape and removals (focus now goes to the trigger, the
neighbouring row or "Add line", and moving focus elsewhere cancels it; busy controls are
`aria-disabled` instead of disabled, so focus is never dropped); the open editor now takes its
field's place in reading order; Enter in the product search waits for the answer to what was
typed; a double Enter in the new line adds one line; the stored PDF redraws for a new version;
a local redraw waiting from typing no longer draws over the server's answer. Checked in Chrome:
one request per action, no second save from the blur of a closing editor. Field buttons are as
small as the printed text they sit on (below 24 px at 100 % zoom): the targets are the text
itself, the exception WCAG 2.5.8 makes for essential presentation, and "Use the form" on the same
screen gives full-size controls.

Production proof (2026-10-24, app.lumitra.co, company "Books Testfirma", headless automation
Chrome at 1500 px): a new draft written entirely on the page. The customer was chosen from the
address slot, a line was typed into the table ("Konzeption", 1,5 Std at 80 €), and a product was
picked from the list (created for the proof, which also showed migration 015 live). The first
line's quantity was edited in place to 2 (focus came back to it), a closing text was added, line
2 was removed and undone back into place, and the service date was set on its printed line.
Issued as TEST-4 (303,45 €: 255,00 € net, 48,45 € VAT at 19 %). The stored PDF (sha256
bd7a91aa…) rendered with sips shows the same lines, figures, service date and closing text as the
page did. It differs only in what issuing adds: no draft marks, the number and issue date, the
payment QR code, and the due date in the payment line. Sampling the page every 50 ms through an
edit and through remove plus undo showed it never blanks during a redraw. The fix found by the
proof: an empty line description's "+" now sits left of the whole row, not over the position
column.

## Phase 4 build notes (2026-10-24): the subject line

- **Data.** Migration `016_books_subject` adds `sales_document.subject` (nullable TEXT, at most 200
  characters by a CHECK, no default, no backfill). Existing documents read NULL and print no
  subject, so issued invoices re-render unchanged. 007's freeze guard compares whole rows, so the
  subject is frozen at issue with no new trigger code. The API takes `subject` on create and on
  the draft PATCH (one line: a line break or more than 200 characters is `invalid_input`). It is
  part of the undrawable-character check at issue.
- **Decided while building:** a correction's replacement draft copies the subject, like the other
  texts. A cancellation's credit note does not, like the intro and closing texts today: its own
  title says what it is.
- **Template.** A new optional `subject` block, body only, at most once, between the title and
  the intro text in the presets, bold at the base size, no "Betreff:" label (the sevdesk look).
  It prints nothing for a document without a subject, and a template with the block renders
  byte-identical to one without it then (pinned by a test, and checked over every preset, font
  and probe before the goldens were renewed). **Existing companies add the block once in the
  composer** ("Subject" in the palette): that is the constraint "prints where the layout says",
  not a gap. The probe documents carry a subject, so the composer previews show it.
- **Editing.** On the page the subject is a one-line field; an empty one is a slot "Add a subject"
  under the title. The form gained a texts section (subject, reference, intro text, closing text),
  which it never had: narrow windows can now reach every text the page edits. Its saves run one
  after another, each with the version the one before produced, so tabbing through the texts
  never sends a stale version, and a value saved elsewhere replaces an input only while it is
  not focused.
- **Golden bytes.** `engineFields.test.ts` gained `UPDATE_ENGINE_GOLDEN=1` to pin a deliberate
  change of what the presets or probes print; all 126 renders changed because every probe now has
  a subject.
