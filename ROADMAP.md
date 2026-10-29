# Roadmap

framer-clone is Lumitra's hosted website builder (a Framer-style visual editor plus hosting
platform; live demo at app.lumitra.co). Dormant since 2026-08-16 (no commits since); this file was
last reconciled 2026-09-10 by work-down session 9b of the one-home-per-open-item plan
(`knowledge-base/plans/2026-09-07-one-home-per-open-item.md`), which read every non-terminal plan
against the code on main and either marked it completed/archived with evidence or kept it here as
an open line. `docs/specs/build-2026-06/ROADMAP.md` is a separate, spec-era index for that one
build wave and stays outside this file's scope (`type: roadmap`, exempt from the plan-status rule).

## Open

- [ ] Builder UX gaps: typed property controls for components (a form per component instead of raw props), a navbar component with editable links, theme colours and fonts, and marketing section components (hero, features, pricing, testimonials). These are what stops a non-developer from building a real marketing site in the editor today. Needs a plan before building; the archived ArboSano builder plan of 2026-06-26 (under docs/specs, sections 1 to 3) has the model map and component inventory to start from. The typed-controls part is now designed as point 1 (code components) of the [external frontend research](docs/plans/2026-10-26-external-frontend-visual-editing-research.md). (2026-10-26)
- [ ] Visual editing of an existing Next.js frontend (the BusBasis storefront as the case): code components with typed property controls, headless delivery of page documents to the external app, a hosted canvas that runs that app's components in an iframe, and the company setup. Researched 2026-10-26, about 11 to 16 weeks; the Puck editor inside the storefront stays BusBasis's tool meanwhile. Waits on Marlin's call whether editing frontends framer-clone does not host is a product direction. See [research](docs/plans/2026-10-26-external-frontend-visual-editing-research.md). (2026-10-26)
- [ ] An immutable published copy of each page: today save and publish write the same `site_pages` rows, so after a cache miss (restart, deploy, second replica) visitors see the last save instead of the last publish. Publish should write a revision that the public site reads, which also gives history and restore. Found by the [external frontend research](docs/plans/2026-10-26-external-frontend-visual-editing-research.md), point 2. (2026-10-26)
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
  (done, recorded in the 2026-10-23 design quality plan linked from the plan below). Since
  2026-10-29 a generation (and the layout review) keeps running when the phone switches apps and
  is collected when the editor comes back, even after iOS reloaded the tab. Phase 4's style references
  and screenshot loop stay open. See [plan](docs/plans/ai-driven-page-generation.md). (2026-10-29)
- [x] Motion and effects: an Effects section in the properties panel (appear on scroll, restrained
  hover states, light scroll-linked transforms such as a small image parallax), stored per
  breakpoint like any style, undoable and generatable by the AI, rendered on published pages with
  CSS plus an IntersectionObserver or Motion (MIT). The canvas shows the final state with an effect
  badge and a play control, the preview plays everything. Follows the motion rules: entrances
  under 300ms, ease-out, nothing perpetual, off under prefers-reduced-motion. Plus an optional
  per-site Lenis (MIT) smooth-scroll toggle, off by default and off under reduced motion. Decided
  by Marlin on 2026-10-23; built 2026-10-24 (Effects section, canvas badge and Play, preview and
  published runtime, Lenis switch in Site settings, sparing appear effects in the generator). See
  [plan](docs/plans/2026-10-23-motion-effects.md). (2026-10-24)
- [x] The editor on phones: below 768px wide (or a phone held sideways) the canvas fills the screen
  between a compact top bar and a bottom bar, Pages and Layers and the properties panel open as
  bottom sheets, every top-bar action stays reachable through a More menu, dialogs and the preview
  fit 390px, components are added with a tap; and the canvas works by touch (two fingers pan and
  pinch-zoom on the canvas only, one finger taps, moves the selection, draws the selection
  rectangle and double-taps to edit text, finger-sized handles, no browser page zoom inside the
  editor, published sites keep it). Asked by Marlin on 2026-10-24 after the editor proved unusable
  at 390px; both parts built 2026-10-24. Then a floating glass quick toolbar next to the
  selection, a long-press menu with slide-to-select, peek and full detents for the properties
  sheet, and haptic ticks (2026-10-25). See [plan](docs/plans/2026-10-24-editor-on-phones.md). (2026-10-25)
- [ ] Scroll-driven page type (later): an opt-in page type for scrollytelling pages, the only place
  GSAP ScrollTrigger pinning and scrubbing is used, because there the scroll is the requested
  interaction (the sanctioned exception to the scroll-jacking rule, as the scroll-craft skill
  defines it). Not a general editor feature. Needs a plan. (2026-10-23)
