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
| C1a | `sandbox-service`, the service and the contract. **Built 2026-11-12,** see "Decided in slice C1a" | `services/box/` (server, cache, rate limit, shell, tests, a fixture that states the view's columns), `src/lib/customCode/contract.ts`, `Dockerfile.box`, `Dockerfile.box.dockerignore`, `.github/workflows/box.yml` (build and test only) | none | 1 session | Every box test above passes against the built image and a real Postgres holding the fixture; `box_reader` reads only the view; the image runs read-only as non-root with every capability dropped; `contract.ts` imports nothing; nothing in the application imports it; no image is pushed and nothing is deployed |
| C1b | `sandbox-schema`. **Built 2026-11-15** on `feat/sandbox-box-schema` after Marlin's yes to the migration by name that day, see "Decided in slice C1b" | Prisma migration `20261115000000_custom_code` (`custom_code_blobs`, `custom_code_audit`, `custom_code_proposals`, `sites.custom_code_enabled`, the function `box_document` of D18 instead of the view), the grant of EXECUTE on it in `prisma/sql/box-reader.sql` (no password in it, applied by the operator in O1), the `deploy/README.md` section, and the box's integration suite pointed at the real migration instead of the fixture | C1a, #394 merged, **Marlin's yes to the migration** | 1 session | The box's integration suite passes against the migrated schema; `box_reader` may call only `box_document`, reads no table and never gets the code of a blob that is not live; the migration is additive and applies on a database without `box_reader` |
| O1 | `sandbox-domain-and-host` (operator, not a worker). **Repository half built 2026-11-17 on `feat/sandbox-box-deploy`,** see "Decided in step O1 (repository half)"; the operator half (infra repository, Coolify, Infisical, DNS, monitors) is open | Infra repo: Cloudflare zone and records in Terraform, Infisical project `framer-clone-box` and its machine identity, Coolify application, `box_reader` applied, five Kuma monitors. In this repository: the Infisical client and login entrypoint in `Dockerfile.box`, and the push, webhook and health poll steps in `box.yml` | C1a, C1b, **M2 bought** | Half a day | `curl` with and without fetch metadata headers gives 200 and 403 on `run.<domain>`; certificates valid; no `Set-Cookie`; all monitors green; abuse page answers |
| C2 | `sandbox-element` | `src/lib/customCode/customCode.ts` (pure parse), `src/lib/renderer/customCode/customCodeElement.tsx`, `renderComponentNode.tsx`, `createComponentElement.tsx`, `HeadlessComponentRenderer.tsx`, `componentRegistry.ts`, `middleware.ts` and `src/lib/site/cspReportOnly.ts` (enforced `frame-src`, D6), the tile | C1a | 2 sessions | Renderer tests above; the map embed still loads after consent with the header enforced; the standalone preview route carries the enforced `frame-src` (a middleware route test); no `iframe` in the mounted editor; `renderer` collision tag |
| C3 | `sandbox-bridge` | `src/lib/customCode/broker.ts`, `CustomCodeIsland.tsx`, the shell client in `contract.ts`, `runtime.ts` (third lazy chunk), size test (broker at most 2 kilobytes gzipped, as the behaviour plan holds) | C2, B4 | 3 sessions | Bridge tests above in three engines; a page without blocks loads no broker byte; the focus watch proven or replaced with the proof attached |
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

**D52. The start program reads five variables and drops every other `INFISICAL_` variable.** Required: the client id and secret, `INFISICAL_PROJECT_ID` and `INFISICAL_ENVIRONMENT` (no default: a box that guessed its environment would be wrong quietly). Optional: `INFISICAL_DOMAIN`, default `https://infisical.lumitra.co`, https and a host only, with plain http accepted only for a host without a dot (a container name; the image test's stand-in for Infisical is one), because the test must point the real client somewhere and the client would send the client secret to whatever it is pointed at. Every other `INFISICAL_` variable of the container is dropped before the client starts, so nothing set on the container can steer it. The client is started by its absolute path, with telemetry off (`INFISICAL_DISABLE_TELEMETRY`, `DO_NOT_TRACK`) and `GOMAXPROCS=2`, because every thread counts against the container's process limit. **The start program refuses `BOX_DATABASE_URL` on the container:** a copy there would be a second home for the secret, the one forgotten at rotation.

**D53. The workflow publishes only from main, only the image it tested, and only once O1 is done.** On a push to main that changes the box's own files (D56), or a manual run on main, the image the suite just tested is handed to the publish job as an artifact and pushed to `ghcr.io/<owner>/framer-clone-box` with the commit and `latest` as tags, never rebuilt; only that job may write packages. Nothing is kept, pushed or deployed until the operator sets the repository variable `BOX_DEPLOY_ENABLED` to `true`; until then the run writes a notice and succeeds, so main stays green before the infrastructure exists and nothing half-published sits in the registry. Once it is set, missing deploy secrets fail the run loudly. A pull request never pushes or deploys. A newer push cancels an older run of a pull request. A running run on main is not cancelled, so a deploy that has started is finished and verified; a newer run waits, and of several waiting GitHub keeps only the newest, which deploys the newest main. **Rolling back** is pointing the Coolify application at the previous commit's tag: `latest` moves before the deploy is verified, so after a failed deploy it names the image that failed.

**D54. The deploy waits for `/health/db`, not `/health`.** The plan's Deploy section and the brief name `/health`. The application's deploy learned that a liveness check goes green over a broken database (its comment in `deploy.yml`); `/health/db` calls the box's one function as `box_reader`, so a missing role, function or network fails the deploy loudly. The container's own health check stays `/health`, so a box whose database is briefly away is not restarted for it.

**D55. Corrections to "Deploy" above, from building it.** The image is the application's digest-pinned `node:22-bookworm-slim`, not `node:22-alpine` (decided in C1a). `tini` was not in the C1a image (node was process 1 and started no child); it is now, as the plan said, a statically linked release binary pinned by version and SHA-256 like the client, because the image now runs a chain of processes. The base image has no certificate authorities; the client's https needs them, so Debian's bundle is copied in from a build stage (apt checks its signature). Coolify sets more than the two Infisical variables: the project id, the environment slug and the box's own non-secret settings (`BOX_EDITOR_HOST` and the rest) are its environment too. The client needs no writable home and no temporary file system: the image test runs the real client on a read-only root file system with nothing mounted. **Coolify's own health check is switched off for the box** (the plan said "health check `/health` on 127.0.0.1"): when it is on, Coolify replaces the image's `HEALTHCHECK` with a shell command calling `curl` or `wget` (its deployment job says so), and this image has neither a shell nor either program, so every container would be reported unhealthy and no deploy could succeed. Switched off, the image's own exec-form check (node asks `/health` every 30 seconds) applies; O1's checklist includes seeing the deployed container reported healthy, because what Coolify does with a disabled check was read from its source, not tried on the deployed version. **Known, outside this repository:** the stack's shared deploy workflow (actions-shared, `coolify-deploy-verify`) prints Coolify's answer to the webhook and, on a timeout, the Coolify address derived from the webhook secret, which GitHub's masking does not cover. The box no longer uses it (D57); the application's deploy still does, and the fix belongs in actions-shared.

**D56. The box is deployed after the application, and a change to the database alone does not deploy it.** The box's `/health/db` calls `box_document`, which the application's migration creates, and the application's deploy (still started by hand) applies migrations; deploying the box first fails its deploy. O1's steps say so: the application first, then the box. The workflow keeps the migrations, the role files and the root configuration as triggers of its tests, since the box's integration suite builds its database from them, but publishes and deploys only when the push changed the box's own files (`services/box/`, the contract module, `Dockerfile.box` and its ignore file, `box.yml`) or the run was started by hand; when it cannot tell what changed (no previous commit), it publishes. The alternative, the publish job asking production whether the function exists, needs a database connection from GitHub to production, which nothing else in the stack has; the order rule and the narrower trigger cost nothing.

**D57. The deploy secrets live in the GitHub environment `box-production`, main only, and the deploy is written into `box.yml`.** As repository secrets, any job of any workflow on any branch of the repository could read them, so a branch could hand them to a step of its own. In the environment, with main as its only deployment branch, only the one job that names it can, and only on main. That rules out the stack's shared deploy workflow: a called workflow cannot read the secrets of an environment it does not name itself, and the shared one names none. So the webhook call, the following of the Coolify deployment and the health poll are steps of the box's publish job, which prints nothing Coolify answers and masks the Coolify address (the known issue of the shared workflow in D55 does not reach the box). Whether to publish is a repository variable, `BOX_DEPLOY_ENABLED`, since a job outside the environment cannot see the environment's secrets. Every action is pinned by commit with its version in a comment, and `Dockerfile.box`'s build frontend by digest: a moved tag would otherwise run foreign code in a job that can write packages or deploy production. The image's id is recorded after `docker build` and checked before `docker save` and after `docker load`, so the image pushed is the one built, whatever ran in the tests between.

**D58. The box must answer `/health` within 60 seconds of `infisical run` starting, or the start is given up on.** The client sets no time limit on its own HTTP calls (its resty client is created without one), so a fetch of the secrets that Infisical accepts and never answers would leave a container running with no box and nothing in the log. The start program asks the box's `/health` where the image's health check does, every half second, and after the limit stops `infisical run` (SIGTERM, then SIGKILL after five seconds) and ends with 69 and a line saying so. `BOX_START_TIMEOUT_SECONDS` (1 to 600) changes the limit. Watching for the box's start line in its log was the alternative; asking `/health` checks what matters, and leaves the box's request log untouched on its way out. The login keeps its own 30 second limit. On "no usable token" the client's message is now passed on too, with every credential taken out, as on a refused login.

**How it was tested.** `services/box/test/launch.test.ts` (39 tests) runs the start program against stand-ins for the client and the box, real processes that record their own command lines and environments: every missing or malformed variable, root, a refused login (its message passed on without any credential), a login that gives no token, one that hangs, a missing client, SIGTERM during the login, SIGTERM and SIGINT reaching the box, the run's status and a run ended by a signal, a refused fetch of the secrets (its message passed on without the token), a client secret and a token straddling the 16 kilobyte cut of a line without a newline (in one write, and split across two), a fetch that never ends and a box that never answers `/health` (both stopped at the time limit) and a box that answered in time (left alone), the time limit's own checks, and the start program bundled and run in a process of its own, where nothing else keeps it alive (it once ended with 0 there before reading the status, which only the image suite had caught), and no credential on any command line, in any log line or in the box's environment. The image suite now starts every box through the real entrypoint and the real Infisical client against a stand-in for Infisical (`test/integration/fakeInfisical.ts`) on its private network, and adds: each missing start variable and the database address on the container stop the box before Infisical is asked anything; a refused login ends with 69 and writes no credential; a project Infisical will not give ends with 1, the client's reason in the log, no box started and no credential written; a fetch Infisical never answers ends with 69 at the time limit; a running box has `tini` as process 1, the secret in its environment and no credential in its environment, in any process's command line or in the log; and `docker stop` ends the chain with status 0 within the grace period. Six rules of the start program were also removed on purpose, one at a time, and tests failed on an expectation each time (never by hanging): the token passed as an argument (1 test), signals not passed on (5), a missing variable tolerated (6), the token left in the box's environment (2), the login's message passed on without taking the credentials out (1), the standard error of `infisical run` passed on without taking them out (1). After the first review, five more: the old cut of a long line (2), no overlap kept at the cut (2), no time limit on the start (2), the client's message dropped on "no usable token" (1), and the start program's waits not holding the process open (1). The image suite has 63 tests.

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
