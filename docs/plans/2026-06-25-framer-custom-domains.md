---
type: plan
status: completed
date: 2026-06-25
title: Framer-clone custom domains (B): connect a customer-owned domain to a published site
summary: The "Option B" upgrade over the demo's default subdomain hosting (Option A). Let a site owner connect their own domain (demo-custom-domain.com) to a published framer-clone site, with domain-control validation, automatic per-domain TLS, and an in-editor onboarding flow. The host-aware routing and the SiteDomain.customHostname model already exist; this plan wires resolution, certs, and UX on top. Background work, sequenced AFTER the hosted-demo (Option A) is live.
tags: [framer-clone, custom-domains, hosting, tls, dcv, multi-tenant, north-star]
projects: [framer-clone]
---

# Framer-clone custom domains (B)

> **Status 2026-10-19: decided, then in progress.** Marlin decided on 2026-10-19 to build this.
> The section "Reality and decisions (2026-10-19)" at the end records how it is being built,
> which differs from the June text in three places: TLS goes through Traefik's file provider
> on the shared server (not Coolify per-host labels and not Cloudflare for SaaS), ownership is
> proven by a TXT token plus a routing record (not a delegated CNAME alone), and a pending claim
> never reserves a hostname.

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

## Reality and decisions (2026-10-19)

Marlin decided on 2026-10-19 to build this. Built on branch `feat/custom-domains`. What was built,
and the decisions taken on the way (decided, say so if you disagree):

**Data.** Custom domains are extra rows in `site_domains` (migration `20261019000000_custom_domains`,
additive). `hostname` is what the owner asked for (not unique), `custom_hostname` is the live claim
(unique, set only after verification), `verification_token` is minted per claim (32 random bytes,
unique index, never reused), plus check timestamps and the last error. New status `verified`
(ownership and routing proven, certificate pending) between `pending` and `active`.

**Decisions.**
- *A pending claim never reserves a hostname.* Otherwise anyone could block a domain by adding it
  first. Several sites may hold pending claims; the one that proves DNS control takes the live claim.
- *The latest DNS proof wins.* If a domain verified for site A is verified again with a fresh token
  for site B, the claim moves to B in one transaction and A shows "claimed elsewhere". Only the
  domain's DNS owner can publish the token, so this is the DNS owner deciding (Vercel does the same).