- [x] Published site essentials, the rest of the owner's 19-point checklist of 2026-10-23. Built by
  2026-10-24 (plan sections "as built"): Site settings, lang, favicon set, Open Graph defaults, title
  template, robots.txt, sitemap.xml, canonical, noindex, JSON-LD, the designable 404 page, loading
  states, forms with a thank-you page, Impressum, privacy and terms templates, the publish warning
  for a missing Impressum, the first-party consent banner that loads analytics only after consent,
  and decision 7 of the generator: a primary call to action in the hero of every new marketing page
  and meaningful alt texts as repair findings (no silent "Image" fallback; an alt field with a
  Decorative switch and a warning in the Image section), plus the sticky mobile call to action
  component. Form notification emails stay open on their own line below. See
  [plan](docs/plans/2026-10-23-published-site-essentials.md). (2026-10-24)
- [ ] Form notification emails: forms (built 2026-10-24, see the site essentials plan, decision 4)
  store submissions per company and show them in the editor's inbox, but framer-clone has no mail
  path, so the owner is not emailed about a new submission. Wire Lumitra Mail (the suite's mail
  service) as the sender: a notification address per form defaulting to the site's contact email,
  sent after the submission is stored, a failure logged and shown in the inbox, never losing the
  submission. Also: when a company erasure routine is written, it must call
  `deleteWorkspaceSubmissions` (src/lib/forms) or drop the tenant schema. (2026-10-24)
- [ ] Animated components, a few chosen ones: React Bits was checked on 2026-10-23 and is MIT plus
  Commons Clause, which forbids redistributing its components "alone, in a bundle, or as a ported
  version", so a builder that offers them to its customers cannot ship them. Instead build the
  few worth having ourselves (a text reveal, a marquee, a logo loop) or take them from MIT sources
  (Magic UI, Motion), avoiding the vibe-coded tells in the round 2 plan
  (docs/plans/2026-10-23-ai-design-quality-round-2.md). (2026-10-23)
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
  `008_books_files`, download from the editor). The operator steps are done: the Books are live
  for Whiz-Art Media (app grant, contacts database, `008`, the company set up), checked
  2026-10-28 in the live editor: invoices 1 to 63 listed, counter at 64. Open: the first real
  invoice from the editor (Nr. 64) closes this line. See
  [plan](docs/plans/2026-08-15-books-receipts-invoices-integration.md), sections "Phase 1 build
  specification" and "Phase 2 and 3 build notes (2026-10-20)". (2026-10-28)
- [x] 3b. The invoice editor in the app's editor shell (PR #164, the glass redesign of the invoice
  editor and template composer): deployed (deploy run 40202044416) and proven live on the Books
  Testfirma company. Done 2026-10-25. See [plan](docs/plans/2026-10-25-books-invoice-editor-shell.md). (2026-10-26)
