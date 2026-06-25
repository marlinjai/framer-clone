---
type: plan
status: draft
date: 2026-06-23
title: Framer-Clone Hosting Platform Foundation (P1 Multi-Tenant Data Layer + P2 Publish Pipeline)
summary: Turn framer-clone from a single-user in-memory editor into a multi-tenant publishing platform, by becoming the 4th auth-brain consuming app (no own identity) and building the static publish pipeline that emits per-variant bundles. This is the substrate for end-user server-side no-flicker A/B/C (P3+ edge hosting). Near-term scope is Marlin's own sites on the shared lumitra auth-brain, architected so external-customer SaaS and a B2B2C "site owners offer auth to their end users" North Star stay open.
tags: [framer-clone, multi-tenant, auth-brain, consuming-app, publish-pipeline, workspace, hosting, b2b2c, north-star]
projects: [framer-clone, auth-brain, analytics-platform]
---

# Framer-Clone Hosting Platform Foundation

Foundation phases (P1 + P2) of the larger effort tracked in `analytics-platform/docs/superpowers/plans/2026-06-23-full-abc-testing-and-heatmaps.md`. The end goal is built-in, server-side, no-flicker A/B/C testing on framer-clone-published end-user sites, hosted on a subdomain by default + connectable custom domains. That A/B/C feature is the top of a stack; this plan builds the bottom two layers.

## Decisions locked (review 2026-06-23)

- **Sequencing:** Framer Platform Foundation first (this plan), before any edge A/B/C.
- **Tenancy scope (near-term):** Marlin's own sites, under the existing Lumitra `tenant_group`. Architect so external-customer SaaS stays open (no rewrite to add it later).
- **Auth-brain instance:** the shared `auth.lumitra.co`. framer-clone is consuming app #4 (after analytics, studio, receipt-ocr).
- **Identity:** framer-clone models NO identity. Thin resource server, per the auth-brain consuming-app contract.

## North Star (do not close this door)

framer-clone's site builders will eventually want to **offer authentication to their own end users** (e.g. a builder ships an ecommerce site whose shoppers need accounts). That is a B2B2C identity direction. It is exactly the path auth-brain's architecture already preserves:
- `tenant_group` is a hard isolation boundary from day one (every org-data table carries `tenant_group_id`, indexed).
- The login UI is domain-agnostic: session cookie domain, login URL, OAuth redirects, and email sender are config, not constants, so a deployment at `auth.<customersite>.com` needs only env changes.
- schema-per-org is the documented multi-org future.

**Consequence for this plan (corrected by the 2026-06-23 architecture red-team):** the DIRECTION is right but the end-user CIAM plane must NOT be bolted into the shared auth-brain. Workforce IAM (suite + site-owners) and consumer CIAM (shoppers) are different products and must stay separate deployments/data stores/failure domains. When end-user auth is actually demanded, default to BUY/embed (Zitadel or Ory for the data-ownership fit; WorkOS AuthKit / Stytch managed; or platform-as-OIDC-provider via WorkOS Connect / Stytch Connected Apps), with per-customer-domain first-party sessions (OAuth code+PKCE) and a pooled-shared-schema+RLS store (not schema-per-tenant) for the consumer plane. The custom-domain hosting infra is NOT a free auth domain: a central-domain cookie is third-party on a customer domain (broken on Safari/Brave).

What this plan must do is keep that choice OPEN, which the locked foundation decisions already achieve: because framer-clone delegates ALL identity to auth-brain and models none of its own, the future CIAM decision is unconstrained. P1 therefore: (a) keeps `tenant_group_id` on every domain table, (b) keeps the consumer plane entirely out of scope, (c) does NOT assume auth-brain will be the B2B2C provider. No P1/P2 work changes; only the North-Star assumption is corrected.

## The auth-brain consuming-app pattern (what we adopt, not build)

auth-brain (`auth.lumitra.co`, SDK `@marlinjai/auth-brain-sdk` 1.0) owns the full `tenant_group -> tenant -> workspace` hierarchy and authorization (OpenFGA). A consuming app:
- has no `users`/`memberships`/invitations tables, no org-switcher UI;
- carries a `workspace_id` FK on its domain resources;
- calls `verifySession(cookie)` once per request and `can(userId, role, { workspaceId })` at route boundaries (via `definePermissions` + `requirePermission`);
- the shared `lumitra_session` cookie on `.lumitra.co` gives editor SSO for free.

Provisioning is agent-first: the machine surface `/api/admin/machine/{orgs,tenants,workspaces,memberships,invitations}` (ADMIN_API_KEY, actor-by-email, no CSRF) creates workspaces programmatically through the secrets proxy. Scoped service-account keys exist for machine-to-machine.

## The dual-principal model

framer-clone has two principal types (the internal apps have only the first):
1. **Site owner** (your user, builds sites): an auth-brain user in a workspace. Editor login = `lumitra_session` + `can()`.
2. **Published-site visitor** (anonymous): bucketed for A/B by the edge layer (P3/P4), not an auth-brain user.
3. **(North Star) a site's own end users**: a future auth-brain end-user identity pool scoped to that site's `tenant_group`, on the site's custom domain. Out of scope for P1/P2; the data model must not preclude it.

## P1: Multi-tenant data layer (framer-clone as consuming app #4)