- *Ownership is TXT plus routing.* TXT `_lumitra-verify.<host>` = `lumitra-verify=<token>` proves
  control; a CNAME to the platform target, or A records that are all platform IPv4 addresses (apex),
  proves routing. A stray AAAA blocks verification with a clear message (Let's Encrypt prefers IPv6).
  Re-checking a live domain needs routing only, so removing the TXT later does not take it down.
- *Cloudflare-proxied customer records are refused* (they resolve to Cloudflare addresses): the
  message tells the owner to set the record to DNS only. Supporting proxied customer domains is
  Cloudflare for SaaS territory, still out of scope.
- *Transient DNS failures change nothing.* Timeouts and server failures only update the note; a
  definitive failure on a live domain removes the claim and stops serving.
- *`active` means a trusted certificate answered.* The app opens TLS to the platform's own IPv4 with
  the domain as server name (never to whatever the domain resolves to, so no request forgery).
- *Unpublished sites keep their proxy routes and certificates*, so publish and unpublish never spend
  Let's Encrypt quota; the resolver alone decides whether a site is served.
- *At most 10 custom domains per site and 50 per workspace*, 1000 hostnames in the proxy feed. When
  the cap bites, active domains keep their routes first, then the oldest verifications; the app logs
  it and the feed says so (`x-hostname-truncated`).
- *Live domains are re-checked on a schedule* (security review, 2026-10-20): every live claim whose
  last check is over six hours old gets a routing-only check (the TXT record may be gone), at most 20
  per call. Three definitive failures in a row release the claim; transient errors never count, and
  every write is guarded on the row as read. It runs from a host timer
  (`POST /api/internal/custom-domains/recheck`, every 10 minutes), not an in-app interval, so there
  is exactly one scheduler however many replicas run.
- *Internationalized lookalikes of the platform* (`lumіtra.co` with a Cyrillic i) are reserved, by a
  confusables skeleton over a curated subset of Unicode's data.

**TLS on Traefik: pull, not push.** The June options (Coolify per-host labels, Cloudflare for SaaS)
were replaced by Traefik's file provider on the shared server, which watches
`/data/coolify/proxy/dynamic/`. The app never writes proxy configuration: it serves the verified
hostnames as plain-text data on `GET /api/internal/custom-domains/hostnames` (editor host only,
bearer token `CUSTOM_DOMAIN_SYNC_TOKEN`, constant-time comparison, 503 when unset). The host script
`deploy/custom-domains/sync-traefik.sh` (systemd timer, every minute) re-validates every line with its
own strict rule (including the reserved endings and `BLOCKED_ZONES`), requires text/plain and a body
matching the `x-content-sha256` and `x-hostname-count` headers, refuses the whole feed on one bad
line, holds a drop of more than 5 routes and more than half of the 24 h high-water mark (additions
still apply, the union is written, a one-shot `force-once` flag in the state directory confirms a
genuine drop), writes one http-to-https redirect
router and one https router with `certResolver: letsencrypt` per hostname (priority 1, so Coolify's
routers always win), keeps the current file on every refusal, and renames atomically only on change.
The systemd units run root without capabilities in a read-only system with only the dynamic
directory and the unit's state directory writable (a dedicated user would need ownership changes in
Coolify's proxy directory). The re-check has its own unit and timer (every 10 minutes), and a
circuit breaker: when more than half of a pass of at least 5 fails definitively, nothing is counted
and the endpoint answers 503 `recheck_circuit_open`. Adding a domain counts and creates under a
per-workspace advisory lock, so concurrent adds cannot exceed the caps. Rejected: mounting the proxy directory into the app container (the app
could write any router), and Traefik's HTTP provider pointed at the app (same problem).

**Resolution and cache.** `hostLookupKeys` in `publicResolver.ts`: a host under the base host is a
subdomain, any other host that passes the hostname contract (`src/server/domains/hostname.ts`) is a
custom hostname, served only while `verified` or `active` on a published site. The origin cache keeps
its rules under the `site-host:<hostname>` tag; verify, claim loss and disconnect revalidate the host,
publish and unpublish revalidate every host of the site.

**Editor.** A Domains button in the top bar opens the panel (add, records with copy buttons, verify,
status, disconnect). Routes under `/api/projects/<id>/domains` use the editor guard chain (editor
host, session, `sites` grant, tenant group, `viewSite` / `manageDomain`, 503 on outages).

**Infra applied and proven, 2026-10-20** (Marlin's yes the same day; every command, the
operating notes and the rollback are in `infra/deployments/framer-clone/RUNBOOK.md`, phase 4):
`domains.lumitra.co` A record, DNS only, in Terraform; `CUSTOM_DOMAIN_TARGET_HOST`,
`CUSTOM_DOMAIN_TARGET_IPV4`, `CUSTOM_DOMAIN_DNS_SERVERS` and the minted `CUSTOM_DOMAIN_SYNC_TOKEN`
in Infisical; the token header file (root, 0600, written source to sink) and the four systemd
units on the server, with `BLOCKED_ZONES` set to the other products' zones on that server; the
proxy's file provider already watched `/data/coolify/proxy/dynamic/`, so no proxy restart.
Decided on the way: IPv4 only (`CUSTOM_DOMAIN_TARGET_IPV6` unset, no AAAA record), because
Traefik's IPv6 reachability is unproven and Let's Encrypt tries IPv6 first. End to end with
`fc-cd-test.marlinjai.com`: verified in the Domains panel, route written within a minute, Let's
Encrypt certificate, `HTTP/2 200` with the site's page, `active`; then disconnected and its
records and route removed.
