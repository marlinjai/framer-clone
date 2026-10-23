---
type: plan
status: in-progress
date: 2026-10-21
title: "Books: a visual invoice template composer that previews the real PDF"
summary: "A block-based A4 composer for Books document templates (blocks panel, the real PDF as canvas with a selection overlay, inspector), a versioned template document model consumed by a new deterministic pdf-lib layout engine, legally required blocks that can be moved and styled but never removed, a save gate that runs the completeness check against probe documents, logos stored in the tenant schema, and a Correct flow for issued invoices (credit note plus a prefilled replacement draft). Adds an EPC QR payment block (GiroCode). Sliced into seven phases; approved by the owner on 2026-10-22, all phases to be built."
tags: [framer-clone, books, invoices, templates, pdf, editor, composer, gobd, ustg, e-invoicing]
projects: [framer-clone, email-editor, receipt-ocr-app]
---

# Books: a visual invoice template composer that previews the real PDF

## Why

The owner asked on 2026-10-21 (translated): "There is no visual composer for the invoices, the
way I could edit existing ones. Is it possible to have a proper visual invoice composer that
renders as PDF, the same way we have our visual email template composer in the mail service or
our visual website composer in framer-clone?"

Two wishes sit in that sentence, and they get different answers:

1. **"Edit existing ones."** An issued invoice can never be edited: it is a document of record
   under the GoBD (Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern, the
   German rules for keeping books, which require that a recorded document is never changed
   without trace). What the owner actually needs is a fast way to fix a mistake. That is the
   **Correct flow** (section 9): one action produces the credit note that cancels the wrong
   invoice and a new draft prefilled with the same data. Drafts stay fully editable, as today.
2. **"A proper visual composer that renders as PDF."** Yes. Section 2 to 8 describe it: a
   block-based A4 composer modelled on the email editor, whose canvas is the real PDF from the
   same pdf-lib pipeline that renders the document of record, so screen and paper cannot differ.

## What exists today (read before the design)

