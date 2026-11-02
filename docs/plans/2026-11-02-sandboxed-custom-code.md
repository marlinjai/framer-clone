---
type: plan
status: draft
date: 2026-11-02
title: "Sandboxed custom code: the box service, the frame, the bridge, authoring and the slices to build them"
summary: "Turns the accepted sandbox contract of the behaviour plan into buildable slices. A small Node service on its own registrable domain (one host, lumitrausercontent.com recommended) serves each block as a content-addressed document per site, with a sandbox Content Security Policy, no cookies, no network and frame requests only. The published page builds the frame itself, never from stored data; the editor canvas never runs it. A broker in the page's runtime talks to the frame over one MessageChannel port with typed reads and writes. Code enters only through a guarded route behind a per-site enable step with an audit table, travels with published revisions by hash, and is reachable by the erase tool. AI and import may propose a block, never write one. Eight slices (C1 to C8) plus one operator step, about 20 worker sessions as judgement. The forcing case, the Grothe truck wash three.js scene, cannot be carried under the accepted 256 kilobyte, no-network contract at all; slice C8 proposes the smallest widening that would carry it (own-host assets, a pinned library shelf), as decisions M11 to M15 for Marlin."
tags: [framer-clone, custom-code, sandbox, security, csp, iframe, infra, coolify, fleet]
projects: [framer-clone]
---

# Sandboxed custom code

**What this is.** Customer sites built in framer-clone can hold a *custom code block*: a box on the page whose content is the
author's own HTML and JavaScript, run in an isolated frame. Marlin decided on 2026-11-01 that custom code is allowed, sandboxed,
off by default and clearly marked ([complete primitives plan](2026-11-01-complete-primitives.md), decision 1). The security
contract is written in the section "Sandboxed custom code" of the [behaviour plan](2026-11-02-behaviour-model.md), and Marlin
accepted its defaults for M1 to M10 on 2026-11-02. This plan does not reopen that contract. It turns it into slices someone can
build, fills in what the contract left open (the service's stack, storage, Domain Name System (DNS) and Transport Layer Security
(TLS), the postMessage contract, authoring, revisions, erase, monitoring, tests), and runs one real scene through it as a forcing
case.

Read against `origin/main` at `46d9252`. What the code holds today that matters here:

- **The render gate** (`src/lib/renderer/blockedNodes.ts`) refuses `iframe`, `script`, `object`, `embed` and the rest by name, in
  both renderers. It stays that way: a block's frame is drawn by the renderers from an address they build, never from a stored tag.
- **The map embed is the precedent.** `src/lib/mapEmbed/mapEmbed.ts` and `src/lib/renderer/mapEmbed/` are a node marked by a prop,
  drawn as a placeholder on every surface, and swapped for a frame by a published island (`MapEmbedIsland.tsx`) only when a
  condition holds (there: maps consent). `renderComponentNode.tsx` dispatches on it around line 200. A custom code block is built the
  same way.
- **The editor and published hosts.** `src/middleware.ts` serves the editor on `EDITOR_HOST` (`app.lumitra.co`) and every other host
  as a published site (`<label>.sites.lumitra.co`, custom domains). Decision D2 there: the auth-brain session cookie
  `lumitra_session` is scoped to the apex `.lumitra.co`, so the browser sends it to every published site. Pull request #305, the
  published-host route allowlist, is open and narrows what a published host answers.
- **A report-only Content Security Policy (CSP)** already goes out on every published document from the middleware
  (`src/lib/site/cspReportOnly.ts`), measuring `img-src`, `font-src`, `media-src` and `frame-src`, with Google allowed in
  `frame-src` only after maps consent, and reports counted per site (`CspReportCount`). Marlin reviews the reports on 2026-11-09
  before deciding whether to enforce. Because the middleware sends headers at run time, it knows `EDITOR_HOST`: the behaviour plan's
  worry that `next.config.ts` headers are fixed at build time no longer applies, see C2.
- **The immutable published copy** (`SiteRevision`, `src/server/sites/revision.ts`): publish freezes a revision document, the public
  site reads it, the newest 30 are kept, and the erase tool (`src/server/sites/erase.ts`, `SiteErasure`) rewrites a value in every
  kept revision and the working copy in one transaction.
- **Behaviour runtime** (`src/lib/behaviour/runtime.ts` and friends, slices B1 to B9 merged, B10 in #307): page state, triggers and
  actions as data. The custom code broker is the runtime's third lazy chunk.
- **Permissions** (`src/lib/permissions.ts`): action names mapped to auth-brain workspace roles. Every mutation is `workspace.admin`.
- **No audit table exists.** The nearest pattern is `SiteErasure`: append-only, no foreign key to the site, so it outlives a delete.

## What stays exactly as accepted

From the behaviour plan, unchanged, so the reader of this plan has the contract in one place:

| Topic | Accepted |
|---|---|
| Domain | A separate registrable domain, never under `lumitra.co` (M2) |
| Service | A separate small service, not the Next process, holding no application secret (M3) |
| Address | `GET https://run.<domain>/box/<siteId>/<sha256>`, built from the rendering site's id and a hash, never from stored text |
| Isolation | `sandbox allow-scripts` on both the response header and the `iframe`; `allow-same-origin` never appears |
| Frame only | 403 unless `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site`; a browser without these headers gets the fallback |
| Network | `connect-src 'none'`, `img-src data:`, no fetch in the frame in this version |
| Limits | 256 kilobytes per block, 4 blocks per page, 1 megabyte of live code per site, 10,000 pixels of height |
| Reads | State ids of type `boolean`, `number` or `choice`; never `text` state (M4) |
| Off by default | `Site.customCodeEnabled`, default false, set only through a route guarded by `manageCustomCode` |
| Entry | Code and its declaration enter only through a guarded `POST`, into a `CustomCodeBlob` row; never through a page save |
| Editor | Custom code never runs in the editor document, in any mode; the canvas shows a tile |
| Kill switch | `CUSTOM_CODE_DISABLED`, every block shows its fallback, the service answers 410 |
| Watchdog | No `hello` within 5 seconds, or three missed `ping`s, removes the frame |
| AI | The generator never writes a block |
| Consent | A lawyer reads the wording before the slice that switches it on (M9) |

## Decisions taken here, say so if you disagree

These follow from the accepted contract and the threat model. None of them is a spend, a legal commitment or a widening of what a
frame can reach. Those are in "For Marlin" at the end.

**D1. One origin, opaque frames, not a subdomain per site.** Every frame is `sandbox` without `allow-same-origin`, so its origin is
`null` whatever host served it. A per-site subdomain would add no isolation between tenants: no cookies exist on the domain, no
storage is reachable from an opaque origin, and browsers isolate processes by registrable domain, not by subdomain. What it would
cost is real: a wildcard certificate needs a DNS-01 challenge, which means a DNS write token on the host that serves customer code,
the one host that must hold no secret. The one argument for subdomains is blocklist reach: if Google Safe Browsing lists the host
after one tenant's phishing, every block on every site goes to its fallback. That is answered by takedown speed (the per-site switch
and the blob block list, below), by the frame-only rule (a visitor can never land on the box directly, which is what phishing
reports are about), and by keeping a move cheap: the broker builds the address from one template, `SANDBOX_ORIGIN` plus
`/box/<siteId>/<sha256>`, so a later move to `<siteId>.run.<domain>` is a change in two files and a certificate. **The trigger to
revisit is the first listing of the host by any blocklist.**

