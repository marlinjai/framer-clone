---
type: plan
status: decided
date: 2026-11-05
title: "Company erasure consumer: auth-brain's tenant.erased deletes the company here"
summary: "POST /api/internal/erasure on the editor host receives auth-brain's signed tenant.erased webhook and deletes every row and file of the company: its sites with pages, revisions, images, domains and records, its CMS collections and agent runs, and its rows in every commerce and Books tenant schema, which are shared by the companies of a tenant group and are never dropped. Issued invoices, payments and the other immutable Books rows go too, through an owner-only bypass of their delete guards (tenant migration 029). Idempotent by event id, fails closed without its secret, and answers 5xx on any failure so auth-brain retries."
tags: [framer-clone, gdpr, erasure, auth-brain, books, commerce]
projects: [framer-clone, auth-brain]
---

# Company erasure consumer

## Why

auth-brain (the suite's login service) erases a company by POSTing a signed `tenant.erased` webhook to every
app that registers an erasure endpoint, and only marks the erasure complete when every app answers 2xx.
framer-clone (Lumitra Sites) had no endpoint, so a deleted company's sites, shop and invoices stayed forever.
auth-brain registers this endpoint only once it is deployed.

## The contract (auth-brain's, not ours)

`POST /api/internal/erasure`, body `{ event_id, kind, user_id, tenant_id?, workspace_ids?, requested_at }`,
header `x-lumitra-erasure-signature: sha256=<hex HMAC-SHA256 of the exact raw body>` with the shared secret
`SITES_ERASURE_WEBHOOK_SECRET`, header `x-lumitra-erasure-event-id`. Same scheme as the social-planner and
receipt-ocr consumers.

| Case | Answer |
| --- | --- |
| Secret not set | 503, nothing deleted |
| Missing or wrong signature | 401, nothing deleted |
| Malformed body, event id header not matching the body | 400 |
| Company delivery without `workspace_ids` | 503, resend with the complete list (including legacy workspaces) |
| `user.erased`, unknown kind | 200, no-op |
| Event already processed | 200, nothing deleted again |
| Company never served here | 200, no-op |
| Any failure while deleting | 500, event left unprocessed, auth-brain retries |
| Any host but the editor host | 404 |

## Decisions

1. **What belongs to the company.** In `public`: sites where `company_id` is the company OR the workspace is
   one auth-brain names (a site created before `company_id` existed has it NULL), with everything that
   cascades from a site (pages, revisions which are the published copies, images with their bytes, domains,
   experiments, report counts), plus `site_erasures`, `site_operation_audits`, `agent_runs` and the CMS
   tables (`dt_*`) of the company's workspaces. Never by `tenant_group_id`: a group holds several companies.
2. **The tenant schemas are shared, so rows are deleted, never the schema.** Every `tg_<hex32>` schema is
   visited (the payload has no group, and a Books-only company has rows without any site). Each table is
   classified in `ERASURE_COVERAGE` (src/server/erasure/commerce.ts): by company (`tenant_id` is the company
   on Books and catalogue tables), by group plus workspace or site (`form_submission`, where `tenant_id` is
   the GROUP), through a parent (credit notes and reservations through the company's orders, the stock
   ledger through the company's SKUs that no other company uses), or kept because it belongs to the group
   and holds no personal data (`stock_location`, `price_list`). A test fails on any table of a provisioned
   schema that is not classified.
3. **Immutability is overridden for an erasure, deliberately and narrowly.** Issued invoices, their lines,
   events and stored PDFs, the number counters, template versions, imported originals, payments and their
   provider events refuse deletes by trigger. Tenant migration 029 splits each such trigger so the DELETE
   half carries `WHEN (NOT company_erasure_allows(OLD.tenant_id))`, true only when the transaction-local
   setting `lumitra.erasing_company` names that company AND the current role is a member of the schema's
   owner. The app role setting the value gets nothing (tested). Keeping its invoices for the retention
   period is the company's own duty under its own records rules; once the company has asked to be deleted
   the platform does not keep its books. The company should export first (that is auth-brain's and the
   product's message, not this endpoint's).
4. **`user.erased` is a no-op.** framer-clone keeps no personal data per user: the only user ids are audit
   references inside a company (`site_erasures.erased_by`, `site_operation_audits.actor_id`), which go with
   the company and point at nothing once auth-brain removes the identity.
5. **Files.** Every file lives in Postgres: `site_images.content`, the published copies (`site_revisions`),
   Books logos (`books_asset`), invoice PDFs (`sales_document_file`), imported originals
   (`historical_import_item`) and catalogue images (`catalog_image`). Content-addressed files are stored
   once per company and SHA-256, so the same bytes of another company are a separate row and stay (tested).
   CMS file cells (`dt_files`) are references to an address, not stored bytes; the rows go.
6. **Caches.** The resolver cache (by tag, with its remembered misses), the expanded page trees in memory and
   the origin cache files on disk are purged, and again five seconds later. As with the owner's erase tool,
   only the container that ran the erasure is cleaned (deploy/README.md, "Erasing personal data: one
   container only").
7. **Order and retries.** A ledger row (`erasure_events`, keyed by event id) stores the scope the first
   attempt found (site ids, workspace ids, subdomains, hostnames) before anything is deleted. Then the public
   rows in committed batches with a 120-second transaction budget, then the caches, then the tenant schemas.
   Sites are locked before their domains are re-read; newly discovered hosts are persisted with the delete.
   Form writers hold a per-site transaction lock and re-check the public site before insertion. Commerce
   cleanup takes that same lock before its probe and form deletion, draining writers already in flight.
   Each schema is probed for company rows; only schemas with a hit get deletes. Deletes select at most 500
   primary rows per batch (their dependent rows are deleted with them), under the shared deploy lock, so retries keep completed
   work. Mutually referencing document/file and template/version pairs remain atomic; document references
   are removed from leaves toward parents. `processed_at` is set last, atomically clearing hostnames and
   subdomains from the ledger. Conditional writes under a ledger row lock prevent overlapping deliveries
   from restoring cleared values. Every step is idempotent.
8. **External services.** The Stripe `payment_account` row is deleted; Stripe is not called. The Lumitra
   Mail connection row is deleted; Lumitra Mail erases its own side from its own webhook.

## Rollout

1. Merge and deploy (the start step runs tenant migration 029 on every schema).
2. Set `SITES_ERASURE_WEBHOOK_SECRET` in Infisical (project framer-clone, `prod`) to the same value auth-brain
   holds for this endpoint.
3. Restart or redeploy the app so a new container starts with that secret. Setting Infisical alone does
   not update the running process; the endpoint keeps answering 503 until the new process has the secret.
4. Register `https://app.lumitra.co/api/internal/erasure` in auth-brain, sending the complete `workspace_ids`
   list on company erasures. Missing lists answer 503 so legacy sites cannot be silently skipped.
5. A missing secret or incomplete scope remains retryable; auth-brain keeps retrying and loses nothing.
