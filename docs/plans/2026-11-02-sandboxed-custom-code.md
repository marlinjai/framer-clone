---
type: plan
status: in-progress
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
- **Bridge tests (C3):** a message from a frame the broker did not create is ignored; a first window message that is not a `hello` and a reload remove the frame, and a second `hello` is only counted;
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
| C1a | `sandbox-service`, the service and the contract. **Built 2026-11-12,** see "Decided in slice C1a" | `services/box/` (server, cache, rate limit, shell, tests, a fixture that states the view's columns), `src/lib/customCode/contract.ts`, `Dockerfile.box`, `Dockerfile.box.dockerignore`, `.github/workflows/box.yml` (build and test only) | none | 1 session | Every box test above passes against the built image and a real Postgres holding the fixture; `box_reader` reads only the view; the image runs read-only as non-root with every capability dropped; `contract.ts` imports nothing; nothing in the application imports it; no image is pushed and nothing is deployed |
| C1b | `sandbox-schema`. **Built 2026-11-15** on `feat/sandbox-box-schema` after Marlin's yes to the migration by name that day, see "Decided in slice C1b" | Prisma migration `20261115000000_custom_code` (`custom_code_blobs`, `custom_code_audit`, `custom_code_proposals`, `sites.custom_code_enabled`, the function `box_document` of D18 instead of the view), the grant of EXECUTE on it in `prisma/sql/box-reader.sql` (no password in it, applied by the operator in O1), the `deploy/README.md` section, and the box's integration suite pointed at the real migration instead of the fixture | C1a, #394 merged, **Marlin's yes to the migration** | 1 session | The box's integration suite passes against the migrated schema; `box_reader` may call only `box_document`, reads no table and never gets the code of a blob that is not live; the migration is additive and applies on a database without `box_reader` |
| O1 | `sandbox-domain-and-host` (operator, not a worker). **Repository half built 2026-11-17 on `feat/sandbox-box-deploy`,** see "Decided in step O1 (repository half)"; the operator half (infra repository, Coolify, Infisical, DNS, monitors) is open | Infra repo: Cloudflare zone and records in Terraform, Infisical project `framer-clone-box` and its machine identity, Coolify application, `box_reader` applied, five Kuma monitors. In this repository: the Infisical client and login entrypoint in `Dockerfile.box`, and the push, webhook and health poll steps in `box.yml` | C1a, C1b, **M2 bought** | Half a day | `curl` with and without fetch metadata headers gives 200 and 403 on `run.<domain>`; certificates valid; no `Set-Cookie`; all monitors green; abuse page answers |
| C2 | `sandbox-element`. **Built 2026-11-16 on `feat/sandbox-element`,** see "Decided in slice C2" | `src/lib/customCode/customCode.ts` (pure parse), `src/lib/renderer/customCode/customCodeElement.tsx`, `renderComponentNode.tsx`, `createComponentElement.tsx`, `blockedNodes.ts`, `renderVocabulary.ts`, `previewSafe.ts`, `src/components/CustomCodeSurface.tsx` with `EditorApp.tsx` and `PreviewMount.tsx` (the surface context), `middleware.ts` and `src/lib/site/cspReportOnly.ts` (enforced `frame-src`, D6), `src/lib/consent/consent.ts` and `MapEmbedIsland.tsx` (D48), `PreviewShell.tsx` and `src/lib/site/sitePath.ts` (D49), `applyBindings.ts` (D98); no registry entry (D43), `HeadlessComponentRenderer.tsx` unchanged | C1a | 2 sessions | Renderer tests above; the map embed still loads after consent with the header enforced; the standalone preview route carries the enforced `frame-src` (a middleware route test); no `iframe` in the mounted editor; `renderer` collision tag |
| C3 | `sandbox-bridge`. **Built 2026-11-17 on `feat/sandbox-bridge`,** see "Decided in slice C3" | `src/lib/customCode/broker.ts`, `CustomCodeIsland.tsx`, the shell client in `contract.ts`, `runtime.ts` (third lazy chunk), size test (broker at most 2 kilobytes gzipped, as the behaviour plan holds) | C2, B4 | 3 sessions | Bridge tests above in three engines; a page without blocks loads no broker byte; the focus watch proven or replaced with the proof attached |
| C4 | `sandbox-authoring` | `POST /api/projects/[projectId]/custom-code` and its read, `permissions.ts` (`manageCustomCode`), `CustomCodeSection.tsx` with CodeMirror, insert menu entry, Layers badge, model action, audit writes, the author API reference page in `docs/` | C3, B11 | 3 sessions | Hash covers the declaration (a changed declaration is a new hash); every refusal returns its reason; all four stateful paths; `pnpm test:integration`. The insert entry and the route are behind `CUSTOM_CODE_AVAILABLE`, off in production until C7 |
| C5 | `sandbox-lifecycle` | `src/server/sites/repository.ts` (blob pruning with revisions), `src/server/sites/erase.ts` (D9), publish dialog listing, `publishCheck.ts` warnings, proposals (D7): `propose_custom_code` in the site operations, the importer's "Propose as custom code", the panel's Accept, `POST /api/internal/custom-code/block` | C4 | 2 sessions | Rollback to a revision whose blob was blocked shows the fallback; an erase inside code rewrites the hash in every kept revision in one transaction; a proposal never reaches the box; an agent key cannot write a hash |
| C6 | `sandbox-escape-suite` | `test/sandbox/escape.spec.ts` and hostile fixtures, a path-filtered workflow on `src/lib/customCode/**`, `services/box/**` and the suite, `events.score.ts`, `report.ts`, `exclusions.json`, `samples.json` | C5 | 3 sessions | Every probe above, in Chromium, WebKit and Firefox, against the real box image; residuals asserted as residuals; the score rows the behaviour plan lists |
| C7 | `sandbox-switch-on` | Enable dialog with the reviewed wording in `SiteSettingsDialog.tsx`, privacy page template line in `src/lib/legal/`, `CUSTOM_CODE_AVAILABLE` on, the abuse page text, the canary site | C6, O1, **M9, M10** | 1 session | Production browser proof: enable on a test site, add a block, publish, see it run on `*.sites.lumitra.co`, disable and see the fallback within six minutes, the kill switch, the canary monitor green |
| C8 | `sandbox-assets-and-shelf` (proposed) | Box routes `/asset/<siteId>/<sha256>` and `/lib/<name>@<version>/<file>`, the shelf build from pinned npm tarballs with recorded licences, `custom_code_assets` table, asset upload in the panel, the widened document policy, the `viewport` read, multi-file code, the escape suite extended | C7, **M11 to M15** | 3 sessions | Escape suite extended: a frame can reach only its own site's assets and the shelf, never another site's assets or another host; the forcing case fixture runs; erase lists assets |

Total C1 to C7: about 17 sessions plus O1; with C8 about 20. B4 and B11 are behaviour slices already planned or merged. Only C2 touches
the renderer files. C1 and O1 are the only ones touching infrastructure.

## Decided in slice C1a, say so if you disagree

Slice C1a was built on 2026-11-12 on the branch `feat/sandbox-box-service`: the box service, the contract module, its image and a workflow that builds and tests. It deploys nothing and is connected to nothing. These decisions were taken while building it. Each narrows what the accepted contract allows; none widens what a frame can reach or where it can be embedded.

**D13. A branch preview host is never a frame ancestor.** This plan was written on 2026-11-02. Site branches slice S8 (pull request #376, 2026-11-12) added public preview links at `preview-<token>.<sites base host>` (`src/lib/sites/previewHost.ts`), which neither this plan nor the behaviour plan knew. How they meet framing, read from `src/middleware.ts`: every answer of a preview host carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so a preview page is never framed itself, but nothing stops it from *framing* a box document if its host were listed in the box's `frame-ancestors`. A preview address is a secret held by whoever has the link, it is served without a session, and it shows a branch nobody published. So preview hosts are left out, in two places that do not depend on each other: the view `box_documents` leaves out every subdomain label that starts with `preview-`, and the box drops every host whose first label starts with `preview-`, under whatever domain, before it writes the header. A block therefore shows its fallback on a preview link. The cost: a customer's own domain that happens to start with `preview-` also gets the fallback. **Letting preview links run blocks would widen where a frame may be embedded and is the sandbox's security design, which is Marlin's; it needs its own decided design** (at least: whether a link holder who is not a workspace member should run a draft's code, and how the box learns that a token is live). Revisit point: slice C2.

**D14. `frame-ancestors` holds exact host names only.** Every entry the view gives must be a lower case host name with at least two labels: no wildcard, scheme, port, path, address literal or white space. Anything else is dropped, never repaired, and at most 32 hosts of a site are named. One `*.sites.lumitra.co` entry would let every site and every preview link frame the code, and a semicolon or a line break in a stored host name would add a directive or a header. When nothing valid is left the header says `frame-ancestors 'none'`. The editor host is checked the same way at start, and the box does not start with one that fails.

**D15. Removing the WebRTC constructors does not hold against a fresh realm; C6 probes it.** The shell makes the six names non-configurable and `undefined` where the engine allows that on its window object, and deletes them where it does not. Either way the constructor the document started with is gone. But a script can create an empty nested frame (`about:blank`), which `frame-src 'none'` is not expected to refuse and which is expected to share the opaque origin, and read a fresh `RTCPeerConnection` from its window (through `contentWindow`, `window[0]`, `frames` or `contentDocument.defaultView`, so guarding one of them closes nothing). The behaviour plan already calls the removal "a mitigation, not a boundary"; this names the route. Two things are unproven here and must not be relied on: whether any engine enforces the `webrtc 'block'` directive, and how Firefox treats a fixed property on its window. None of this was run in a browser in this slice: slice C6 probes the fresh-realm route, the directive and the shell's result in all three engines, and records each as closed or as a stated residual. Nothing is switched on before C6.

**D16. The box does not serve unless it is told to.** The kill switch is on unless `CUSTOM_CODE_DISABLED` is exactly `0`. Unset, empty, `1`, `false` or a typing mistake all mean every block answers 410. The accepted contract says the variable being set switches everything off; this makes "not decided" behave the same, so a box started by accident serves nothing. The operator sets `0` in O1. **For C2:** the application's side of the switch must read the variable the same way (`0` serves, everything else is off), so that one value means the same on both sides.

**D17. C1 is split into C1a and C1b.** The service and the contract (C1a) need no database change and no deploy. The migration, the role file and the deploy section (C1b) put three tables, a column and a view into the next production deploy, because `boot.sh` runs `prisma migrate deploy` at every start, and they touch `prisma/schema.prisma` and `deploy/README.md` while pull request #394 is changing both. So C1b waits for #394 and for Marlin's yes to the migration by name. Until then the box's integration tests run against `services/box/test/integration/fixture.sql`, which is a test fixture and states the columns C1b has to meet. The image holds no Infisical client and the workflow pushes nothing; both come with O1.

**D18. The box calls one function, not a view; it gets labels and custom host names, and never code that is not live.** D3 said the box's role reads a view `box_documents` with a `frame_ancestors` column. Two things are wrong with that, both found while building and in the security review of this slice:

- **The database cannot build the hosts.** It stores a platform subdomain as its label (`SiteDomain.subdomain`), and both the sites base host and the editor host are configuration (`PUBLIC_SITE_BASE_HOST`, `EDITOR_HOST`). So the database gives `subdomain_labels` and `custom_hostnames` (live claims only: verified or active), both empty unless the pair is live (review 29: the box refuses such a pair without them, so it is not told the host names), and the box builds `<label>.<BOX_SITES_BASE_HOST>` from a label that is one plain DNS label and adds its own `BOX_EDITOR_HOST`. A custom host name that is the sites base host or a name under it is dropped, so one site cannot name another site's platform address through its custom domain.
- **A view can be listed.** `SELECT * FROM box_documents` would hand every site id, every hash, every live document (drafts included) and every host name to whoever holds the role's password, which is not "what the box serves to anyone anyway": the box serves a document only to someone who already knows the pair. So the contract is a function, `box_document(site_id text, sha256 text)`, `SECURITY DEFINER` with a fixed `search_path`, returning at most one row of `document`, `live`, `subdomain_labels`, `custom_hostnames`. `EXECUTE` is revoked from PUBLIC and granted to `box_reader`, which has no right on any table or view. `document` is NULL unless `live`, so the role never gets the code of a blocked blob or of a site that switched custom code off.

This replaces the view and the `frame_ancestors` column of D3 for slice C1b. `services/box/test/integration/fixture.sql` stated it exactly (until C1b replaced the fixture with the real migration, D31), and the box's integration tests hold the role to it with the one error code each forbidden statement must fail with.

**D19. The document is `private` and varies by the two fetch metadata headers.** D5 said `Cache-Control: public, max-age=300`. The answer depends on `Sec-Fetch-Dest` and `Sec-Fetch-Site`: a shared cache put in front of the box later would otherwise hand the document to a direct visit. So the document goes out with `Cache-Control: private, max-age=300` and `Vary: Sec-Fetch-Dest, Sec-Fetch-Site`. The visitor's browser still keeps it for five minutes, so the six-minute bound on a disabled block is unchanged.

**D20. What a stolen `box_reader` password can still do, and what C1b has to decide about it.** With D18 it cannot read a row of any application table, list what the function could answer, write an application row or create a temporary table (the fixture revokes `TEMPORARY` from PUBLIC in its scratch database). "Cannot read or write" means application rows, nothing wider. What remains, from the security reviews of this slice; the first four are asserted as residuals in the box's integration tests so a change in either direction is noticed, the rest are from the Postgres documentation and are for C1b to test:

- It can ask for a pair it knows, as the box does.
- It can hold the role's four connections. The role's timeouts (statement 2 seconds, idle in transaction 5 seconds, idle session 60 seconds) are defaults a session can change, so they bound the box and not a thief.
- **It can take an advisory lock.** Every role can, and the application uses advisory locks (`src/server/commerce/provisioning/ownerSql.ts`, `src/server/forms/repository.ts`); `prisma migrate deploy`, which runs at every container start, takes one too. A session that holds the right lock number could keep the application from starting or a form from being written until it is ended.
- **It can read the catalogs:** the names of every table, column, function and role, and the text of functions. Never a row.
- **It can change itself:** its own password, and its own role defaults (for example a statement timeout of one millisecond, which would stop the box and survive a password rotation until an operator resets it).
- **It can use what PUBLIC may use:** create large objects, fill disk with the temporary files of a large sort, connect to other databases of the same cluster, call any function left executable by PUBLIC, and cancel or end the box's own sessions.

Closing these means changing privileges in the production database (revoking from PUBLIC what the application's own roles are then granted by name: `EXECUTE` on the advisory lock functions, `TEMPORARY` and `CONNECT` on the databases, large object creation; a `temp_file_limit` for the role; a role that cannot alter itself, with its defaults set and checked by the operator's script), or giving the box a database of its own that the application fills. Both change production privileges or the storage design, which the fleet plan reserves for Marlin, so **none of it was decided here: it was a question for Marlin before C1b**, recorded in the coordinator inbox on 2026-11-12. He answered on 2026-11-14 for offline preparation only, see D24. The recommendation is the revoke-and-grant, written into `prisma/sql/box-reader.sql` and applied by the operator in O1, because it is one idempotent file and needs no second database; C1b's tests then assert each point above as closed.

**D24. Option A for the box's database role is prepared and rehearsed offline; applying it is not approved.** On 2026-11-14 Marlin approved preparing and rehearsing the first way of closing D20: take from PUBLIC what the box's role should not have and give it by name to the roles that need it. The approval is for offline preparation only. **The production privilege change and the migration are not approved; each still needs his yes by name, with the default and the rollback stated.**

What exists, on the branch `feat/sandbox-box-role-rehearsal`, stacked on the box's pull request and applied by nothing (no start script, no workflow, no migration):

- `prisma/sql/box-reader.sql`: the role `box_reader` (no login, no password, at most 4 connections, no temporary files, its timeouts, and since C1b a search path of `pg_catalog` only, D33 below) and, in the database it is applied to: `EXECUTE` on every advisory lock function taken from PUBLIC and given by name to `commerce_app` and `commerce_ddl`; `EXECUTE` on every large object function, and on `pg_logical_emit_message` (it writes straight to the write-ahead log), taken from PUBLIC and given to nobody; `CONNECT` taken from PUBLIC and given by name to the two commerce roles and `box_reader`. It grants nothing on the application's tables or functions (since C1b it also grants EXECUTE on `box_document` if the migration has made it, D25).
- `prisma/sql/box-reader-rollback.sql`: in three steps, shuts the box out (no login, no grant of `CONNECT` by name, committed), ends its sessions and looks again after a second until none is left (a login caught mid-startup appears only at its end), then gives PUBLIC those rights back in one transaction.
- `prisma/sql/box-reader-preflight.sql`: read only. Run on the real database first; it lists what the rehearsal cannot know (roles that would lose their connection right, other roles that may need the lock functions, whether the Prisma role is a superuser, large objects, functions PUBLIC may execute, other databases PUBLIC may connect to, any right PUBLIC holds on a table, view, sequence, single column or schema, and default privileges for PUBLIC).
- `src/server/commerce/provisioning/__tests__/box-reader-roles.itest.ts`: the rehearsal, on a throwaway Postgres 16 built the way a deploy builds it (the commerce roles file, the Prisma tier as the superuser, the start step and a company as the non-superuser `commerce_ddl`).

What the rehearsal showed:

- **The application depends on exactly what the file grants.** With the lock functions only taken from PUBLIC, the start step and provisioning as `commerce_ddl`, a Books lock, its shared form and the asset delete trigger as `commerce_app` all fail; with the file applied they all work. The Prisma role is the bootstrap superuser (deploy/README.md) and needs no grant.
- **TEMPORARY needs no grant.** `commerce-roles.sql` already takes it from PUBLIC, and `commerce_app` does without; the first description of option A ("grant temporary tables to the application roles") was wrong and would have widened access.
- **`box_reader` by allow-list:** it may connect to the one database, and holds no right on any table, view or sequence, no schema to create in, no lock function, no large object function, no direct write to the write-ahead log. Tried as the role: twenty-one things a thief would reach for are refused, among them the lock `prisma migrate` takes, a large object, a temporary table, ending or cancelling a session of the application, lifting its own temporary file limit. A sort that needs a temporary file fails. A fifth connection is refused.
- **A finding outside the file:** PUBLIC, and so `box_reader`, may execute four functions in `public`, because Postgres gives EXECUTE on every new function to PUBLIC: the trigger functions of the site branches migrations. A trigger function cannot be called directly (tried: refused), so nothing follows from these four. The test pins the list, so a new function there, above all one that is not a trigger function, fails the test and has to be looked at. Whether the application's migrations should take EXECUTE from PUBLIC by default is a question for C1b.
- **Left to someone who holds the role's password. None of it reads or writes a row of the application.** Held as stated residuals by the rehearsal: it reads the catalogs and the statistics views (names, row counts per table, who is connected; not the text of another role's statements); it changes its own password and its own defaults, also for one database, and a one millisecond statement timeout set that way stops the box and survives a password rotation until the file is re-applied (shown: every statement of a new session is cancelled; re-applying resets every default, for every database); it lifts its own session timeouts; it ends sessions of its own role; it can make a migration wait, because preparing a statement on a table it may not read takes a lock on it before any right is checked (shown); it may send notifications (`pg_notify` and the `NOTIFY` command, which checks no right, so taking `pg_notify` from PUBLIC would close nothing), raise its own working memory and use transaction ids. Known from how Postgres works and not rehearsed: the notification queue is kept on disk and can grow to several gigabytes while a session of the role listens with a transaction left open; an open transaction holds back vacuum; four connections can use processor time and memory; neither a new password nor re-applying the file ends a session the thief already holds (gate 5).
- **The file does not protect the disk.** In the other databases of the cluster (`postgres`, `template1`), while PUBLIC may connect to them, the role has what PUBLIC has there: the rehearsal shows it writing a large object and a temporary table in `postgres`, on the same disk. Closing that is gate 4 below. Even after it, the notification queue above stays: the file narrows how the role can use the disk, it does not protect it. The file's header says so in capitals.
- **A re-run takes away what was added by hand** (a membership in either direction, the power to create databases or roles, a grant by name of what the file took from PUBLIC): shown. **Re-applying `commerce-roles.sql` afterwards changes nothing.** The role file runs in one transaction, whole or not at all (shown: stopped partway by an event trigger, nothing of it stays).
- **The rollback** first takes the box's login and its grant of `CONNECT` by name and commits, then ends every session the role has open and checks they are gone (stopping with an error, before PUBLIC gets anything, if one is left), and only then gives PUBLIC its rights back in one transaction, as `has_function_privilege` and `has_database_privilege` report them (the stored access lists are not byte for byte what they were). So no session of the box runs with PUBLIC's rights back, short of a startup slower than a second (a login past its checks when step 1 commits that appears in the list of sessions more than a second later is not seen). Shown: in the last step, held at its first grant on a function, the box has no session and a login as it is refused; the test waits for that step's own pause (the trigger names its session), not for the one-second sleep of step 2. Stopped in that last step, it leaves the box shut out and PUBLIC with nothing back (shown), the safe side; run again, it finishes, also under a statement timeout shorter than step 2's wait, because step 2 lifts it for its session (shown, with 500 milliseconds). The three files set `ON_ERROR_STOP` themselves: run with plain `psql -f`, without `-v ON_ERROR_STOP=1`, while a session of the box cannot be ended, the rollback stops at step 2's error with a non-zero exit status, the box stays shut out and PUBLIC gets nothing back (shown); the role file, stopped partway that way, exits non-zero too (shown). Step 3's safety does not rest on any psql setting: its check (that `box_reader` cannot log in and has no session, with the list of sessions read afresh) and every grant are one statement, so a failed check undoes all of it, whether or not autocommit is on (with it off, steps 2 and 3 share one transaction, which changes nothing of this), and also under psql's `ON_ERROR_ROLLBACK`, which undoes only the statement that failed (shown: step 3 run alone by plain `psql`, once while the box can log in and once while it has a session, and once more with `-X -v ON_ERROR_ROLLBACK=on`, gives PUBLIC nothing). Both files also set `ON_ERROR_ROLLBACK off` themselves. For the role file that matters where an error does not end the run (pasted into an interactive session): its checks are separate statements inside one transaction, and with the setting off a failed statement leaves the transaction failed, so nothing commits (shown: the role file without its `ON_ERROR_STOP` line, stopped partway under `ON_ERROR_ROLLBACK=on`, leaves nothing). For the rollback it changes nothing the rehearsal can see: steps 1 and 3 are each one statement inside `BEGIN` and `COMMIT`, and step 2 is a `SET` plus one statement, so no failed statement can be skipped over on the way to the grants; it is kept so both files behave alike. Both headers say to run them with `psql -f` and never to paste them, or part of them, into an interactive session, where an error returns to the prompt and the pasted rest would go on. The rollback's header also says it never runs at the same time as the operator's role script (O1): step 3's check takes no lock on the role, so a `LOGIN` committed during step 3 would undo it.
- **Every file the operator applies as a superuser sets its own search path** (`pg_catalog, pg_temp`): `box-reader.sql`, its rollback, its preflight and `commerce-roles.sql`. Under the default path (`"$user", public`) an unqualified call picks a function in `public` with a closer argument type over the built-in (`pg_sleep(integer)` for `pg_sleep(1)`, `format(text, name)` for `format('%I', current_database())`), and `commerce_ddl` may create functions in `public`; the seventh review made `commerce_ddl` a superuser that way. Shown: as `commerce_ddl`, five such functions are planted in `public`; one of them wins when the superuser calls it under the default path (the control); with them in place the four files are applied as the operator applies them, none of the planted functions runs, and `commerce_ddl` holds exactly what it held. None of the four files names an object in `public` or `ext` that would need the default path; the role and job suites that apply `commerce-roles.sql` still pass. The case that shows the rollback stopping by itself without `-v ON_ERROR_STOP=1` used a `pg_terminate_backend` shadowed through the search path, which the file's own path now defeats; it runs a copy of the rollback with only that line cut, so it shows that the file's `ON_ERROR_STOP` ends the run at step 2's error, not that a session can outlast step 2 in the real file. **This covers only these four files, not the application's own superuser connection:** that wider class is the roadmap's database role hardening line, tracked in the infra repository, not by this pull request. It never grants `lo_import` or `lo_export` (they read and write files of the server and were never PUBLIC's). The file can be applied again after it. It assumes PUBLIC held Postgres' defaults before. The preflight shows that only for `CONNECT` on the database and the advisory lock functions, not for the large object functions or `pg_logical_emit_message`, which the rollback also gives back.
- **A dump and restore:** the rights on the catalog functions travel with a plain dump; the right to connect to the database does not. So the file is applied again after any restore, as `commerce-roles.sql` is.
- **Weakened forty-two ways, against the files and the test of the commit "test(sandbox): every search path weakening and step 3's fresh look fail in the rehearsal"** (2026-11-16, `/tmp/ovinv/box-role-rehearsal/mutations-of-e4045673-final.txt`, script `/tmp/rolemutate9.py`; the record's SQL files and test are byte-identical to the branch head's): the seven of the first version (no grant to the commerce roles, locks left with PUBLIC, large objects left with PUBLIC, CONNECT left with PUBLIC, no temporary file limit, no connection limit, defaults not put back), sixteen for the rules added after it (defaults for one database not reset; the role file without `BEGIN` and `COMMIT`, or without `BEGIN`; `pg_logical_emit_message` left with PUBLIC; in the rollback: the session step removed, the sessions not ended, steps 1 and 2 in one transaction, the sessions ended before the login is taken, no second look after the wait, `lo_import` and `lo_export` granted, the last step without `BEGIN` and `COMMIT` or without `BEGIN`, the old order with PUBLIC's rights given first, the sessions ended only after them, `pg_logical_emit_message` not given back, the login not taken), seven for the fourth review's changes (the box let back in during step 3 only; `ON_ERROR_STOP` not set by the rollback; the statement timeout not lifted; dropped columns listed by section 11; section 12b ignoring Postgres' built-in default, or ignoring an entry for every schema; the section 12 headings quoted the shell way, which psql prints with stray quotes), three for the fifth's (step 3 not checking again; `ON_ERROR_STOP` not set by the role file; 12b leaving out roles that own only schemas; the first try of the last one, in the previous record, was malformed and is corrected here), three for the sixth's (step 3 split back into a check statement and separate grants; `ON_ERROR_ROLLBACK off` not set by the rollback, or by the role file) and four for the seventh's (the search path not set by each of the four files, each caught by the planted-functions case) and one for the eighth's (step 3 not reading the list of sessions afresh, caught by the autocommit-off case). Forty of the forty-one failed an expectation. One survived: `ON_ERROR_ROLLBACK off` removed from the rollback, as expected, since no step of the rollback holds a failed statement that could be skipped over on the way to the grants (see above). Step 3 without `BEGIN` and `COMMIT` is now held by the order of the statements only: as one statement, it is whole or nothing without them. What holds the rollback's order: steps 1 and 2 in one transaction, and the sessions ended before the login is taken, do not fail the pause test, which looks in step 3, where the login change is committed either way. They are caught by the order of the statements in the file and, by behaviour, by the plain-`psql` case: when step 2 fails, the box must already be shut out, and with either weakening it is not. The race they stand for, a login that starts between the end of the sessions and the committed `NOLOGIN`, is held by the order of the statements, and is also refused by step 3's own check whenever such a session is visible by then. The second look is held the same two ways (without it the guard never raises). Its window of a few milliseconds cannot be hit on purpose. The forty-second run is a control: the step-3-only weakening with the test's look put back to "any session sleeping". In the previous record the pause test then passed, which showed what the step-3-only look buys; now step 3's own check stops that weakening first, so the control fails the same six cases as the weakening (the record lists them) and no longer isolates the look. Not weakened: `ON_ERROR_STOP` in the preflight (read only). The rehearsal has 34 cases.
- **Reviewed nine times** by fresh agents without the author's reasoning. The first review (of the first version): four medium and three low findings, all acted on. The second (`/tmp/ovinv/REVIEW-9-box-role-option-A.md`, of the changes for the first): two medium findings (the rollback ended the box's sessions before its login was taken away for good, so a session could start meanwhile and keep PUBLIC's rights; the disk was described as protected after the operator step) and eleven low or informational ones, all acted on in the files, the test and this text. The third (`/tmp/ovinv/REVIEW-10-box-role-option-A.md`, of the changes for the second) found every earlier finding resolved and nothing above low: a login caught mid-startup could slip past the single look of step 2, no test held the order of steps 1 and 2, grants on single columns and default privileges were not in the preflight, and smaller points. All acted on in the commits "fix(sandbox): the box rollback shuts the box out before PUBLIC gets anything back" to "fix(sandbox): the box rollback looks again for late logins; tests pin its order". The fourth (`/tmp/ovinv/REVIEW-13-pr442-head-0de8d808.md`, of the branch at "docs(sandbox): the production preflight result and the third review in D24") found one medium problem: the pause test's look matched step 2's new one-second sleep, so it looked during step 2, not step 3. And low or informational ones: step 2's stop depended on a `psql` flag the file did not set (without it, PUBLIC got its rights back with exit status 0); section 12 of the preflight did not show what its heading said (with no entry, Postgres' built-in default leaves new functions open to PUBLIC, and a global entry lists PUBLIC though nobody named it); section 11 listed dropped columns; no case made sections 11 and 12 return a row; gate 2 rested on a run without sections 11 and 12; commit hashes not on the branch were cited; "ever" overstated the rollback; and three small points. All acted on in the commits from "test(sandbox): the rollback pause test looks in step 3 only" to "fix(sandbox): the preflight's section 12 headings quote for psql", and weakened as above. The fifth (`/tmp/ovinv/REVIEW-14-pr442-head-3496dbf0.md`, of the branch at "docs(sandbox): the preflight's sections 11 and 12 run on production, gate 2 passed") found every finding of the fourth resolved and nothing above low: 12b answered only for every schema and could say `f` while new functions in one schema were open to PUBLIC, and it skipped roles owning only schemas or types; stopping before step 3 still depended on how psql was run (pasted into an interactive session, the rest would go on); the role file's `ON_ERROR_STOP` was never weakened; and two informational points (unqualified catalog names, `transaction_timeout` on Postgres 17), each now a sentence in the rollback's header, plus three overlong lines. All acted on in "fix(sandbox): the box rollback checks again in step 3; 12b speaks for every schema", and weakened as above. The sixth (`/tmp/ovinv/REVIEW-15-pr442-head-f9cddbc6.md`, of the branch at "docs(sandbox): the widened preflight section 12b run on production") found nothing above low: step 3's check was a separate statement, so under `ON_ERROR_ROLLBACK` the grants after a failed check ran and committed (shown by the reviewer in a container); the step-3-alone case did not re-apply the role file when it failed; and informational points (the race sentence above, one overlong line, the search path and `transaction_timeout` sentences, roles that own nothing in 12b). All acted on in "fix(sandbox): the box rollback's step 3 is one statement, check and grants together". Decided while acting on it, say so if you disagree: every comment line of the role file and the rollback now fits the header width of 80; code lines and the preflight's printed headings stay wider, as they were, and the role file's checks stay separate statements (the whole file is one transaction, and with `ON_ERROR_ROLLBACK off` a failed check cannot be skipped over). The seventh (`/tmp/ovinv/REVIEW-16-pr442-head-e33ec152.md`, of the branch at "docs(sandbox): the box role plan records the sixth review and one-statement step 3") found nothing above low, but one security finding: the files ran unqualified calls as a superuser under the default search path, and a function `commerce_ddl` planted in `public` made it a superuser (shown by the reviewer in a container; `commerce-roles.sql` had the same pattern). And informational points: with autocommit off, step 3's count reused step 2's last look; "one statement, in one transaction" and "however it was run" were too broad; step 3's check takes no lock, so it must never run alongside the operator's role script; a partial paste of the role file could leave it half applied. All acted on in "fix(sandbox): the box role files and commerce-roles.sql set their own search path"; the search path of `commerce-roles.sql` is fixed in this pull request too (decided by the coordinator). The eighth (`/tmp/ovinv/REVIEW-17-pr442-head-02aae2f6.md`, of the branch at "docs(sandbox): the box role plan records the seventh review and the search path") found nothing above low within this pull request: step 3's fresh look was untested, the planted-functions case was only a partial control (now each file's copy without its `SET` line must fire its own planted functions, and a box session is open before each rollback), stale wording here, and the preflight's section 5 now printing names with their schema (its heading says so). Its one medium finding is outside this pull request, see the search path point above. All acted on in "test(sandbox): every search path weakening and step 3's fresh look fail in the rehearsal". The ninth (of those fixes) called the pull request ready to merge and found three low points: a plan sentence named the details of the open route above, which this public repository must not carry (rewritten, and the commit that carried it replaced); the autocommit-off case's wait could match an idle moment before step 2 (now tied to step 2's own statement; the fresh-look weakening is still caught); two wording slips. A short fresh review of exactly that difference confirmed all three, and asked for this sentence. Decided while acting on it, say so if you disagree: `pg_logical_emit_message` is taken from PUBLIC as well (nothing in the repository uses it, and it lets any role write to the write-ahead log); `pg_notify` is left, because the `NOTIFY` command needs no right. This widens what gate 1 asks to approve by that one function.

**The preflight on the production database** (gate 2), run read-only on 2026-11-15 22:19 from the commit now on the branch as "test(sandbox): the rollback pause test fails at once when the rollback stops early" (rebased since; its box files did not change), with Marlin's yes of that day, through the RUNBOOK route (SSH to the shared server, `psql` in the framer-clone database container, `default_transaction_read_only` on): clean and as rehearsed. No login role would lose its connection right; no non-superuser role besides the two commerce roles; the Prisma role `framer_clone` is the only superuser; no large objects; the only functions PUBLIC may execute outside the system schemas are the four trigger functions of the site branches migrations; PUBLIC holds `CONNECT` on the database and may execute the advisory lock functions (Postgres' defaults for the two rights the preflight checks; it does not check the large object functions or `pg_logical_emit_message`, which the rollback also gives back); PUBLIC may connect to `postgres` and `template1`; 21 advisory lock functions open to PUBLIC (the file is not applied); no right of PUBLIC on any table, view or sequence; on schemas only `USAGE` on `public`. Sections 11 and 12 (single columns, default privileges; 12 is now 12a and 12b) were added after that run, so the whole preflight was run again read-only on 2026-11-16 00:57 from the commit "docs(sandbox): the box role plan cites the weakening run of the final files", the same route and the same yes: sections 1 to 10 showed exactly the results above; section 11 none; section 12a none; section 12b `t` for both owners, `commerce_ddl` and `framer_clone` (Postgres' built-in default: a function a migration creates later is open to PUBLIC until that migration takes it away, which the rehearsal pins for this repository's migrations). As expected, so gate 3, a second rehearsal on a copy of production, is not needed. After that run 12b was widened to roles that own only schemas or types (fifth review). So the whole preflight was run read-only once more on 2026-11-16 01:26 from the commit "docs(sandbox): the box role plan records the fifth review and step 3's own check": sections 1 to 11 and 12a unchanged, and 12b still lists only `commerce_ddl` and `framer_clone`, both `t` (`commerce_app` owns nothing on production).

**Gates before production. Gate 2 is passed (above, all twelve sections); the others are not:**

1. **Marlin's yes by name** to applying `box-reader.sql` to the production database. Default if he says nothing: not applied. Rollback: `box-reader-rollback.sql`, one command, and the box is not deployed anyway.
2. **The preflight on the real database, read by a person.** The rehearsal database is built from this repository, not copied from production. Any login role there that connects only through PUBLIC would be locked out; any role there that takes advisory locks, or calls `pg_logical_emit_message` (replication or change capture), and is not one of the two commerce roles would start failing.
3. **A copy of production, not of the migrations,** for a second rehearsal if the preflight lists anything unexpected.
4. **Other databases of the cluster.** `box_reader` can connect to them while PUBLIC may. Closing that is cluster-wide (or a `pg_hba.conf` rule) and belongs to the operator step O1. Since C1b (review 11, finding 7): the migration's check for the role is cluster-wide, so any other database of the cluster that runs it (a restore rehearsal, a copy) grants EXECUTE on `box_document` to `box_reader` without the file's hardening there; the same O1 step covers it.
5. **The operator's role script** (infra repository): it gives `box_reader` its login and password, checks the role's defaults on every run (the role can change them for itself), and after rotating the password and re-applying the file ends every session of `box_reader`, because neither ends a session a thief already holds.
6. **The migration of C1b,** with its own yes: the tables, the function `box_document` and the grant of EXECUTE on it to `box_reader`. **Given by Marlin by name on 2026-11-15** and built that day (see "Decided in slice C1b"); it reaches production with the boot of the first deployment that contains it.

**D21. No `Cross-Origin-Opener-Policy`.** D5 listed `Cross-Origin-Opener-Policy: same-origin` as a harmless extra for a direct visit. It is not harmless: the HTML standard makes a top-level document that has both a `sandbox` policy and an opener policy a network error, so the plain page that says what the domain is, with the abuse contact, would never show in a browser, while `curl` would show it. The header is dropped from every answer. Nothing is lost: a browser ignores the header on a document in a frame, which is the only way a block is ever served, and the answers a direct visit can get (the plain page, the refusals, the health checks) are plain text that runs no script. Not run in a browser in this slice, and the reading of the standard is from memory; O1's check "abuse page answers" must open the page in a browser, not only with `curl`.

**D22. Corrections to "The box service" above, from building it.**

- **The kill switch takes a restart of the box.** The plan says the variable is "read on every request, so it is immediate". It is read on every request, but a running process's environment does not change, so switching it means restarting the container (seconds), as the abuse handling list already says ("through Infisical and a restart"). Blocking one blob or one site needs no restart and reaches the box within the 60 second cache.
- **Time is measured with a clock that only goes forward,** so a step of the wall clock cannot keep a taken-down block in the cache.
- **The rate limit counts an IPv6 client by its /56,** an IPv4 client by its address. Visitors whose provider puts several of them into one /56 share a bucket, as visitors behind one IPv4 address do. Someone who holds a much larger IPv6 range, or many addresses, gets a bucket for each; what bounds the damage then is the cap of 64 lookups in flight (the rest get 503) and the separate cache of misses. A flood of that kind is to be stopped in front of the box, at the proxy; the box's 429 and 503 counts are the signal.
- **One connection may have four requests waiting for their answers,** and a connection that sends more is closed, so a client cannot have hundreds of documents prepared and held for a socket it does not read.
- **One connection to the database.** The box's pool holds one connection, and the driver sends calls down it one behind the other without waiting for each answer. The price, accepted: one slow statement delays every call behind it by up to the 2 second statement timeout, and when the whole database is slow, calls behind two slow statements are given up on at 3 seconds. It is bounded (each caller ends at 3 seconds, each statement at 2, and after 24 given-up calls the pool is thrown away, which empties the line), and it depends on the database honouring the statement timeout the box asks for at login. That is plenty for a lookup by primary key behind a 60 second cache, and it removes the states that were hard to get right: with two connections, one could fail while the other was busy. An old pool and its replacement together are two of the role's four connections.
- **A database that is slow, or goes silent.** A call is given up on after 3 seconds, queueing and connecting included, and its caller gets 503. That alone changes nothing else: a database that is busy but answering keeps its connection, so one slow call cannot fail the others. The pool is thrown away when it gave no answer at all, to any call, since the given-up call began, or once 24 of its calls were given up on whatever answered meanwhile. Only an error the database itself sent counts as an answer, never a network error. A pool that is thrown away has its socket closed for real (the box opens the sockets itself) and opens no more; a new pool takes its place and service returns by itself. A connection has 2 seconds to open, less than the 3 seconds of a call, so a slow connect fails as itself. Nothing is cancelled through a second connection, and a promise nobody waited for is logged and never ends the process.
- **A database that refuses, or accepts and hangs up.** A connection that ends within a second of being tried is followed by a pause, twice as long each time up to two seconds. During the pause no connection is opened and a call fails at once with 503, so a database that is restarting is neither flooded with connections nor waited for. A socket the driver asks for during a pause is not opened; it is closed a moment later with an error and never starts or lengthens the pause, so a pause cannot keep itself going. The pause is in place by the time the failed socket reports its error. The driver's own growing wait between attempts is switched off; this pause is the one wait there is. These rules are in `services/box/src/socketGate.ts`, apart from the driver. The module takes its clock and its sockets from outside, so every rule about time is tested with a clock the test moves and a socket the test drives: each pause length exactly, and each boundary stood on (a socket asked for one millisecond before a pause ends is not opened; at the end it is). The same rules are run against real sockets too, without tight timing. Tests on real time must never ask whether a pause is running and then act on the answer a moment later; one did, and failed once in many runs.
- **The database address is read once, by the box,** and the driver is given its parts, never the text: one host by name or IPv4 address, a role, a database, no control character in any of them, and no parameter but `sslmode=disable`. So no parameter in the address can lift the statement timeout or add a startup parameter, and the host the box checked is the host it connects to.
- **For O1:** the image has no shell, so the planned login entrypoint cannot be a shell script. Either Coolify hands `BOX_DATABASE_URL` to the container as its environment, or the entrypoint is a small node script; O1 decides, and the Infisical client is then one more file in the image, not a shell.

**D23. No encryption between the box and the database in this version; an address that asks for it is refused.** The plan puts the box on the same server as the database, on the database's own Docker network ("Deploy"), which is the case this version is built for. The exact-head security review found that with the box opening its own sockets, `sslmode=verify-full` checked the database's certificate against the name "localhost" for an IPv4 host and sent no server name, so the address promised a check it did not make. Building that properly (a certificate checked against the checked host, a server name, tests with a private certificate authority, the driver's listener handling on an encrypted socket) is more than this slice, so it is not half built: the address parser accepts only `sslmode=disable` or no `sslmode`, and the box does not start with anything else. **If O1 puts the database anywhere but a private network shared with the box, encryption has to be built and reviewed first;** that is a condition on O1, written here so it is not found out in production.

**Exceptions from the exact-head review, each with its reason.** Everything else that review found is fixed in the slice.

- **Encryption to the database** is refused, not built (D23): it materially exceeds the slice, and refusing fails closed.
- **A database host given as an IPv6 address** is refused by the address parser. Supporting it means bracket handling that must match the driver's; no deployment in the plan needs it. A name or an IPv4 address works.
- **`sslmode=verify-ca` and every other parameter** in the address are refused by design: each is a way to change a limit or a check the box relies on.
- **`/health/db` reaches the database without the fetch metadata check.** By design: it is the operator's and the monitor's check, asks for a fixed pair no site can have, runs one at a time and at most once in five seconds.

**What C1a does beyond the plan's list of tests,** all in `services/box/test`: the fetch metadata refusal, the overall rate limit and a malformed address are answered before the database is asked; the rate limit remembers a bounded number of addresses; `X-Forwarded-For` is read only from a configured proxy, from the right, and only its end, whatever its length; an upper case or percent-encoded hash is not an address; a request body is never read; a connection on which nothing moves for 15 seconds is closed in either direction, so a client that asks for a document and never reads it does not keep its place, and one peer that is not a configured proxy holds at most 64 connections; a request Node would answer by itself with no policy (an `Expect` header, a request past the limit of one connection, a request that is not HTTP, is too large or too slow) gets no answer, the connection is closed, and a request without a `Host` header is answered by the box like any other; a flood of unknown addresses pushes out other remembered misses, never a remembered document; a database that is away, or frozen with its connections open, answers 503 in bounded time with no error text, and service resumes by itself when it is back; every answer the box writes carries a policy and no `Set-Cookie`; the image is the application's digest-pinned base with every shell and package manager removed, runs with a read-only root file system, every capability dropped and no new privileges, as a non-root user, and refuses to start as root or without its configuration.

**The box is its own package with its own checks.** The application's type check, lint and image context leave `services/` out (one line each in the root `tsconfig.json`, `eslint.config.mjs` and `.dockerignore`), so a change to the box cannot break the application's build and the reverse. The box workflow runs the box's own type check and lint, and also runs when one of those three root files changes. The contract module stays in `src/`, so the application's type check, lint and unit tests cover it, and the box's type check covers it a second time.

**Reviewed seven times.** Two fresh agents, one after the other, reviewed the slice as a security boundary without the author's reasoning; the second was briefed on hostile inputs and on failure and recovery, and removed 36 protections one at a time to see whether a test noticed. Neither found anything critical or high. A third reviewed only the fixes made after the second, and a fourth, a fifth, a sixth and a seventh each reviewed the exact head of the pull request at the time. The seventh found nothing above low. The medium findings were: a client that never reads its answer held a connection; the database role could list and do more than the plan said; the database timeout leaned on a cancel that could end the process or leave dead connections in place; D20 was incomplete; the first fix for a silent database replaced its connections also when the database was only busy; an address that asked for a checked certificate did not get the check it promised; the pause after a failed connection could keep itself going on a healthy database; and the tests did not hold three of the reconnect rules. After that last finding the socket rules were moved into a module of their own and the pool reduced to one connection, so that every rule has a test that fails when the rule is removed, checked by removing each in turn several times over. All findings are fixed in the slice or written down above as a stated residual, a correction or an exception with its reason (D15, D20 to D23). The pull request is held: it merges only on the coordinator's direction and a recorded approval of its exact final commit, given after a fresh review of that commit.

**Left for the slices that own them:** the bridge client in the shell (C3; the shell of C1a removes WebRTC and says `hello`), `http://localhost` as a frame ancestor for the local forcing-case fixture (it needs a development-only switch, decided with C8), the report route `/api/csp-report/box` on the editor host (C2; the box already names it in `report-uri`), and the text of the plain page (C7).

## Decided in slice C1b, say so if you disagree

Slice C1b was built on 2026-11-15 on the branch `feat/sandbox-box-schema`, after Marlin's yes to the migration by name that day. On 2026-11-16 it was rebased onto main once the box (#401), the role files (#442) and the commerce role change that takes CREATE on `public` from `commerce_ddl` (#447) had landed, its own changes unchanged, and every suite was run again. It reaches a real database only with a deploy, which applies the migration at the next start; `box-reader.sql` is not part of any deploy: the operator applies it separately (deploy/README.md). Where D3 and D18 are exact they were followed; where they left something open, the conservative option was taken and is written down here.

**D25. The grant of EXECUTE on `box_document` is made from both sides, each only if the other side's object exists.** `prisma migrate deploy` runs at every container start and on every fresh database (CI, local development, the other integration tests) without `box-reader.sql`, which the operator applies separately (deploy/README.md). So the migration always takes EXECUTE on `box_document` from PUBLIC and grants it to `box_reader` only in a `DO` block that finds the role; `box-reader.sql` grants it, inside its one transaction, only if `to_regprocedure` finds the function. Whichever order, the end state is EXECUTE for the function's owner and `box_reader`, nobody else. **Also when both run at the same time** (review 19, finding 2): each side's check sees only what is committed, so without more the migration could find no role and the file no function, and neither would grant. So both take the same transaction-level advisory lock, `pg_catalog.pg_advisory_xact_lock(7461001200)`, as a statement of its own before their check (each takes it first thing in its transaction, with `PERFORM` inside a `DO` block, so it prints nothing; review 20, finding 5) and hold it until they commit. The later side waits for the earlier one's commit, and under READ COMMITTED its check, a new statement, then sees the other side's object. The key is a fixed constant outside the int4 range, the range of every `pg_catalog.hashtext` key, so it equals none of the repository's fixed keys (74610010 and 74610011 in the application, 74610020 in a test fixture, Prisma's own 72707369, and the small keys of the tests, all in that range); keys made with `pg_catalog.hashtextextended` span all 64 bits, and a collision with one of them is negligible (about 2^-64 per key; review 20, finding 3). The migration takes it first rather than right before its check: a migration that has to wait for the role file then waits before it locks `sites`, so no site request waits behind it meanwhile. The rehearsal holds both orders of that race, each with the real `prisma migrate deploy` and the real `box-reader.sql` (review 20, finding 4): the migration, from a copy of the migrations folder whose C1b migration gets one extra statement after the lock that waits for the test, held open while `box-reader.sql` is seen waiting on the lock; and `box-reader.sql`, held open before its commit, while the migration is seen waiting on it. Each time `box_reader` may execute `box_document` afterwards. **The operator's side of the lock** (review 20, finding 2): a session left open on `box-reader.sql` (an error under `\i`, an interrupted paste) holds the lock and stops a container start that applies migration `20261115000000_custom_code` (the first deploy with it, or one after its rollback), so the file is applied only with `psql -X -v ON_ERROR_STOP=1 -f`, and such a session is ended at once (deploy/README.md, the file's header). Decided, say so if you disagree: the migration gets no `lock_timeout` (a migration that times out is recorded as failed and blocks every later start), and `box-reader.sql` gets none either: while it waits for a running migration it holds nothing anyone waits for (the lock is its first statement after `BEGIN`), so waiting harms no one, and a timeout would only add a failure the operator must retry; it would not bound how long the file holds the lock, which is the case that matters. The rehearsal holds both orders on one cluster (migration then file in the first database, file then migration in a second) and compares the rights and the stored access list; it also holds that a database without the role migrates (exit status 0, with the role absent at that moment). `box-reader-rollback.sql` needs nothing for it: without a login the role cannot use the grant, and re-applying `box-reader.sql` restores it. A dump restore runs no migration: it carries `_prisma_migrations` and the grants, which name `commerce_app`, `commerce_ddl` and `box_reader`, so in a fresh cluster the restore stops at the first role that does not exist (review 19, finding 3: with only `box_reader` created it stopped at `commerce_ddl`). Before restoring into a fresh cluster, create the three roles bare, as superuser (`CREATE ROLE commerce_app NOLOGIN; CREATE ROLE commerce_ddl NOLOGIN; CREATE ROLE box_reader NOLOGIN`), restore, then apply `commerce-roles.sql` and `box-reader.sql`, which give them their shape (deploy/README.md). Applying `commerce-roles.sql` before the restore would break it: its `CREATE SCHEMA IF NOT EXISTS ext` makes the dump's own `CREATE SCHEMA ext` fail.

**D26. `box_document` is owned by the role that runs the migrations,** in production the bootstrap superuser (deploy/README.md), so a `SECURITY DEFINER` call runs as a superuser. What bounds it: `LANGUAGE sql` with no dynamic SQL, a fixed `search_path` of `pg_catalog, pg_temp`, every table schema-qualified, `STABLE`, and the two parameters only compared for equality (the box's suite tries hostile text in both and gets nothing). A dedicated, unprivileged owner role holding `SELECT` on the three tables would bound it further, but it is a new role in the production cluster, the kind of privilege change the fleet plan reserves for Marlin; it was not created. Revisit if the function ever grows beyond a lookup by key.

**D27. Immutability and the append-only audit are held by triggers, not grants.** D3 says the app role gets no update or delete on the audit. The application writes every site table as the Prisma role, the bootstrap superuser, whom no grant restrains, and `commerce_app` and `commerce_ddl` hold no right on the Prisma tables at all. So nothing is granted to anyone, and two `BEFORE UPDATE` triggers do the work: a blob may change only `blocked_at` (the takedown and its reversal), and an audit row may never change. Deleting stays possible on both: D4 prunes unnamed blobs, D9 rewrites a blob under a new hash and deletes the old row, and erasing a company deletes its audit rows. **Done in this slice (review 12):** `src/server/erasure/public.ts` deletes a company's `custom_code_audit` rows by site or workspace, in the same batches as `site_operation_audits`; blobs and proposals go with the site by cascade; the takedown list of D32 is deliberately not erased (it names hashes, no person). The company erasure integration test seeds a blob, a proposal and an audit row and shows them gone, and shows a listed hash still there.

**D28. Each function this migration creates has EXECUTE taken from PUBLIC; nothing wider was changed.** D24 left open whether the application's migrations should take EXECUTE from PUBLIC by default. This migration does it for its own three functions (`box_document` and its two trigger functions; a trigger fires without the right), so the list of functions PUBLIC may execute stays the four trigger functions of the site branches migrations, and the rehearsal pins that list for PUBLIC and for `box_reader` separately. Changing default privileges, or taking the right from the four existing functions, would change production privileges beyond this slice and was left. Recommendation, not decided: every later migration that creates a function takes EXECUTE from PUBLIC in the same file; the rehearsal's pinned list is what notices one that does not.

**D29. The tables, where D3 and D7 left the columns open.**

- `custom_code_blobs`: exactly D3's columns. Added: a `CHECK` that `sha256` is 64 lower case hex characters (the box asks for nothing else) and that `declaration` is a JSON object; a foreign key to `sites` with `ON DELETE CASCADE`, so deleting a site deletes its code. **No `CHECK` on the size of `document`:** the per-block limit (262144 bytes) is enforced by the guarded write route of a later slice and, as the backstop the box relies on, by `box_document`, which gives no document above it. A table constraint would need a migration with every change of the limit and would make the function's own guard untestable.
- `custom_code_audit`: D3's columns; `sha256` and `detail` may be NULL (enable and disable concern no blob); a `CHECK` on the seven actions of D3 and on the hash's form.
- `custom_code_proposals` (D7 named its content, not its columns): `id`, `site_id`, `workspace_id` and `tenant_group_id` (the isolation columns every site-keyed table of this repository carries, with the composite foreign key to `sites (id, workspace_id)` and `ON DELETE CASCADE`), `source` (`import` or `agent`, by `CHECK`), `document`, `declaration` (a JSON object), `title`, `created_by`, `created_at`. No accepted or rejected state: accepting writes a blob and an audit row, and what happens to the proposal row then is for the slice that builds the panel.
- Times are `TIMESTAMP(3)` as Prisma writes them everywhere in this schema; the fixture's `timestamptz` was not kept (the box reads no time).

**D30. `live` follows D18 exactly, also for a branch row.** A site branch is a hidden `sites` row with its own `custom_code_enabled`, default false, which nothing sets. A branch holds no domain (a trigger), so it would never get a host name from the function anyway. Whether a branch's draft blocks run in the editor's own preview is for the slices that build the switch and the element (C2, C5), within D13.

**D31. The box's integration suite builds its database from the committed files, through `psql`.** `services/box/test/integration/docker.ts` applies, in production's order, `commerce-roles.sql`, every `prisma/migrations/*/migration.sql` sorted by folder name (each in one transaction, as Prisma would), then `box-reader.sql`, then gives `box_reader` a login and a random password as O1's script will. The box's package has no Prisma, and its workflow installs only the box, so `psql` runs the files. `fixture.sql` is deleted; its contract text is now the migration's header. The fixture's stand-in table is replaced by a real one (`site_erasures`), and the D20 residual "it can take an advisory lock" became a refusal there, because `box-reader.sql` closes it (D24). `box.yml` now also runs on changes under `prisma/migrations` and `prisma/sql`. The rehearsal of D24 has 45 cases (29 before this slice; seven came with it, holding both orders, the call, the tables' own rules, the takedown list of D32, that the commerce roles hold no right on the new tables, and the migration's `rollback.sql`; it had grown to the 41 review 19 counted; review 19 added four: the structural check that both sides take the grant lock, the two orders of the race of D25, and the rollback's own search path of D35) and tries 24 refusals as the role (21 before: reading each of the three new tables was added); the counts in D24 are those of its own day.

**D32. A takedown outlives the blob row and its site (decided by the coordinator after review 11, finding 4).** D3 says a blocked blob is refused "on any site", but `blocked_at` lives on one site's blob row, which D4's pruning, D9's erase and a site delete all remove, and the `blob-block` audit row can go with a company erasure. So the migration adds `custom_code_blocked_hashes` (`sha256` as primary key with the blobs' format check, `blocked_at`, `blocked_by`, `reason`), with no foreign key to any site, deleted neither with a site nor by a company erasure, written like every site table by the Prisma role and granted to nobody. `box_document` treats a listed hash as not live (no document), exactly like `blocked_at`, which stays as it is. The rehearsal shows a listed hash served on no site, and still blocked after its blob rows and sites are deleted and the same code is written again under the same hash on a new site. For the slice that builds the takedown route: write the hash to this list, and have the guarded write route refuse a listed hash.

**D33. `box_reader` searches `pg_catalog` only, and the box names every object with its schema (review 11, finding 1).** `commerce_ddl` keeps CREATE on the database, so it may create schemas there; since #447 (the change that takes CREATE on `public` from it), `commerce-roles.sql` leaves it CREATE on `public` only until the first start has run the public migrations and the file is applied again (review 19, finding 5). A `public.to_json(text[])` it planted would match the box's unqualified `to_json` better than the catalog's, and a schema named `box_reader` would be searched first (as `"$user"`) for `box_document`; either could change the host list or the whole answer. `services/box/src/store.ts` now calls `pg_catalog.to_json` and `public.box_document`, and `box-reader.sql` sets the role's `search_path` to `pg_catalog`, role-wide, re-set on every run like its other defaults. The box's integration suite plants both as `commerce_ddl`, in the state before `commerce-roles.sql` is applied again after the first start (it still has CREATE on `public` there), and shows the box gets the same answer; the rehearsal pins the new default. A session can still change its own search path (a residual like the timeouts of D20); what matters is that the box's own sessions do not search a schema that role can write. Residual (review 12): `commerce_ddl` can still add an overload of `public.box_document` (for example one with a third argument that has a default) and so make the box's call ambiguous. That is a denial of service by a role that already owns all the application's commerce data, never a planted answer: the qualified call either reaches the real function or fails. `services/box/test/store.test.ts` pins both qualifiers in the statement text.

**D34. `custom_code_blocked_hashes.blocked_by` holds an operator label, never a person's id (review 19, finding 4; decided, say so if you disagree).** A company erasure keeps the takedown list on purpose (D32), so nothing in it may name a person, or an erased company's user would outlive the erasure there. The schema's comment said "the operator or auth-brain user who blocked it", and the erasure's comment said the list "names hashes, no person"; only the second may be true. The only value written so far, in every test, is the label `operator`, and the plan's takedown route is the operator's (an operator token). So the migration holds the format with a `CHECK`: `operator`, optionally followed by a colon and lower case words joined by hyphens (`operator:abuse-report`), at most 64 characters. Any value containing a digit or anything but that shape is refused, so an id (a UUID, for one) fits neither alone nor behind the label. Pseudonymising the column at erasure instead was not chosen: a takedown made by a company's own user is a decision of a later slice, and that slice can widen the format then, with the erasure in view. The `reason` column is free text for the abuse record; it must name no person either (the schema's comment says so), which no constraint can hold. The rehearsal shows a user id, a label with a user id and another word refused, and a label with a channel taken.

**D35. The migrations' rollback files set their own search path (review 19, finding 1).** Like every file the operator applies as a superuser (D24, "Every file the operator applies as a superuser sets its own search path"), the three hand-run `rollback.sql` files (`20261112200000_site_models`, `20261112300000_site_model_coordination`, `20261115000000_custom_code`) now start with `SET search_path = pg_catalog, pg_temp;` and name every object with its schema (`pg_catalog.to_regclass('public._prisma_migrations')`, `DELETE FROM "public"."_prisma_migrations"`), so what they drop and delete does not depend on the session's search path, which differs between databases, rebuilds and sessions. The same holds for the hand-run snippet of `20261104000000_site_last_write_key` in deploy/README.md. `src/server/__tests__/migrationRollbacks.test.ts` holds that shape for every `rollback.sql`, and fails closed: each statement line must match one of a short list of allowed shapes that name every object with the application's schema `public` (never Prisma's history table, except the one shape that deletes the file's own row), and any line, a comment included, that holds a character outside printable ASCII (a carriage return included), a backslash, or `$$` other than on the allowed `DO $$` and `END $$;` lines is refused (review 27: inside a `DO` block psql reads a comment as part of the quoted body, so a `$$` there would end the body and run the rest of the line, a psql command included); the file's own history row may be deleted only when the migration folder's name has Prisma's form (fourteen digits, an underscore, lower-case letters, digits and underscores; review 28: a quote in the name would end the SQL string and run the rest of the name), and a migration folder holds no file but `migration.sql` and `rollback.sql`, both named exactly, no line may drop with `CASCADE` (it reaches whatever depends on the object, in any schema, which no line names; review 29), and the documented command runs psql with `-X`, so the operator's own `~/.psqlrc` cannot switch `ON_ERROR_STOP` off or `ON_ERROR_ROLLBACK` on and let a failing rollback commit half done (review 29), so a line of any other kind (dynamic SQL, `\gexec`, an inline comment, a comment psql would end early) fails until a shape for it is added on purpose (four reviews of a detector that tried to read every possible statement each found a new gap, so it was replaced), and the rehearsal runs this migration's rollback with plain `psql` under a session search path that differs from the file's, with a copy without the `SET` line and the qualifiers as its control.
## Decided in step O1 (repository half), say so if you disagree

Built on 2026-11-17 on the branch `feat/sandbox-box-deploy`: the Infisical client and a start program in the box's image, and the push, deploy and health poll in its workflow. Nothing was deployed, no secret was read or written and no infrastructure was touched. `box_reader` is already applied to production (`prisma/sql/box-reader.sql`, with slice C1b); the migration that creates `box_document` reaches production with the next deploy of main. The rest of the operator half of O1 (the domain's records, the Infisical project and identity, the Coolify application, the GitHub environment and variable, the monitors) is still to do, and what it has to set is listed in `services/box/README.md` ("Deploying") and `deploy/README.md` ("The box").

**D50. The box gets its one secret from Infisical at start, through a small node start program, not from Coolify's environment.** D22 left this open because the image has no shell. The alternative, Coolify handing `BOX_DATABASE_URL` to the container directly, is simpler (no client in the image, no dependency on Infisical at start) and was weighed against it. Infisical wins because it is what D12 decided and how every other service of the stack is run: the value has one home, it is rotated in Infisical and a restart picks it up, reads of it are in Infisical's audit log, and it does not sit in Coolify, whose interface and API show environment values to anyone with access. The start program (`services/box/src/launch.ts`, bundled to `/opt/box/launch.cjs`) runs under `tini` as process 1, logs in with `infisical login --method=universal-auth --silent --plain` (client id and secret in the client's environment, never on a command line, the token read from a pipe and never written), then runs the box inside `infisical run` with the token in that process's environment and the box behind `env -u INFISICAL_TOKEN`, so the box's own environment holds `BOX_DATABASE_URL` and no credential. Everything `infisical run` and the box write to standard error passes through the start program a line at a time with every credential taken out, since the client holds the token while it runs. It passes SIGTERM and SIGINT on and ends with the status of `infisical run`; a missing or malformed variable stops it with 78, a refused or hanging (30 seconds) login with 69, each with one line naming what is wrong and never a value. **What this does not buy, stated so it is not overclaimed:** the client secret is in the container's environment, so whoever can read Coolify's environment can also read the database address through Infisical; and the box runs as the same user as the start program and `infisical run`, so code running inside the box can read their environments (the client secret, the token) from `/proc`. D12 still holds in both cases because the box's identity can read one value, the one the box already has. Measured cost, on the image test's limits (read-only root, 0.5 CPU, 256 megabytes, 64 processes): about 30 processes and threads and about 40 to 60 megabytes for the whole container while serving (the higher figure since the start program asks `/health` while the box starts, D58); the image grows by the client, about 150 megabytes, kept byte for byte as released so its checksum means something. A box that restarts while Infisical is down does not start; a running box is not affected.

**D51. A box that refuses its configuration ends the container with status 1, not 78.** `infisical run` reports a child that failed as its own status 1 (its source: `execBasicCmd` returns the wait error, and `run` exits 1). The box's own line (`box: BOX_DATABASE_URL ...`), the client's `exit status 78` and the start program's `infisical run ended with status 1` are in the log, and Coolify only needs a status that is not 0. A fetch of the secrets that Infisical refuses (a wrong project id, an identity without access) also ends with 1, with the client's own reason in the log and no box started. Keeping 78 would mean dropping `infisical run` for a fetch-then-start of our own; not worth a second way of running secrets for one number. The start program's own refusals (its variables, root, the login) still end with 78 and 69.

**D52. The start program reads five variables and drops every other `INFISICAL_` variable.** Required: the client id and secret, `INFISICAL_PROJECT_ID` and `INFISICAL_ENVIRONMENT` (no default: a box that guessed its environment would be wrong quietly). Optional: `INFISICAL_DOMAIN`, default `https://infisical.lumitra.co`, https and a host only, with plain http accepted only for a host without a dot (a container name; the image test's stand-in for Infisical is one), because the test must point the real client somewhere and the client would send the client secret to whatever it is pointed at. Every other `INFISICAL_` variable of the container is dropped before the client starts. **`infisical run` gets an allow-list, not the container's environment:** `PATH`, `HOME`, `NODE_ENV`, `TZ`, `CUSTOM_CODE_DISABLED` and the `BOX_` settings (never `BOX_DATABASE_URL`), and both client calls get `--log-level=error --log-destination=stderr` on their command lines, which the client prefers over `LOG_LEVEL` and `LOG_DESTINATION`. The second review found the gap this closes: with `LOG_LEVEL=debug` on the container the client logs every variable it injects, the database address with its password among them, and `LOG_DESTINATION=stdout` sends its log past the redaction; a proxy variable would send the token through a proxy, and `NODE_OPTIONS` would reach the box. Refusing to start when such a variable is set was the alternative; an allow-list also covers the variables nobody has thought of yet, and a container that sets one still starts. `LOG_FORMAT` is dropped with the rest. What remains steerable is the container's own process, the start program, which runs before any of this and is the operator's. The client is started by its absolute path, with telemetry off (`INFISICAL_DISABLE_TELEMETRY`, `DO_NOT_TRACK`) and `GOMAXPROCS=2`, because every thread counts against the container's process limit. **The start program refuses `BOX_DATABASE_URL` on the container:** a copy there would be a second home for the secret, the one forgotten at rotation.

**D53. The workflow publishes only from main, only the image it tested, and only once O1 is done.** On a push to main when the box's own files changed since the commit running in `box-production` (D56, D59), or a manual run on main, the image the suite just tested is handed to the publish job as an artifact and pushed to `ghcr.io/<owner>/framer-clone-box` under the commit's tag, never rebuilt, and the Coolify application is pointed **at the digest the push reports**, not at a tag, through Coolify's API before the deploy is started (`services/box/ci/deploy.ts`, tested against a stand-in for Coolify); there is no `latest`. Only the publish job asks to write packages, but that does not protect the registry: any workflow on any branch of the repository can ask for `packages: write` without naming the environment, and push or overwrite a tag. So production never follows a tag. Coolify 4.7.5 (the version the instance reports) treats an image tag of the form `sha256-<hex>` as a digest and deploys `<image>@sha256:<hex>` (its deployment job, read from the source at that tag), so the application's `docker_registry_image_tag` is set to that form; a redeploy in Coolify then pulls the same image, whatever any tag holds. **The first deploy in O1 proves it** (deploy/README.md, step 4); this was read from Coolify's source, not tried. If Coolify refuses the form (the tag call fails, or the deployment fails to pull), the run fails before or without replacing the running container, and the fallback is a one-line change of `deploy.ts` to the commit's tag, with this decision reopened for the tag's weakness. **The Coolify token is limited to the box application** and has the read, write and deploy permissions, since Coolify's scoped tokens cover the application, deploy and deployment calls. Stated so it is not overclaimed (the fourth review): the limit is not a server boundary. Write on the box application alone can still set its run options (a privileged container, the Docker socket mounted) and its pre- and post-deployment commands, and Coolify's own documentation says so; setting the image needs write, so the permission cannot be narrowed. The limit only narrows what a stolen token reaches without effort. What bounds the risk is that only the two main-only `box-production` jobs can read the token, so a writer would first have to land a change on main, which the green-check merge allows and which is visible in the history. O1 adds a check that the box application's run options and commands stay as documented, and Coolify's allow-list of addresses for its API is a further option for the operator. The first deploy proves the limited token can make all three calls. **The deploy first lists the application's newest deployments** and refuses, changing nothing, when one is queued or in progress (the seventh review: Coolify would skip ours, and that deployment, starting during our polls, would read the tag we had just set while we put the old one back and reported failure; Coolify 4.7.5's `GET /api/v1/deployments/applications/{uuid}`, newest first, needs only read). **It then reads the application's tag** and, when it fails before a deployment started (the webhook refused, no deployment named, or three answers of 404 in a row, which is how Coolify answers a deploy it skipped because one is already queued or running), puts that tag back and names both images, so a restart or a redeploy from Coolify's interface never starts an image no run proved. The webhook asks `cancel_previous=queued`, which cancels older webhook deployments waiting for another commit or tag but not one already queued for this application: Coolify 4.7.5 checks for that first and skips ours (the fifth review), which the three 404s then catch, safely and loudly. If that queued deployment starts during the three polls, it runs the new digest while the run reports failure; the error names both images, and the operator checks Coolify. The webhook must be https (it carries the token), and each health call has a five second limit, so the follow and the tries fit the job's 30 minutes. The application is created with a plain image name and tag: one given with a digest at creation through the API gets `@sha256` appended to its stored name. Nothing is kept, pushed or deployed until the operator sets the repository variable `BOX_DEPLOY_ENABLED` to `true`; until then the run writes a notice and succeeds, so main stays green before the infrastructure exists and nothing half-published sits in the registry. Once it is set, missing deploy secrets fail the run loudly. A pull request never pushes or deploys. A newer push cancels an older run of a pull request. A running run on main is not cancelled, so a deploy that has started is finished and verified; a newer run waits, and of several waiting GitHub keeps only the newest. That newest run does not judge its own push but the change since the commit running in `box-production` (D59), so a run cancelled while waiting, or one whose deploy failed, is made good by the next run whatever that push touched. The deploy step fails the run on everything that leaves the deploy unproven: the image tag not taken, the webhook refused, no deployment named, a token that cannot read deployments, a deployment that fails, is cancelled by a user or is skipped (Coolify's statuses, read from its source), and no end within 15 minutes. It prints only status names it knows, never Coolify's answer. **Rolling back** sets the repository variable `BOX_DEPLOY_PINNED` and then runs the workflow by hand on main with the input `rollback_digest`: a rollback job in the same environment refuses unless the pin is set, checks that the image is in the registry and deploys exactly that digest, rebuilding nothing. The digest is taken from a publish run on main, since any branch with `packages: write` can add images to the package. **Rollback runs have a run group of their own** (the fourth review found that a push arriving while a rollback waited would replace it, GitHub keeping only the newest pending run of a group), and the two deploying jobs share one job-level group, so deploys never overlap; a pinned push skips its publish job and never enters that group. The third review showed why the pin is needed: without it the next push that runs the workflow (even one that only bumps `.nvmrc`) compares main with the rolled-back commit, finds the box change that was backed out and publishes it again, healthy and wrong. While pinned, `publishDecision.ts` publishes nothing, and the publish job is skipped by its own condition, so it never joins the deploy group where a rollback may wait; a manual run publishes main only with the input `publish_while_pinned`. While pinned a push still compares with the commit running in production and, when the database changed, its notice says to deploy the application before lifting the pin (D56). The pin is lifted by deploying the application first if a migration landed, then setting it to false and running the workflow by hand on main: the rollback job records main's commit as deployed in `box-production` (GitHub records the run's commit, not the image's), so without that run later pushes would see no box change and leave the rolled-back image running. A manual run with `publish_while_pinned` leaves the pin set; it is then set to false with no further run. **Re-running an older run is not a rollback.** A full re-run asks the decision again and is refused once production has moved past it. "Re-run failed jobs" keeps the box job's decision and artifact from the earlier attempt, so the fourth review found it could deploy an older image over a newer one and through the pin: the publish job now starts with a guard (`publishDecision.ts guard`, its own token, `deployments: read` and `actions: read`) that reads the pin again (unless a manual run with `publish_while_pinned`) and refuses unless the commit running in `box-production` is this run's commit or an ancestor of it, read from the comparison's status alone (identical or ahead, however many files changed). When nothing ever reached success it passes. A manual run with the input `override_guard` passes after the operator has checked, **on the first attempt of the run only** (`GITHUB_RUN_ATTEMPT` is 1): a GitHub re-run repeats the inputs for about 30 days, so the sixth review found an old override run could be re-run over a newer production, with no ancestry check and no database hold; a re-run of it is now refused, and the operator starts a new manual run. Binding the input to the commit the operator saw running was the alternative; the attempt number is simpler and needs no input to be typed right. The guard step passes only when the script printed its verdict line (`May publish: `), and both scripts compare their entry path by real path, so a script that ran but checked nothing (an entry check false through a symlinked path) fails the step instead of passing it silently. **Two assumptions are not yet verified** (the sixth review): that `vars.BOX_DEPLOY_PINNED` is read when the publish job starts, not when the run starts, which the job-level `if` and the guard's second reading of the pin rely on (the first O1 runs show it: a pin set while a run waits must skip its publish job); and the `log_url` shape `.../actions/runs/<run>/job/<job>` for a deployment made by a second or later attempt of a job, of which no example exists in this account's repositories (if it carries an attempt segment, the trust check finds what runs not known and fails loudly, and `override_guard` is the way out until the pattern is widened). The deploy names the token's permissions also when Coolify 4.7.5 answers a token without the deploy permission with 200, "Unauthorized to deploy this application" and no deployment id. **Each deploy has a short outage:** with Coolify's health check off (D55) the old container is replaced without waiting for the new one, which needs a few seconds to log in to Infisical and fetch its secret. **The image id check** across `docker save` and `docker load` relies on the runner's classic image store keeping the config id; on the containerd image store it would fail closed, loudly, and the first manual run in O1 proves which one the runner has.

**D54. The deploy waits for `/health/db`, not `/health`.** The plan's Deploy section and the brief name `/health`. The application's deploy learned that a liveness check goes green over a broken database (its comment in `deploy.yml`); `/health/db` calls the box's one function as `box_reader`, so a missing role, function or network fails the deploy loudly. The container's own health check stays `/health`, so a box whose database is briefly away is not restarted for it.

**D55. Corrections to "Deploy" above, from building it.** The image is the application's digest-pinned `node:22-bookworm-slim`, not `node:22-alpine` (decided in C1a). `tini` was not in the C1a image (node was process 1 and started no child); it is now, as the plan said, a statically linked release binary pinned by version and SHA-256 like the client, because the image now runs a chain of processes. The base image has no certificate authorities; the client's https needs them, so Debian's bundle is copied in from a build stage (apt checks its signature). Coolify sets more than the two Infisical variables: the project id, the environment slug and the box's own non-secret settings (`BOX_EDITOR_HOST` and the rest) are its environment too. The client needs no writable home and no temporary file system: the image test runs the real client on a read-only root file system with nothing mounted. **Coolify's own health check is switched off for the box** (the plan said "health check `/health` on 127.0.0.1"): when it is on, Coolify replaces the image's `HEALTHCHECK` with a shell command calling `curl` or `wget` (its deployment job says so), and this image has neither a shell nor either program, so every container would be reported unhealthy and no deploy could succeed. Switched off, the image's own exec-form check (node asks `/health` every 30 seconds) applies; O1's checklist includes seeing the deployed container reported healthy, because what Coolify does with a disabled check was read from its source, not tried on the deployed version. **Known, outside this repository:** the stack's shared deploy workflow (actions-shared, `coolify-deploy-verify`) prints Coolify's answer to the webhook and, on a timeout, the Coolify address derived from the webhook secret, which GitHub's masking does not cover. The box no longer uses it (D57); the application's deploy still does, and the fix belongs in actions-shared.

**D56. The box is deployed after the application, and a change to the database never deploys it by itself.** The box's `/health/db` calls `box_document`, which the application's migration creates, and the application's deploy (still started by hand) applies migrations; deploying the box first fails its deploy, and with Coolify's health check off (D55) the new container would already have replaced the old one, so production would answer 503 until the application is deployed. O1's steps say so: the application first, then the box. The workflow keeps the migrations, the role files, the root configuration and `.nvmrc` as triggers of its tests, since the box's integration suite builds its database from them, and publishes only when the box's own files (`services/box/`, the contract module, `Dockerfile.box` and its ignore file, `box.yml`) changed since the commit running in `box-production`. **When anything under `prisma/migrations` or `prisma/sql` changed since that commit, it does not publish, even when the box changed too:** it writes a notice telling the operator to deploy the application and then run the box workflow by hand on main, and a manual run always publishes. The notice repeats on every push until that manual run, since the change stays between main and what production runs. When nothing was ever deployed it publishes, unless this push alone shows a database change; when it cannot tell what production runs, it fails rather than publishes (D59). While `BOX_DEPLOY_PINNED` is set the comparison is still made, and a database change turns the pinned notice into one that says to deploy the application before lifting the pin, since lifting it always publishes. The alternative, the publish job asking production whether the function exists, needs a database connection from GitHub to production, which nothing else in the stack has; the order rule and the narrower trigger cost nothing.

**D57. The deploy secrets live in the GitHub environment `box-production`, main only, and the deploy is written into `box.yml`.** As repository secrets, any job of any workflow on any branch of the repository could read them, so a branch could hand them to a step of its own. In the environment, with main as its only deployment branch, only the one job that names it can, and only on main. That rules out the stack's shared deploy workflow: a called workflow cannot read the secrets of an environment it does not name itself, and the shared one names none. So the webhook call, the following of the Coolify deployment and the health poll are steps of the box's publish job, which prints nothing Coolify answers and masks the Coolify address (the known issue of the shared workflow in D55 does not reach the box). Whether to publish is a repository variable, `BOX_DEPLOY_ENABLED`, since a job outside the environment cannot see the environment's secrets. Every action is pinned by commit with its version in a comment, and `Dockerfile.box`'s build frontend by digest: a moved tag would otherwise run foreign code in a job that can write packages or deploy production. The image's id is recorded after `docker build` and checked before `docker save` and after `docker load`, so the image pushed is the one built, whatever ran in the tests between.

**D58. The box must answer `/health` within 60 seconds of `infisical run` starting, or the start is given up on.** The client sets no time limit on its own HTTP calls (its resty client is created without one), so a fetch of the secrets that Infisical accepts and never answers would leave a container running with no box and nothing in the log. The start program asks the box's `/health` where the image's health check does, every half second, and after the limit stops `infisical run` (SIGTERM, then SIGKILL after five seconds) and ends with 69 and a line saying so. `BOX_START_TIMEOUT_SECONDS` (1 to 600) changes the limit. Watching for the box's start line in its log was the alternative; asking `/health` checks what matters, and leaves the box's request log untouched on its way out. The login keeps its own 30 second limit. On "no usable token" the client's message is now passed on too, with every credential taken out, as on a refused login.

**D59. Whether to publish is judged against the commit running in production, by a small tested script.** The second review showed that comparing a push with its own previous commit loses box changes: a waiting run cancelled by a newer database-only push, or a deploy that failed, is never retried. `services/box/ci/publishDecision.ts` (run by node, which strips its types, with nothing installed) asks GitHub's Deployments API for the newest deployment to `box-production` whose latest status is success (the job token has `deployments: read` and nothing more than reading), and its compare API for the files changed from that commit to this one; a comparison through the API also works when the repository is private, where an anonymous `git fetch` would not. It publishes on a box change, holds back on a database change (D56), and stays quiet otherwise. It publishes, with a notice, when no deployment ever reached success. **When it cannot tell, the step fails:** the API failed or was rate limited, the newest success was not made by this workflow's deploying jobs, or the deployed commit is not an ancestor of this one. **A list of files cut at GitHub's 300 holds instead, with a notice** (the fifth review: the box deploys rarely in an active repository, so a cut list is likely and must not be permanent): the database hold cannot be checked, so the notice says to deploy the application if the database changed and then run the workflow by hand. It writes `publish=false` and an error naming the way out (re-run, or run the workflow by hand with `override_guard`), and it runs after the tests, so they report first. Publishing on not knowing (the second round's choice) was corrected by the third review: when a migration lies between production and main, a box published then replaces the running container and production answers 503 until the application is deployed, which is not "at most one deploy of an unchanged box". Failing loudly costs a re-run or a manual run; the decision asks GitHub nothing on a manual run, and the publish job's guard lets a manual run through with `override_guard` once the operator has checked what runs. **No state is permanent:** every refusal names its way out (a re-run, a manual run, `override_guard`, `publish_while_pinned`, or deploying the application first). While `BOX_DEPLOY_PINNED` is set, and on a manual rollback run, it publishes nothing (D53). **Only deployments this workflow's deploying jobs made count** (the fourth review, made workable by the fifth): a job with `environment:` creates its deployment itself, its creator is the run's actor (not `github-actions[bot]`), and every status of it names the job in its log address (`.../actions/runs/<run>/job/<job>`), as recorded from this repository's own environment deployments. A success is trusted when that address is on GitHub, its job (`/actions/jobs/<id>`, with `actions: read`) is the publish or rollback job, succeeded on main at the deployment's commit, and its run's workflow is `box.yml`. A deployment created through the API has the commit's checks page as its log address and is not trusted, nor is one by another job, workflow or branch: what runs is then unknown, and the run fails loudly. The first version asked for the creator and listed the commit's runs and jobs; it was built and tested on invented answers and could never pass on a real run (the publish job's own deployment is listed in progress while it runs, and the creator is the actor), so the tests now use answers recorded from this repository's API, including the running job's own in-progress deployment. **Only the end of the list without a success means none** (the first deploy): the deployments are read page by page (100 a page, newest first), passing over failed ones and the running job's own. The sixth review found that the first version read one page of 30 and took no success there as none, so 30 failed deploys (Coolify down a while, each run and re-run adding one) would have skipped the database hold and the guard's ancestry check. Each page is one GraphQL query that returns every deployment with its latest status (the seventh review: one call per row spent a large share of the run token's hourly allowance in exactly the state of many failed deploys), so a lookup costs a call per 100 rows plus the job and run of the success; a refused query (200 with errors and no data) is not known, and so is any answer carrying errors next to partial data (the eighth review: a status that failed to load comes back null and would read as none). That a job token with only `deployments: read` may read deployments through GraphQL is confirmed on the first run; if it may not, GitHub answers with errors, which fails safe and loudly with `override_guard` as the way out. At most two pages are read; no success among the newest 200 means not known, and the run fails loudly with `override_guard` as the way out. The decision step's error names `override_guard`, since without it a manual run's guard asks the same question and refuses again when the cause lasts. Reporting the build's commit from `/health` and comparing it after the deploy was considered for the case of an old container answering: with every deployment status that is not `finished` failing the run, and the application pointed at the exact digest first, a finished deployment runs that image, so it is not added.

**How it was tested.** `services/box/test/launch.test.ts` (44 tests) runs the start program against stand-ins for the client and the box, real processes that record their own command lines and environments: every missing or malformed variable, root, a refused login (its message passed on without any credential), a login that gives no token, one that hangs, a missing client, SIGTERM during the login, SIGTERM and SIGINT reaching the box, the run's status and a run ended by a signal, a refused fetch of the secrets (its message passed on without the token), a client secret and a token straddling the 16 kilobyte cut of a line without a newline (in one write, and split across two), a fetch that never ends and a box that never answers `/health` (both stopped at the time limit) and a box that answered in time (left alone), the time limit's own checks, and the start program bundled and run in a process of its own, where nothing else keeps it alive (it once ended with 0 there before reading the status, which only the image suite had caught), and no credential on any command line, in any log line or in the box's environment. The image suite now starts every box through the real entrypoint and the real Infisical client against a stand-in for Infisical (`test/integration/fakeInfisical.ts`) on its private network, and adds: each missing start variable and the database address on the container stop the box before Infisical is asked anything; a refused login ends with 69 and writes no credential; a project Infisical will not give ends with 1, the client's reason in the log, no box started and no credential written; a fetch Infisical never answers ends with 69 at the time limit; a running box has `tini` as process 1, the secret in its environment and no credential in its environment, in any process's command line or in the log; and `docker stop` ends the chain with status 0 within the grace period. Six rules of the start program were also removed on purpose, one at a time, and tests failed on an expectation each time (never by hanging): the token passed as an argument (1 test), signals not passed on (5), a missing variable tolerated (6), the token left in the box's environment (2), the login's message passed on without taking the credentials out (1), the standard error of `infisical run` passed on without taking them out (1). After the first review, five more: the old cut of a long line (2), no overlap kept at the cut (2), no time limit on the start (2), the client's message dropped on "no usable token" (1), and the start program's waits not holding the process open (1). After the second review: a JWT-shaped token straddling the cut (in one write, and in two writes cut inside its header and just after its first dot), where the cut may fall (`safeCut`), and an allow-list test with log, proxy and `NODE_OPTIONS` variables on the container; the image suite adds a box started with `LOG_LEVEL=debug`, `LOG_DESTINATION=stdout` and a proxy that is not there, which still starts and logs no credential and no database address, and the image's health check now starts after 60 seconds, the start program's default limit. `services/box/test/publishDecision.test.ts` (25 tests) covers the publish decision (D56, D59): pull requests and other branches, the variable off, a manual run, each box path, nothing of the box changed, a box change of a cancelled run, a migration, a role file and a migration with a box change held back, nothing deployed or not known, and the GitHub answers (failed, running and inactive deployments passed over, failed calls, a deployed commit that is not an ancestor, a cut file list, a renamed file). Four more rules removed on purpose: the token pattern applied to the part kept back (1 test failed), no move of the cut back to an `eyJ` run (1), no allow-list (3), no log flags (1); and four in the decision: this push judged instead of the deployed commit (10), no database hold (3), any deployment status taken as success (2), a diverged comparison trusted (1). The deploy step was run against a stand-in for Coolify: `finished` passes, and `failed`, `cancelled-by-user`, `skipped`, no deployment named, a 401 on reading the deployment, a 403 on setting the tag and no answer at all (`HTTP 000`) each fail the step. After the third review: `test/publishDecision.test.ts` (now 31 tests) adds the pin (no publish on a push, on a manual run without `publish_while_pinned`, or when what runs is unknown; a manual run with it publishes), the rollback run (publishes nothing, pinned or not), and the loud failure (an unknown deployed commit or comparison gives no publish and an error, and the script run as the workflow runs it exits 1 with `publish=false`). `test/deploy.test.ts` (19 tests) runs `ci/deploy.ts` against a stand-in for Coolify: the digest in the `sha256-<hex>` form, the calls in order with the token and the health check without it, the masks first and no address or token in the log, each failing status, a refused tag, webhook or read with the token hint naming read, write and deploy, no deployment or a malformed one, the 15 minute limit with unknown statuses never printed, `/health/db` never answering, and every malformed input refused before Coolify is asked. Rules removed on purpose: the pin ignored on a push (1 test failed), any manual run lifting the pin (1), an unknown deployed commit publishing (3), the error not failing the step (1), a rollback run also publishing (1); and in the deploy script, cancelled and skipped not failures (2), no deployment passing (1), a refused read polled on (1), the digest not in Coolify's form (1), the bare host not masked (1). After the fourth review: `test/publishDecision.test.ts` (now 39 tests) adds the guard (an ancestor or the same commit or nothing deployed passes; a deployed commit ahead or diverged, the pin, a run off main and an unknown deployed commit refuse; run as the workflow runs it, it fails the step while pinned), the trust check (a success by another creator, with no box.yml run on main, from another branch or file, or with no successful deploying job is not trusted; a rollback job counts), and the comparison while pinned (the database notice, and no failure when GitHub cannot be asked). `test/deploy.test.ts` (now 25 tests) adds the earlier tag read, named and put back on each failure before a deployment started, a failed put-back and a missing earlier tag reported, three 404s in a row ending the follow while a single one does not, `cancel_previous=queued`, the five second health limit, and a plain http webhook refused. Rules removed on purpose: the guard trusting any order (1 test failed), the guard ignoring the pin (2), any creator trusted (1), no deploying run needed (1), the database hidden by the pin (1), a skipped job counted (1); in the deploy script, 404s followed for 15 minutes (2), the earlier tag not put back (6), a plain http webhook accepted (1), no short health limit (1), 404s counted across other answers (1). After the fifth review: the trust check, the guard and the comparison were rewritten smaller and their tests moved onto answers recorded read-only from this repository's API (`test/fixtures/github`: the plugin-mirror deployment made by its job with all five statuses, its job and run, a production deployment made through the API, and comparisons ahead, behind and cut at 300 files). `test/publishDecision.test.ts` (now 45 tests) covers the first publish with only the running job's own in-progress deployment listed (none, and the guard passes), a recorded success made by the publish or rollback job (trusted), the recorded records unchanged and each changed field (job name, branch, conclusion, commit, run, workflow path, the run's branch, a log address elsewhere, an API deployment) not trusted, the guard passing a cut list, refusing behind and diverged with the way out, and `override_guard` passing a manual run but not a push. Rules removed on purpose: no success read as unknown (3 tests failed), the running job's own row not passed over (5), the workflow path not checked (1), the job name not checked (1), the log address's host not checked (1), the guard needing a whole file list (1), a cut list failing (2), `override_guard` on a push (1), decide ignoring ancestry (1). After the sixth review: `test/publishDecision.test.ts` (now 54 tests) adds a success found behind a full page of 100 failures on the second page (with 35 more failures), a full last page followed by an empty one (none), every page it may read full of failures (not known, and no third page asked), a later page that does not answer, `override_guard` refused on attempts 2, 7 and an absent attempt without asking GitHub, the guard's verdict printed when started through a symlinked path, and `box.yml`'s guard step run by bash as GitHub runs it (the real guard's verdict passes, a refusal fails showing the error, a script exiting 0 with nothing or another line fails). `test/deploy.test.ts` (now 27 tests) adds Coolify's "Unauthorized to deploy" answer (the earlier image put back, the token hint shown) and the script started through a symlinked path. Rules removed on purpose: one page read only (4 tests failed), the page limit meaning none (1), no attempt rule (1), the entry compared by plain path (1 each in both scripts), no verdict line (2), the step passing without a verdict (1), no hint on "Unauthorized to deploy" (1), the decision error without `override_guard` (2). After the seventh review: `test/publishDecision.test.ts` (now 55 tests) moves the lookup onto GraphQL answers recorded read-only from this repository (`graphql-deployments.json`, the plugin-mirror environment's three newest deployments with their latest statuses; `graphql-deployments-api.json`, the newest production deployment, made through the REST API), checks the query and its variables, passes cursors from page to page, and adds a refused query (not known); the REST fixtures for the per-row calls are removed. `test/deploy.test.ts` (now 32 tests) adds a deployment queued or in progress (refused, only the two reads made) and a list refused, unanswered or malformed (nothing changed, the token hint on 403). The image suite adds the image's own health check reading healthy (an interval and a start period of one second; a start period of 0s would mean the image's own 60 seconds, in which failures do not count), ending on either verdict. Rules removed on purpose: any latest status taken as success (8 tests failed), the first page taken as the end (4), no cursor passed on (2), a refused query read as none (1), no look at Coolify's deployments (2), in progress not counted as busy (1), a list Coolify refused ignored (2), and in the image the health check asking a path the box does not serve (the test failed on the status, unhealthy, after about nine seconds). After the eighth review, `test/publishDecision.test.ts` (now 56 tests) adds errors next to partial data (not known); with the errors check removed on purpose it and the refused-query case failed (2). The unit suite has 333 tests, the image suite 65.

## Decided in slice C2, say so if you disagree

Slice C2 was built on 2026-11-16 on the branch `feat/sandbox-element`: the stored value of a block and its parse
(`src/lib/customCode/customCode.ts`), the element on every surface (`src/lib/renderer/customCode/customCodeElement.tsx`),
the dispatch in both renderers, and the enforced `frame-src` from the middleware (D6). It draws no frame anywhere: the published
page and the standalone preview show the fallback until the island of C3 exists. It does not depend on C1b. Numbering continues
after D35, the last number of the C1b pull request.

**D36. The stored value is read strictly, and never reaches the DOM.** `props.customCode` is either `{ sha256, title }` or
`{ proposal, title }`, exactly those two keys, in a plain object. The hash must match the contract's pattern (64 lower case hex,
`BOX_SHA256_PATTERN`, reused from `contract.ts`). A proposal id is 1 to 64 characters of letters, digits, `_` and `-` (a UUID or a
similar token), so it can never be markup or a path. The title has its white space folded and is refused when it is empty, longer
than 200 characters or holds a control character. Anything else is invalid, and an invalid value, like a proposal, shows only the
fallback. The prop is kept off the element in four places that do not depend on each other: the server renderer's list of props
that are never attributes, the render gate's node settings (so it is dropped without a warning), the element itself, and the render
vocabulary, which now reserves `data-fc-custom-code` and its `-` forms, so a stored node cannot pass for a block or its tile.

**D37. The box's origin is one environment value, `SANDBOX_ORIGIN`, with no default.** No configuration for it existed. It must be
exactly `https://` and an exact host name (the contract's `isExactHostname`): no path, port, wildcard, address literal or second
source. Unset or malformed means no page may frame the box at all, so every block shows its fallback. A default naming
`run.lumitrausercontent.com` was rejected: the domain is registered (M2) but nothing is served on it until O1, and a default would
allow frames from a host before anyone decided to run the box there. A set but malformed value is logged at start
(`src/instrumentation.node.ts`) and does not refuse the start: the sites work, only custom code stays off. Documented in
`.env.example` and `deploy/README.md`. O1 sets it together with the kill switch.

**D38. The application's side of the kill switch is in the middleware.** D16 asked C2 to read `CUSTOM_CODE_DISABLED` the way the box
does. `isCustomCodeServing` reads it (only `0` serves), and a test holds it equal to the box's `isKillSwitchOn` for a dozen values.
While the switch is not `0`, the enforced `frame-src` leaves the box out, so no page can frame a block even if something drew a
frame. The renderers do not read the switch in C2, since they draw no frame. C3's island must take the same decision from the
server (never from `process.env` in the client bundle, which does not have it).

**D39. The enforced `frame-src` names the box and Google, not `'self'`.** On every published document the middleware sends
`Content-Security-Policy: frame-src https://run.<box domain>/box/`, plus `https://www.google.com` when the maps consent cookie is
set (the same switch the report-only policy uses), or `frame-src 'none'` when neither applies. The report-only policy measures
`frame-src 'self'`; the enforced one leaves `'self'` out because a published page holds exactly the two kinds of frame D6 names,
and no part of a published page frames its own origin. The same header carries `object-src 'none'` (added after the second review
of pull request #450): that review saw WebKit load an `object` and an `embed` from another host under `frame-src` alone, while the
render gate's WebKit build refused both as `frame-src` violations; `object-src 'none'` refuses them in every engine whichever way it
reads them, and no published page uses either. The standalone preview and branch preview hosts send it too. What no policy refuses: an `iframe srcdoc` or an `about:blank`
frame makes no request, so it runs in the page's own origin whatever `frame-src` says. The policy is a second line for frames and
plugins that load from somewhere; the render gate refusing `iframe`, `object` and `embed` stays the line that holds. The report-only
header is unchanged. **For C3:** once blocks run, the
report-only `frame-src` (which has no box) will report every box frame. C3 either adds the box there or drops `frame-src` from the
report-only policy, now that it is enforced.

**D40. The standalone preview route is matched by its exact shape.** `/projects/<id>/preview` on the normalized path (so `//Projects/x/%70review`
counts too, and `/projects/x/preview/extra` does not). Its header joins both directives in one value,
`frame-ancestors 'none'; frame-src ...`, because the frame guard adds `frame-ancestors 'none'` only where no policy is set yet; a
test asserts both. A signed-out request is redirected to the login and gets no frame policy (a redirect is not a document). Not
matched, and tested as such: the editor (`/projects/<id>`, with or without the preview over it), the dashboard, the approval and
review pages, Books, the catalogue and the demo preview `/preview`. The demo project lives only in the browser and has no site, so
no block of it can run anywhere.

**D41. Which preview draws the box is said by a context, and the default is the tile.** The preview over the editor and the
standalone preview both render through `PreviewShell` and `HeadlessComponentRenderer` in the same mode, so a surface signal is
needed. `CustomCodeSurfaceContext` defaults to "tile, no link". Only `PreviewMount` (the standalone route) says `standalone`; the
editor (`src/components/CustomCodeSurface.tsx`) gives the tile its link; the branch review pane and the demo preview keep the
default. The canvas always draws the tile, whatever the context says. The plan's "button to the standalone preview" is a link
(`target="_blank"`, `rel="noopener noreferrer"`): it opens the page in a new tab, which is what a button would do, and works
without script. The demo project's tile has no link.

**D42. On the editor surfaces the tile replaces the fallback.** As the map embed does, the tile fills the box and the fallback
children are not drawn on the canvas or in the preview over the editor. The Layers panel still lists them. How an author edits the
fallback (for example a switch in the panel that shows it instead of the tile) is C4's, with the panel section.

**D43. No registry entry in C2.** A `COMPONENT_REGISTRY` entry is an item of the insert menu and is taught to the generator; the
insert entry is C4 ("only on an enabled site"). So C2 changes neither `componentRegistry.ts` nor the panel's categories, and a block
reaches a page only as stored data. The generator and the review already refuse `customCode` in any spelling (`validate.ts`,
`ai/review/ops.ts`, both tested), as D7 requires.

**D44. A branch preview link shows the fallback, unchanged from D13.** D13 named C2 as its revisit point. Nothing is widened: a
preview host keeps its `frame-ancestors 'none'` and now also gets `frame-src 'none'` (changed after the first review of pull request
#450): a preview draws no frame at all (a map shows a notice, a block its fallback), so this refuses only a frame a stored page could
sneak past the render gate, the backstop the published plane has. Nothing frames a preview host, which already refuses being framed.
`previewSafeTree` takes `customCode` off every node, so a block on a preview link renders as its fallback with no mark an island could
act on. Letting preview links run blocks stays
Marlin's decision, with the design D13 asks for.

**D45. What the published page marks, and what it cannot know.** The server renders the node's own tag (a void tag becomes a
`div`, since a block holds children), its attributes and its children. Only a valid block carries
`data-fc-custom-code="<first 12 hex of the hash>"`; a proposal and an invalid value carry no mark and nothing of the stored
value. Whether a hash belongs to another site, or to no stored blob, the renderer cannot tell without a database read (C1b
is not merged, and the published render path has none for this): the box answers 404 for it (its lookup is keyed on the site and
the hash, D3), and since the page draws no frame in C2, the fallback is what shows.

**D46. Left for C3, deliberately.** The per-site `<meta>` that tightens `frame-src` to `/box/<siteId>/` (D6) and the limit of 4
blocks per page (the renderer warns for the rest) both only matter once a frame is drawn, so they come with the island. C2 draws
no frame on any surface.

**D47. The browser proof runs in the render gate job.** `test/renderGate/frameSrc.gate.ts` takes the headers from a real call of the
middleware, for a published page and for the standalone preview, with and without maps consent, serves a document with exactly
those headers in Chromium and WebKit, and tries three frames: the box, the map as its island builds it, and another host. It
asserts each frame's outcome (loaded, by a message from its document, or refused, by an enforced violation the page sees), so a
weakened policy fails on an expectation, not a timeout. Firefox is not covered there: the render gate installs Chromium and WebKit
only. The render gate fuzz has new probes for blocks carrying `src`, `srcdoc` and iframe markup, and for forged renderer
attributes.

**D48. A maps "yes" given on a page already loaded reloads the page.** The middleware reads the maps consent cookie into the
document's enforced `frame-src`, and a policy cannot widen after the document loaded. Before C2 the map island drew the map in the
same document on the banner's "yes"; under the enforced header that frame would be refused. The consent runtime
(`src/lib/consent/consent.ts`) now remembers whether the document was served with the cookie: a "yes" on a page with a map, in a
document served without it, once stored, reloads the page instead of announcing it, and the new document allows the map. A page
without a map only sets the cookie, and the next document's policy allows Google. The reload is decided before anything loads, so
the document it replaces starts no tracker and a visit is not counted twice (changed after the first review of pull request #450),
and the `#cookie-settings` address is dropped first, so the banner does not open again. A stored "yes" whose cookie has expired (a
year at most, seven days for a cookie set by script in Safari) sets the cookie again before the tracker could start, and on a page
with a map reloads once. When storage throws, a reload would forget the answer, so it is announced as before; the runtime exposes
`mapsAtLoad`, and the map island draws no frame the policy would refuse. Its placeholder says "Reload the page to show the map" with a
reload button, which gets focus (the cookie is already set, so the new page allows the map, and its banner asks again because the
answer was not stored). The visitor also keeps "Open in Google Maps". The same holds once the visitor has edited a field on the
page: a reload would lose it, so the "yes" is announced and the map offers the reload, which the visitor presses when ready (decided
after the third review of pull request #450, instead of listing the lost input as a limit). The runtime records the visitor's own
`input` and `change` events (trusted ones, in the capture phase on the document, from an input, a textarea, a select or an editable
region outside the banner, the field read from the event's composed path so one in a shadow root counts) and holds the reload while a
field the visitor edited is still on the page: a platform form that was sent replaces its fields with its thanks, so a later "yes"
reloads again (fifth review). The held note then adds that reloading may clear what the visitor typed on the page: "may", because
the platform's contact form brings its draft back from session storage after a reload where storage works, and loses it where
storage is blocked. The map reads `edited()` when the hold begins and again on every `input` and `change` on the page (after the
runtime's capture listener has counted it) and when the visitor points at or focuses the box, so an edit made while the note shows,
and a form sent since, change the sentence (sixth review; before, it was read once per render and nothing re-rendered). The first version compared each field with its default, which the
fourth review showed missed every published form: React keeps a controlled field's default in step with what is typed, so the
reload wiped the visitor's message; it also held the reload over untouched selects, ranges and colours. Typing into the platform's
contact form is proven in jsdom and in Chromium and WebKit (`test/behaviour/maps.spec.ts`: no new document, the text
kept, the map's reload button then shows the map). The map's own reload button uses the runtime's `reload()`, which drops the
`#cookie-settings` address first, as the runtime's own reload does (fourth review). Where the browser blocks cookies the maps cookie never sticks, so no reload could help; the runtime
exposes `mapsAllowed()`, and the placeholder then says the map cannot be shown while this browser blocks cookies, with no button, and
"Open in Google Maps" gets focus (found by the third review; before C2 those visitors saw the map in the same page). Focus survives
the reload: the runtime announces a maps reload first, as a `lumitra:maps-reload` event saying whether a map's "Load map" opened the
banner, and only then does the last map that asked leave a one-shot `sessionStorage` mark naming its box (path and position among the
page's maps); a map's own reload button does the same. After the reload that box focuses its frame once and removes the mark; a mark
for another page is removed unread. A banner declined or closed without a "yes" leaves no mark (the third review found one written on
"Load map" that lingered). Two limits remain. A visitor whose tracker already runs (analytics granted earlier) and who then accepts maps on a page
with a map still reloads, so that page view is counted twice; the alternative, a placeholder asking for a manual reload, costs every
map visitor a step for a rarer double count. And `mapsAtLoad` is read from the cookie as the runtime starts, not from the response: if
the maps cookie is set (in another tab, say) between the request leaving and the runtime script running, the page believes its policy
allows Google when it does not, and shows a refused frame until the next load. A page restored from the back-forward cache keeps the
value it had at load, which matches the policy it was served with, so a later yes takes the reload path as it should. The address cleanup applies to the analytics revoke reload as well. A placeholder that says "reload to show the map" was the alternative; a reload is what the visitor asked
for in one step. The render gate proves it in Chromium and WebKit: a page served without the cookie, the banner's yes, a second
document with Google in `frame-src`, and the map loads.

**D49. The project's standalone preview is left with a full document load.** A response header applies to the document it came
with. A client-side step from `/projects/<id>/preview` back into the editor would keep the preview's `frame-src` there and refuse
the editor's own frames (the Books PDF preview in `ImportRowEditor.tsx`). "Editor" and the "Open your projects" link of the
preview now load a new document (`src/components/preview/leavePreview.ts`). The way in is already a full load: the tile's link
opens a new tab, and no other client-side link leads to the route. The preview over the editor and Interact read every link to a
path as a page of the site (`sitePathOfClick`, `src/lib/site/sitePath.ts`); a link with the tile's reserved
`data-fc-custom-code-preview` attribute is left alone, so it opens its tab (the third review found it cancelled with a false notice). The demo preview at `/preview` stays client-side, because its
project lives only in the tab's memory, and it never carries the policy. The checkout draws no frame (no payment script runs on
the page), so nothing else on the policed documents is affected.

**D95. A block inside a form or a shop control shows its fallback, with no stored value in the page's script data.** Form and shop
controls are client islands that receive their whole stored node, and an island's props are serialized into the page (the React
Server Components payload). `withoutCustomCodeTree` (`src/lib/customCode/customCode.ts`) takes `customCode` off such a node and
every descendant before it crosses, so nothing of a block's value reaches the page, as D36 and D45 say. It empties the prop to null
rather than deleting it, so the node stays a block and the island draws it as an invalid one: its box with the fallback inside,
without the trace mark, a void tag swapped for the box as D96 says. Until the sixth review it deleted the prop, and a void-tag block
inside a form published as its bare element with the fallback dropped (an `img` showing only its `alt`), while this text already
claimed the fallback; tests now read the drawn markup inside a form, a variant selector and a checkout. A shop part and a nested
shop control lose the prop instead and stay what they are: the block check comes before theirs, so emptied they would be drawn as
a box, and a checkout whose button carried the prop would publish without a button (decided after the sixth review, say so if you
disagree). Running a block inside a
form or a shop control is left to C3 if it is ever wanted. Found by the first review of pull request #450, corrected after the sixth.

**D96. The tile is drawn in a plain container, as a labelled group.** On the canvas a block stored as a link, a button, an SVG
element or any tag that cannot hold the tile (a paragraph, a list, a table part) draws the tile in a `div`, without the control's
own attributes (`href`, `type` and the like). A block whose ancestor is a link, a button, a label or a summary leaves the tile's link
out (found by the second review of pull request #450), so the tile's link is never inside another control. Plain containers (`div`,
`section`, `article`, `aside`, `header`, `footer`, `main`, `nav`, `figure`, `blockquote`, `li`, `dd`, `td`, `th`) keep their tag. A
block standing inside an `svg` draws a `g` with its attributes and the tile as HTML in a `foreignObject`, because React draws an HTML
tag under `svg` as an SVG element, which shows nothing; inside `math`, where React draws no HTML at all, the tile is its label as text
in `mtext`. The tile carries `role="group"`, which may hold its `aria-label`. On the published page and in the standalone preview a
block stored as a void tag (which cannot hold the fallback) is drawn as a container the browser's parser leaves where it stands
(`customCodeBoxTag`): a `g` inside `svg`, an `mrow` inside `math`, and a `span` anywhere in HTML. A `div` closes an open paragraph
wherever inside it the block sits (under a picture, a meter, a progress bar or a link in a paragraph, as the fifth review showed), while
a `span` never does, so one rule covers every depth without tracking paragraphs down the walk; the box is inline where a `div` was a
block, which matches most void tags (an image, an input) anyway. Under a parent that
holds only its own kinds of children (a table, its sections and rows, a column group, a select, an option group, an option, a
datalist) the block is not drawn at all on those two surfaces: no container would stay there, and drawing nothing is what the page
shows anyway once the parser has moved it (decided after the fourth review; refusing such a block at the render gate would also hide
it on the canvas, where the author can still see and move it). The published renderer passes each node its parent's tag for this
(a shop control's island passes its host's tag to the nodes it renders, so a block in a selector drawn as a table is dropped there as
it is anywhere else), and the standalone preview reads it from the tree. The replacement keeps only global, `data-` and `aria-` attributes of the stored
tag, never one that only that tag understood (`alt`, `fetchPriority`). The fallback's own children keep their stored tags, as every
stored node does: a stored paragraph inside a paragraph breaks the same way anywhere on a page. Found by the third and fourth reviews. This is wider than the review asked (every tag that
cannot hold the tile, not only controls and SVG). Found by the first review of pull request #450.

**D97. A title refuses invisible formatting characters and lone surrogate halves, and must show something.** Besides control
characters, the parser refuses every format character (Unicode category Cf: the bidirectional marks, embeddings, overrides and
isolates, the zero-width characters and the word joiner range, the soft hyphen, the deprecated format marks U+206A to U+206F, the
interlinear annotation marks, the Mongolian vowel separator, the byte order mark and the tag characters, which are invisible text an
agent reading the title would still see), the combining grapheme joiner, the blank fillers that draw nothing (the Hangul fillers and
the blank braille pattern), and half of a surrogate pair without its other half. A title must also hold at least one visible letter,
number, symbol or punctuation mark. They change how a title reads without being seen, on the editor surfaces now and in a frame's
`title` from C3. Also refused: the variation selectors that make no visible choice and can carry hidden bytes after any letter (U+FE00 to
U+FE0D, U+E0100 to U+E01EF, and the Mongolian ones U+180B to U+180F), the object replacement character U+FFFC, every default-ignorable code point
(Unicode's Default_Ignorable_Code_Point, which also covers the Khmer inherent vowels U+17B4 and U+17B5 and the unassigned U+E0080 to
U+E0FFF; it replaced most of the hand-written list after the fifth review), and more than twelve code points in one grapheme cluster,
the character a reader sees (counted with `Intl.Segmenter`, or as a base and its marks where a runtime has none). The fourth review's
first cap, five marks in a row, refused everyday Burmese ("hope", "discount sale") and pointed Hebrew with an accent and a meteg; those
reach four to six code points in a character, while a letter under 150 marks is still refused. The fifth review's cap of ten left no
margin: measured on Node 22 (Unicode 17, whose grapheme rules join an Indic conjunct into one character), Sanskrit `कार्त्स्न्य` holds
nine code points in one character, ten with a joiner after its first virama, and a kiss emoji with two skin tones holds ten. Nothing
measured exceeds ten, so twelve is margin, not need: raised after the sixth review (decided, say so if you disagree); a runtime on older Unicode data splits conjuncts smaller, which only lowers the count. The text and emoji
presentation selectors U+FE0E and U+FE0F pass once, right after a pictograph, and in a keycap (`1`, U+FE0F, U+20E3); a digit with
U+FE0F and no keycap is refused. The zero-width non-joiner U+200C and joiner U+200D pass in two places only: one between two letters
(Unicode category L) of the same script whose spelling needs them (Arabic, Syriac, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya,
Tamil, Telugu, Kannada, Malayalam or Sinhala), the left letter optionally followed by combining marks of any script (a virama, the
Arabic shadda) and the right letter directly after the joiner, as Persian writes `کتاب‌ها` ("books") and `می‌خواهم` ("I want"), Sinhala `ශ්‍රී ලංකා` and Marathi its eyelash ra; and
one zero-width joiner between two pictographs, the left one optionally carrying its presentation selector or a skin tone, which draws
them as one emoji (a technologist, a rainbow flag, a family). That reverses the earlier refusal of joined emoji (decided by the
coordinator with the sixth review): a single joiner between two visible pictographs carries no hidden payload. A joiner at a word's edge,
doubled, between Latin letters, across two joining scripts (Bengali to Devanagari), before a mark, or next to a digit, a tatweel, a
danda, a modifier apostrophe or a shared mark on a Latin letter is still refused (the sixth review's first version matched by script
extension and let several of these through; the seventh review found it). Between two letters of the same script a joiner passes
even where it changes nothing visible (after an alef, between two Devanagari consonants with no virama): one such byte hides no text. The subdivision flags (England, Scotland, Wales) stay refused,
because their letters are tag characters, which are hidden text. Titles in any script, right-to-left ones included, single and joined
emoji, an emoji with its presentation selector and a keycap pass. Found by the second review of pull request #450, widened from a
hand-written list to the category after the third, to the variation selectors, U+FFFC and stacked marks after the fourth, and to the
default-ignorables and the per-character cap after the fifth; the joiners were let back in after the sixth and anchored to
same-script letters after the seventh.

**D98. Nothing is bound into a custom code block's value.** `applyBindings` (`src/lib/bindings/resolver/applyBindings.ts`) skips a
binding into `customCode` or any path below it, as it does for `behaviour` and FX scenes, so page data and the address bar can neither
create a block nor choose which approved code it names: that stays the stored revision's choice, which D4 relies on to know which code
a revision uses. The agent refusal (`namesCustomCodeProp`) matches every name whose folded form starts with `customcode`, so a dotted
path such as `customCode.sha256` is refused in every spelling. Found by the third review of pull request #450.

## Decided in slice C3, say so if you disagree

Built 2026-11-17 on `feat/sandbox-bridge`, stacked on C2. A published page now draws an accepted block as a sandboxed frame
through the broker, the behaviour runtime's third lazy chunk; every other surface still shows the fallback. Numbering starts at
D60 (O1 holds D50 to D58).

**D60. Reads come from the attributes the runtime already reflects; writes and events go through the kit.** The runtime writes
every state but `text` to `data-fcs-<id>` on its scope. The broker sends a declared read at `connect` and on every change of that
attribute (one `MutationObserver` per block, observing each scope once with every read's attribute), so the core needed no change notification and no byte for it.
A write goes through `Kit.write`, an event through `Kit.emit`, both new on the kit the core lends its chunks.

**D61. A frame's event runs state verbs only, and starts no chain.** `Kit.emit` fires `custom:<name>` as a replayed run: `set`,
`toggle` and `step` run, while `navigate`, the focus verbs, `emit` and `delay` do not. The parser already refuses `navigate` and the
focus verbs in a `custom:` trigger; the run-time rule holds on its own (a program handed past the parser is tested in jsdom and in
three browsers). A frame is not a person, so it may change what the page shows but never move the visitor.

**D62. A block that writes makes the page changeable, and any block brings the runtime.** `applyBehaviour` takes
`{ changeable }`: a page whose block declares a write holds its cells like a page with a trigger. A page with any accepted block gets
`program.broker = true` (with an empty program when it had none), which is what makes BehaviourIsland fetch the broker. A page with
no block carries neither, proven in jsdom and on Next's real chunks.

**D63. A wrong write is dropped, never clamped.** A `setState` must name a declared write of a state that stands above the block,
with a value of exactly its type: a boolean, a finite number within `min` and `max`, one of a choice's options. No coercion (`"5"`
is not 5), no clamping (99 for a maximum of 9 is dropped, not stored as 9), and `text` never, whatever a declaration says.

**D64. `lumitra.ready()` needs no new message.** The shell's client (shell version 2) resolves it once every declared read has a
value; it queues up to 30 calls made before `connect`. `onState` calls a new watcher at once with a known value. `emit('done')` and
`emit('custom:done')` mean the same. The client is a frozen object on a non-configurable `window.lumitra`.

**D65. The 64 kilobyte rule is the UTF-8 length of the message's JSON form, of plain data only; a flood ends the frame.** Changed
after the first review of pull request #452 (C3), which proved in all three engines that dropping message by message did not hold.
- Plain data only: a message must be primitives, arrays and plain objects. JSON says nothing of a buffer, a typed array, a `Map` or a
  `Set` (`{}`), so a 32 megabyte buffer passed the size rule as almost nothing, already deserialised in the page. `JSON.stringify`
  now runs with a replacer that throws at any object whose constructor is not the realm's `Object` or `Array`; a cycle or a bigint
  makes it throw itself. A message that is not an object (`null`, a number, a string) is refused the same way, without an error
  in the page (review 2, L2: `null` raised an uncaught error per message).
- The walk is bounded before its cost (review 2 of pull request #452, M1). A sparse array is plain data that costs its sender
  nothing, since structured clone carries only its length, while `JSON.stringify` in the page walks every slot: ten million
  slots 28 times a second kept a click from answering for 3.6 to 4.7 seconds, and with the frame in its own process (Chromium's
  site isolation) for more than a minute. The replacer counts its calls and throws past 65,536 of them, or at any string or array
  longer than 65,536, at once. Every call but one for `undefined` (which JSON leaves out, or writes as `null` in an array) writes
  at least one byte, so such a message is either over 64 kilobytes of JSON or a mass of `undefined`, which nothing honest sends;
  refusing both is harmless, and it now costs the page no more than a small message. Keys are not counted by length: one 10
  megabyte key costs the page about 31 ms and is refused by its size, and a second such message ends the frame, so that is bounded. `sizeOf` in `broker.ts` holds this, with unit tests for escaped characters,
  an own `length` key and a fresh budget per message.
- Over 64 kilobytes is treated like data that is not plain: dropped and warned of the first time, and after any earlier wrong
  message the frame is removed (`not plain data or over 64 KB`), so an expensive message cannot be repeated.
- The rate: every message of the frame counts, on its port and to the page's window, before `hello` and after, and so does a window
  message from a frame nested in it at any depth (review 2, L1: a `srcdoc` child flooded the page's window uncounted); the page
  walks the message's source up through its parents, which any site may read. Each message is counted as it is handled, first,
  before its data is read. On the port a counted message past 30 is dropped without its data being read, and any other is measured
  with the bounded walk. On the window, where the frame may send anything at any size, the page reads data at most once per frame
  (review 3 of pull request #452, M1): Chromium deserialises a message's data at its first read, and an array of 300,000 small
  objects posted to the window after `hello`, once per task, kept a click from answering for about a minute under site isolation,
  with the frame never removed, because each read took long enough that fewer than 90 were handled in any second. Now the frame's
  first window message must be its `hello`, read once (anything else removes the frame, `no hello`; the shell sends `hello` before
  any author code runs), and after `hello` its window messages and its nested frames' are counted from `source` alone and never
  read. The gate proves both under Chromium's site isolation with a page that reads no message itself: a click answers within 2
  seconds while the costly flood runs, and a frame whose first message is the costly one is removed at it. Past 30 in a second
  a message is dropped; past 90 in a second the frame is removed (`flooded`), because each message costs the page's main thread a
  task whether it is used or not. The review measured a click beside a flooding frame at 8.9 seconds in Chromium, 584 ms in
  WebKit and 255 ms in Firefox, with the frame never removed. The bridge gate's new case floods the port and the window for 4
  seconds: both frames are removed and a click answers in about 40 ms in all three engines. A frame keeping between 31 and 90 a
  second is only dropped from: at that rate the cost is a few dozen tasks a second, which the page does not feel. The gate pins
  both edges (review 2, L3): 85 messages in each of three seconds keeps the frame, with what is past 30 dropped, and 95 in one
  second removes it.
- `resize` shares the count and nothing else: the earlier rule that honoured it only among the first 10 messages of a second is
  gone (review 2, M3), since it dropped exactly the settled height at the end of a burst.
- The shell client coalesces (shell version 3, review 2, M2 and M3; version 4, review 3, M2 and L1). An honest block that writes a state from every animation
  frame sends 120 messages a second on a 120 Hz screen, and was removed as `flooded`; dropping past 30 lost the last value (a
  growing block ended at 134 to 263 pixels instead of 400). `lumitra.setState` and `lumitra.resize` now keep the latest value
  of each state and the latest height and send them on the trailing edge of a timer, about one message per 50 milliseconds
  (after a flush of `n` messages the next waits `n` times 50), so an honest author stays near 20 a second and the last value
  always arrives. Emits ride the same timer (review 3, M2: an `emit` sent at once made a slider that writes and emits on every
  `input` send 120 to 240 messages a second while dragged, and it was removed in all three engines): an emit of a name already
  pending is merged into it, and emits go after the pending writes and height, in the order of their first call, so the page
  still sees a write before an event that followed it. A merged emit runs the page's handlers once where the author called it
  several times within about 50 ms; handlers set state, so that is the same end state. The shell also never sends more than 25
  messages in any second, counted as they leave (review 3, L1: a flush of 31 states at once passed 30 and lost the 31st); what
  does not fit waits, latest only, for the next flush. Errors are reported at most once a second. The broker's ceiling is then
  left for code that bypasses the client on purpose. The gate proves it in three engines: two writes per animation frame and a
  4 ms timer keep the block and end on their last values, a block growing to 400 pixels ends at 400, a slider dragged with the
  mouse (a write and an emit on every input) is kept and ends on its last value, and 31 states written at once all arrive at
  their last values.
- One warning a frame: the first wrong message or reported error says `dropped a message or error, then silent`, and every later
  one is silent, so a frame cannot fill the page's console with text of its choosing (review 1, L2). Removal is always said. The
  frame's own errors stay in its own console, where the developer tools show them.

**D66. Four blocks a page, held twice.** The server accepts the first four blocks in document order (`applyCustomCode`) and
draws the rest as their fallback with a warning; the broker refuses a fifth on its own. Only a block the renderer will draw as a box
of its own in HTML is counted: one on or inside a form part or inside a shop control (whose islands get the node without its value,
D95), inside a shop part, the sticky bar, a map, a void or unnamed tag or a refused tag (none of which draw their children), or inside
`svg` or `math`, itself stored as `svg` or `math`, or stored as a void tag under a parent where `customCodeBoxTag` draws no box (a
table part, a select, an option), is refused with a reason, takes no slot, and brings no broker and no `<meta>`. So is a block on or
inside a tag that draws no element child as a box (`FRAMELESS_TAGS` in `applyCustomCode.ts`: `select`, `option`, `optgroup`,
`datalist`, `textarea`, `canvas`, `video`, `audio`, `template`, `noscript`, `colgroup`; review 3 of pull request #452, L2): a frame
there measures 0 by 0 in all three engines (a `canvas` draws it in Firefox only), and only Chromium loads it, so its hello would
replace a visible fallback, such as a select's options, with a frame nobody sees, while in WebKit and Firefox the block would take
a slot for nothing.
An HTML element directly under an SVG or MathML element is outside what those formats render (HTML belongs in a `foreignObject`, or
in a MathML text element), so a frame there could not be seen and its hello would remove a fallback that was showing. That is
reasoned from the specifications, not probed in a browser. A block inside a `foreignObject` stands in HTML again and runs. Decided while rebasing C3 onto C2's third review, say so
if you disagree. The island draws its box as `customCodeBoxTag` says (C2's D96), with the parent's tag, and a void tag's box
keeps only the attributes any element may carry, as the fallback's does.

**D67. The per-site `<meta>` names the site's box path, and Google only on a page with a map.** A policy in a `<meta>` element
narrows the header's, never widens it, so the consent cookie still decides the map in the header (D48); the `<meta>` only keeps a
page from framing another site's path. A page without blocks carries no `<meta>`. `frameSrc.gate.ts` proves it in Chromium and
WebKit with the `<meta>` taken from a real render: the site's own box frame loads, another site's box path is refused, and the map
is refused before consent and loads after it.

**D68. What may run is read per request, from the blob row alone.** `loadLiveCustomCode` reads the blobs the page names, keyed by
the site, not blocked, not on the takedown list, of a site whose switch is on, and the declaration stored with each. The switch is
read live, never from the cached published site, so turning it off reaches every page at its next request. A preview, the kill
switch, a missing origin or a failed read means no frames. The standalone project preview keeps the fallback in C3: it would need
C4's read route. Only `applyCustomCode` gives a node the island's block (`customCodeRun`): one that arrives on a node is taken away on every
page, with live code on or off, so the renderer never rests on the snapshot adapter leaving that field out.

**D69. A frame is hidden until `hello`, and its fallback stays until then and for good after any failure.** The `hello` is accepted
only from the frame's own window, with the opaque origin `null` a sandboxed frame has, as the frame's first window message. The frame is laid out at the box's width
but invisible before it, so a lazy frame still loads and the page never shows an empty box. A first window message that is not a
valid `hello`, a second `load`, no `hello` within 5 seconds of `load`, or three unanswered pings (removed at the fourth tick, about 20 seconds after the last
answer) take the frame away and bring the fallback back for good. After `hello` the page never reads a window message of the
frame again, it only counts it (D65), so a second `hello` is ignored like any other: the rule that removed the frame for one went
with the third review of pull request #452 (M1), since enforcing it meant reading every message's data. A reload still ends the
frame by its second `load`.

**D70. The frame is created only within one viewport of the screen,** so a block far down the page costs nothing until the
visitor nears it, and its 5 second clock starts at its own `load`.

**D71. The focus watch, D8 as built and proven.** The behaviour plan marked it "designed, not probed"; the probe changed the design
three times.
- A first version listened only for the window's `blur`. Chromium fires it when a frame takes the keyboard; Firefox does not (it
  blurs only the element that had it), so in Firefox a frame took the keyboard six times and stayed. The broker now listens for
  `focus` and `blur` in the capture phase, the window's own included, reads a task later which element holds the keyboard, and
  counts each arrival in a frame once.
- In Firefox the frame runs in the page's process and can take the keyboard back before that task runs, so the page holding the
  keyboard is now noted at once, inside the event.
- Firefox as Playwright runs it holds the page's focus events back until the page's next focus change. Every ping (5 seconds)
  therefore also looks where the keyboard is, so a theft no event announces is still seen within one ping. Seen that late, a
  person's own move needs as long to explain it, so for those arrivals the grace is 6 seconds instead of 1.

The rule: a move into a non-interactive frame removes it the first time. A move into an interactive frame counts as theft when
a character was typed into a text field of the page (an `input`, a `textarea` or an element that is `contenteditable`; a key whose
name is one character) within the last half second, pointer or not; otherwise it counts unless the pointer is
over the frame (`:hover`), or the pointer entered a frame or a Tab was pressed in the page within the last second (6 seconds when
only a ping saw the move). The third theft removes it. The typing clause came from the first review of pull request #452 (M2): a
frame receives `mousemove` whenever the pointer is over it, so one that took the keyboard only then had every move excused, and
captured what the visitor typed after resting the pointer on it. A person stops typing before reaching for a frame; a frame that
grabs the keyboard under the pointer does not wait. A Tab clears the typing, since it moves the keyboard on purpose. The second
review (M4) found the first version took any key anywhere as typing, so a visitor who scrolled with the arrow keys and then
clicked into a block within half a second was counted as a theft, and removed at the third time in Chromium and WebKit. Arrows,
Space on the page, Escape and the modifiers no longer count, and the gate keeps a frame clicked into right after arrow keys. The proof, in `customCodeBridge.gate.ts` with real input
from Playwright:
- Chromium and Firefox: a frame whose script focuses an input inside it every 300 ms takes the keyboard back after the page
  takes it, and is removed at its third arrival (interactive) or its first (not interactive). An attempt where Firefox did not
  apply the page's `focus()` at all is not counted as a theft; the test keeps trying until six attempts counted or the frame is
  gone, within twelve in all, so a slow machine costs attempts and never the verdict.
- WebKit never lets a frame of another site take the keyboard by script: the page keeps it in every attempt, so the watch has
  nothing to do there. The test asserts exactly that, so a change in WebKit shows.
- No false removal in any of the three engines: four clicks into an interactive frame and out again, four Tabs into it and back,
  four taps on a touch screen, three clicks into it with the pointer then moved away past a ping, and four rounds of typing in the
  page, a pause of 700 ms and a click into the frame leave it in place.
- The review's probe (six rounds of: click the page's field, type, move onto a frame that focuses itself on `mousemove`, type):
  Chromium removes the frame at its third move, so it gets the keys of two rounds and never a third. Firefox, in this harness,
  honours the frame's `focus()` in the first round or two only, so it never reaches a third move and stays, with at most two
  rounds' keys. WebKit refuses the focus every time and the page keeps every key.

What remains: a frame that waits for the visitor to pause typing for more than half a second, then takes the keyboard under the
pointer, is excused as a person's click would be. The visitor sees the caret leave the field. Once the frame holds the keyboard
the page sees no keys, so a later grab under the pointer (after the visitor Tabs out of the frame, say) is excused the same way;
that is the same residual, not a new one. The typing signal needs a key whose name is one character, so it never fires for a
visitor typing through an input method editor (which reports `Process`) or most virtual keyboards on Android (`Unidentified`):
for them only the pointer and Tab clause applies, the same residual again (noted by the third review of pull request #452). The page cannot tell a click inside a
frame of another site from a script's `focus()` there, so no signal from the page closes this; the residual is accepted with D8.

The per-engine moves are written to `custom-code-bridge.log` in the system's temporary folder on every run.

**D72. D39 settled: the report-only `frame-src` expects the box.** Wherever the box may be framed (`boxFrameSource`), the report-only
policy's `frame-src` is `'self'`, the box's path and, after consent, Google, so a block's frame reports nothing and any other frame
still does.

**D73. The broker's size, and what it does not check twice.** After the first review's fixes (D65, D71) esbuild measures 1974 bytes; to
make room, the warnings became one a frame, the removal reasons shorter (`no hello`, `no pong`), the resize limit shares the
message count, and the plain-data check rides on `JSON.stringify`'s replacer instead of a walk of its own. The limit was 2 kilobytes
gzipped until the second review of pull request #452, when the real chunk stood at 1993 bytes. That review's fixes need about 130
more: the bounded walk (`sizeOf` and its budget, M1), the walk up a message's parents for nested frames (L1), the check that a
message is an object (L2) and the typing signal's text-field test (M4), against the bytes the removed first-10 resize rule and the
merged oversize branch gave back. Cutting a fix to fit would cost correctness, so the limit is now 2,200 bytes gzipped (decided,
inside the brief's ceiling of 2,400; say so if you disagree). esbuild measured 2107 bytes and Next's real chunk 2122. The third
review's fixes made it smaller, with no raise needed: the window route now reads data once per frame and drops the second-hello
rule (M1), and the coalescing of emits and the 25-a-second cap (M2, L1) live in the shell, which has no size limit. esbuild now
measures 2096 bytes and Next's real chunk 2108, 92 under the limit of 2,200 (the core's stays at 4968 of 5000). It is
held on esbuild's measure in the unit suite and on Next's real chunk in the behaviour suite. Next compiles `?.`, `??` and template strings into longer code than esbuild does
(its first real chunk came to 2037 bytes against esbuild's 1990), so the broker is written without them, and its numbers are
literals at their use, since a bundler keeps a module's constants as variables. The registry it shares with the island and the
attribute names it shares with the core sit in other chunks in Next and are left out of the esbuild measure too. The broker does not
check the frame's address again: the server builds it (`boxPath`, from the site's id and a stored hash), and the page's enforced
`frame-src` and its per-site `<meta>` admit only that site's box path, which `frameSrc.gate.ts` proves in the browser. The core's
own limit (5 kilobytes) had 14 bytes to spare before C3; the kit's two new members and the broker's start cost about 50, so nine
empty fallbacks in the core (`x ?? []` where `x` is an array or nothing) became `x || []`, which means the same and costs less
after Next compiles it.

**D74. The bridge tests run in Chromium, WebKit and Firefox.** `test/renderGate/customCodeBridge.gate.ts` bundles the real runtime,
broker and registry and frames documents from a local stand-in for the box that answers with the real headers and the real shell
(or, for a hostile block, a document that speaks the protocol by hand). The render gate job now installs Firefox for it; a run
without Firefox fails unless `CUSTOM_CODE_GATE_NO_FIREFOX=1` says it may be left out. A frame that stops answering pings is
removed in all three engines. A frozen frame (`for (;;) {}`) can only be removed where the engine runs it apart from the page:
Chromium launched with site isolation (`--site-per-process`, as desktop Chrome ships) removes it while the page answers
throughout. Every box frame is of one site, so they share that process, and a healthy block beside the frozen one stops and is
removed with it; the page keeps every fallback. WebKit, and Firefox as Playwright runs it (Fission does not start there even when
asked), run the frame in the page's own process: a frozen frame holds the page as well. That is the residual M7 the plan already
names, asserted as such so a change shows; the plan's wish to prove the watchdog on a frozen frame in Firefox could not be met in
this harness.

The gate starts the runtime and the broker by hand, so the chain as it ships has a test of its own in the behaviour suite
(`test/behaviour/customCode.spec.ts`, Chromium and WebKit): a stored page with a block, published through the real repository,
its blob row and the site's switch in the real database, served by `next start` of a production build with the box's origin
configured. Only the box's answer comes from the test, with the real headers and the real shell. It proves that BehaviourIsland
fetches the broker chunk once and starts it, that the island and the broker share one registry across Next's chunks, that React
keeps the broker's frame through both settles while the fallback goes, that the frame's write reaches a bound text, and that the
per-site `<meta>` lands in `<head>` (React hoists it there) where the browser refuses another site's box path. The suite's
server now runs with custom code served, so the maps spec's report-only expectation names the box as well (D72).

The bridge gate stays in the render gate job rather than a path-filtered workflow of its own, as C6 will have. On the last run
of `main` before this slice the jobs took 12 minutes (verify), 14 (render gate) and 27 (behaviour), and a pull request waits for
the longest. Locally, under heavy load, the bridge and frame policy gates took about 6 minutes together; added to the render
gate that stays well inside the behaviour job, so a pull request's wait does not change. What it costs is runner minutes, a few
per pull request, which buys the bridge in three engines on every change to the runtime it rides on.

## For Marlin

**M2 done on 2026-11-02:** `lumitrausercontent.com` is registered at Cloudflare Registrar (through Lumitra Mail's buy-a-domain flow, in the Lumitra Mail workspace "Lumitra Infrastructure"), held by Marlin for Lumitra, expiring 2027-11-02 with auto-renew, privacy and transfer lock on. Its DNS zone is in Lumitra's Cloudflare account (zone id `2d1f61f852327bc23ef420fda0651121`, nameservers blair and lochlan at Cloudflare) with no records yet and no mail setup. Slice O1 can now bring the zone under Terraform and add the box's records. The Lumitra Mail order is deliberately left in "needs attention": never retry it, because a retry would try to make it a sending domain.

**Answered by Marlin on 2026-11-02:** M2 yes, `lumitrausercontent.com`, bought through Lumitra Mail's own buy-a-domain flow (a separate session in the email-editor repo is doing the purchase and reports back); M10 the default below; M11, M12 (three.js first), M14 and M15 yes; M13 yes if C8's probe holds. M9, the lawyer's reading before C7, still stands. C8 is therefore in scope, not a proposal.

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