**D2. The service is plain Node with one dependency.** Node 22 on `node:http`, no web framework, and `postgres` (porsager) as the
only runtime dependency. The service has four routes and about 300 lines; at a security boundary every dependency is surface. It
lives in `services/box/` in this repository with its own `package.json` and lockfile (framer-clone is not a pnpm workspace and this
does not make it one), its own `Dockerfile.box`, its own image `ghcr.io/marlinjai/framer-clone-box` built for `linux/arm64`, and its
own path-filtered workflow. The pure contract both sides share (header values, the shell, the hash, the message kinds) is one
dependency-free module, `src/lib/customCode/contract.ts`, which the box's esbuild step bundles from the app's source, so the two can
never drift. A test fails if the module imports anything.

**D3. Storage: two rows in the app's Postgres, read by the box through one view.**

```text
custom_code_blobs        site_id, sha256, document (text), declaration (jsonb), title, created_by, created_at, blocked_at
custom_code_audit        id, site_id, workspace_id, tenant_group_id, actor, action, sha256, detail (jsonb), created_at
sites.custom_code_enabled  boolean, default false
box_documents (view)     site_id, sha256, document, frame_ancestors (text[]), live (boolean)
```

- `sha256` is the hash of a canonical manifest: `{"v":1,"document":"<sha256 of the text>","declaration":<canonical JSON>}`. So the
  hash covers code and declaration, and a page save can never widen what approved code may do. The primary key is
  `(site_id, sha256)`: the same code on two sites is two rows, so site B naming site A's hash finds nothing.
- `blocked_at` is the per-blob takedown: a blocked blob answers 410 even on an enabled site, and the guarded route refuses to
  write it again on any site.
- `box_documents` joins a blob to its site: `live` is `custom_code_enabled AND blocked_at IS NULL`. It does not require the site to
  be published, because the standalone preview runs drafts and the accepted contract serves a blob by hash whether or not it is
  published (the hash is not guessable). And `frame_ancestors` is the site's live hosts (platform subdomain, verified custom
  hostnames) plus the editor host. The view is the only object the box's role can read.
- **Role `box_reader`:** `LOGIN`, `CONNECTION LIMIT 4`, `statement_timeout 2s`, `SELECT` on `box_documents` only, nothing else,
  created by a committed SQL file applied once by the operator like `prisma/sql/commerce-roles.sql`. What its password can read is
  what the box serves to anyone anyway, so its leak costs nothing beyond what is public.
- `custom_code_audit` is append-only (no update or delete grant for the app role), without a foreign key to the site, so it outlives
  the site, as `SiteErasure` does. Actions: `enable`, `disable`, `blob-write`, `blob-erase`, `blob-block`, `blob-unblock`,
  `proposal-accept`. It records who, when and which hash, never the code.

**D4. Per block and per revision.** A node holds `props.customCode = { sha256, title }`. A published revision freezes that node like
any other, so a revision names exact code by hash, and rollback to revision 12 brings back revision 12's code, or its fallback if
that blob was blocked. The blob row is immutable. **A blob is live while the working copy or any of the 30 kept revisions names
it.** At every publish and save, in the same transaction that prunes revisions, blobs of that site named nowhere and older than 7
days are deleted (the 7 days are for an editor tab that wrote a blob and has not saved yet). The 1 megabyte site budget counts live
blobs only.

**D5. Headers of the box document,** the accepted set made exact, with three additions and one refusal:

```text
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none';
  form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none';
  manifest-src 'none'; webrtc 'block'; frame-ancestors <the site's hosts> <the editor host>;
  report-uri https://<EDITOR_HOST>/api/csp-report/box
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(),
  midi=(), payment=(), display-capture=(), fullscreen=(), clipboard-read=(), clipboard-write=(),
  publickey-credentials-get=(), xr-spatial-tracking=(), accelerometer=(), gyroscope=(), magnetometer=(),
  idle-detection=(), screen-wake-lock=(), browsing-topics=(), attribution-reporting=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: cross-origin
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: off
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=63072000; includeSubDomains
Cache-Control: public, max-age=300
```

- **No `Set-Cookie`, ever,** asserted by a test on every route and status, the 403s and 410s included.
- **`report-uri`** sends the frame's own violations to the editor host's report route, which reads the site id from the reported
  document address and counts them per site in `CspReportCount` under a new directive family. A block that keeps trying to leave is
  the clearest abuse signal there is. Reports carry no cookies (cross-origin), and the editor host already answers `/api/csp-report`.