- **1a. Adopt the auth-brain SDK.** Add `@marlinjai/auth-brain-sdk` client init; a Next.js middleware/route guard that runs `verifySession` and redirects to `auth.lumitra.co/login?return_to=` when absent; `definePermissions` for framer's verbs (`editSite: workspace.admin`, `viewSite: workspace.viewer`, `publishSite: workspace.admin`). No NextAuth, no own users table. Env contract: `AUTH_BRAIN_URL`, `AUTH_BRAIN_ADMIN_KEY` (server, via Infisical/proxy), `OPENFGA_*`.
- **1b. Persist sites to Prisma (today they are in-memory MST).** New tables: `sites` (id, workspace_id, tenant_group_id, name, status), `site_pages` (the serialized ProjectModel/page snapshots), `site_domains` (subdomain + custom hostname state), `site_experiments` (experiment config refs). Every table carries `workspace_id` AND `tenant_group_id` (indexed) for the hard isolation boundary. The in-memory MST stays the editor working copy; Prisma is the source of truth, snapshot in/out.
- **1c. Site -> workspace provisioning.** On site creation, call the auth-brain machine surface to create a `workspace` (under the Lumitra `tenant` for now), grant the owner `admin`, store `workspace_id` + `tenant_group_id` on the site. Through the secrets proxy (agent-first). Architected so a site can later be promoted to its own `tenant_group` (B2B2C).
- **1d. Site -> analytics project provisioning.** On first publish-with-analytics, call analytics `POST /api/projects` (account key `ap_account_`, with `workspace_id` + site metadata) to create one analytics project + `ap_live_` ingestion key; store both in the `LumitraBindingModel`. One published site = one analytics project (events/experiments/heatmaps scoped per site). Depends on analytics WS-E so the whole flow is key-reachable.
- **1e. Route-level scoping.** Every editor/API route scopes queries to the caller's `workspace_id`; never return cross-workspace data. `can()` at each mutation boundary.

## P2: Static publish pipeline (per-variant)

Builds the Wave 2 spec (`docs/specs/wave-2/static-html-publish-pipeline.md`, currently unbuilt; only `hydrateBindings.ts` exists).

- **2a. Core emitter.** `projectPublisher.ts` + `assetCollector.ts` + per-page `staticHtmlEmitter.ts` (using `renderToStaticMarkup(HeadlessPageRenderer)`), emitting `<slug>/index.html` + flattened `style.css` + assets + `manifest.json`.
- **2b. Per-variant emit.** When a site has running experiments, emit one artifact set per variant combination, keyed for R2 upload as `{siteId}/_exp/{experimentKey}/{variant}/<page>/index.html` plus the control baseline `{siteId}/<page>/index.html`. This is the precompute permutation set the P3 edge layer rewrites to. Bound by ISR-style lazy build if combinations are large (log any cap, never silently truncate).
- **2c. Tracker snippet injection.** On publish, resolve `apiKeyRef` -> literal ingestion key server-side (never in the browser/build artifact as a secret beyond the public `ap_live_`), inject the tracker init + a `window.__AP_VARIANTS` hook so the published site tags events with the server-decided variant (the D3 cookie/bootstrap bridge consumed in P3).
- **2d. Upload + versioning.** Push the bundle to R2; write a per-site config blob (running experiments, variants, weights, `version`) destined for Workers KV in P3; bump `version` on each publish so derived edge caches invalidate atomically.

## Dependencies and what is deferred to P3+

This plan stops at "sites are persisted, multi-tenant, and publish to per-variant static bundles in R2." The following are explicitly the NEXT plan (P3-P5, in the analytics master plan):
- **P3 edge hosting:** Cloudflare for SaaS custom hostnames + SSL, the single Worker tenant router serving R2 by `Host`, Workers KV per-site config, subdomain-by-default wildcard zone, custom-domain onboarding.
- **P4 edge A/B/C:** the precompute rewrite + sticky cookie + cookie bridge in the Worker, reusing `analytics-core` `assign()` (proven by the spike).
- **P5 end-user authoring + results:** visual variant builder on `ComponentModel`, and surfacing per-variant results/heatmaps to the site owner (UI deferred; Marlin's idea: an overlay on the published-page preview with an experiment-evaluation toggle).

Independent and parallelizable on the analytics side (does not block P1/P2): the server-authoritative Next.js SDK (WS-A), dashboard variant-heatmap UI (WS-D), agent-first route closeout (WS-E, which P1d depends on), QA override (WS-F).

## Risks

- P1 is real work but de-risked by precedent: analytics + studio + receipt-ocr already did the consuming-app migration; reuse their pattern and scripts.
- framer-clone currently has zero deployment automation and an unbuilt publish pipeline; P2 is greenfield against a drafted spec.
- B2B2C North Star must stay a design constraint (tenant_group_id everywhere, identity fully delegated), not creep into P1 scope.
- Provisioning calls (auth-brain machine surface, analytics project API) must be idempotent and key-gated; depends on analytics WS-E closing the 6 session-only routes.

## Open questions for the P3+ scoping session

1. End-user results UI shape (the publish-preview overlay idea).
2. Custom-domain onboarding UX inside the editor (DCV method: HTTP vs delegated).
3. When/whether a site graduates from `workspace` to its own `tenant_group` (the B2B2C trigger).
