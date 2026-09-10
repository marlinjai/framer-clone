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
  evidence of this shipping yet. See [plan](docs/plans/ai-driven-page-generation.md). (2026-09-10)
- [ ] Custom domains (Option B): let a site owner connect their own domain to a published site
  (domain-control validation, per-domain TLS, in-editor onboarding), on top of the default
  subdomain hosting that already shipped. Background work, still wanted, not started. See
  [plan](docs/plans/2026-06-25-framer-custom-domains.md). (2026-09-10)
- [ ] Multi-tenancy: finish the migration from the deployed single-tenant storefront slice to the
  full multi-tenant Framer model (authenticated multi-user editor at
  app.lumitra.co/projects/<id>, per-site subdomains on a wildcard). The data, scope and
  auth-scoping layers are already multi-tenant-correct; the gaps are routing surfaces, the editor
  shell, the publish-side subdomain allocator, an interim admin-secret removal, commerce tenancy
  (`src/server/commerce/tenant.ts` is still hardcoded to one shared schema), and wildcard
  DNS/TLS. See [gap analysis](docs/plans/2026-06-26-multi-tenancy-gap-analysis.md) and
  [implementation plan](docs/plans/2026-06-26-multi-tenancy-phase2-plan.md) (23 specs across 5
  waves; the last wave is a hands-on infra cutover that needs Marlin's DNS/TLS/Coolify hands).
  (2026-09-10)
- [ ] The Books: build the Customer + SalesDocument + DocumentTemplate schema and the invoices/
  offers document tier for Marlin's own accounting (joins with receipt-ocr-app's expense side).
  Roughly 85 percent of the new code lands in this repo. Decided 2026-08-15, not yet started. See
  [plan](docs/plans/2026-08-15-books-receipts-invoices-integration.md). (2026-09-10)
- [ ] Restart the framer-clone Coolify Postgres database to close the published port 5439 mapping
  left over from a one-off production seed; the database was re-privated (`is_public=false`)
  already but the port mapping persists until the next restart. Production/machine change, needs
  Marlin's hands. (2026-09-10)
- [ ] Commit or drop the two files untracked in the main checkout (not this worktree, which built
  from a clean origin/main): an undated commerce-tenant database migration plan draft dated
  2026-06-27, and a `build-2026-06-arbosano` specs directory. Left alone per this session's rule
  against touching the main checkout. (2026-09-10)

## Completed

See the individual plan files under `docs/plans/` and `docs/specs/` for status and evidence; this
roadmap only tracks open work, per the one-home-per-open-item rule
(`knowledge-base/standards/document-lifecycle.md` section 4).