- **Cross-Origin-Opener-Policy (COOP)** only matters for a top-level document, which the frame-only rule already refuses; it is a
  harmless extra for the 403 page.
- **Cross-Origin-Embedder-Policy (COEP) is not used,** on the box or on published pages. It would only buy `SharedArrayBuffer`, which
  needs the parent page cross-origin isolated too, and that would break every hot-linked image, the Stripe return and the map embed
  on every published site. No block needs it in this version.
- **`unsafe-eval` stays out,** as accepted. Section "Forcing case" shows the first real scene does not need it (it needs
  `wasm-unsafe-eval`, which is M13).

**D6. The enforced `frame-src` on published pages goes out from the middleware, not `next.config.ts`.** The behaviour plan's C2 added
build arguments because `headers()` is fixed at build. The middleware already sends a run-time policy, so C2 adds a second header
there, on every published document and on the editor host's standalone preview route (`/projects/<id>/preview`, which runs real
frames: the header was the only control that stopped `blob:` self-navigation in all three engines, so the preview needs it too), an enforced `Content-Security-Policy: frame-src https://run.<domain>/box/` plus `https://www.google.com` when the maps
consent cookie is set, the same switch the report-only policy uses. It is constant per consent state and names no site, so it needs
no database read in the middleware. A per-site `<meta>` tightens it to `/box/<siteId>/` where it reaches `head`. The report-only
header stays as it is, measuring the rest. Enforcing `frame-src` alone is not the open decision of the roadmap line "Enforcing the
Content Security Policy on published pages", which is about images; it touches only frames, and a published page holds exactly two
kinds (the map after consent and the box), both listed. A test proves the map still loads after consent with the header enforced.

