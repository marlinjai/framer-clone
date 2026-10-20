# Roadmap

framer-clone is Lumitra's hosted website builder (a Framer-style visual editor plus hosting
platform; live demo at app.lumitra.co). Dormant since 2026-08-16 (no commits since); this file was
last reconciled 2026-09-10 by work-down session 9b of the one-home-per-open-item plan
(`knowledge-base/plans/2026-09-07-one-home-per-open-item.md`), which read every non-terminal plan
against the code on main and either marked it completed/archived with evidence or kept it here as
an open line. `docs/specs/build-2026-06/ROADMAP.md` is a separate, spec-era index for that one
build wave and stays outside this file's scope (`type: roadmap`, exempt from the plan-status rule).

## Open

- [ ] AI-driven page generation: let AI agents write pages directly as MST (MobX-State-Tree, the
  in-memory tree that backs the editor) snapshot JSON, so the data format is the API. Decided and
  in progress since 2026-10-19: phases 1 to 3 (registry-generated schema docs with validation, the
  guarded `/api/ai/generate-page` route, the editor's "Generate page" dialog with undo) are being
  built on `feat/ai-page-generation`; phase 4's style references and screenshot loop stay open.
  See [plan](docs/plans/ai-driven-page-generation.md). (2026-10-19)
- [ ] Custom domains (Option B): let a site owner connect their own domain to a published site
  (TXT ownership check, per-domain Let's Encrypt certificates through Traefik's file provider,
  a Domains panel in the editor). Decided 2026-10-19 and built on branch `feat/custom-domains`;
  goes live once the infra steps in the plan's reality section are applied on the shared server
  (DNS-only target record, Infisical values, the sync timer) and one real domain is proven end to
  end. See [plan](docs/plans/2026-06-25-framer-custom-domains.md). (2026-10-20)
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
- [ ] 4. Existing invoices and the suite: import invoices 28 to 61 as historical documents
  with their original PDFs attached (never re-rendered), then connect: the read-only endpoint
  receipt-ocr-app pulls issued invoices from (service-account key from auth-brain; the receipts
  session gets the contract when it exists), storage-brain for the PDFs, the shared contacts
  database for recipients. After the import the receipts app's register rows map to the mirror
  by invoice number. See the Books plan's amendment of 2026-10-15. (2026-10-15)
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
