---
type: plan
status: decided
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
- **Guards**: only one open replacement draft per invoice (partial unique index on
  `replaces_document_id` where status is draft); a replacement draft of an invoice that meanwhile
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