**D7. Agents and import propose, a person accepts.** The behaviour plan says the generator never writes custom code. The MCP endpoint
of the [agent plugin plan](2026-11-02-lumitra-sites-agent-plugin.md) (in #308) and the React importer's leftover regions
([React import plan](2026-11-02-react-import.md), "Custom code is the remaining route for a `left` region") both meet code that only
a block can carry. Neither writes a blob. (MCP is the Model Context Protocol, the standard way an agent such as Claude Code calls a server's tools.) They may write a **proposal**: a `custom_code_proposals` row (site, source `import` or
`agent`, the code, a suggested declaration, who created it), written through `editSite`, never served by the box, never rendered.
The node they insert carries `props.customCode = { proposal: <id>, title }`, which every renderer treats as "no hash": the fallback
shows. The panel shows the proposal marked "Proposed by import" or "Proposed by agent, not active", with the code, and only a person
holding `manageCustomCode` on an enabled site can press Accept, which posts it through the guarded route under that person's session
and writes `proposal-accept` to the audit. An agent's key never holds `manageCustomCode`: the MCP's `set_props` refuses a
`customCode` key with a `sha256`, as `validate.ts` and `ai/review/ops.ts` drop it today. So "the generator never writes one unasked"
holds, and a person who asked an agent for a block gets one press away from it, not zero.

**D8. The focus watch and a pass-through frame.** The behaviour plan's broker removes a block after 3 focus moves into the frame while
the pointer is not over it. A block may set `interactive: false` (a background scene behind text): the broker then gives the `iframe`
`pointer-events: none` and `tabindex="-1"`, so scrolling and clicks pass through to the page. Such a frame can never be hovered, so
the hover test means nothing for it; instead **any** focus move into a non-interactive frame is theft, and the first one removes it.
Interactive frames keep the accepted rule.

**D9. Erase reaches code by rewriting it under a new hash.** A name or phone number can sit in a block's code. The erase tool's
search walks the text of every live blob of the site. A match is rewritten into a new blob (same declaration, new hash), every kept
revision and working page naming the old hash is rewritten to the new one in the same transaction the erase already runs, the old
row is deleted, and `blob-erase` goes to the audit with both hashes. The code may break where a string literal changed; the erase
report says which blocks were rewritten so the owner can check them. The alternative, deleting the blob so old revisions fall back,
loses the block for a one-word erase and was rejected. Binary assets, if M11 is accepted, cannot be text-searched: the erase
dialog lists a site's assets with their uploader and date, and the owner may delete one, after which a block naming it gets its
fallback.

**D10. Code editor: CodeMirror 6, lazy.** Monaco is several megabytes and wants workers; CodeMirror 6 with the HTML and JavaScript
languages is about 150 kilobytes gzipped, works in the phone sheet, and loads as its own chunk only when the custom code section
opens. No linting of the author's code beyond a parse warning, and no formatting.

**D11. The box runs on the shared server, as its own Coolify application with hard limits,** 0.5 CPU and 256 megabytes, a read-only
root filesystem and a non-root user. A dedicated server would cost money (Marlin's call) and buys isolation from a container escape,
which a 300-line read-only service is an unlikely route to. **If abuse or load shows up in the box's numbers,** moving it to its own
Hetzner CAX11 is a one-line ask to Marlin with the numbers attached.

**D12. Secrets for the box live in their own Infisical project,** `framer-clone-box`, holding one value, `BOX_DATABASE_URL`, read by
its own machine identity. The box's identity cannot read the app's project, so a compromise of the box host yields one read-only
password, as D3 says.

## The box service

### Routes

| Route | Answers |
|---|---|
| `GET /box/<siteId>/<sha256>` | The document: the constant shell, then the author's document. 403 without the two fetch metadata headers, 404 for an unknown or malformed pair, 410 when the site is off, the blob blocked or the kill switch set. Any query string: 400 |
| `GET /health` | `ok`, for the container check and Uptime Kuma. Exempt from the fetch metadata check (it serves no customer content) |
| `GET /health/db` | `ok` after `SELECT 1` through the view, 503 with the error class otherwise |
| `GET /` and `GET /.well-known/security.txt` on the apex and `run` hosts | A plain page saying what the domain is ("sandboxed customer code for sites hosted by Lumitra"), with the abuse contact (M10) and a link to the takedown form, and the security contact. No customer content |
| Anything else | 404, no body |

`HEAD` mirrors `GET`. Every other method: 405.

### Inside

- **Lookup:** `(siteId, sha256)` validated by shape (a universally unique identifier (UUID) and 64 hex characters) before any query. One prepared statement on the
  view.
- **Cache:** an in-memory least-recently-used cache of 32 megabytes, keyed on the pair, holding the document and the live flag, each
  entry 60 seconds. With the 300-second HTTP cache that bounds how long a disabled block can keep loading at six minutes; the kill
  switch is an environment variable read on every request, so it is immediate for new requests.
- **Rate limits:** an in-memory token bucket per client address, 60 requests a minute per path and 600 overall, answered 429. The
  client address is the one Traefik forwards, trusted only from the Coolify proxy network.
- **Logging:** one structured line per request with status, the site id for valid pairs, and duration. No path for invalid
  requests (a path can carry data, see "Network is not zero" in the behaviour plan), no full client address (a 24-bit prefix only),
  no user agent.
- **The shell,** first in every document: deletes the WebRTC constructors the behaviour plan lists, then sets up the bridge client
  (below). It is a constant string from `contract.ts`, so its bytes are in the hash of nothing and can change with a deploy; its
  version number is in the `hello` message.

### Deploy

Following the stack's conventions (Hetzner `aarch64`, Coolify, Terraform, Infisical, the reusable `coolify-deploy-verify` workflow):

- **Image:** `Dockerfile.box`, `node:22-alpine`, the Infisical command-line client, a non-root user, `tini` as process 1, entrypoint
  logs in with the box's machine identity and runs the server inside `infisical run`, binding `0.0.0.0:8080`.
- **Coolify:** application `framer-clone-box` on the shared server, connected to the network of framer-clone's Postgres, only
  `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `_SECRET` as environment, health check `/health` on `127.0.0.1`, limits per D11.
- **Workflow:** `.github/workflows/box.yml`, path-filtered on `services/box/**` and `src/lib/customCode/contract.ts`, on
  `ubuntu-24.04-arm`: typecheck, unit tests, the header suite against the built image, push, Coolify webhook, then poll
  `https://run.<domain>/health`.

## DNS and TLS for the new domain

Recommended name `lumitrausercontent.com` (M2; Marlin buys it through Lumitra Mail). The zone moves to Cloudflare and is managed by
Terraform in the infra repository like every other zone.

| Record | Value | Why |
|---|---|---|
| `run` A (and AAAA if the server has IPv6) | The shared server, **DNS only, not proxied** | A Cloudflare challenge cannot pass inside a frame, and a proxied host would set Cloudflare cookies, breaking "no cookies ever" |
| apex A | The shared server, DNS only | The plain "what is this domain" page with the abuse contact |
| `CAA` (Certification Authority Authorization) | `0 issue "letsencrypt.org"` and `0 iodef "mailto:<security contact>"` | Only the certificate authority Traefik uses may issue |
| `MX` | Per M10: a forwarding mailbox for `abuse@` and `security@`, or a null `MX` (`0 .`) if the contact lives elsewhere | Blocklist operators write to `abuse@<domain>` first |
| `TXT` SPF (Sender Policy Framework) | `v=spf1 -all` (or the mail provider's, if M10 gives the domain mail) | The domain sends nothing |
| `_dmarc` TXT (Domain-based Message Authentication, Reporting and Conformance) | `v=DMARC1; p=reject` | Nobody can send mail as the domain |

**Certificates:** Traefik on the shared server obtains two Let's Encrypt certificates (apex and `run`) by the HTTP-01 challenge, the
same way every other Coolify application gets one. No wildcard, no DNS token anywhere (D1). `Strict-Transport-Security` without
`preload` at first; submitting to the preload list is a later, separate step once the domain has run cleanly for a month, because it
is slow to undo.

## How a block is embedded

### Stored shape

```ts
/** props.customCode, on an ordinary `div`. The renderers dispatch on it; it never reaches the DOM. */
type StoredCustomCode =
  | { sha256: string; title: string }          // a block
  | { proposal: string; title: string };       // a proposal, renders the fallback only (D7)

/** In the blob row, set only through the guarded route, covered by the hash. */
interface CustomCodeDeclaration {
  reads?: string[];        // state ids of type boolean, number or choice
  writes?: string[];       // state ids the frame may set, checked against their type
  emits?: string[];        // custom:<name> events it may fire
  sizing: 'fixed' | 'content';  // fixed: the wrapper's own size; content: height from `resize`
  interactive: boolean;    // false: pointer-events none, tabindex -1, see D8
}
```

The node's children are the fallback: ordinary nodes, shown until the frame says `hello`, and shown for good on every failure. An
author is told to fill it, and the publish check (below) warns on an empty one.

### Per surface

| Surface | What is drawn |
|---|---|
| Editor canvas, Select and Interact | `createCustomCodeElement('editor')`: a striped tile at the wrapper's size, "Custom code, not run here", the title, a badge, and a button to the standalone preview. No frame, ever. A test mounts the editor with a block and asserts no `iframe` in the document |
| In-editor preview (`PreviewFrame`) | The same tile. The preview shares the editor's origin |
| Standalone preview tab (`/projects/<id>/preview`) | The real frame, same policy. The view serves a blob of an enabled site whether or not it is published (D3; the hash is not guessable, and the frame is opaque and cross-site, so an admin viewing it gives the code nothing). `frame-ancestors` includes the editor host for this |
| Published page | The server renders the wrapper (`data-fc-custom-code="<sha256 prefix>"`, so a report can be traced) and the fallback. `CustomCodeIsland`, through the broker chunk, creates the frame on the client |

The frame the broker creates, with constant attributes, never a stored value:

```html
<iframe src="https://run.<domain>/box/<siteId>/<sha256>" sandbox="allow-scripts" title="<title>"
        referrerpolicy="no-referrer" loading="lazy" allow="" style="border:0;width:100%;height:<per sizing>">
```

### The postMessage contract

The parent trusts nothing about the frame's origin, which is `null`. Version 1 of the protocol:

1. The shell posts `{ fc: 1, kind: 'hello', shell: <version> }` to `window.parent` with target `*`.
2. The broker accepts only a message whose `source === iframe.contentWindow`, from a frame it created, once. It creates a
   `MessageChannel`, keeps one port, and posts `{ fc: 1, kind: 'connect', declaration }` with the other port transferred. Every later
   message runs on the port. A second `load` of the same frame removes it (a reloading block would reset the rate limit).
3. Messages on the port:

| Kind | Direction | Body | Rule |
|---|---|---|---|
| `state` | parent to frame | `{ id, value }` | Sent for each declared read at connect and on every change. Never `text` state |
| `setState` | frame to parent | `{ id, value }` | Only a declared write, value checked against the state's type, `min`, `max` and `options` |
| `emit` | frame to parent | `{ name }` | Only a declared `custom:<name>`. Not a person's input: it cannot drive `navigate` or the focus verbs |
| `resize` | frame to parent | `{ height }` | Only with `sizing: 'content'`, clamped to 10,000 pixels, at most 10 a second |
| `ping`, `pong` | both | `{}` | The parent pings every 5 seconds; three missed and the frame is removed |
| `error` | frame to parent | `{ message }` | Counted, shown in the console with the block's title |

The 5-second `hello` clock starts at the frame's `load` event, not at its creation: the frame is `loading="lazy"`, so a block below the
fold would otherwise be removed before it ever loads. The broker creates the frame only once the wrapper is within one viewport of
the screen.

Anything undeclared, of the wrong type, of an unknown kind, over 64 kilobytes, or past 30 messages a second is dropped with a console
warning naming the block. **The shell's client** gives the author a small API instead of raw messages:
`lumitra.read(id)`, `lumitra.onState(id, fn)`, `lumitra.setState(id, value)`, `lumitra.emit(name)`, `lumitra.resize(height)`,
`lumitra.ready()`. Its reference is a page of `docs/` written in C4.

### Sizing

`fixed` takes the wrapper's size from its normal style sections, at every breakpoint, as any `div`. `content` starts at the
wrapper's minimum height and follows `resize`. Width always follows the wrapper. A frame never sizes the page beyond its own box.

### The behaviour model's `reads`

A read is the frame's view of page state: a tab index, a toggle, a slider value, as a typed value. It is what lets a block react to
the page without reaching into the page. A write is the reverse and drives the page through state like any trigger would, which is
why it is declared and typed. Neither reaches the DOM.

## Authoring

- **Enabling a site** (C7): Site settings, section "Custom code", a switch that opens a dialog: what custom code is, that visitors'
  devices run it in an isolated frame, the consent wording a lawyer has read (M9), and a confirm button that names the site. Only a
  holder of `manageCustomCode` sees it (an action name in `permissions.ts`, mapped to `workspace.admin` per M8, adding a deliberate
  step and an audit line, not a higher bar). The section then shows who enabled it and when. Disabling is one press with the same
  audit line; blocks show their fallback within six minutes.
- **The block** (C4): "Custom code" in the insert menu, only on an enabled site. The panel section has the title (required, it is
  the frame's accessible name), the code editor (D10), pickers for reads, writes and emits drawn from the page state list (only
  allowed types offered), sizing, the interactive switch, and a plain sentence stating what the code can read, write and fire.
  **Save** posts the document and declaration to `POST /api/projects/<id>/custom-code`, which checks the session, `manageCustomCode`,
  the site switch, the limits and the declaration against the page, writes the blob and the audit line, and returns the hash, which
  becomes the node's `sha256` through one model action and one undo step.
- **Clearly marked,** as accepted: a badge on the Layers row and the tile, the site settings line, the publish dialog listing each
  block on the pages going out with title and who last changed it, the `data-fc-custom-code` attribute, and the audit table.
- **The publish check** (`src/lib/legal/publishCheck.ts`) gains two warnings, never blocking: a block with an empty fallback, and a
  site with blocks whose privacy page lacks the custom code line (the template line comes with C7).

## Travelling with revisions, retention and erase

Covered by D4 (a revision names code by hash, blobs live while anything kept names them, pruned at publish and save) and D9 (erase
rewrites under a new hash). Two more rules:

- **The live switch is not in the revision.** `customCodeEnabled`, `blocked_at` and the kill switch are live state, so disabling a
  site or blocking a blob reaches every revision, rollback included.
- **Format of a revision does not change.** `props.customCode` is an ordinary prop inside a page snapshot, so
  `REVISION_SCHEMA_VERSION` stays 1.

## AI and import

- The generator (`validate.ts`, `ai/review/ops.ts`) keeps dropping `customCode` with a warning, as merged. It is never taught the
  block.
- The MCP endpoint and the in-editor agent loop may call one tool, `propose_custom_code`, which writes a proposal (D7) and inserts a
  proposal node, and only when the person's request asked for custom code in so many words. The tool's description says so, and a
  server-side check refuses it on a site that is not enabled.
- The React importer's `left` regions offer "Propose as custom code" beside "Rewrite" once C5 exists and the site is enabled. The
  importer never evaluates source, so what it proposes is the region's source text as the author wrote it, which the person reads
  before accepting.

## Limits and abuse handling

| Limit | Value | Where |
|---|---|---|
| Document | 256 kilobytes, code plus declaration | Guarded route, and the box refuses larger rows |
| Blocks per page | 4, the first four render, a warning for the rest | Renderer |
| Live code per site | 1 megabyte | Guarded route, counted on live blobs (D4) |
| Height | 10,000 pixels | Broker |
| Messages | 64 kilobytes each, 30 a second | Broker |
| Requests to the box | 60 a minute per path and address, 600 overall | Box |
| Blob writes | 30 an hour per site | Guarded route |

**Abuse handling,** in order of reach:

1. **One blob:** an operator sets `blocked_at` through `POST /api/internal/custom-code/block` (operator token, editor host only,
   audit line). The blob answers 410 everywhere within six minutes and cannot be written again.
2. **One site:** the same route sets `customCodeEnabled = false` with a reason the owner sees in Site settings.
3. **Everything:** `CUSTOM_CODE_DISABLED=1` on the box and the app, through Infisical and a restart.
4. **Signals:** the frame's CSP reports per site (D5), the box's 429 and 410 counts in its logs, and abuse mail to the M10 contact.
   A site whose blocks produce more than 100 violation reports in a day shows up in the weekly report review the CSP line already
   schedules.

What takedown means for the customer (notice, appeal, timing) is the terms of M10.

## Monitoring

Per the monitoring skill (Uptime Kuma at `status.marlinjai.com`, Telegram alerts, added through the secrets proxy):

| Monitor | Type | Target | Why |
|---|---|---|---|
| Box health | Keyword `ok` | `https://run.<domain>/health` | The process is up |
| Box database | Keyword `ok` | `https://run.<domain>/health/db` | The view and the role work |
| Box canary | Keyword `fc-box-shell`, custom headers `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site` | `https://run.<domain>/box/<canary site>/<canary hash>` | The real path end to end: lookup, live flag, shell. The canary is a platform-owned site with one enabled block |
| Box apex | HTTP 200 | `https://lumitrausercontent.com/` | The abuse contact page answers |
| Certificate expiry | Kuma's TLS expiry warning on the health monitor, 14 days | | Traefik renewal failing |

The shared server is already in Beszel for CPU and memory, so the container's limits show there. All five go on the framer-clone
status page.

## Tests, adversarial ones included

- **Box unit and image tests (C1):** every header byte for byte from `contract.ts`; no `Set-Cookie` on any status; 403 for each
  missing or wrong fetch metadata header; 400 for a query; 404 for a malformed id, an unknown hash, and site B naming site A's hash;
  410 for off, blocked and kill switch; 429 past the bucket; 405 for other methods; `box_reader` cannot read any table directly
  (a real Postgres in the integration suite).
- **Renderer tests (C2):** no `iframe` from any stored prop, `src` or `srcdoc`; `iframe` still in `BLOCKED_TAGS`; the tile on canvas
  and in-editor preview; the fallback for a proposal, an unknown hash and a blob of another site; the enforced `frame-src` read from a
  real document in the browser, and the map loading after consent under it.
- **Bridge tests (C3):** a message from a frame the broker did not create is ignored; a second `hello` and a reload remove the frame;
  undeclared ids, wrong types, `text` state and oversize messages are dropped; `emit` cannot trigger `navigate`; the watchdog removes
  a frozen frame in Chromium and Firefox; the focus watch removes a frame that steals focus three times, and a non-interactive frame
  on the first move (D8). The behaviour plan marked the focus watch "designed, not probed": C3 proves it or replaces it.
- **The escape suite (C6),** in Chromium, WebKit and Firefox, on a path-filtered workflow so the five-minute rule holds elsewhere.
  Each probe from the review of the behaviour plan made permanent, plus the hostile blocks below, each asserting the page and the
  editor are unchanged:
  - reading `document.cookie`, `localStorage`, `indexedDB`, `parent.document`, `top.location` (all throw or are empty);
  - navigating `top`, opening a window, submitting a form, self-navigating to `blob:` and `data:`;
  - `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, an image or font from another host, a nested `iframe`, a
    worker (all blocked, each producing a CSP report counted for the site);
  - WebRTC after the shell (STUN, Session Traversal Utilities for NAT, packets counted at zero in Chromium and WebKit);
  - `preconnect` and `dns-prefetch` to a data-carrying host name: **expected to leak in WebKit and Firefox,** asserted as the stated
    residual so a change in either direction is noticed;
  - a direct visit to the box address (403), and framing the box from a host not in `frame-ancestors` (refused);
  - a frame spamming `setState` and `resize`, a frame posting a forged `connect` to its own parent, a frame that loops (`while(true)`)
    and the measured WebKit freeze of the parent (asserted as the M7 residual);
  - focus theft by `focus()` on load and on a timer;
  - the editor mounted with a hostile block on the page: no frame, no request to the box.
- **Stateful flows (C4, C5),** per the stateful flow standard: forward (enable, add a block, save, publish, see it run); backtrack
  (change the code: a new hash, the old blob pruned after 7 days; change the declaration: a new hash; delete a state a block reads:
  the block's fallback and a panel error); resume (reload the editor: the node names its hash, the tile shows); re-entry (disable
  and enable the site; block and unblock a blob; roll back to a revision whose blob was erased or blocked).
- **The score:** C6 closes the event row `securitypolicyviolation` (published only) and the rows labelled `custom code`
  (`contextlost`, `contextrestored`, and the selector rows the selector contract promised back), as the behaviour plan's table says.

## Forcing case: the Grothe truck wash scene, side by side with the 3D scene primitive

The 3D scene primitive is being planned in parallel by another agent in `docs/plans/2026-11-02-3d-scene-primitive.md`. Both plans
use the same scene as their forcing case: the truck wash page built for the client Grothe, where a vehicle drives through a
four-station wash hall as the visitor scrolls, with glTF models, procedural foam, a camera flight tied to the page's sections, and a
GSAP (GreenSock Animation Platform) intro.

**What the scene needs, measured from its code:** three.js `three.module.min.js` (672 kilobytes), addons (GLTFLoader, DRACOLoader with
its WebAssembly decoder, RoomEnvironment, RoundedBoxGeometry, BufferGeometryUtils, MeshSurfaceSampler, about 420 kilobytes), GSAP
core (72 kilobytes), the scene's own modules (about 58 kilobytes), and glTF binary (GLB) models plus dirt textures of 1.1 to 3.1
megabytes depending on the model set. It reads the parent page: `window.scrollY` and the positions of the page's station sections
(`data-station`), which drive where the vehicle stops so copy and scene line up.

**Under the accepted contract it cannot be carried at all.** The block is 256 kilobytes with no network: three.js alone is larger
than the whole budget, before a single model. And a sandboxed frame cannot read the parent's scroll position or its sections. That
is the finding, and it is the case for the widening proposed as M11 to M15 and built in C8.

**Under the proposed widening (C8) it can,** with the scene's code changed in three places: the import map points at the shelf,
`load('models/...')` points at asset hashes, and the scroll and station reads come from `lumitra.onViewport`. Laid out as a sticky
full-height block with `interactive: false` behind the page's sections.

| Question | Custom code block (with C8) | 3D scene primitive |
|---|---|---|
| Runs on the editor canvas | No, a tile; the standalone preview runs it | Per the 3D plan |
| Editable by a non-developer | No, it is code | Per the 3D plan |
| AI can build or change it | No, a person accepts a proposal at most | Per the 3D plan |
| Per site | Off by default, enabled by an admin, consent wording needed | Per the 3D plan |
| Bytes on first visit | Measured by the fixture | Measured by the fixture |
| Time to first frame, frame rate while scrolling, parent long tasks | Measured | Measured |
| Without JavaScript, reduced motion, a slow phone | The fallback; the author's own reduced-motion code | Per the 3D plan |
| Failure mode | A hung scene freezes the parent in WebKit (M7) | Per the 3D plan |
| Scroll link | Through `viewport` messages, one animation frame late | Per the 3D plan |

The 3D plan fills its column; this plan's fixture measures both.

**The fixture is local only, never in this repository** (it is public, and the scene is client work). It lives on Marlin's Mac in a
folder named `comparison-sandbox-vs-3d`, a sibling of the client's site worktree, outside any git repository. It holds:

1. `run.sh`: starts the framer-clone dev server, the box from `services/box` in Docker on `127.0.0.1:8787` (a different site from
   `localhost:3000`, so `Sec-Fetch-Site` is `cross-site` as in production), and a local Postgres with a seeded site that has custom
   code enabled.
2. `load-block.ts`: posts the scene, rewritten for the shelf, the asset route and `viewport`, through the guarded routes into that
   site, with the client's models as assets.
3. `load-primitive.ts`: builds the same scene with the 3D primitive once its slices exist, as the 3D plan specifies.
4. `measure.spec.ts`: Playwright in Chromium, WebKit and Firefox, on a desktop profile and a throttled phone profile: bytes over the
   network, time to first rendered frame, animation frame intervals while scrolling through all five stations, long tasks on the
   parent, screenshots at each station, the no-JavaScript and reduced-motion renders, and whether the editor canvas shows anything.
5. `results.md`: the numbers. Only aggregate figures without client content ("the forcing scene: block N milliseconds, primitive M")
   may be copied into this plan, by the operator, after reading them.

It runs once C8 is merged (or on C8's branch), and again when the 3D primitive's first slices land.

## Slices

The behaviour plan named five slices, C1 to C5. This plan splits them where a slice was larger than one worker session or mixed
an infrastructure step with code, and adds C8 for the proposed widening. Mapping: old C1 is C1 plus O1; old C2 is C2; old C3 is C3;
old C4 is C4, C5 and C7; old C5 is C6.

Each slice is one pull request, green alone. **Sizes are judgement, not measurement,** in fleet worker sessions of about 1.5 hours.
C1 to C6 can be built now: nothing is served on the real domain until O1, and nothing reaches a customer until C7.

| # | Slice | Files | Depends on | Size (judgement) | Acceptance checks |
|---|---|---|---|---|---|
| C1 | `sandbox-service` | `services/box/` (server, cache, rate limit, shell), `src/lib/customCode/contract.ts`, Prisma migration (`custom_code_blobs`, `custom_code_audit`, `custom_code_proposals`, `sites.custom_code_enabled`, view `box_documents`), `prisma/sql/box-reader.sql`, `Dockerfile.box`, `.github/workflows/box.yml`, `deploy/README.md` section | none | 3 sessions | Every box test above passes against the built image and a real Postgres; `box_reader` reads only the view; the image runs read-only as non-root; `contract.ts` imports nothing; the migration is additive |
| O1 | `sandbox-domain-and-host` (operator, not a worker) | Infra repo: Cloudflare zone and records in Terraform, Infisical project `framer-clone-box` and its machine identity, Coolify application, `box_reader` applied, five Kuma monitors | C1, **M2 bought** | Half a day | `curl` with and without fetch metadata headers gives 200 and 403 on `run.<domain>`; certificates valid; no `Set-Cookie`; all monitors green; abuse page answers |
| C2 | `sandbox-element` | `src/lib/customCode/customCode.ts` (pure parse), `src/lib/renderer/customCode/customCodeElement.tsx`, `renderComponentNode.tsx`, `createComponentElement.tsx`, `HeadlessComponentRenderer.tsx`, `componentRegistry.ts`, `middleware.ts` and `src/lib/site/cspReportOnly.ts` (enforced `frame-src`, D6), the tile | C1 | 2 sessions | Renderer tests above; the map embed still loads after consent with the header enforced; the standalone preview route carries the enforced `frame-src` (a middleware route test); no `iframe` in the mounted editor; `renderer` collision tag |
| C3 | `sandbox-bridge` | `src/lib/customCode/broker.ts`, `CustomCodeIsland.tsx`, the shell client in `contract.ts`, `runtime.ts` (third lazy chunk), size test (broker at most 2 kilobytes gzipped, as the behaviour plan holds) | C2, B4 | 3 sessions | Bridge tests above in three engines; a page without blocks loads no broker byte; the focus watch proven or replaced with the proof attached |
| C4 | `sandbox-authoring` | `POST /api/projects/[projectId]/custom-code` and its read, `permissions.ts` (`manageCustomCode`), `CustomCodeSection.tsx` with CodeMirror, insert menu entry, Layers badge, model action, audit writes, the author API reference page in `docs/` | C3, B11 | 3 sessions | Hash covers the declaration (a changed declaration is a new hash); every refusal returns its reason; all four stateful paths; `pnpm test:integration`. The insert entry and the route are behind `CUSTOM_CODE_AVAILABLE`, off in production until C7 |
| C5 | `sandbox-lifecycle` | `src/server/sites/repository.ts` (blob pruning with revisions), `src/server/sites/erase.ts` (D9), publish dialog listing, `publishCheck.ts` warnings, proposals (D7): `propose_custom_code` in the site operations, the importer's "Propose as custom code", the panel's Accept, `POST /api/internal/custom-code/block` | C4 | 2 sessions | Rollback to a revision whose blob was blocked shows the fallback; an erase inside code rewrites the hash in every kept revision in one transaction; a proposal never reaches the box; an agent key cannot write a hash |
| C6 | `sandbox-escape-suite` | `test/sandbox/escape.spec.ts` and hostile fixtures, a path-filtered workflow on `src/lib/customCode/**`, `services/box/**` and the suite, `events.score.ts`, `report.ts`, `exclusions.json`, `samples.json` | C5 | 3 sessions | Every probe above, in Chromium, WebKit and Firefox, against the real box image; residuals asserted as residuals; the score rows the behaviour plan lists |
| C7 | `sandbox-switch-on` | Enable dialog with the reviewed wording in `SiteSettingsDialog.tsx`, privacy page template line in `src/lib/legal/`, `CUSTOM_CODE_AVAILABLE` on, the abuse page text, the canary site | C6, O1, **M9, M10** | 1 session | Production browser proof: enable on a test site, add a block, publish, see it run on `*.sites.lumitra.co`, disable and see the fallback within six minutes, the kill switch, the canary monitor green |
| C8 | `sandbox-assets-and-shelf` (proposed) | Box routes `/asset/<siteId>/<sha256>` and `/lib/<name>@<version>/<file>`, the shelf build from pinned npm tarballs with recorded licences, `custom_code_assets` table, asset upload in the panel, the widened document policy, the `viewport` read, multi-file code, the escape suite extended | C7, **M11 to M15** | 3 sessions | Escape suite extended: a frame can reach only its own site's assets and the shelf, never another site's assets or another host; the forcing case fixture runs; erase lists assets |

Total C1 to C7: about 17 sessions plus O1; with C8 about 20. B4 and B11 are behaviour slices already planned or merged. Only C2 touches
the renderer files. C1 and O1 are the only ones touching infrastructure.

## For Marlin

One line each, with the default that holds if he says nothing different.

- **M2, the domain:** buy `lumitrausercontent.com` through Lumitra Mail (default name; any other registrable domain outside
  `lumitra.co` works the same). O1 waits for it.
- **M9, the consent wording:** a lawyer reads the enable dialog's wording and the privacy page line before C7 (default: drafted in
  C4, sent with the facts listed in the behaviour plan's "Consent").
- **M10, terms, takedown and abuse contact:** default `abuse@` and `security@` on the new domain forwarded by Lumitra Mail to his
  inbox, a takedown target of one working day, terms of use stating that customer code is the customer's responsibility and may be
  disabled without notice when it harms visitors.

**Proposed widening for the forcing case.** These change what a frame may reach, which the fleet plan reserves for Marlin, so they are
proposals with defaults, built only in C8, and C1 to C7 are complete without them. If he refuses them, the custom code block stays
for small things (a calculator, a canvas drawing, a small simulation, as the behaviour plan says), and scenes like the truck wash
belong to the 3D primitive alone.

- **M11, own-host assets:** a block may load files its site uploaded, by hash, from `run.<domain>/asset/<siteId>/`, with
  `connect-src`, `img-src`, `media-src` and `font-src` limited to that path. 8 megabytes per asset, 16 per block, 64 live per site.
  Types: GLB, PNG, JPEG, WebP, AVIF, KTX2, HDR, WOFF2, MP3, OGG, MP4, WebM, JSON; no SVG, HTML or script. Data still reaches only
  Lumitra's own host, never a third party, and the box logs no paths. Default: yes.
- **M12, a pinned library shelf:** reviewed, version-pinned libraries served by the box at `/lib/<name>@<version>/`, not counted in
  any limit, loaded by an import map. First entry three.js with the addons the scene uses. Only libraries whose licence was read and
  recorded join it; GSAP's licence is unread here, so it stays off until read, and authors may bundle their own copy meanwhile.
  Default: yes.
- **M13, WebAssembly and a worker:** `script-src 'wasm-unsafe-eval'` (compiling WebAssembly, not JavaScript `eval`) and `worker-src
  blob:`, which Draco model decoding needs, allowed only if C8's probe shows a `blob:` worker keeps the frame's policy in all three
  engines. Default: yes if the probe holds, otherwise refused and models ship without Draco.
- **M14, multi-file code:** a block may be up to 16 text modules served by the box under its hash, still 256 kilobytes in all.
  Default: yes.
- **M15, a `viewport` read:** a declared block receives its own position against the viewport and the positions of up to 16 nodes it
  names, once per animation frame while visible. It is how a scene follows the page's scroll; it tells the frame how the visitor
  scrolls, which the consent reading of M9 must cover. Default: yes.

## What this does not cover

- Fetching from third-party hosts in a frame, consent-gated embeds, persisted state: each its own plan, as the behaviour plan says.
- Page-wide scripts in `head`: a block is always a node.
- Running a React component's original source in a frame: the React import plan names it a later decision.
- The 3D scene primitive itself: its own plan.
