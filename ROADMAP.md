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
  images.unsplash.com with credits in the canvas and on the published page); phase 4's style
  references and screenshot loop stay open. See [plan](docs/plans/ai-driven-page-generation.md).
  (2026-10-20)
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
- [ ] 8. A visual invoice template composer in the Books (asked by the owner on 2026-10-21): a
  block-based A4 composer like the email editor whose canvas is the real PDF, versioned templates,
  legally required blocks that move but cannot be removed, a save gate running the completeness
  check, logos in the tenant schema, and a Correct flow (credit note plus a prefilled replacement
  draft), plus an EPC QR payment block. Approved by the owner on 2026-10-22, phases 1 to 5
  to be built: 1 Korrigieren (migration 011), 2 model and engine (012), 3 the shared editor
  package, 4 the composer, 5 logos and fonts; English and e-invoicing later. Phases 1
  (Korrigieren, #125, migration 011) and 2 (model, engine, versions, the save gate, the preview
  route, #127, migration 012) are live since 2026-10-22: 012 applied to both company schemas,
  checked in the browser on app.lumitra.co (a template saved through the gate and archived
  again, a 3-page preview in 245 ms server time, imported invoices still served byte for byte;
  a pre-012 database dump is on the database host). Open: issuing a first editor invoice end to
  end on a test company (none exists; asked), then phases 3 to 5. See
  [plan](docs/plans/2026-10-21-books-visual-template-composer.md). (2026-10-22)
- [ ] 9. E-invoicing for Books documents (XRechnung and ZUGFeRD profile EN 16931, built from the
  frozen document data, ZUGFeRD as a PDF/A-3 with the XML embedded): write its own plan in the
  first half of 2027, so every regular-taxed company using the Books can issue e-invoices before
  the German business-to-business obligation of 1 January 2028 (section 19 small businesses such
  as Whiz-Art Media are exempt). Decided 2026-10-22; background in
  [plan](docs/plans/2026-10-21-books-visual-template-composer.md), decision 14. (2026-10-22)
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