- [ ] 3c. One business platform: a company-level catalogue of products and services on the commerce
  engine (replacing the Books' own list), first proven on the owner's test jewellery shop (sample products,
  checkout through Stripe Connect in test mode, receipt in the Books), then instant booking for one
  practitioner (paid online, receipt in the Books), then quotes, then team dispatch; lumitra-booking's slot engine and calendar sync
  reused as packages. Architecture decided; the catalogue is being built in slices (2026-10-26: slice 1, the
  company column, migration `020_catalogue_company` and `sites.company_id`; open: the catalogue area, Books
  lines from the catalogue, the receipt from a paid order, Stripe Connect, the test shop, and rolling 020 out).
  See [plan](docs/plans/2026-10-25-business-platform-architecture.md) and
  [catalogue design](docs/plans/2026-10-25-catalogue-design.md). (2026-10-26)
- [ ] 3f. Prove Stripe Connect against Stripe in test mode: open the Stripe account (test mode), paste the
  test secret key, the webhook signing secret and the Connect client id into the three placeholders in
  Infisical (project framer-clone), register the webhook endpoint `/api/payments/stripe/webhook` for
  connected accounts, then connect the test shop and pay with a test card. Built against a fake Stripe on
  2026-10-26; see [catalogue design](docs/plans/2026-10-25-catalogue-design.md), "Decided while building
  slice 5". Progress 2026-10-26: the sandbox "Lumitra Sites" in the Lumitra Stripe account has Connect
  (Standard accounts, OAuth) and the webhook; the three keys are in Infisical prod and dev; the test shop's
  Stripe account finished onboarding and reads "Ready". Open: the test purchases. (2026-10-26)
- [x] 3g. Shop pages that link up: a Link component (its target checked as it is typed, or picked from the
  site's pages), and `{{product.href}}` in the binding picker inside a product list or detail, which links
  each product to the site's product page (`products/:handle`, `productPagePath` in `src/lib/pages/slug.ts`).
  Every bound link target passes `isSafeHref` (`src/lib/links/safeHref.ts`), so a CMS cell can never become
  a `javascript:` link; the canvas no longer navigates when a link is clicked, and the preview follows links
  to the site's fixed pages. The payments page says "test mode" while the platform runs on Stripe test keys,
  and the buyer's thank-you shows the order number and no longer promises an email. Found while building the
  test shop on 2026-10-26, built the same day. (2026-10-26)
- [ ] 3h. Shop buyers with the same name share one contact and one Books customer: the shared contacts
  database's identity is the name (and company or role), so two different buyers called "Anna Müller" (or one
  buyer who moved) are linked to the same contact. Each receipt is made out correctly since 2026-10-27 (the
  order's own buyer details are frozen on it), but the customer list mixes their invoices. Needs a decision on
  the shared contact model (email as part of a person's identity, or a contact per buyer), which spans every
  app on the contacts database. Found in the receipt email test on 2026-10-27. (2026-10-27)
- [x] 3e. Customer email from the shop: an order confirmation with a link to the receipt, and the notice when a
  late payment had to be refunded, sent from the shop company's own Lumitra Mail workspace (framer-clone is
  Lumitra Mail's trusted application `sites`, email-editor pull request 176; framer-clone pull request 185).
  Plan [shop receipt email](docs/plans/2026-10-27-shop-receipt-email.md) : completed. Proven on production
  2026-10-27: the test company connected its workspace (sending domain testshop.lumitra.co), order ORD-000005
  paid through Stripe, the confirmation arrived in the buyer's inbox and its link served receipt RE-4. (2026-10-27)
- [ ] 3d. Deletable invoice drafts: a draft (no number, not a bookkeeping record) can be deleted with its
  lines and events (hard delete, no tombstone, migration relaxing the 007 guards for drafts only);
  issued documents stay undeletable. Reverses decision 8 of the Books integration plan for drafts
  only. Built on the owner's order of 2026-10-26 (migration `019_books_draft_delete`, the DELETE
  route, "Delete draft" in the editor's More menu); a draft that was issued once (an offer taken
  back) keeps its spent number and is not deletable. Open: roll `019` out with the next deploy.
  See [plan](docs/plans/2026-10-25-business-platform-architecture.md). (2026-10-26)
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
- [x] 5. Importing past invoices by uploading PDFs in the Books: a company drops up to 50 invoice
  PDFs, Claude Sonnet 5.5 reads each one into the historical-import record, the user checks and
  corrects the rows in a review table beside the PDF, and confirmed rows import through the same
  core as `pnpm books:import` (original PDF as the document of record, counter raised upwards
  only). Built 2026-10-20 (migration `010_books_upload_import`). First real upload proven
  2026-10-28 for Whiz-Art Media: invoices 62 (BCB GmbH, 750 €) and 63 (Schönlau & Rudolph
  GbR, 387 €) read correctly, imported with "Import all ready", counter raised to 64, the
  original PDF downloadable from the document. Done 2026-10-28. See
  [plan](docs/plans/2026-10-20-books-upload-import.md), "Build notes".
- [x] 5b. The import page kept showing the old "Next invoice number" in its header after an
  import raised the counter (showed 62 after the 2026-10-28 import set it to 64). The header now
  moves with every raise the import reports, never down; covered by the single-row and the
  "Import all ready" tests. Done 2026-10-28.
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
- [x] 8b. Write the invoice on the invoice (asked by the owner on 2026-10-23, "a pixel perfect
  WYSIWYG editing experience closer to sevdesk but even more WYSIWYG"): the draft editor becomes the
  real A4 page in the company's template, every field edited in place over the PDF, add-line and
  line actions placed on the page, redrawn by the layout engine running in the browser; plus a
  subject line, a reference number, payment terms on the page, formatted intro and closing texts
  and a product and service list. Decided 2026-10-23 (the owner took every recommendation), in
  progress: phase 1 built (the engine draws drafts in a browser worker, byte-identical to the
  server, proven in headless Chrome); phase 2 (every editable field's rectangle and style, the
  add-line and row anchors in the layout map) built 2026-10-23; phase 3 (the editor on the page,
  line actions, product picker, undo, the issued invoice as its stored PDF) live and proven on
  Books Testfirma 2026-10-24 (TEST-4 written on the page and issued); the subject line (migration
  016, a template block, on the page and in the form) live and proven 2026-10-24 (TEST-5); formatted
  intro and closing texts (italic faces, migration 018, the engine, the formatting editor on the
  page) live and proven 2026-10-24 (TEST-6). Done 2026-10-24; the whole-invoice discount and the
  snippets are 8c and 8d. See
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
