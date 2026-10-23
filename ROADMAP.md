# Roadmap

framer-clone is Lumitra's hosted website builder (a Framer-style visual editor plus hosting
platform; live demo at app.lumitra.co). Dormant since 2026-08-16 (no commits since); this file was
last reconciled 2026-09-10 by work-down session 9b of the one-home-per-open-item plan
(`knowledge-base/plans/2026-09-07-one-home-per-open-item.md`), which read every non-terminal plan
against the code on main and either marked it completed/archived with evidence or kept it here as
an open line. `docs/specs/build-2026-06/ROADMAP.md` is a separate, spec-era index for that one
build wave and stays outside this file's scope (`type: roadmap`, exempt from the plan-status rule).

## Open

- [ ] Builder UX gaps: typed property controls for components (a form per component instead of raw props), a navbar component with editable links, theme colours and fonts, and marketing section components (hero, features, pricing, testimonials). These are what stops a non-developer from building a real marketing site in the editor today. Needs a plan before building; the archived ArboSano builder plan of 2026-06-26 (under docs/specs, sections 1 to 3) has the model map and component inventory to start from. (2026-10-20)
- [ ] AI-driven page generation: let AI agents write pages directly as MST (MobX-State-Tree, the
  in-memory tree that backs the editor) snapshot JSON, so the data format is the API. Decided and
  in progress since 2026-10-19: phases 1 to 3 (registry-generated schema docs with validation, the
  guarded `/api/ai/generate-page` route, the editor's "Generate page" dialog with undo) shipped;
  real Unsplash stock photos instead of the placeholder and a Fast / Balanced / Best model slider
  (dialog and CMS agent) live since 2026-10-20 (#112, verified on app.lumitra.co: 4 photos from
  images.unsplash.com with credits in the canvas and on the published page). Since 2026-10-23 the
  prompt carries a design brief distilled from the design skills, containers can hold a stock
  photo behind text under a scrim, every stock photo is cropped around its subject (a Haiku vision
  pass), and the properties panel has an Image section for fit, focal point and photo backgrounds
  (done, recorded in the 2026-10-23 design quality plan linked from the plan below). Phase 4's style references
  and screenshot loop stay open. See [plan](docs/plans/ai-driven-page-generation.md). (2026-10-23)
- [x] Custom domains (Option B): a site owner connects their own domain to a published site
  (TXT ownership check, per-domain Let's Encrypt certificates through Traefik's file provider,
  a Domains panel in the editor; code in #103). Live since 2026-10-20: `domains.lumitra.co`
  (DNS only, IPv4 only) is the CNAME target, the `CUSTOM_DOMAIN_*` values are set, and the sync
  and re-check timers run on the shared server. Proven end to end with
  `fc-cd-test.marlinjai.com`: verified in the Domains panel, route written within a minute, Let's
  Encrypt certificate, `HTTP/2 200` with the site's page, `active` in the panel; then
  disconnected, its records deleted and the route gone again. The infra side is recorded in
  infra's deployments/framer-clone/RUNBOOK.md, phase 4. See
  [plan](docs/plans/2026-06-25-framer-custom-domains.md). Done 2026-10-20.
Build order decided by Marlin on 2026-10-15: finish the per-company schemas, get the app running
again, then the invoicing tier on top, then the import of the existing invoices and the
connections to the suite. The four lines below are in that order.

- [x] 1. Commerce per company (step MT-18 of the multi-tenancy plan, carried out as the commerce
  tenant plan): every company's shop data lives in its own `tg_<hex32>` Postgres schema on
  auth-brain tenant groups, every shop page and route reads only that schema and fails closed
  without one (CM-10, #92), the tenant isolation guards run in CI as `pnpm lint:guards`, and
  Prisma is out of the commerce module with its test coverage ported (CM-13), including a fix
  that keeps orders, credit notes and stock movements append-only for the app role. See
  [commerce tenant plan](docs/plans/2026-06-27-commerce-tenant-db-migration-plan.md). Done
  2026-10-17.
- [x] 2. Running again: live since 2026-10-19 (new Coolify app and database with daily backups,
  editor on app.lumitra.co, published sites on <label>.sites.lumitra.co with a DNS-01 wildcard
  certificate, hardened commerce roles, demo seeded, test order placed). The empty legacy
  `commerce` schema was dropped (0 rows, structure saved on the server), and a project was
  created, published and opened at its new address in the browser, then removed. The infra side
  is recorded in infra's deployments/framer-clone/RUNBOOK.md. Done 2026-10-19.
- [ ] 3. The Books: the Customer + SalesDocument + DocumentTemplate document tier for Marlin's own
  accounting (invoices and credit notes now, offers later; joins with receipt-ocr-app's expense
  side), in each company's own schema. Built: phase 1 (2026-10-17, the document domain, migration
  `007_books`), phase 2 (2026-10-20, the `/api/books` routes behind the active company, the
  auth-brain app grant `books` and the workspace admin role, and the Books area in the editor:
  customers, documents, the document editor with issue on confirmation) and phase 3 (2026-10-20,
  templates, the PDF rendered with pdf-lib from the frozen snapshots, checked for the section 34a
  UStDV and section 14 (4) UStG fields and stored once in `sales_document_file`, migration
  `008_books_files`, download from the editor). Open, all operator steps: register the app
  `books` in auth-brain and grant it to Whiz-Art Media and Lumitra, set
  `CONTACTS_DATABASE_URL` in framer-clone's Infisical project (copied from the receipts project
  with `copy_secret`), roll `008` out with the deploy, and run `pnpm books:init-company` for
  Whiz-Art Media. Then the first real invoice from the editor closes this line. See
  [plan](docs/plans/2026-08-15-books-receipts-invoices-integration.md), sections "Phase 1 build
  specification" and "Phase 2 and 3 build notes (2026-10-20)". (2026-10-20)
- [ ] 4. Existing invoices and the suite. The historical import is DONE: invoices 1 to 61 (the
  full series) were imported live on 2026-10-20 at 15:08 with `pnpm books:import` for Whiz-Art
  Media, 61 imported and 0 errors, the printed yearly totals matching the filed returns 2019 to
  2025, the invoice counter still at 62; checked in the live editor (61 documents numbered 1 to
  61, the PDFs of invoices 1, 23 and 60 byte-identical to the originals). Imports keep their
  printed currency (invoice 23 is in CHF, never converted). Open, the connections: the read-only
  endpoint receipt-ocr-app pulls issued invoices from (carrying each document's
  `currency_code`; service-account key from auth-brain; the receipts session gets the contract
  when it exists), storage-brain for the PDFs, the shared contacts database for recipients in
  production. Then the receipts app's register rows map to the mirror by invoice number. See the
  Books plan's amendment of 2026-10-15 and "Historical import build notes (2026-10-20)".
  (2026-10-20)
- [ ] 5. Importing past invoices by uploading PDFs in the Books: a company drops up to 50 invoice
  PDFs, Claude Sonnet 5.5 reads each one into the historical-import record, the user checks and
  corrects the rows in a review table beside the PDF, and confirmed rows import through the same
  core as `pnpm books:import` (original PDF as the document of record, counter raised upwards
  only). Built 2026-10-20 on `feat/books-upload-import`: migration `010_books_upload_import`
  (staging rows, an extraction ledger for the daily ceiling, printed numbers outside the
  company format, VAT discount lines), small-business, regular VAT and reverse-charge invoices,
  the review table beside the PDF. Open, the operator steps: deploy (rolls 010 out), optionally
  set `AI_INVOICE_EXTRACT_MODEL` and `BOOKS_IMPORT_DAILY_LIMIT`, and prove the first real upload
  in the editor. See [plan](docs/plans/2026-10-20-books-upload-import.md), "Build notes".
  (2026-10-20)
- [ ] 6. Domestic reverse charge (section 13b UStG) for Books documents and the import, when a
  company needs it. Not supported now (lead's decision of 2026-10-20): the Books cannot issue such
  documents, so the import refuses them too (`reverse_charge_domestic`, the row says to keep the
  invoice outside the Books); Whiz-Art Media is never affected (section 13b does not apply to a
  small-business supplier). See [plan](docs/plans/2026-10-20-books-upload-import.md), Build notes
  item 15. (2026-10-20)
- [ ] 7. Production on Node 24 before Node 22 leaves support (2027-04-30): the Dockerfile's
  NODE_IMAGE, `.nvmrc`, package.json engines and `@types/node` move together, as in the move to
  Node 22 of 2026-10-20 (pinned by digest, Dependabot proposes patch and minor releases but never a
  new major). (2026-10-20)
- [x] 8. A visual invoice template composer in the Books (asked by the owner on 2026-10-21): a
  block-based A4 composer like the email editor whose canvas is the real PDF, versioned templates,
  legally required blocks that move but cannot be removed, a save gate running the completeness
  check, logos in the tenant schema, and a Correct flow (credit note plus a prefilled replacement
  draft), plus an EPC QR payment block. Approved by the owner on 2026-10-22; phases 1 to 5 are
  live and proven, English documents and e-invoicing are later work on their own lines below.
  Phases 1 (Korrigieren, #125, migration 011) and 2 (model, engine, versions, the save gate, the
  preview route, #127, migration 012) are live since 2026-10-22, proven on app.lumitra.co on the
  test company "Books Testfirma" (auth-brain organisation marlinjai, apps `sites` and `books`,
  fictional sender, regular taxation, number series `TEST-{n}`, `TEST-GS-{n}`, `TEST-ANG-{n}`;
  for proving Books changes without touching a real number series): invoice TEST-1 with the EPC
  QR code, its PDF byte-identical after a later template edit. Phase 3 (the shared editor
  package `@marlinjai/block-editor-react`, email-editor #166, 0.1.0 on npm) is done since
  2026-10-23. Phases 4 (the composer, #135) and 5 (logos and Noto fonts, #134, migration 013) are
  deployed and proven on app.lumitra.co on 2026-10-23: a template created from Modern in the
  composer, a logo uploaded, a QR block added, a block moved by keyboard, saved through the gate;
  invoice TEST-2 issued with it (the stored PDF shows the logo, the QR code and every legal field,
  and stayed byte-identical after a later template edit to version 4; the version list counts it
  against version 3); a composer refresh after an edit takes 705 to 892 ms end to end on
  production. The proof found Noto printing blank letters (pdf-lib subsetting), fixed in #136
  (Noto embedded whole, a glyph-outline test) and deployed; TEST-3 issued in Noto Serif renders
  correctly. The last piece, deleting a logo nobody uses (phase 4 decision 9: never while an
  issued document or a live template's current version names it), was built in #137 (migration
  014, BK015, the logo list and delete routes, "Your logos" in the composer's logo picker), and
  the plan was completed with it. See
  [plan](docs/plans/2026-10-21-books-visual-template-composer.md). (2026-10-23)
- [x] 8a. Prove the logo deletion on app.lumitra.co after the deploy that rolls migration
  `014_books_asset_delete`: proven on 2026-10-23 on "Books Testfirma". A spare logo deleted with
  "Delete" in the composer's "Your logos" (the confirmation says it cannot be undone) is gone from
  the list and the server; the logo printed on TEST-2 shows "In use" with no delete, its DELETE
  answers 409 `asset_in_use`, and TEST-2's stored PDF is unchanged (sha256 698c6ba9...). The proof
  found a deleted logo still showing from the browser cache (served `immutable` for a year): now
  `private, no-cache`, revalidated by its ETag. (2026-10-23)
- [ ] 8b. Write the invoice on the invoice (asked by the owner on 2026-10-23, "a pixel perfect
  WYSIWYG editing experience closer to sevdesk but even more WYSIWYG"): the draft editor becomes the
  real A4 page in the company's template, every field edited in place over the PDF, add-line and
  line actions placed on the page, redrawn by the layout engine running in the browser; plus a
  subject line, a reference number, payment terms on the page, formatted intro and closing texts
  and a product and service list. Decided 2026-10-23 (the owner took every recommendation), in
  progress: phase 1 built (the engine draws drafts in a browser worker, byte-identical to the
  server, proven in headless Chrome); phase 2 (every editable field's rectangle and style, the
  add-line and row anchors in the layout map) built 2026-10-23; phase 3 (the editor on the page,
  line actions, product picker, undo, the issued invoice as its stored PDF) live and proven on
  Books Testfirma 2026-10-24 (TEST-4 written on the page and issued). Left: phase 4's subject line
  and formatted intro and closing texts. See
  [plan](docs/plans/2026-10-23-books-wysiwyg-invoice-editor.md). (2026-10-23)
- [ ] 8c. A discount on the whole invoice ("Gesamtrabatt", as sevdesk), split across the tax rates
  in proportion and printed so the tax per rate stays right (section 14 UStG): needs its own small
  plan touching the tax engine, the totals block and the completeness check. Decided 2026-10-23 as
  later work, after the in-place editor. (2026-10-23)
- [ ] 8d. Text snippets and placeholders for intro and closing texts (sevdesk's "Textvorlage" and
  "Platzhalter", for example the customer's name), with placeholders resolved to frozen data at
  issue: after the in-place editor is in daily use. Decided 2026-10-23 as later work. (2026-10-23)
- [ ] 9. E-invoicing for Books documents (XRechnung and ZUGFeRD profile EN 16931, built from the
  frozen document data, ZUGFeRD as a PDF/A-3 with the XML embedded): write its own plan in the
  first half of 2027, so every regular-taxed company using the Books can issue e-invoices before
  the German business-to-business obligation of 1 January 2028 (section 19 small businesses such
  as Whiz-Art Media are exempt). Decided 2026-10-22 as phase 7 of the completed visual template
  composer plan of 2026-10-21 (in docs/plans, decision 14 has the background; the roadmap check
  refuses an open line naming a completed plan's path). (2026-10-23)
- [ ] 10. English documents in the Books (phase 6 of the completed visual template composer plan,
  "not now", decided 2026-10-22): an `en-GB` label dictionary, date and number formats, the locale
  on the template and the completeness check per locale. Built when a client needs an English
  invoice; about 3 agent days. (2026-10-23)
- [x] The framer-clone Coolify Postgres database with the published port 5439: checked on
  2026-10-15, there is no framer-clone database or app in Coolify any more and port 5439 is closed
  on both servers, so nothing is left to restart. Done 2026-10-15.
- [ ] Re-evaluate the untracked `docs/specs/build-2026-06-arbosano/` in the main checkout: a draft
  plan of 2026-06-26 to mature the builder UX with the ArboSano site as the forcing spec. ArboSano
  has since been built on WordPress, so the forcing spec is gone; the builder-UX gaps it lists
  (typed property controls, navbar, theme) are still real. Marlin's call: re-scope, keep as
  reference, or drop. The commerce tenant plan that sat next to it is committed. (2026-10-15)

## Completed

See the individual plan files under `docs/plans/` and `docs/specs/` for status and evidence; this
roadmap only tracks open work, per the one-home-per-open-item rule
(`knowledge-base/standards/document-lifecycle.md` section 4).
