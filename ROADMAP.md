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
  in-memory tree that backs the editor) snapshot JSON, so the data format is the API. No code
  evidence of this shipping yet. See [plan](docs/plans/ai-driven-page-generation.md). (2026-10-14)
- [ ] Custom domains (Option B): let a site owner connect their own domain to a published site
  (domain-control validation, per-domain TLS, in-editor onboarding), on top of the default
  subdomain hosting that already shipped. Background work, still wanted, not started. See
  [plan](docs/plans/2026-06-25-framer-custom-domains.md). (2026-10-14)
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
- [ ] 2. Running again: production was retired on 2026-09-10 (the app had been down since 27
  July; app, database without backups and the app.lumitra.co record were removed, infra commit
  d15a07d). Redeploy as a new Coolify app and database declared in Terraform, this time with a
  backup schedule, then the cutover of the multi-tenancy plan's wave 5 (MT-19 to MT-23: wildcard
  DNS for the published sites, certificates, the Coolify host, the configuration switch). On the
  new database, drop the EMPTY legacy `commerce` schema that the historical Prisma migrations
  still create (no commerce data survived the retirement; why no migration drops it is in the
  commerce tenant plan's reality note of 2026-10-17).
  Recommended start without Cloudflare's paid certificate manager (about 10 dollars a month,
  global edge caching); Marlin decides that at this step. MT-01 to MT-17 are merged. See
  [multi-tenancy plan](docs/plans/2026-06-26-multi-tenancy-phase2-plan.md) and
  [gap analysis](docs/plans/2026-06-26-multi-tenancy-gap-analysis.md). App side ready
  2026-10-17: the container start runs the commerce public and tenant migrations as the owner
  role, `prisma/sql/commerce-roles.sql` is complete for a non-superuser owner on Postgres 16
  (proven by `roles.itest.ts`), and `deploy/README.md` matches the infra RUNBOOK
  (`infra/deployments/framer-clone/RUNBOOK.md`), whose steps 1, 7, 9 and 10 now simplify.
  (2026-10-17)
- [ ] 3. The Books: the Customer + SalesDocument + DocumentTemplate document tier for Marlin's own
  accounting (invoices and credit notes now, offers later; joins with receipt-ocr-app's expense
  side), in each company's own schema. Phase 1 is built (2026-10-17): migration `007_books` with
  the seven tables and the triggers that freeze an issued document for every database role,
  customers over the shared contacts database, gap-free numbering from a locked counter (invoices
  continue the plain series at 62), the German VAT rules shared with the order path, the
  repository API with idempotent issue and cancellation through a credit note, and the tests
  (four stateful-flow paths, concurrency, two companies in one schema, the real contacts
  package). Open: phase 2 (routes and the editor, with the `books` grant check) and phase 3
  (templates, PDF rendering), then running `pnpm books:init-company` for Whiz-Art Media. Settings
  from receipt-ocr-app's plan "Invoicing and income" of 2026-10-14: company Whiz-Art Media,
  small-business treatment by default (section 19 of the value-added tax act, section 34a
  invoice fields), `Customer` points to the shared contacts database for name and address.
  See [plan](docs/plans/2026-08-15-books-receipts-invoices-integration.md), section "Phase 1
  build specification" and its deviations in P1.12. (2026-10-17)
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