- **Template = layout only** (`src/server/books/repository/templates.ts`, table
  `document_template` from migration `007_books`): name, default flag, locale (`de-DE` only),
  accent colour, up to four footer blocks of small print, default intro and outro texts.
  `logo_file_id` exists but stays NULL, because the repository has no storage-brain client
  (storage-brain is the suite's file service). The editor (`TemplatesPanel.tsx`) is a plain form.
- **Rendering** (`src/server/books/render/`): `model.ts` builds every printed string from the
  document (pure function), `pdf.ts` lays them out in a fixed order with pdf-lib on A4 (address
  window at 45 mm, document data on the right, title, reference, intro, line table with a header
  repeated on every page, totals, notes, payment terms, outro, small print, a four-column sender
  footer with "Seite n von m" on every page). `fonts.ts` embeds DejaVu Sans and DejaVu Sans Bold
  as subsets; `drawable.ts` refuses (`UNDRAWABLE_TEXT`) a field the font cannot draw.
  `extractText.ts` reads the drawn text back and `completeness.ts` checks it against the legal
  field list (section 14 (4) UStG, Umsatzsteuergesetz, the VAT act, for regular taxation; section
  34a UStDV, the VAT implementing ordinance, for section 19 small businesses; section 14a UStG for
  reverse charge), with expected values derived from the frozen data independently of the
  render model.
- **Freezing**: at issue the template is frozen into `sales_document.template_snapshot`
  (`TemplateSnapshotV1`: template id, name, accent colour, footer blocks). The PDF is rendered,
  checked and stored inside the issue transaction (`storeRenderedIn`), and downloads serve the
  stored bytes. The output is byte-deterministic (fixed metadata dates, hand-written number and
  date formatting, deterministic font subsetting), and a test proves a re-render after changing
  the customer is byte-identical. `RENDERER_ID = 'books-pdf-lib-2'` is recorded on every file.
- **Cancellation** (`src/server/books/cancel.ts`): an invoice is cancelled only through a full
  credit note issued in the same transaction; the 007 trigger refuses anything else. The credit
  note copies the invoice's customer snapshot, lines and tax fields and keeps the invoice's frozen
  layout. There is no "replace" link from a new invoice to the one it supersedes.
- **Receipts mirror**: receipt-ocr-app keeps `TaxIssuedInvoice` as a read-only copy of issued
  Books documents (its plan `docs/plans/2026-10-14-invoicing-and-income.md`, decision D6 and the
  mirror section); payments, payment matching and the section 19 turnover meter stay there.

## Decisions (decided, say so if you disagree)

### 1. Base: the email editor's architecture, not framer-clone's canvas

framer-clone's website editor is a free canvas: components positioned absolutely (Framer style),
responsive values per breakpoint, a MobX-State-Tree (MST, the in-memory tree behind the editor)
model of nested components with arbitrary sizes. An invoice is the opposite kind of document: a
fixed A4 page, content that **flows** and must break across pages (a 40-line invoice is three
pages), and regions that repeat (the footer, the table header). Free positioning would let a user
place the totals where a long line table then runs over them, and nothing in that model knows
about pages. So the website canvas is the wrong base.

The email editor (`email-editor/packages/core`, `blocks`, `ui`, `editor`) is the right shape: a
document of typed blocks in a vertical order, a block registry where each block type declares
default properties and a zod schema (zod: the validation library both repos use), a versioned
document with migration steps (`schema/migrate.ts`), an undo history (`history/HistoryManager.ts`,
Immer snapshots), drag and drop with dnd-kit, and a three-panel interface (blocks and outline on
the left, canvas in the middle, property inspector on the right). The composer copies that shape.
Where it differs: the email editor compiles to MJML (an email markup language) and shows the
compiled HTML in an iframe; the composer compiles to a PDF and shows that PDF.

### 2. Reuse: patterns now, one shared package only where it is genuinely generic

The owner prefers shared packages over copies (memory note of 2026-10-08, "package and database
first"). Checked against the code, the email packages cannot be depended on as they are:

- `@marlinjai/email-editor-core`'s `BlockDefinition` has a required `toMJML`, and the package
  depends on `mjml`, `mjml-browser` and their parsers; a PDF composer would ship an email compiler
  it never calls.
- The email editor uses MST 6; framer-clone is on MST 7.
- The canvas (`CompiledCanvas`, `idiomorph` patching of compiled HTML) is HTML specific.

What is generic is small: the undo history, the inspector's field primitives (colour, number with
unit, alignment toggle, select), and the sortable block list with its keyboard support. Decision:

- **Phase 3 extracts `@marlinjai/block-editor-react`** (a new published package in the
  email-editor monorepo). Name per the package naming standard
  (`knowledge-base/standards/package-naming.md`): one scope, `@marlinjai/<product>-<role>`, and
  roles only from the fixed vocabulary, which bans invented words such as `-kit`; the pieces are
  React components and hooks, so the role is `-react` and the product slug is `block-editor`. It
  holds exactly those three pieces with no MJML and no MST dependency (plain React plus Immer). The email editor
  switches to it in the same slice, so there is one implementation and no copy.
- **The template document model, the block registry for invoices and the layout engine stay in
  framer-clone** (`src/server/books/template/` and `src/server/books/render/`), because they are
  bound to the Books data, the legal check and the renderer, and have no second consumer.

### 3. The template document model (version 2)

A template becomes a JSON document validated by zod, stored per version (decision 4). Shape:

```ts
interface TemplateDocumentV2 {
  v: 2;
  locale: 'de-DE';                    // more locales in phase 6 (decision 13)
  page: {
    size: 'A4';                       // the only size: German invoices are A4, DIN 5008
    addressLayout: 'din5008-b' | 'din5008-a'; // address window at 45 mm (B) or 27 mm (A) from the top
    marginsMm: { left: number; right: number; bottom: number }; // left 20 to 25, right 10 to 20
  };
  theme: {
    fontFamily: 'dejavu-sans' | 'noto-sans' | 'noto-serif';
    baseSizePt: number;               // 8 to 11
    ink: string;                      // text colour, #rrggbb, contrast checked (decision 7)
    accent: string;                   // rules, title, table header, #rrggbb
    muted: string;                    // labels, small print
  };
  regions: {
    firstPageHeader: Block[];         // letterhead above the address zone (logo, sender line)
    addressZone: { left: Block[]; right: Block[] };  // left: recipient; right: document meta, logo
    body: Block[];                    // the flowing content, in order
    followingPageHeader: Block[];     // compact header on page 2 and later
    footer: Block[];                  // repeats on every page, above the page number
  };
}
```

**Blocks** (one zod schema per type, all with `id`, `type` and a small `style` object):

| Block | Bound to | Required | Notes |
|---|---|---|---|
| `logo` | the template's logo asset | no | width in mm, alignment |
| `senderLine` | sender snapshot (name, street, postal code, city) | yes* | the small return line above the address |
| `recipient` | customer snapshot | **yes** | fixed to the address zone's left, DIN 5008 position, cannot move out of it |
| `documentMeta` | number, issue date, service date or period, customer number, contract, recipient VAT id under reverse charge | **yes** | items can be reordered; legal items cannot be hidden |
| `title` | "Rechnung", "Gutschrift (Stornorechnung)" plus the cancelled invoice reference on a credit note | **yes** | size and colour styleable |
| `introText`, `outroText` | the document's texts (defaults from the template) | no | |
| `lineTable` | the stored lines | **yes** | column choice and widths (section 5) |
| `totals` | totals and the tax summary per rate | **yes** | |
| `taxNote` | the section 19 exemption or reverse-charge note | **yes** | printed only when the document has one |
| `paymentDetails` | due date or terms, payment reference, bank | no (invoice only) | |
| `paymentQr` | issuer IBAN, BIC and name, the total, the reference | no (invoice only) | EPC QR code ("GiroCode") with a caption, decision 17 |
| `senderColumns` | sender identity, contact, tax and register, bank | yes* | footer columns; the sender's tax ids live here |
| `freeText` | template text | no | plain text with bold, up to 2000 characters |
| `spacer` | none | no | height from the spacing scale |
| `divider` | none | no | thickness 0.3 to 1.5 pt, colour from the theme |
| `columns` | none | no | a row of 2 to 4 cells with width fractions, each cell holding non-flowing blocks |

\* The sender's name, address and tax id are legally required. They must appear in at least one of
`senderLine` and `senderColumns`; the tax id only lives in `senderColumns`, so that block is
required in the footer region.

**Labels.** Every label of a legally checked field ("Rechnungsnummer", "Leistungsdatum",
"Gesamtbetrag", "Nettobetrag zu 19 %") is fixed per locale and not editable, because the
completeness check matches label plus value, and a custom label could make a value ambiguous
(for example a due date read as the issue date). Labels of optional items (the payment heading,
free texts) are editable.

**Styling allowed**, deliberately bounded so every template stays legible, legal and fast to
render:

- Fonts: the three embedded families of decision 6, regular and bold. No upload.
- Sizes: per block from a scale (6.5, 7, 7.5, 8, 9, 9.5, 10, 11, 12, 14, 16, 20 pt); legal blocks
  never below 7 pt, footer small print never below 6.5 pt (today's value).
- Colours: the three theme colours, and per block a choice among them (not a free colour per
  block), plus a light tint of the accent for the table header band.
- Spacing: a fixed scale (0, 2, 4, 6, 8, 12, 16, 24, 32 pt) above and below each block.
- Alignment: left, centre, right for text blocks; amounts are always right aligned.
- Column widths: fractions in a 12-unit grid for `columns`; the line table's widths per section 5.

**Migration of today's templates.** A new migration `012_books_template_v2` adds the version
table (decision 4) and converts every existing row into a version 1 of the v2 document built from
the built-in **"Klassisch"** preset (today's layout expressed as blocks) with the row's accent
colour, footer blocks (as `freeText` blocks in the body's small print position) and intro and outro
defaults. The old columns `accent_color` and `footer_blocks` are dropped in the same migration
(the editor and the repository are switched in the same pull request, nothing external reads
them). `default_intro_text` and `default_outro_text` stay on the template row, because they seed a
new draft and are not layout. The composer offers three presets for a new template: Klassisch,
Modern (logo top right, accent band table header), Kompakt (smaller type, one-line footer).

### 4. Versioning and freezing

- New table `document_template_version` (tenant schema): `id`, `tenant_id`, `template_id`,
  `version` (1, 2, 3 per template), `document` JSONB (the v2 document), `created_at`,
  `created_by`. Append-only (no update, no delete, the house `APPEND_ONLY_TABLES` revoke plus a
  trigger, as `sales_document_file`). `document_template` gains `current_version_id`.
- **Saving** a template writes a new version row and moves `current_version_id`, in one
  transaction, only after the save gate passes (decision 8). An unsaved working copy lives in the
  browser (decision 11), never in the database.
- **Drafts** reference the template (`template_id`, as now) and always preview its current version.
- **Issue** freezes `TemplateSnapshotV2 = { v: 2, templateId, templateVersionId, name, document,
  logo: { sha256 } | null }` into `sales_document.template_snapshot`. The snapshot carries the
  whole document, not only the version id, so a re-render never depends on another table; the
  version id is the human reference ("issued with Klassisch, version 4").
- **Old snapshots stay readable.** `TemplateSnapshotV1` documents keep the current `pdf.ts`,
  frozen and renamed `render/legacyV1.ts`, used only for v1 snapshots. Their PDFs are already
  stored, so this path only runs for a document issued before 008 without a stored file; keeping
  the old code is cheaper and safer than proving that a converted v1 renders byte-identically in
  the new engine.
- A template version in use can never be deleted (append-only); a template can be archived
  (hidden from the picker) instead of deleted once any document used it.

### 5. Page geometry and how the line table paginates

- **A4 (595.28 x 841.89 pt).** Address window per DIN 5008 (German standard for business letters,
  which window envelopes are cut for): form B puts the address field 45 mm from the top, form A
  27 mm, both 20 mm from the left, 85 x 45 mm. The `recipient` block is pinned there and cannot be
  dragged out, so a window envelope always shows the address.
- **First page**: `firstPageHeader`, then the address zone (left and right side by side, the
  taller one sets the height), then `body`. **Following pages**: `followingPageHeader` (default:
  logo small, "Rechnung 62, Seite 2 von 3") then the continued body. **Every page**: the `footer`
  region at the bottom margin, and "Seite n von m" (page number position: right or centre under
  the footer; always present, not removable, because a multi-page invoice must show it belongs
  together). The footer's height is measured once and reserves the bottom of every page.
- **What may break across pages**: only the line table (between rows, and inside a row taller
  than a page line by line, as today), and long text blocks (`introText`, `outroText`, `freeText`)
  between lines. Everything else is keep-together: a block that does not fit moves to the next
  page whole. `totals` and `taxNote` are kept together with each other (an orphaned tax note on
  its own page reads as a separate document). `columns` rows are keep-together.
- **The table header repeats** at the top of the table on every page it continues on, as today.
- **Line table columns.** Position, title (with description and discount detail lines), quantity,
  unit, unit price, tax rate, amount. Quantity, unit, title and amount are legally required (the
  "quantity and kind" of each service and the amount) and cannot be hidden; position and unit
  price can; the tax rate column is hidden automatically under section 19 (as today) and cannot be
  hidden under regular taxation when the document has more than one rate. The user sets widths by
  dragging column borders in the canvas (or numbers in the inspector), in a 100-unit grid. The
  amount and price columns have a **minimum width computed from the widest possible value**
  ("-21.474.836,47 EUR" in the chosen font and size), so no template can be saved whose amounts
  could overflow; the title column takes the rest and wraps.

### 6. Fonts

Today only DejaVu Sans (broad coverage: Latin with every European diacritic, Greek, Cyrillic).
Decision: add **Noto Sans** and **Noto Serif** (SIL Open Font License, regular and bold, same
coverage class as DejaVu for European scripts), committed in `assets/fonts/` with their licence,
about 1.2 MB more in the image. Font files are identified by family id plus a content hash in
code; a family id never changes its files (an update gets a new id), so an issued document always
re-renders with the bytes it was issued with. `fonts.ts` and `drawable.ts` take the family as a
parameter, so the `UNDRAWABLE_TEXT` check uses the coverage of the font the document is actually
set in. No font upload: licences, coverage and determinism would all become the user's problem.

### 7. What the completeness check needs from the composer (text present is not enough)

The check reads the drawn text back. A visual composer opens ways to make text technically present
but unreadable, which the check cannot see. The composer therefore enforces, at save and again
in the renderer:

- legal blocks never below 7 pt;
- every text colour against white at a contrast ratio of at least 4.5:1 (the WCAG, Web Content
  Accessibility Guidelines, AA level for normal text), and the accent tint behind the table header
  light enough that the header text keeps 4.5:1;
- nothing drawn outside the page or under the footer zone (the layout engine asserts it, the
  tests check positions, as the current 4000-character description test does);
- no overlap: the layout is a flow, so blocks cannot overlap by construction; `columns` cells are
  measured and the row takes the tallest cell.

### 8. The save gate: an incomplete template cannot be saved

Two checks, both server side on save (the composer runs the first live for feedback):

1. **Structural**: every required block present in an allowed region, every legal column and
   meta item visible, the size, contrast and width rules of decisions 5 and 7. Fast, gives
   precise messages ("Die Steuernummer steht in den Absenderspalten; die Spalten können nicht
   entfernt werden").
2. **Probe render**: the template is rendered against a fixed set of probe documents and
   `missingFields` (the existing completeness check, unchanged) runs on each: a section 19
   invoice, a regular invoice with two tax rates, a reverse-charge invoice, a credit note, a
   40-line invoice over three pages, a recipient with a very long name and a foreign address, a
   line with a 4000-character description. Any missing field refuses the save with the probe and
   field named. Probes are code fixtures with fictional data, so no real customer data is used.

The check at issue keeps running on the real document (`storeRenderedIn`) as the backstop. The
probe set proves the template, the issue check proves each document.

### 9. The Correct flow

Refined from the direction given to the owner ("one click cancels via credit note and opens a new
draft prefilled with the same data"). The written reason for the one refinement: cancelling at
the click means a wrong click, or a draft that is then abandoned, leaves a customer with a credit
note and no valid invoice, and the cancellation cannot be undone (only a new invoice repairs it).
Issuing both at the moment the replacement is ready gives the customer the credit note and the
corrected invoice together and leaves nothing dangling.

- **"Korrigieren"** on an issued, not cancelled, editor-made invoice creates a **replacement draft**: same customer, currency, net or gross
  mode, payment terms, tax fields, contract and payment references, intro and outro, all lines,
  and the same template. The draft carries `replaces_document_id` (new nullable column, composite
  foreign key to the invoice, frozen at issue by the 007 guard like every column) and shows a
  banner: "Ersetzt Rechnung 62. Beim Ausstellen wird Rechnung 62 per Gutschrift storniert."
- The draft is edited like any draft. **Issuing it** runs one transaction: lock the old invoice,
  run the existing `cancelInvoice` steps (credit note issued, invoice set to cancelled, events),
  then issue the replacement, each with its PDF rendered, checked and stored before commit. A
  failure anywhere rolls all of it back: no number taken, nothing cancelled.
- **Numbering**: the credit note takes the next credit note number, the replacement the next
  invoice number (never the old number: a number is used once). Lock order as today: documents,
  then counters, credit note counter before invoice counter.
- **Links**: credit note `corrects_document_id` = old invoice (exists); replacement
  `replaces_document_id` = old invoice (new). The document view shows the chain: "Rechnung 62
  (storniert durch Gutschrift 5, ersetzt durch Rechnung 63)". The replacement's PDF prints no
  reference by default (it is a normal invoice); an optional line "Ersetzt Rechnung 62 vom
  14.10.2026" can be switched on per document.
- **Imported invoices are out of scope** for Korrigieren and keep the plain "Stornieren": an
  import may be in CHF (editor documents are EUR only, `CURRENCY_NOT_SUPPORTED`) or carry an
  incomplete printed address, so a copied replacement draft could dead-end at issue. The button is
  not shown on them; the document view says "Importierte Rechnung: stornieren und neu anlegen".
- **Guards**: one replacement per invoice, draft or issued (a unique index on
  `replaces_document_id` wherever it is set; built stricter than first written, which said
  "where status is draft", with the same effect); a replacement draft of an invoice that meanwhile
  got cancelled by another path refuses to issue (`REPLACED_INVOICE_CANCELLED`, with the option to
  issue it as an ordinary invoice). The plain "Stornieren" (cancel only) stays for invoices that
  should simply go away.
- **What the receipts mirror sees**: as today, the old invoice turning `cancelled` and a new
  credit note pointing at it, plus the new invoice with a `replacesDocumentId` field in the payload
  of the mirror pull endpoint (when that endpoint is built; this repo adds the field to the
  document view it will serve). A payment already matched to the old invoice is the receipts app's to move to the
  replacement (it owns payment matching, D6); the mirror pull gets the field in this repo, the
  re-matching rule is a receipts-side change, filed on receipt-ocr-app's roadmap when phase 1 of
  this plan ships.

### 10. The renderer: one layout engine, deterministic

`render/` gets a layout engine in three pure steps, all synchronous after the fonts are loaded:

1. **Bind**: template document plus render model gives a tree of concrete boxes with text
   (`model.ts` stays the single place that builds printed strings; it gains label keys and loses
   nothing).
2. **Measure and paginate**: font metrics from the embedded faces (as `wrapText` does today), the
   footer and headers measured first, then the body flowed into pages by the rules of decision 5.
   Output: a **layout map**: every block id with its page and its rectangle in points.
3. **Draw**: pdf-lib draws the boxes. Then footers with "Seite n von m".

Determinism stays by construction: no clock, no `Intl`, no random ids, a fixed producer string,
the document's `issued_at` as the metadata date, integer arithmetic for positions rounded to
1/100 pt before drawing (so a floating point difference cannot change the bytes). `RENDERER_ID`
becomes `books-pdf-lib-3`. The tests assert the same bytes twice in one process, across a fresh
process, and after editing the template that a document was issued with.

The layout map is returned next to the bytes (never stored, never in the PDF). It is what the
composer uses to draw selection outlines over the real PDF (decision 11).

The engine stays free of Node-only imports (no `node:fs` inside the layout code; the font bytes
are passed in), so moving the preview into the browser later stays possible if the latency
targets are missed (decision 12).

### 11. The composer interface

`/projects/books/templates/:id`, opened from the templates list. Three panels, as the email editor:

- **Left: blocks and outline.** The block palette (only blocks that are allowed in the selected
  region, required blocks greyed with "schon vorhanden") and an outline of the regions and their
  blocks, which is a sortable, keyboard-navigable tree. Required blocks show a lock badge: they
  move and restyle, but the delete action is absent with the reason as tooltip text.
- **Middle: the PDF canvas.** The preview PDF drawn page by page with pdf.js (Mozilla's PDF
  renderer, Apache licence, loaded only on this page) into canvases, with a transparent overlay
  per page that uses the layout map: hover outlines, click selects, drag in the overlay reorders
  within a region, column borders of the line table are draggable handles. Above the canvas: the
  preview subject (sample document or one of the company's real documents), a page indicator,
  zoom, and a status ("Vorschau aktuell", "wird aktualisiert", or the save gate's messages).
- **Right: inspector.** The selected block's properties as a form (zod schema driven, as the
  email editor's inspector), plus the template's page and theme settings when nothing is selected.
- **Undo and redo**: the template document is plain JSON held in the browser; every change goes
  through one history (Immer based, from `block-editor-react`), typing in one field coalesced within
  700 ms into one step, 100 steps. Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (and Ctrl+Y). Saving creates a
  version and does not clear the history.
- **Working copy**: unsaved changes persist in `localStorage` (wrapped in try/catch) keyed by
  template id and the `current_version_id` they started from; on load a working copy whose base
  version is no longer current is offered as "Änderungen von vorhin, auf Version 3 beruhend"
  with discard or apply-anyway, never silently applied (resume path of the stateful-flow standard).
- **Keyboard and accessibility**: every action reachable without a mouse. The outline is the
  accessible representation of the page (a `tree` with arrow-key navigation); Alt+Up and Alt+Down
  move the selected block (also the dnd-kit keyboard sensor); Delete removes optional blocks only;
  Escape clears the selection; focus moves to the inspector with Enter. The canvas overlay has
  labelled regions, preview updates and save errors are announced through an `aria-live` region,
  all controls have visible focus. The composer is checked against WCAG 2.2 AA with the `wcag`
  skill before the slice merges.

### 12. Preview: route, latency, refresh

- **Route**: `POST /api/books/templates/preview` with `{ document: TemplateDocumentV2,
  subject: { kind: 'sample', variant } | { kind: 'document', documentId } }`. It answers the PDF
  bytes and the layout map (multipart, or JSON with the PDF base64 encoded; decided at build by
  measurement). Behind the same Books guard (`editBooks`), never stored, `no-store`. A real
  document renders from its own data (an issued one from its snapshots, a draft from live data)
  **with the composer's template**, and every page carries "VORSCHAU, KEIN BELEG" so a preview of
  an issued invoice in a new layout can never pass for the original.
- **Refresh**: debounced 350 ms after the last change; a newer request aborts the older one
  (`AbortController`), and a response older than the current document state is dropped (each
  request carries a change counter). While waiting, the previous pages stay visible, dimmed.
- **Latency targets** (server time, measured in the tests on the continuous integration (CI)
  runner and logged in production): 95th percentile (p95) under 150 ms for a one-page document, under 400 ms for a five-page one; end to
  end in the browser (change to new pages drawn) p95 under 800 ms for one page. Fonts are parsed
  once per process (as now), the probe of decision 8 runs only on save. If the targets are missed
  in phase 2's measurement, the fallback is rendering in a Web Worker in the browser with the same
  engine (decision 10 keeps that possible), and the server stays the only renderer of record.

### 13. Languages (cheap part now, the rest when a client needs it)

Today every label is German in code. From phase 1, labels go through one dictionary keyed by
label id and locale, used by both `model.ts` and `completeness.ts` (the check still derives its
values from the frozen data, only the label strings are shared constants). That makes a second
language a dictionary plus date and number formats, not a refactor. An English invoice is legal
in Germany (section 14 UStG names no language; the tax office may ask for a translation under
section 87 AO, the fiscal code). Adding `en-GB` is phase 6, not now (decided 2026-10-22), built when a client needs it.

### 14. E-invoicing (XRechnung, ZUGFeRD)

- **The timeline** (Wachstumschancengesetz, the 2024 growth act, and the BMF, Federal Ministry of
  Finance, letters on it): since 1 January 2025 every German business must be able to **receive**
  e-invoices from other businesses. Until the end of 2026 a PDF may still be issued; in 2027 only
  businesses with prior-year turnover up to 800,000 EUR may still issue PDFs; from **1 January
  2028 every domestic business-to-business invoice must be an e-invoice** (structured data per
  EN 16931, the European e-invoice standard). Section 19 small businesses are **exempt from
  issuing** (they may keep sending PDFs) and invoices up to 250 EUR are exempt. So Whiz-Art Media
  (section 19) is not affected; any regular-taxed company using the Books needs it by 2028, or
  2027 above the turnover line.
- **What the composer means for it**: an e-invoice's legal content is the XML, not the picture.
  XRechnung is XML only; ZUGFeRD (profile EN 16931 or higher, the "MINIMUM" and "BASIC WL"
  profiles do not count) is a PDF/A-3 (archival PDF that may carry attachments) with the XML
  embedded. The XML is generated from the same frozen document data that the completeness check
  reads, never from the template, so **the block model neither blocks nor complicates it**. Two
  things this plan does to keep it easy: the layout engine keeps every font embedded and every
  colour in one colour space (both PDF/A requirements), and the PDF metadata path stays
  centralised so an XMP (the PDF's XML metadata) packet and an embedded file can be added
  deterministically. pdf-lib can attach files; PDF/A-3 conformance also needs an output intent
  (an embedded colour profile), which is a contained addition.
- E-invoicing is a separate plan (phase 7 placeholder), not part of this one.

### 15. Logos and where they are stored

No storage-brain client exists yet, so logos are stored like the documents of record: new table
`books_asset` in the tenant schema (`id`, `tenant_id`, `kind = 'logo'`, `content_type`,
`byte_size`, `sha256`, `width_px`, `height_px`, `content` BYTEA, `created_at`), append-only,
unique on `(tenant_id, sha256)`. The template document references a logo by `sha256`, the issue
snapshot carries it, so a re-render reads exactly the image that was issued. Moving to
storage-brain later is a copy and a column (the same note as `sales_document_file`).

Upload: PNG or JPEG only (what pdf-lib embeds; SVG is rasterised in the browser to PNG before
upload), at most 1 MB and 2000 px on the longer side, checked by magic bytes and by actually
decoding it server side (a file pdf-lib cannot embed is refused at upload, not at issue). The
`document_template.logo_file_id` column, never used, is dropped in `012`.

### 16. Permissions

Editing templates needs `editBooks` (workspace admin), the same as every Books write. Previewing
against a real document needs `viewBooks` on that document's company, which the guard already
enforces (another company's id is 404).

### 17. The EPC QR payment block ("GiroCode")

The owner's existing invoices carry a payment QR code with the line "Scannen Sie den QR-Code in
Ihrem Online-Banking, um schneller zu bezahlen". The composer offers it as the block `paymentQr`
(added on 2026-10-22, part of the owner's approval).

- **Format**: the European Payments Council's QR code for SEPA credit transfers (EPC069-12,
  version 002, the format German banking apps read as "GiroCode"). The payload is twelve lines
  separated by line feeds: `BCD`, `002`, `1` (UTF-8), `SCT`, the BIC (may be empty in version
  002), the beneficiary name (the sender's legal name, at most 70 characters), the IBAN, the
  amount as `EUR` plus the total with a dot and two decimals (for example `EUR1234.50`), an empty
  purpose code, an empty structured reference, the unstructured remittance text (at most 140
  characters), and an empty note. Error correction level M; the payload is at most 331 bytes.
- **Reference**: the document's payment reference when it has one, otherwise
  `Rechnung <number>`. So the bank transfer carries what the receipts app's payment matching looks
  for.
- **Printed only when it can be right**: on an issued invoice (never on a credit note, there is
  nothing to pay), when the sender snapshot has an IBAN, the currency is EUR and the total is
  between 0.01 and 999,999,999.99 EUR. Otherwise the block draws nothing and takes no space, so a
  template with the block stays valid for every document. A name longer than 70 characters is cut
  to 70 in the code only (the printed name is unchanged). The caption is editable; the size is
  fixed between 25 and 40 mm (below that, phone cameras struggle).
- **Drafts and previews**: a draft has no number yet, and a code someone scans and pays from a
  draft would carry the wrong reference. The draft preview therefore draws a grey placeholder of
  the same size with "QR-Code erscheint bei Ausstellung". The template preview against the sample
  document draws a real code from the fictional sample data (a test IBAN), so the layout is seen
  as it will print.
- **Deterministic**: the code is generated from the frozen snapshot data (sender snapshot, total,
  number), never from live settings, by a pure JavaScript QR encoder with the mask chosen by the
  standard's own scoring (deterministic), and drawn as vector squares with pdf-lib, not as an
  embedded image. Same document, same bytes.
- **Not legal content**: the completeness check does not require it, and the payment details
  printed as text stay where they are (the QR code is a convenience, the text is the record).

## Test strategy

The four paths of the stateful-flow standard (`knowledge-base/standards/stateful-flow-testing.md`),
for the two flows this plan adds.

**The composer (template editing):**

1. **Forward**: create from a preset, add a logo, move blocks, change widths, save; version 1
   exists, a new draft previews it, issuing freezes it (`TemplateSnapshotV2` with the version id),
   the stored PDF passes the completeness check.
2. **Backtrack and revise**: change a block, undo, redo; change the theme font and back; the
   preview request for the abandoned state is aborted and its late response is dropped (keyed to
   the change counter). Keeping the same value does not create a history step or a new request.
   A save attempt that the gate refuses leaves the working copy intact and names the field.
3. **Resume**: reload mid-edit; the working copy returns keyed to its base version. Another tab
   saves version 4 meanwhile; the stale working copy is offered, not applied. A working copy from
   before this feature (no base version key) is discarded.
4. **Re-entry**: open the template again after a save: a clean history, the current version, no
   working copy. Edit the template after a document was issued with it: the document's stored PDF
   and its re-render are byte-identical to before (the existing invariant, extended to v2).

**The Correct flow:**

1. **Forward**: Korrigieren, edit a line, issue: one credit note, the old invoice cancelled, the
   replacement issued with the next number, links in both directions, three stored PDFs all
   complete, events written, the mirror payload carries `replacesDocumentId`.
2. **Backtrack and revise**: change the customer on the replacement draft: allowed, and the
   credit note still goes to the old invoice's frozen recipient. Abandon the draft: nothing
   cancelled, a second Korrigieren reopens the same draft (unique index) instead of making another.
3. **Resume**: reload the replacement draft: banner and link intact. A failing completeness check
   on the replacement rolls back the cancellation too (test seam: the broken renderer of `store.ts`).
4. **Re-entry**: after the replacement is issued, Korrigieren on the replacement works the same
   way (a chain of three); Korrigieren on the cancelled invoice is refused. Racing: the old invoice
   is cancelled through the plain path while a replacement draft is open; issuing the draft is
   refused with `REPLACED_INVOICE_CANCELLED`.

**The EPC QR block** (unit): the exact payload for fixed inputs against the EPC069-12 field order
and the examples in the standard; amount formatting (0.01, 1234.5, the maximum); the reference
fallback from payment reference to `Rechnung <number>`; the 70- and 140-character limits; nothing
drawn for a credit note, without an IBAN, for a non-EUR currency (an imported CHF invoice's
re-render) and for a zero total; the draft placeholder; a round trip that rasterises the drawn
module matrix and decodes it with a QR decoder back to the exact payload; byte determinism with
the block present. **Renderer and gate** (unit, `pnpm test`): every block type in every allowed region; pagination
rules (keep-together, totals with tax note, table header repeat, a row taller than a page, the
following-page header); minimum widths against the largest amount in every font and size; contrast
and size rules; determinism (twice, fresh process, all three fonts); the probe set against every
preset; each required field removed by a hand-made invalid document is named by the gate; the
legacy v1 path still reproduces its stored bytes. **Schema parity**: one test runs a real saved
template through the real zod schema, the real engine and the real `missingFields`, no mocks.
**Integration** (`pnpm test:integration`, real Postgres): migration `012` converts existing
templates, versions are append-only, the Correct transaction, the preview route's guard.
**Interface** (Testing Library): the composer's keyboard paths, undo and redo, the live region.
**In the browser**: after the deploy, the composer is proven on app.lumitra.co through the
automation browser (create, edit, preview, save, issue a test document on a test company,
download and compare).

## Phases

Rough sizes are in focused agent days, including tests and review.

| Phase | What | Size |
|---|---|---|
| 1 | **Correct flow**: `replaces_document_id` (migration `011_books_replacement`), the replacement draft, issue-with-cancel in one transaction, links in the document view, mirror payload field, receipts roadmap line. Independent of the composer and the most useful thing right now. | 2 days |
| 2 | **Model and engine**: `TemplateDocumentV2` with zod schemas, the version table, migration of existing templates into the Klassisch preset, the label dictionary, the three-step layout engine with layout map, `legacyV1.ts`, `RENDERER_ID` 3, the structural rules and the probe-render save gate, three presets, the `paymentQr` block in the model and the renderer (decision 17). The existing templates form keeps working on top (edits only theme and texts) until phase 4. Preview route with latency measurement. | 6 days |
| 3 | **`@marlinjai/block-editor-react`**: history, inspector fields, sortable outline with keyboard, extracted from the email editor, the email editor switched to it, published. | 2 days |
| 4 | **Composer interface**: three panels, pdf.js canvas with overlay, drag and keyboard reordering, column handles, undo and redo, working copy, save with gate messages, version list ("Version 3 vom 21.10.2026, verwendet von 4 Dokumenten"), the `paymentQr` block in the palette and inspector (caption, size), WCAG pass. | 6 days |
| 5 | **Logos and fonts**: `books_asset`, upload with checks, the logo block, Noto Sans and Noto Serif, font-aware drawable check. | 2 days |
| 6 | **English documents** (not now, decided 2026-10-22; built when a client needs it): `en-GB` dictionary, date and number formats, locale on the template, the check per locale. | 3 days |
| 7 | **E-invoicing**: a separate plan in the first half of 2027 (ZUGFeRD EN 16931 and XRechnung output from the frozen data, PDF/A-3), its own ROADMAP.md line. | own plan |

Phases 1, 2 and 3 can run in parallel (different files, phase 3 in another repo); 4 needs 2 and 3;
5 needs 2.

## Decided on 2026-10-22 (the lead, on the owner's behalf)

1. **Korrigieren cancels when the replacement is issued** (option a): the credit note and the
   corrected invoice are issued together in one transaction, as decision 9 describes. Abandoning
   the replacement draft cancels nothing. The plain "Stornieren" stays.
2. **No English invoices now.** The model is language-ready from phase 2 (the label dictionary of
   decision 13); English (phase 6, about 3 days) is built when a client needs it.
3. **E-invoicing gets its own plan in the first half of 2027**, so every regular-taxed company
   using the Books can issue XRechnung or ZUGFeRD before the obligation of 1 January 2028. It is
   tracked as its own dated line on the root ROADMAP.md; phase 7 here is only the pointer.

## Approval (2026-10-22)

The owner approved this plan on 2026-10-22: **build all phases** (phases 1 to 5; English, phase 6, and e-invoicing,
phase 7, stay as decided above). Two further decisions came with the approval:

4. **The presets stay neutral.** The owner uploads his own logo once phase 5 (logos) exists; his
   logo is available, so nothing in this plan waits for it.
5. **An EPC QR payment block** (decision 17), as his existing invoices carry one: model and
   renderer in phase 2, the composer's palette and inspector in phase 4.

No questions remain open.

## Phase 1 build notes (2026-10-22): the Correct flow

Built on branch `feat/books-correct-flow`. Decided while building, say so if you disagree.

**What exists now.**

- Migration `011_books_replacement`: `sales_document.replaces_document_id` (composite foreign
  key, invoices only, never the document itself), a partial unique index (one replacement per
  invoice), a trigger that allows the link only to an issued, not cancelled invoice made in the
  editor (BK011, mapped to `NOT_CORRECTABLE`), and a deferred constraint trigger that refuses, at
  commit, a replacement that is issued while the invoice it replaces is not cancelled (BK013,
  mapped to `REPLACEMENT_INCOMPLETE`; BK012 belongs to phase 2's 012). The column is
  frozen after issue by 007's whole-row guard like every other column.
- `src/server/books/correct.ts` (`startCorrection`): locks the invoice, refuses anything but an
  issued, not cancelled editor invoice, returns an existing replacement (`existing: true`), and
  otherwise inserts the draft with the invoice's customer, template, net or gross mode, service
  date or period, payment terms, contract reference, intro, outro and copies of its lines, then
  recomputes every figure under today's tax profile.
- `src/server/books/cancel.ts`: the cancellation's steps moved into `cancelInvoiceIn`, which runs
  in the caller's transaction; `cancelInvoice` wraps it unchanged. `issue.ts` calls it for a
  replacement between the tax recomputation and its own number, with the reason "Ersetzt durch
  eine korrigierte Rechnung" and the replacement's id in the `cancelled` event. The routes' PDF
  hook runs for both documents, so the credit note and the replacement are each rendered, checked
  and stored inside the one transaction; any failure rolls all of it back.
- Lock order: the replacement draft, the old invoice, the credit note counter, the invoice
  counter. The credit note takes its number first.
- Every document view now carries `related` (`corrects`, `correctedBy`, `replaces`,
  `replacedBy`), read in one query, so the editor shows the chain and the receipts mirror's pull
  endpoint, when it is built, can serve `replacesDocumentId` from the same view.
- Routes: `POST /api/books/documents/:id/correct` (201 created, 200 existing, 409
  `not_correctable`), the issue answer gains `replaced: { invoiceId, creditNoteId }` and 409
  `replaced_invoice_cancelled`, and `PATCH /api/books/documents/:id` accepts
  `replacesDocumentId: null` (never a value) to turn a replacement into an ordinary invoice.
- The editor: "Correct…" next to "Cancel with a credit note…" on an issued editor invoice (it
  opens the new draft; nothing is cancelled by the click), "Open the correction draft" when one
  exists, a banner on the replacement draft that says what issuing does, the confirmation naming
  the invoice that is cancelled with it, "Make it an ordinary invoice" when the replaced invoice
  was cancelled in the meantime, a hint on imported invoices, and a "Linked documents" list.
- `scripts/commerce-codegen.ts` regenerates `db-types.ts` again (it had failed since 010 for
  lack of table docs and overrides for the upload-import tables).

**Decisions.**

1. **The editor's labels are English** ("Correct…"), because the whole editor is English; the
   documents themselves stay German.
2. **The replacement is recomputed under today's tax profile**, not copied figure for figure: it
   is a new document issued today, so a changed company tax status or customer VAT id applies.
   The credit note still offsets exactly what was invoiced (it copies the invoice, as before).
3. **No new event type**: the replacement's `draft_created` and `issued` events and the old
   invoice's `cancelled` event carry the ids. Detaching a replacement is a draft edit (version
   bump), like every other draft edit, which writes no event.
4. **A cancelled invoice cannot be corrected**, even when it was cancelled by its own
   replacement: correcting the corrected invoice means correcting the replacement (a chain works,
   tested).
5. **The optional printed line "Ersetzt Rechnung 62 vom 14.10.2026" moves to phase 2.** It is a
   label on the PDF, and phase 2 owns the label dictionary (`template/labels.ts`); phase 1 prints
   nothing new, so no second dictionary exists. Phase 2 adds the label and a per-document switch.

6. **A retried issue answers what the first one did**: an already issued replacement reports
   `replaced` (the old invoice and its credit note) on every later call too.
7. **The credit note counter stays locked through both PDF renders** of a replacement issue (the
   credit note's and the replacement's). A plain cancellation elsewhere in the same company waits
   that long (well under a second); no deadlock is possible with the lock order above.

**Review (2026-10-22).** A fresh review of the final diff found no serious defect; its findings
are fixed on the branch: the link guard also refuses an already cancelled invoice, the
commit-time check has its own code (BK013), the editor labels an open correction draft as such
and warns on the cancel form when one exists, a retry keeps `replaced`, "Correct" carries no
ellipsis (it opens no dialog) and disables the cancel button while it runs, the issue-date
message names both series, and the concurrency, retry and refused-Correct tests below were added.

**Tests.** `src/server/books/__tests__/books-correct.itest.ts` (the four paths on real Postgres
with the real PDF pipeline, the rollback when the last render fails, the race with a plain
cancellation sequential and in parallel, two Correct clicks at once, the replacement issued twice
at once and retried later, imports refused, and 011's database guarantees including the deferred
trigger), two route tests in `books-routes.itest.ts`, six interface tests in
`DocumentEditor.test.tsx`.

**Receipts side**: when this merges, a line goes on receipt-ocr-app's `ROADMAP.md` for moving a
payment already matched to a replaced invoice onto its replacement (the receipts app owns payment
matching, D6 there).

**Operator step**: deploy, which rolls `011_books_replacement` across every tenant schema at boot.
Nothing else is new (no secret, no variable).

## Phase 2 build notes (2026-10-22): the model, the engine and the preview

Built on branch `feat/books-template-engine`. Decided while building, say so if you disagree.

**What exists now.**

- `src/server/books/template/`: `schema.ts` (the template document version 2 in zod, strict
  objects, 17 block types, bounded), `labels.ts` (the de-DE dictionary; the render model and the
  completeness check both read it), `presets.ts` (Klassisch, Modern, Kompakt), `probes.ts` (the
  seven probe documents, fictional data, a production module because the gate runs on every
  save), `rules.ts` (the structural check) and `gate.ts` (structural check, drawable template
  text, then the probe render with the unchanged `missingFields`).
- `src/server/books/render/engine/`: the layout engine (bind, paginate, draw) returning the PDF
  and the layout map (every block's page and rectangle in points from the top left, the line
  table's column positions, the layout issues). `RENDERER_ID` is `books-pdf-lib-3`.
  `render/epcQr.ts` builds the EPC payload and the module matrix (`qrcode` 1.5.4, pinned exactly,
  byte mode, level M); the engine draws merged dark runs as vector rectangles.
- `render/legacyV1.ts`: the version 1 renderer, unchanged and frozen, with golden hashes in
  `legacyV1.test.ts`. A document whose template snapshot is version 1, or which has none, keeps
  it; the stored file records which renderer drew it.
- Migration `012_books_template_v2`: `document_template_version` (append-only, BK012),
  `document_template.current_version_id` (a deferred composite key to a version of the same
  template), `archived_at`, every existing template converted into its version 1 (a frozen copy
  of Klassisch with the row's accent colour and footer blocks as small print), the columns
  `accent_color`, `footer_blocks` and `logo_file_id` dropped, and
  `sales_document.print_replaces_reference` (below).
- Issue freezes `TemplateSnapshotV2` (the whole document, the version id, the name, `logo: null`);
  a document without a template freezes Klassisch with null ids. Draft previews render the
  current version with the engine.
- `POST /api/books/templates/preview`, and the templates routes on versions: POST from a
  `preset` or a whole `document`, PATCH with a `document` (and `baseVersionId`) or the phase 3
  form's `accentColor` and `footerBlocks`, DELETE archives. The phase 3 form keeps working; a
  refused save shows the gate's problems.
- `pnpm bench:preview`: the latency measurement below, reproducible.

**Decisions.**

1. **One font in phase 2.** The theme's font enum holds only `dejavu-sans`; Noto Sans and Noto
   Serif widen it in phase 5. A saved template naming a font that is not embedded would be a dead
   end.
2. **The logo block draws nothing and takes no space** until phase 5 brings `books_asset`, so a
   template with it stays valid.
3. **Removing a template archives it.** Versions are append-only and reference their template,
   so a template with versions (every template, from 012 on) cannot be deleted; archiving hides
   it from the list and the picker and frees its name (the unique name is a partial index over
   live templates). Only a template a draft uses is refused (`template_in_use`); issued
   documents carry their layout frozen.
4. **Saving the same layout again writes no version**, and an edit made on an older version is
   refused (`concurrent_edit`, 409) when the composer sends `baseVersionId`.
5. **Gate answers are codes with English messages** and the block id, region, field and probe
   they concern (`template_invalid`, 422). The composer of phase 4 words them for the user;
   the German example sentence in decision 8 is the composer's wording, not the API's.
6. **Column widths.** A width of 0 in the 100-unit grid means the column's computed minimum. The
   minimums: amount `-21.474.836,47 €`, unit price `21.474.836,47 €` (a unit price is never
   negative, `repository/lines.ts`), quantity `999.999,999` (the editor's bound), rate
   `99,99 %`, position `999`, each at least as wide as its header, plus a 6 pt gap. The
   description column keeps at least 100 pt. At 9.5 pt with every column shown that leaves the
   description about 110 pt on A4 with 20 mm margins; Kompakt (8.5 pt) leaves more.
7. **The address field holds only the return line and the address** (decision 5's "pinned"
   made structural): the left address zone allows `senderLine` and `recipient` only, the return
   line above the address, and the engine flags an address that would start below the field's
   remarks band (`ADDRESS_FIELD_OVERFLOW`). The body starts no higher than the address field's
   bottom edge (45 mm below its top, DIN 5008), so Klassisch's title sits about where DIN puts
   the subject line, slightly lower than the version 1 layout.
8. **The tax note stands directly after the totals** (a rule, `TAX_NOTE_NOT_AFTER_TOTALS`), so
   the two always share a page.
9. **The EPC payload ends with its last populated element.** The plan's "twelve lines" would end
   in a line feed; as far as we recall EPC069-12, a separator may not follow the last populated
   element, so trailing empty elements are left off. Not checked against the document itself.
   A malformed BIC is left out (version 002 allows an empty one); a name or reference full of
   multi-byte letters is shortened further until the payload fits 331 bytes (the remittance
   first); a malformed IBAN in the snapshot prints no code instead of failing the issue. The
   draft placeholder uses exactly the code's conditions.
10. **Bounds.**
    - **Templates:** at most 30 blocks per region and 20,000 characters of template text.
    - **Documents:** at most 200 pages.
    - **Starved layouts:** a footer or following-page header that leaves less than 300 pt of body
      stops the flow at two pages.
    - **Preview requests:** at most 256 KB.
    - **Why:** a client-sent document can neither burn CPU nor fill memory. The engine's review
      found a 2-minute preview before these existed.
11. **Layout issues refuse a document of record.** At issue, an engine layout with an issue (a
    block taller than a page, an address zone running under the footer, a payment code wider than
    its cell) is `render_incomplete` with `layout.<issue>.<block>` named, like a missing field.
    A gated template cannot produce one; this is the backstop for data the gate did not foresee.
12. **The preview answers JSON with the PDF in base64**: one answer carries the PDF and the layout
    map, and the measured answer is 33 KB for one page and 62 to 65 KB for five. The preview
    does not run the gate: an incomplete layout renders as it is, with its issues in the map.
13. **Phase 1's decision 5 is delivered here**: the label "Ersetzt Rechnung" is in the dictionary,
    `sales_document.print_replaces_reference` (only a replacement may set it, a CHECK; frozen at
    issue by the 007 guard) prints "Ersetzt Rechnung 62 vom 14.10.2026" under the title, and the
    editor's correction banner has the switch. Detaching a replacement clears it.
14. **A converted template keeps its accent colour as it was**, even one under 4.5:1 on white:
    the migration does not change a company's layout. The gate asks for a readable colour at the
    next save.

15. **Stored documents are read with a shape check only.** A version row or a frozen snapshot passed
    the strict schema when it was written; reading it with today's bounds would make an issued
    invoice unreadable the day a later phase tightens one (GoBD). Writes stay strict.
16. **The IBAN behind the payment code is checked with its mod-97 checksum**, so a mistyped IBAN
    prints no code (and the draft promises none).

17. **A correction whose invoice template was archived starts on the company's default template**
    (or the built-in Klassisch layout without one), not on the hidden template. No separate
    notice: the draft's PDF preview shows the layout before anything is issued.
18. **The engine checks a document's structure before drawing** (known block types, theme
    colours, layouts, finite margins and sizes) and fails naming the path, so a malformed stored
    document can never draw a wrong page; every written version passes the strict schema, form
    edits included.

**Review (2026-10-22).** Three fresh reviews: one of the engine before the wiring (three defects
and four risks, all fixed: decisions 7, 9 and 10 came from it), one of the final diff (no
defect; three risks and three nits, all fixed), and one of those fixes (two defects, one risk,
four nits; all fixed or decided: a re-runnable logo guard in 012, form edits through the strict
schema, decision 18, a 64-bit lock key, the byte order mark stripped from the preview body, the
IBAN length per SEPA country, and decision 17). The fixes from the final review:
- stored documents read leniently (decision 15);
- a draft can no longer land on an archived template: the template check takes a shared lock,
  and a correction whose invoice template was archived starts on the company default;
- the preview body is bounded as a stream, also without `Content-Length`;
- 012 refuses to drop `logo_file_id` while a row holds a value;
- the IBAN checksum (decision 16);
- two first templates created at once wait for each other on a per-company transaction lock, so
  exactly one becomes the default;
- CI now regenerates `db-types.ts` and fails on a difference, so the generated types cannot drift
  from the migrations again.

**Latency** (decision 12; `pnpm bench:preview`, the route's work from the render model to the
base64 answer, 10 warm-up and 200 measured runs per case, node 22.23 bookworm-slim, the
production image's runtime, `NODE_ENV=production`):

| Case | p50 / p95 (ms), hermes x86 EPYC 9354P, 2 CPUs | p50 / p95 (ms), Apple M4 Pro, Docker arm64, 4 CPUs |
|---|---|---|
| Klassisch, 1 page | 56 / 70 | 50 / 74 |
| Klassisch, 5 pages | 146 / 203 | 107 / 138 |
| Modern, 1 page | 58 / 74 | 49 / 68 |
| Modern, 5 pages | 136 / 188 | 108 / 137 |
| Kompakt, 1 page | 66 / 83 | 56 / 81 |
| Kompakt, 5 pages | 168 / 202 | 134 / 234 |

The server targets (p95 under 150 ms for one page, under 400 ms for five) hold with a margin of
about two on both machines; the first render in a fresh process takes about 170 ms (font
parsing). Not measured on the production ARM host itself (a benchmark does not belong on a
production box); its cores are slower than both, so the margin there is smaller. The route logs
each preview's render time and page count, so production shows the real numbers. The browser
end to end target (800 ms) is measured with the composer in phase 4. No Web Worker fallback is
needed.

**Tests.**

- **Template and gate (`templateGate.test.ts`):** every preset parses and passes the whole gate,
  which is the probe set against every preset. Every required block, legal item, legal column,
  size, contrast, width, order and layout problem is named.
- **Engine (`engine.test.ts`):**
  - every block type in every region it may stand in;
  - pagination: the header repeats, totals stay with the tax note wherever the page breaks, a row
    taller than a page breaks line by line, nothing is drawn under the footer;
  - the DIN positions, the widest values inside their columns, the stamps, the payment code and
    its placeholder;
  - the bounds and a latency guard (four times the targets);
  - determinism twice in one process and in a fresh process in another time zone.
- **Payment code (`epcQr.test.ts`):** the payload, the amount format and the limits, a decode
  round trip with `jsqr`, and when no code is printed.
- **Legacy (`legacyV1.test.ts`):** the version 1 renderer reproduces its golden bytes.
- **Fleet migration (`books-fleet.itest.ts`):** 012 converts existing templates (they then pass
  the gate), versions are append-only for every role, and the current version must be the
  template's own.
- **Routes (`books-routes.itest.ts`):**
  - versions, the gate's refusal, a stale edit, archiving;
  - a draft previewing the current version, a version 1 document still drawn by the version 1
    renderer, the frozen re-render;
  - the preview: sample, real document, stamp, nothing stored, bounds, another company's document,
    the guard.
- **Correction (`books-correct.itest.ts`):** the reference line.
- **Editor (`DocumentEditor.test.tsx`):** its switch.

**Operator step**: deploy, which rolls `012_books_template_v2` across every tenant schema at boot
and converts the existing templates. Nothing else is new (no secret, no variable).

## Phase 3 build notes (2026-10-23): the shared editor package

- `@marlinjai/block-editor-react` lives in the email-editor monorepo (`packages/block-editor-react`,
  its own release set `block-editor-v*`), extracted in email-editor #166 (merged 2026-10-23). It
  holds `SnapshotHistory` (React-free under `/history`, opt-in coalescing of quick edits to one
  field), `useUndoableState` (the same history for a plain JSON document with Immer recipes), the
  inspector's field primitives, and under `/outline` (the one entry that needs dnd-kit)
  `SortableOutline` with `planOutlineDrop`, keyboard sorting and `rowLabel` announcements. The
  React entries carry `"use client"`, so the Next.js App Router here can import them. No MJML,
  MobX or MobX-State-Tree dependency, so it serves MobX-State-Tree 6 there and 7 here. The API for
  phase 4 is in that package's README.
- The email editor runs on it in the same change (undo and redo, the Layers panel, the inspector
  fields), so there is one implementation and no copy.
- Publishing: 0.1.0 was published by hand on 2026-10-23 (npm only registers a trusted publisher
  on a package that exists); email-editor's `publish.yml` is registered as its trusted publisher
  the same day, and 0.1.1 (same code, email-editor #171) is the first version published through
  it, which validates the registration. Phase 4 adds the package as a dependency here.

## Phase 5 build notes (2026-10-23): logos and fonts

Built on branch `feat/books-logos-fonts`. Decided while building, say so if you disagree.

**What exists now.**

- Migration `013_books_assets`: `books_asset` in the tenant schema (`id`, `tenant_id`,
  `kind = 'logo'`, `content_type` PNG or JPEG, `byte_size`, `sha256`, `width_px`, `height_px`,
  `content` BYTEA, `created_by`, `created_at`), unique on `(tenant_id, sha256)`, append-only for
  every role (BK014 on UPDATE, DELETE and TRUNCATE, plus the house REVOKE re-applied through
  `APPEND_ONLY_TABLES`), with CHECKs mirroring the upload bounds (1 MB, 1 to 2000 px a side, a
  lowercase hex digest). Purely additive; it rolls across every tenant schema at boot like 011
  and 012.
- `render/logoImage.ts`, the upload checks, in order: the type (PNG or JPEG, named by the request
  and confirmed by the magic bytes); the size (1 MB); the pixel size read from the PNG header or
  the JPEG frame header BEFORE anything decodes the pixels (at most 2000 px on the longer side);
  what a PDF would draw differently from a browser (a rotation flag in the Exif metadata, a
  colour profile, gamma or primaries other than sRGB's, a CMYK JPEG without the Adobe marker);
  the full decode (every PNG chunk's checksum, the image data
  inflated to exactly the size its header promises, interlaced or not; the JPEG decoded by
  `jpeg-js` without tolerance for missing data, at most 64 scans, in a coding every PDF reader
  draws); then pdf-lib embeds it into a throwaway PDF and writes that PDF, which must stay
  under 2 MB.
- `repository/assets.ts`: `storeLogo` (uploads of one company run one at a time under a
  transaction lock: the same bytes again answer the stored row, a company holds at most 100
  logos), `readAsset`, and `templateAssets`, which every render path calls with the template it
  draws: the save gate's probe render, the template preview, the draft preview, the document of
  record at issue and its lazy re-render (inside the issue or cancel transaction, through its
  handle).
- `POST /api/books/assets` and `GET /api/books/assets/<sha256>` as the contract the composer
  (phase 4) builds against: raw body, `booksRoute('write')`, a bounded stream read
  (`http/boundedBody.ts`, now shared with the preview route), `201` new or `200` already stored
  with `{ sha256, contentType, byteSize, widthPx, heightPx }`; `413 asset_too_large`,
  `415 unsupported_asset_type`, `422 asset_invalid` (the message and `problem` say which:
  `undecodable`, `not_embeddable`, `too_many_pixels`). The download is `booksRoute('read')`,
  `private, max-age=31536000, immutable`, the hash as entity tag (ETag; a revalidation answers
  304 without reading the bytes), nosniff,
  same-origin only, `content-security-policy: default-src 'none'`; another company's, an unknown
  or a malformed hash answer `404 asset_not_found`. `src/lib/books/api.ts` has `uploadAsset`,
  `assetUrl`, `AssetView` and the messages, appended at the end.
- The engine draws the logo block: at `widthMm` with the image's own aspect ratio, aligned left,
  centre or right in its box, kept together, in every region a logo may stand in and inside
  `columns` cells. A logo wider than its box is `BLOCK_TOO_WIDE`; a logo naming an asset the
  caller did not pass draws nothing and is the layout issue `LOGO_ASSET_MISSING`.
  `render/engine/images.ts` prepares each image once per process (pdf-lib's own embedders into
  a scratch PDF, the compressed streams kept, bounded by count and by 64 MB, least recently used
  out, the key checked against the bytes' hash because the cache serves every company of the
  process) and copies the streams into every PDF: pdf-lib re-decoded and re-compressed a PNG on every render, 0.7 to
  1.6 s for a 2000 px logo; prepared, the page renders in about 50 ms, with the same bytes.
- Issue freezes `TemplateSnapshotV2.logo = { sha256 }` (or null), and the snapshot is the
  authority on re-render: a frozen layout is drawn with exactly that asset, read by hash from the
  append-only table, and logo blocks naming any other hash are drawn empty.
- Fonts: Noto Sans and Noto Serif 2.015, the static unhinted Regular and Bold faces, committed
  in `assets/fonts/` with the SIL Open Font License; `assets/fonts/README.md` records the release
  archives they came from and the SHA-256 of every file. `fonts.ts` pins each family's two files
  by their digest and refuses to load a file that differs. The family is a parameter everywhere:
  `fontFiles(family)`, `canDraw(cp, family)`, `undrawable(text, family)`, `fontMeasure(family)`
  in the gate (the column minimums depend on the glyph widths), `undrawableFields` and
  `previewSafe` in the template's family (DejaVu Sans for a version 1 layout, a required
  argument). The schema enum is exactly `['dejavu-sans', 'noto-sans', 'noto-serif']`.
- `next.config.ts` needed no change: `outputFileTracingIncludes` already names the folder as a
  glob (`./assets/fonts/**/*` for every Books route); the production build traces all six font
  files into every Books route.

**Decisions.**

1. **One template, one logo.** The snapshot has one `logo` field (decision 4's shape) and the
   block table calls it "the template's logo asset", so every logo block of a template names the
   same image (a structural rule, `LOGO_ASSETS_DIFFER`, with the block named); several blocks may
   show it at different widths (Modern top right, small in the following-page header). A logo
   block without an image beside one with an image is allowed and draws nothing.
2. **A missing logo is refused by name at both ends.** The gate checks the company's assets
   before the probe render (`LOGO_ASSET_MISSING` with the block and region, the contract's code).
   At issue, inside the issue transaction, the same check refuses with the error
   `LOGO_ASSET_MISSING` (422 `logo_asset_missing`, the block ids in `blockIds`), so nothing is
   issued and no number is taken. This adds a code to the contract at issue instead of the
   generic `render_incomplete`, because "a required field is missing" would send the user to the
   wrong place; the engine's layout issue stays as the backstop. A template preview of a hash the
   company does not have draws the page without it and shows the issue in the layout map; a
   draft preview leaves it out.
3. **The snapshot's `logo` decides what a re-render draws** (found in review). Before this
   change the schema already accepted a hash in a logo block while the engine drew nothing, so a
   template saved through the API with a hash froze `logo: null` and a layout naming the hash.
   Drawing from the layout would change such a document's bytes, or refuse its cancellation
   (the credit note copies the invoice's snapshot). So the frozen layout is drawn with only the
   snapshot's logo; a test proves such a document re-renders unchanged and can be cancelled.
4. **The magic bytes must match the declared type** (`415`), so a PNG sent as `image/jpeg` is
   refused rather than silently re-typed; `image/jpg` and `image/pjpeg`, which some systems
   send, are read as `image/jpeg`. An empty body is `422 asset_invalid` ("the file is empty").
5. **JPEGs are decoded by `jpeg-js` 0.4.4** (pinned exactly, BSD-3-Clause, no dependencies),
   added as a runtime dependency. pdf-lib only copies a JPEG into the PDF without decoding it, so
   without a decoder a damaged JPEG would pass the upload and print as garbage on an invoice.
   Only baseline, extended sequential and progressive Huffman JPEGs at 8 bits are accepted (what
   every PDF reader draws); lossless, hierarchical and arithmetic codings are refused as
   `not_embeddable` with the advice to save a baseline JPEG or a PNG. More than 64 scans are
   refused before decoding (a progressive JPEG has about ten; thousands would burn central
   processing unit (CPU) time). The
   tests encode their JPEGs with the same package at run time.
6. **Refused because the PDF would differ from the composer** (found in review): a JPEG or PNG
   whose Exif metadata says "rotate" (a browser turns it, pdf-lib does not); a colour profile
   that is not sRGB (Display P3 screenshots, Adobe RGB), or a PNG gamma or primaries that are
   not sRGB's without an sRGB chunk (a browser applies them, pdf-lib draws the plain numbers);
   and a CMYK JPEG without Adobe's colour marker (pdf-lib inverts every CMYK JPEG, which is
   right only for Adobe's). All are `not_embeddable` with the advice to save the image again.
   A profile counts as sRGB when its description names sRGB or IEC 61966 (the standard that
   defines it), in ASCII or UTF-16.
7. **At most 100 logos per company** (`409 asset_limit`, found in review): stored logos are
   append-only and never deleted, so the cap keeps one user with `editBooks` from filling the
   schema. A company uses one or two. This adds a code to the contract. An upload already stored
   or over the cap is answered before the decode, and both are asked again under the lock.
8. **A logo adds at most 2 MB to a PDF** (found in the second review): pdf-lib stores a PNG's
   pixels without PNG's row filters, so a 23 KB PNG of smooth gradients became a 12 MB image
   stream in every invoice. The trial PDF of the upload must stay under 2 MB
   (`not_embeddable`, with its size and the advice to save it smaller or as a JPEG).
9. **Issue refuses a layout naming two different logos** (found in the second review): a
   template saved before the one-logo rule could; the snapshot freezes one, so the other would
   vanish silently. It is refused like a layout that does not fit (`render_incomplete`,
   `layout.logo_assets_differ.<block>`); documents already issued keep drawing only their
   frozen logo (decision 3).
10. **The unhinted Noto builds**: hinting only steers screen rasterisation, which PDF readers do
   themselves; the unhinted files are half the size with the same outlines. Both families use
   the release's standard character set (the larger `full` build exists only for Noto Sans), so
   the two Noto families cover the same characters. The four files add 1.8 MB to the image (the
   plan estimated 1.2 MB).
11. **The families do not cover the same symbols**, and the drawable check is per family: DejaVu
   draws arrows and the infinity sign, Noto does not; Noto draws the bitcoin sign, DejaVu does
   not; no family draws Chinese, Japanese or Korean. A document set in Noto with an arrow in a
   line title is refused at issue (`undrawable_text`, the field named), exactly as DejaVu refuses
   Chinese today, and the save gate refuses template text its family cannot draw.
12. **A font file that is not its pin stops the process loudly** (every Books render and the
    gate fail with the file named) instead of drawing an issued document with other glyphs.
    Decision 6 made enforceable: a new font version is a new family id.

**Open, the owner's call:** whether a logo no template and no issued document uses may be
deleted. Today nothing is ever deleted (an issued document must re-render with its logo); an
image uploaded by mistake that shows a person stays stored, which the General Data Protection
Regulation (GDPR) right to erasure may require to change. Tracked on the ROADMAP.md line of
this plan.

**Review (2026-10-23).** A fresh review of the whole diff (given only the diff and this plan)
found one defect, four risks and twelve nits; all are fixed:
- the defect: a re-render read the logo from the frozen layout instead of the snapshot (decision
  3), with a test of such a document's re-render and cancellation;
- the risks: rotated images and CMYK JPEGs without the Adobe marker (decision 6); no bound on
  stored logos (decision 7; deletability is the open question above); the logo's decode cost on
  every render, now prepared once per process (`images.ts`, a latency test with a 2000 px RGBA
  logo) and progressive scans bounded;
- the nits: the byte order mark escape in `boundedBody.ts`, interlaced PNG tests, tests for the
  lazy re-render with a logo, a credit note's logo, an empty body and a palette PNG without its
  palette, `image/jpg`, an unreadable success answer in `uploadAsset`, the family argument made
  required in `undrawableFields`, messages for `asset_not_found`, the ETag and content security
  policy on the download, comment wrapping and acronyms.
A second fresh review of those fixes found no defect, five risks and fourteen nits; all are
fixed: the 2 MB budget inside the PDF and a byte bound on the prepared images (decision 8); the
prepared image's key checked against its bytes; a layout naming two logos refused at issue
(decision 9); colour profiles, gamma and primaries (decision 6); a failed preparation no longer
evicting a newer entry; the version 1 template read straight from the snapshot (no assertion
on a version 2 snapshot the preview never draws); a test that emptied logo blocks draw exactly
what the engine drew before assets existed; Exif orientation read only as a single SHORT value,
with little-endian, out-of-range and cut-off tests; the post-end-marker message; the cheap
checks before the decode and a test of the lock at 99 logos; messages built from the cap;
`If-None-Match: *` and revalidation without reading the bytes; the latency test named for its
90th percentile and run cold; comment wrapping and acronyms.

**Tests.**

- **Upload checks (`logoImage.test.ts`):** PNG (RGBA, RGB, interlaced at awkward sizes) and JPEG
  accepted with their size, exactly 2000 px accepted; the magic bytes against the declared type;
  more than 1 MB; more than 2000 px on either side, also a small file whose header claims
  30000 x 30000 (refused without inflating); truncated, damaged (checksum), not-deflate and
  size-mismatched PNGs; a palette PNG without its palette; truncated and garbled JPEGs; lossless
  and arithmetic JPEGs; rotation flags in JPEG and PNG; CMYK without the Adobe marker; scan
  markers in metadata accepted, more than 64 scans refused; an empty file; Exif in both byte
  orders and malformed; colour profiles, gamma and primaries in PNG and JPEG; a 23 KB PNG
  refused for the 12 MB it would add to every PDF.
- **Engine (`engineLogo.test.ts`):** every allowed region with each alignment (width, aspect,
  position, and the image drawn exactly where the layout map says), a tall JPEG, `columns` cells
  in four regions, a logo wider than its cell, one embedded image for several blocks on several
  pages, no asset, a missing asset, unrelated assets ignored, malformed stored blocks; a page
  with a 2000 px RGBA (red, green, blue, alpha) logo within four times the one-page target, run
  cold, the same bytes whether the image was prepared or found prepared; an asset whose bytes
  are not its hash refused; logo blocks emptied by the snapshot drawing exactly the bytes of
  blocks without an asset; determinism with a PNG and a JPEG logo in each family
  twice in one process and in a fresh process in another time zone (`engineChild.ts`).
- **Fonts (`fonts.test.ts`):** each family's pinned static faces, an unknown family, the
  drawable check and the preview's "?" per family, the gate in each family on every preset, the
  embedded font names, and the proof for documents issued under DejaVu Sans: the three presets
  as they stood on main before this change are frozen in `dejavuGolden.json` with the SHA-256 of
  their render against every probe document, recorded from the unchanged engine; the new code
  reproduces all 21 (the reviewer re-derived them from main independently).
- **Gate (`templateGate.test.ts`):** a company logo saves and is drawn in the probe render; a
  missing one names both blocks; two different images; a logo too tall for the letterhead.
- **Migration on real Postgres (`books-fleet.itest.ts`):** 013 onto a schema at 012 holding a
  template leaves it unchanged; commerce_app has the append-only rights; every CHECK; unique per
  company, the same hash for another company; UPDATE, DELETE and TRUNCATE refused for the app
  role (42501) and for the owner (BK014); a second run changes nothing. The provisioning tests
  list 013 and the table.
- **Routes on real Postgres (`books-assets.itest.ts`):** upload, dedup and a race of two
  uploads, every refusal, the bounded stream, `image/jpg`, an empty body, the cap and two
  uploads racing at 99 logos, the guard; the download, its headers, the 304 (also for `*`, and a
  404 for another company's), another company's, unknown and malformed hashes;
  templates with the company's, an unknown and another company's logo; the preview with and
  without the asset; the four stateful-flow paths of a document with a logo (forward: draft
  preview, issue freezing `logo: { sha256 }`, the image in the stored PDF; backtrack: logo and
  font of the template changed afterwards, the re-render byte-identical, a new draft taking the
  new logo; resume: the stored file served again; re-entry: an issue refused for a missing logo
  takes no number, the retry after the upload gets number 62); the lazy re-render reproducing
  the logo; a credit note carrying it; a document whose snapshot froze no logo drawn without one
  and cancelled; a layout naming two logos refused at issue; each family issued and re-rendered byte-identically; a DejaVu document
  re-rendering identically after its template moved to Noto Serif; an arrow refused at issue
  under Noto.

**Operator step**: deploy, which rolls `013_books_assets` across every tenant schema at boot.
Nothing else is new (no secret, no variable).

## Phase 4 build notes (2026-10-23): the composer

Built on branch `feat/books-template-composer`. Decided while building, say so if you disagree.

**What exists now.**

- `/projects/books/templates/<id>` (`src/app/projects/books/composer/`), opened with "Edit layout"
  from the templates list; a new template starts from Klassisch, Modern or Kompakt and opens there.
  Three panels:
  - **Left (`Outline.tsx`):** the palette lists the blocks the chosen region can take, the others
    folded under "Not available here" with the reason ("Already in the template", "Not allowed in
    the footer"); the document structure is `SortableOutline` from `@marlinjai/block-editor-react`
    with the regions as groups, pointer and keyboard sorting, lock badges on required blocks,
    a problem count per block.
  - **Middle (`PdfCanvas.tsx`):** the preview PDF drawn with pdf.js 4.10.38 (worker from the same
    bundle, loaded only on this page), an overlay from the layout map (hover, click to select,
    drag to reorder within a page, the line table's column borders as resize handles), the
    preview subject (the seven fictional samples or one of the company's 50 newest documents),
    zoom, "Page n of m", "Open the preview as PDF".
  - **Right (`Inspector.tsx`):** the selected block's fields from the schema's bounded scales,
    move up and down, remove (optional blocks only), the logo picker (`LogoPicker.tsx`); page and
    theme when nothing is selected; the saved versions with their issued documents.
- `doc.ts`: the document operations (add, move, remove, cells), on the gate's own rules.
  `workingCopy.ts`: the unsaved edits in `localStorage`. `usePreview.ts`: the refresh.
  `problems.ts`: the gate's codes in words.
- Server: `GET /api/books/templates/<id>/versions` (newest first, each with the issued documents
  frozen with it, one grouped query), and the preview answer carries `problems`, the gate's
  structural step, so the composer shows them while the user edits.
- The phase 3 form's partial edits (`accentColor`, `footerBlocks` on POST and PATCH) are removed
  from the repository, the routes and the client: the composer saves the layout as a whole
  document. (The phase 2 notes above describe the form as it was then.) The list keeps the accent
  colour as a read-only swatch.
- `@marlinjai/block-editor-react` ^0.1.0, the three `@dnd-kit` packages and `pdfjs-dist` are new
  dependencies; `globals.css` scans the package for its Tailwind classes.

**Decisions.**

1. **The composer is English**, like the rest of the editor (phase 1 decision 1); the documents
   stay German. Decision 8's German sentences become English ones in `problems.ts`.
2. **Live problems come from the server.** The structural rules need the embedded fonts' widths;
   rather than ship the fonts to the browser, every preview answer carries them (cheap: the
   measurer is built once per process). The probe render still runs only on save.
3. **Order rules are not enforced on moves.** Totals after the table, the tax note right after
   the totals and the return line above the address are shown live next to the block and refused
   by the gate on save; refusing the move itself would make reordering fiddly, since it often
   passes through such a state. Where a block may stand, the title once per region, and the
   required instance staying in its region ARE enforced on every move and addition.
4. **A document the schema refuses is never sent.** An emptied text (the one way the inspector
   can leave the schema) pauses the preview and the save with a message naming the block.
5. **The working copy restores what it can show.** A copy made on the current version comes back
   with a notice and as one undo step; one made on an older version is offered, and the panels
   and saving wait for "Apply them anyway" or "Discard them". A copy that fails the strict schema
   but is a template document (an edit that ended mid-retyping) is restored; only one that is not
   a template document is dropped.
6. **Screen readers hear the edits, not every refresh.** The preview is announced only when its
   page count changes or it fails; moves, removals, refusals and saves are announced; the visible
   status line is not a live region.
7. **Only the pages near the viewport are drawn**, at a pixel ratio of at most 2, with one PDF
   open at a time: a long real document cannot exhaust the browser's canvas memory.
8. **One logo per template in the picker.** An uploaded logo goes to every logo block (phase 5's
   `LOGO_ASSETS_DIFFER`), and a new logo block takes the template's image. SVG files are turned
   into PNG in the browser (the plan's decision 15).
9. **A logo nobody uses may be deleted** (the question the phase 5 notes left open). GoBD only
   protects what an issued document was printed with, and GDPR's right to erasure requires that
   an uploaded image can be removed. So: deletable when no issued document's snapshot and no live
   template's current version names it; never while either does. It is built in its own pull
   request (a list of the company's logos in the picker, a delete route, and a migration that
   lets exactly that delete through the append-only guard, with the issue path taking a share
   lock on the logo so a delete can never race an issue).
10. **The outline is a labelled list, not an ARIA tree.** The arrow keys move between blocks,
    Alt+Up and Alt+Down move the selected block, Enter opens its inspector, the drag handles
    carry dnd-kit's keyboard sorting. A tree role would promise tree semantics (expand, collapse,
    levels) the regions do not have.

**Accessibility (WCAG 2.2 AA, with the `wcag` skill before the pull request).** Every action has
a keyboard path and a single-pointer path (move buttons for SC 2.5.7); drag handles are 24 px
(SC 2.5.8); control borders and icons reach 3:1 (SC 1.4.11; the shared package's fields got the
same fix in `@marlinjai/block-editor-react` 0.1.2, email-editor #172); one polite live region; the
preview is also available as a PDF with its text (SC 1.1.1); a page title and heading; panels stack
on narrow screens (SC 1.4.10); focus has a place after every removal, refused move, reload and
choice; shortcuts listen on the window, so they keep working when focus falls back to the page.

**Latency** (decision 12's browser target, p95 under 800 ms from a change to new pages drawn):
measured in the automation browser against the real engine, 558 to 711 ms per refresh after an
edit for one to three pages on the Mac (the first preview of a session is slower, about 860 to
1180 ms, while pdf.js loads). On app.lumitra.co it is measured again in the browser proof.

**Review.** Two fresh reviews: the first found 7 defects, 11 risks and 9 nits (the title rule,
focus after a refused move, Enter on a row, Escape in the name, the working copy dropped
mid-edit, cells offering what their region refuses, the order comment, keys during a drag, the
offer racing edits, no-op moves as undo steps, canvas memory, the version count query, and more);
all fixed or decided above. The second checked those fixes and found two more defects (the Books
page calling a client module's function on the server, focus after a reload landing before the
offer existed) and a partial fix (the documents list retry); all fixed, with tests.

**Tests.** `composer/__tests__/`: `doc.test.ts` (operations against the gate's rules, the title
rule, no-op moves), `workingCopy.test.ts`, `usePreview.test.tsx` (debounce, abort, a late answer
dropped, failure, disabled), `TemplateComposer.test.tsx` (the four stateful-flow paths: forward,
backtrack and revise with a refused save, resume and the offer, re-entry after a save and after a
lost race; the keyboard paths, renaming, cells, the documents list, the logo picker);
`books-routes.itest.ts` (the version list with counts, tenant scoping and archived templates,
structural problems in the preview, the routes without the form's fields). Checked in the
automation browser with the development server and the production build (`node
.next/standalone/server.js`, the pdf.js worker served as JavaScript): select, edit, undo and redo,
add, Alt+Up, Enter, delete, drag in the canvas, column resize, save, resume, the offer, the lost
race, a refused save, three pages scrolled with "Page n of m".

**Operator step**: deploy. No migration, no secret, no variable.
