---
type: plan
status: draft
date: 2026-06-25
title: Framer-clone custom domains (B): connect a customer-owned domain to a published site
summary: The "Option B" upgrade over the demo's default subdomain hosting (Option A). Let a site owner connect their own domain (demo-custom-domain.com) to a published framer-clone site, with domain-control validation, automatic per-domain TLS, and an in-editor onboarding flow. The host-aware routing and the SiteDomain.customHostname model already exist; this plan wires resolution, certs, and UX on top. Background work, sequenced AFTER the hosted-demo (Option A) is live.
tags: [framer-clone, custom-domains, hosting, tls, dcv, multi-tenant, north-star]
projects: [framer-clone]
---

# Framer-clone custom domains (B)

The published-site demo ships on **Option A**: a lumitra-owned subdomain (`<site>.<base>.lumitra.co`),
one wildcard record + one wildcard cert, customer manages no DNS. This is exactly how Framer's default
`*.framer.app` hosting works. **Option B** is the upgrade Framer sells next to it: the site owner
connects their OWN domain (`demo-custom-domain.com`), like Framer's "Get Free Domain" / connect-domain
flow. This plan is B. It is explicitly background work, sequenced after the Option A demo is live, and
it does NOT block that demo.

## What already exists (the foundation that shipped 2026-06)

- **`SiteDomain` model** (P1): carries `subdomain` (unique), `customHostname` (unique),
  `verificationStatus`, `isPrimary`, scoped by `workspace_id` + `tenant_group_id`. The data shape for
  custom domains is already there; the resolver just does not use `customHostname` yet.
- **Host-aware routing** (PR #41): `src/middleware.ts` discriminates on `EDITOR_HOST`. Any host that is
  NOT the editor host is treated as a published site and its root `/` serves the storefront. This is
  apex-agnostic: it already works for a custom apex, no routing change needed for B.
- **SSR render layer** (PR #40): `resolvePublishedSite(host)` + `ServerComponentRenderer` + the public
  route. It resolves by `Host`; today only via `SiteDomain.subdomain`.
- **Multi-tenant data layer** (P1): every site row is workspace + tenant_group scoped. Custom domains
  ride this; they need NO new tenancy work (the tenancy boundary is the isolation, already shipped;
  custom domains are a hosting/UX layer on top).

## Scope (three parts)

### 1. Custom-hostname resolution

Extend `src/server/sites/publicResolver.ts` to match the FULL request Host against
`SiteDomain.customHostname`, in addition to the existing subdomain path. A custom apex
(`demo-custom-domain.com`, two labels) currently returns null in `parseSubdomain`; add a
custom-hostname lookup that:
- looks up `SiteDomain` by `customHostname == host` (exact, lowercased, port-stripped),
- serves the site ONLY when `verificationStatus = verified` AND the parent `Site.status = published`,
- otherwise returns null (404), exactly like the subdomain path.
Resolution order: try `customHostname` first (a custom domain is a full host), then fall back to the
subdomain parse. Keep it a pure, testable function.

### 2. Per-domain TLS + DNS

A custom domain needs a certificate for that exact hostname (the wildcard cert does not cover it). Two
paths, design the seam so either slots in:

- **(A) Coolify per-host Let's Encrypt (HTTP-01).** The customer points an A/CNAME at the Coolify
  server; Coolify issues a per-host cert on first request. Simplest on the existing Hetzner/Coolify
  stack; fine for low volume. The bottleneck is cert issuance latency on first hit and the A-record
  (not CNAME-flattening-friendly at an apex).
- **(B) Cloudflare for SaaS (custom hostnames API).** The real multi-tenant SaaS path (what Framer
  uses): register the custom hostname via the API, Cloudflare issues + renews an SNI cert per host,
  the customer adds one CNAME to a lumitra-owned fallback origin. Scales to many domains, handles apex
  via CNAME flattening. More setup + a Cloudflare for SaaS subscription.

RECOMMEND: start with (A) for the first few domains to prove the flow end to end, with the issuance +
resolution behind a seam so the move to (B) is a provider swap, not a rewrite.

### 3. In-editor onboarding (the "Connect domain" flow)

A flow in the editor: the user enters their domain, we create a `SiteDomain` row (`pending`), show the
exact DNS records to add, poll for verification, flip to `verified`, then trigger cert issuance.

- **Domain-control validation (DCV).** Before issuing a cert or serving the domain, prove the user
  controls it (so nobody can claim someone else's domain). A delegated CNAME-to-a-lumitra-owned-target
  check, or a TXT record check, or HTTP-01. This is the foundation plan's open question #2 (DCV method:
  HTTP vs delegated). Pick delegated CNAME for the friendliest UX where the provider allows it; TXT as
  the fallback.
- Surface the verification state + the cert state in the editor so the user sees "pending DNS",
  "verifying", "live". Errors surface loudly (a stuck verification is not a silent no-op).

## Related items folded in (this session, 2026-06-25)

- **Multi-site editor at `/projects/<id>`.** Mirror Framer (editor at `framer.com/projects/<id>`, sites
  at `<slug>.framer.app`). The editor loads WHICH site by id (`loadProject(scope, siteId)`), plus a
  site picker/dashboard and a "new site" flow. This is the multi-SITE editor UX on the ALREADY-SHIPPED
  multi-tenant data layer, NOT new tenancy work. It also needs the P1c piece that the single-site demo
  skipped: site -> workspace provisioning via the auth-brain machine surface on site creation. Natural
  pair with custom domains (both are "this is a real multi-site product now" features).
- **Auto-generated per-site subdomain slug.** Like Framer's `fuzzy-flows-876416.framer.app`: generate a
  unique default subdomain per site on first publish (the demo wires one chosen subdomain by hand). A
  small enhancement on the existing `SiteDomain.subdomain` field.

## Dependencies and sequencing

- Depends on the Option A demo being live (`framer-prod-provision`): the published-site host + the
  Coolify/Cloudflare TLS path must exist before a custom domain can attach to them.
- Background work after the demo. Not on the demo critical path.

## Out of scope (stays deferred)

- **End-user auth on custom domains (CIAM, the B2B2C North Star).** A central-domain session cookie is
  third-party on a customer domain (broken on Safari/Brave), so a site's OWN end-user accounts need
  per-customer-domain first-party sessions and a separate consumer identity store. That is a separate
  product decision (buy/embed: Zitadel/Ory/WorkOS/Stytch), never bolted into the shared auth-brain. See
  the foundation plan's North Star section.
- Wildcard custom domains (`*.customer.com`).
- Cloudflare for SaaS, until path (A) proves insufficient for volume.

## References

- `docs/plans/2026-06-23-framer-hosting-platform-foundation.md` (P1/P2 + the P3+ deferral incl. the DCV
  open question). This plan is the dedicated home for what that plan listed as deferred custom-domain
  onboarding.
- `knowledge-base/backlog/intents/analytics-abc-engine-and-framer-hosting-platform.md` (the HIGH global
  thread that frames subdomain-default + custom domains + multi-tenant edge hosting as the Framer
  business model). This plan is the framer-clone-side detail for the custom-domain half of it.
- Shipped foundation: PRs #37 (commerce read repo), #38 (content agent), #39 (publish write), #40 (SSR
  render layer), #41 (host-aware root routing), #36 (CI integration tests).
