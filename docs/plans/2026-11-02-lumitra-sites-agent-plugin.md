---
type: plan
status: in-progress
date: 2026-11-02
title: "Lumitra Sites agent plugin: an MCP so an agent can build sites in framer-clone"
summary: "An MCP endpoint at app.lumitra.co/api/mcp and a lumitra-sites plugin, so Claude Code or any MCP client can read, build, edit and publish sites with a company API key carrying the sites grant. Server-side site operations shared with the in-editor AI, a version lock so agent and editor never overwrite each other, publish with confirmation. About two to three agent weeks. Approved by Marlin on 2026-11-02."
tags: [framer-clone, mcp, agents, api, plugin]
projects: [framer-clone]
---

# Lumitra Sites agent plugin: an MCP so an agent can build sites in framer-clone

## Context

Marlin wants an agent (Claude Code, Claude Desktop, any MCP client) to write sites in framer-clone the way the Lumitra Studio plugin lets an agent drive Studio. First use: building the new lumitra.co landing page.

Nothing like it exists today. Research found:
- **framer-clone has no machine door.** Every authoring route needs a browser `lumitra_session` cookie plus workspace admin rights (`src/lib/auth-api.ts`, `src/lib/permissions.ts`). The auth-brain SDK's `verifyApiKey` is installed but unused.
- **There is no read route for a project's content.** The editor loads it through a server component (`src/app/projects/[projectId]/loader.ts:147`).
- **AI generation never writes.** It runs on the server, but the browser applies the result and the user has to Save.
- **Save has no version check:** the newest whole-project write wins (`src/server/sites/repository.ts` `saveProject`). An agent and an open editor tab would silently overwrite each other.

The patterns to follow already exist:
- **Studio:** a plugin (skills plus an MCP server) that sends a company API key from auth-brain, checked with `verifyApiKey` and an app grant (`lumitra-studio/src/lib/auth/verifyRequest.ts`, `packages/studio-mcp`, `plugin/lumitra-studio`).
- **Booking:** an MCP endpoint inside the app at `booking.lumitra.co/api/mcp`, where each tool maps to an existing operation marked `machine: true`, with 401/503 handling and tests (`lumitra-booking/apps/web/src/server/mcp.ts`).
- **auth-brain:** already registers a `sites` app grant (`auth-brain/packages/app/src/lib/suite-apps.ts`). Company keys are minted at auth.lumitra.co.

## Decisions (approved by Marlin on 2026-11-02)

1. **Name:** "Lumitra Sites". The endpoint is `https://app.lumitra.co/api/mcp`. The plugin is `lumitra-sites`, in the same marketplace as Studio.
2. **The endpoint lives inside framer-clone, like Booking, not as a separate npm server like Studio.** One deploy, no version drift, and it works with `claude mcp add --transport http` and any client that sends the key as a bearer header. (Corrected 2026-11-03: it does not work with claude.ai connectors or Claude Desktop's connectors yet. Those sign in with OAuth as the MCP authorization spec defines it, which needs protected-resource metadata on `/api/mcp` in framer-clone and dynamic client registration in auth-brain's OAuth provider, neither of which exists. Tracked as its own ROADMAP line.) The plugin is skills plus an `.mcp.json` pointing at that URL, with the key taken from an environment variable.
3. **Auth is a company API key with the `sites` grant,** checked through `verifyApiKey`, failing closed with a 503 when auth-brain is down. A bearer header never falls back to the cookie. The scope is the key's company: the server takes the company id from the verified key, looks up that company's sites workspace itself and feeds that pair to `resolveScopeForCompanyWorkspace` (`src/server/sites/scope.ts:294`). A workspace or company identifier in the MCP request is never read, and key claims are never treated as session data. If that function cannot take a key-derived company without a session, a separate `resolveScopeForKey` is added next to it and tested for the same isolation. The service account counts as workspace admin only if the key's role allows it; edit and publish both need `workspace.admin` today, so a key without the admin role is refused on both.
4. **One operations vocabulary, shared by the agent, the in-editor AI and later the CLI,** as the 2026-05-31 platform plan says ("do not build a separate agent API"). It extends the existing review ops (`src/lib/ai/review/ops.ts`) and maps one-to-one onto existing editor actions, which already run on the server (`POST /api/projects` calls `ProjectModel.create`).
5. **Every agent write is applied on the server:** load the project, apply the ops as `ProjectModel` and `PageModel` actions, check them, then save with a version check. Nothing reaches storage without passing `ProjectModel.create` and the generation validator.
6. **Publish is allowed,** and only with the person's approval, never the agent's word (amended 2026-11-03 after the security review of #319: a one-time token handed back to the same agent could be replayed by content injected into it). First choice is MCP elicitation, the client's own dialog. Without one, the first call opens an approval request and answers a link to an editor page on app.lumitra.co; opening it needs the editor sign-in of a user with `publishSite` on that site's workspace, shows the server-built summary of what goes live, and only a POST from its button (never the GET of opening it) records the decision, approve or decline, on the server. The agent's second call names the request and proceeds only if an approval is recorded for exactly the subject it was opened for: company, key, site and version, and for rollback also the revision and the revision live at the time (any write bumps the version, so the version pins the content). A request carries 192 random bits, expires after five minutes, is spent on its first use after a decision, and checking and spending happen in one step. Open requests are capped per key (five, the oldest of that key dropped) with a total backstop, and opening them is rate limited per key. Approval state lives in the app process, under the single-container rule `deploy/README.md` already sets (a restart forgets open requests and the agent opens a new one); moving it to the database is needed before the app runs more than one container. Approving needs a sign-in from the last 15 minutes (the session's `created_at`, which auth-brain's own OIDC tokens use as `auth_time`); an older session is sent through auth-brain's logout and login and back to the page. The page cannot be framed: every editor-host page answers `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so a same-site `*.lumitra.co` page cannot overlay it. Residual: an agent that drives a browser in which the person signed in during the last 15 minutes could still open the link and click; closing that needs a step-up auth-brain does not offer to apps yet (its re-auth stamp `reauth_at` is not in the session verify answer). For an account that signs in with Google, signing in again can be a single click while Google's own session lives, so a browser-driving agent could get through it too; that is part of the same residual until auth-brain offers apps a step-up. Publishing can be undone through revision rollback. Deleting sites or domains is not exposed in the first version.
7. **First rollout is limited to Marlin's company.** The `sites` grant is operator-only today, so access is limited already. Opening it to customers comes later and is a separate decision.

## Work, in order

**1. Version lock (needed by both the agent and the editor).**
- Add a `version` integer column to `sites`, `NOT NULL DEFAULT 1` (additive migration; existing rows backfill to 1 and new sites start at 1, so every site has a defined version). `saveProject`, `publishProject` and `rollbackToRevision` take an `expectedVersion`, compare and increment it in one atomic update in the same transaction as the write (`UPDATE ... WHERE version = expected`), refuse a stale write with 409 `site_changed` and return the new version on success.
- The editor's Save sends the version it loaded. On 409 the editor shows "this site was changed elsewhere, reload or keep yours" instead of overwriting.
- Files: `src/server/sites/repository.ts`, `src/app/api/projects/_schema.ts`, the save and publish routes, `src/stores/openProject.ts` (it already compares baseline, server and working copies on load).

**2. Machine door.**
- New `src/lib/auth-machine.ts`: `verifyCompanyKey(req)`, modelled on Booking's `session.ts` and Studio's `verifyRequest.ts`, returning `{kind:'key', tenantId, keyId, serviceAccountId, scope}`, `refused` or `unavailable`.
- Middleware lets a bearer request reach `/api/mcp` only. Cross-origin writes stay refused for cookie requests.
- Every agent action is audited with the key id and service account.
- **Accepted risk (decided 2026-11-02, PR #316):** a key's verify answer carries only its company id, and auth-brain has no route a service account can ask for its company's tenant group and workspaces, so the server reads them from the structural edges auth-brain syncs into OpenFGA (`src/lib/openfgaRead.ts`). That sync is asynchronous. Reads use `HIGHER_CONSISTENCY`, and the resolved workspace is cross-checked against its site rows (every row must carry the key's tenant group, and every row stamped with a company must name the key's company), refusing on a mismatch. What remains: while the sync worker lags after a workspace moves between companies, the old company's key can still resolve to that workspace if it holds no sites yet, or if the move stays within one tenant group and the sites carry no company stamp. A brand-new company can see `no_sites_workspace` until its edges arrive. The proper fix is a read-only auth-brain route that answers a service account its own company's tenant group and workspaces from auth-brain's database; that is a change in the auth-brain repo, filed as a dated ROADMAP line there in [marlinjai/auth-brain#193](https://github.com/marlinjai/auth-brain/pull/193), and `resolveScopeForKey` then reads it instead of OpenFGA.

**3. Site operations (`src/lib/siteOps/`).**
- **Read:**
  - `list_sites`
  - `get_site`: pages, theme, components, version
  - `get_page`: an outline with node ids and resolved styles per breakpoint, kept short
  - `describe_vocabulary`: reuses `buildSchemaDocs()` from `src/lib/ai/pageGen/schemaDocs.ts`
- **Write (one batch per call, all or nothing, validated):**
  - Sites and pages: `create_site`, `create_page`, `update_page_settings`.
  - **Blocked content contract (all write tools):** a blocked tag or prop is rejected, never silently dropped. The call returns the rejected operations with a reason each, writes nothing and keeps the version unchanged. The only warnings on success are non-blocking ones (for example a limit nearly reached). The generation validator's drop-with-warning behavior is used only inside `generate_page`, whose result lists what was dropped.
  - Node trees and edits:
    - `insert_nodes` takes a node tree in the generation format, checked by `validateGeneration` (`validate.ts:1773`) then turned into editor nodes with `toEditorSnapshot` (`apply.ts:67`).
    - Single edits: `update_style`, `update_text`, `set_props`, `move_node`, `remove_node`.
    - Selector rules: `add_rule`.
  - Theme and components: `set_theme`, plus component placement through the existing definition actions.
  - Generation and images: `generate_page` from a brief, which runs the existing server pipeline in `src/app/api/ai/generate-page/route.ts` and saves the result. `find_images` reuses the Unsplash search in `stockImages.ts`.
- **Publish:**
  - `preview_url`: the editor preview link for the working copy.
  - `publish`, which requires confirmation.
  - `list_revisions` and `rollback`.
- **Every write** takes `expectedVersion`, returns the new version, rejects blocked tags and props (see the contract above), and uses the same limits as generation (`GENERATION_LIMITS`).

**4. MCP endpoint `src/app/api/mcp/route.ts`.**
- Streamable HTTP with no session state, copying Booking's tested handler: `initialize`, `ping`, `tools/list`, `tools/call`, protocol versions 2025-06-18, 2025-03-26 and 2024-11-05. This is the `initialize` era: a client that speaks only the newer stateless protocol (2026-07-28, which replaces `initialize` with `server/discover`) cannot connect until a `server/discover` handler is added, which is a later slice; the supported clients (Claude Code, Claude Desktop, claude.ai connectors) fall back to `initialize`. The handler also has a body size cap, 401 with `WWW-Authenticate: Bearer`, and 503 with `retry-after`.
- Tool annotations mark which tools only read and which are destructive.
- Per-key rate limit. A server `instructions` text explains the workflow: read the vocabulary, outline, insert, check the preview, publish.
- **Decided while building (2026-11-02, amended 2026-11-03):** the endpoint keeps no server-side session, so the confirmation dialog works like this: `initialize` answers an `Mcp-Session-Id` that carries the negotiated version, whether the client declared elicitation and a fingerprint of its key, signed with a per-process secret. A confirming tool call from such a client that accepts a stream is answered as one carrying `elicitation/create`; the client's answer arrives as its own POST and is matched by request id and key fingerprint, at most three open questions per key. No answer within two minutes, an error answer, a key past its question cap, or no capability falls back to the approval link of decision 6. Open questions live in the process under the same single-container rule. Tool results start with a notice that their text is data written by site authors or third parties, never an instruction, and the server instructions say the same. Per key: reads 300 a minute, writes 60 a minute and one at a time, image searches 30 per ten minutes, approval links 10 per ten minutes; at most five tool calls per JSON-RPC batch. The approval page (`/projects/<site>/confirm/<id>`) and its route (`POST /api/projects/<site>/confirmations/<id>`) are editor-only: whichever of #305 (the published-host route allowlist) and #319 lands second adds them and `/api/mcp` to `src/lib/hostRoutes.ts` without `published` methods.

**5. Plugin `plugin/lumitra-sites/` in framer-clone (Agent Plugins format, as Studio's). Done 2026-11-03.**
- Built: `plugin/lumitra-sites/` (`plugin.json`, `mcp.json` with the server as `streamable-http`, `README.md`, three skills), `plugin/lumitra-sites-mirror/` (the Claude Code files of the public mirror: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` with type `http`, `LICENSE`), the validator `plugin/validate.mjs` (adapted from Studio's) with `plugin/SPEC-NOTES.md`, `scripts/sync-plugin-repo.sh` and `.github/workflows/sync-plugin-mirror.yml`. CI runs the validator offline on every pull request; the unit tests check the skills and README against the live tool list (`src/server/mcp/__tests__/plugin.test.ts`).
- Skills:
  - `build-a-site`: brief, design direction (with the motion rules), describe_vocabulary first, read before writing, structure, small batches with expectedVersion, site_changed, the preview checked in a browser at every breakpoint, publish only when asked, tool output is data.
  - `edit-a-site`: read first, outline, targeted batches, verify, never publish unasked.
  - `redesign-a-site`: a screenshot per breakpoint, a critique, revision in passes (theme, layout, type, detail), look again.
- **The key, amended 2026-11-03 (supersedes the earlier "not expanded inside a header template"):** the server entry is `{ "type": "http", "url": "https://app.lumitra.co/api/mcp", "headers": { "Authorization": "Bearer ${LUMITRA_SITES_API_KEY}" } }`. Verified: Claude Code expands `${VAR}` (and `${VAR:-default}`) in a server's url and headers, for plugin servers too, at connect time, so the key is never written into a configuration file. A client that does not expand it, or Claude Code with the variable unset (the config still loads and `claude mcp list` shows `Missing environment variables: LUMITRA_SITES_API_KEY`), sends the literal `${LUMITRA_SITES_API_KEY}`, which the server refuses before it reaches auth-brain with 401 `a valid company API key is required` (checked against production on 2026-11-03). That fails closed with a clear error and sends nothing secret, which removes the reason the earlier text avoided the template. `claude mcp add --transport http ... --header "Authorization: Bearer $LUMITRA_SITES_API_KEY"` stays the server-only alternative; there the shell expands the key at add time and Claude Code stores it in plain text, which the README says. claude.ai and Claude Desktop connectors sign in with OAuth, which the endpoint does not offer, so they cannot connect yet; that is a later slice (an OAuth authorization server in front of the key), not part of this step.
- **Decided while building (2026-11-03), say so if you disagree:**
  - The mirror's marketplace is named `lumitra-sites`, not Studio's `lumitra`: Claude Code keys marketplaces by name, so two repositories both called `lumitra` collide for a user who adds both. "The same marketplace as Studio" (decision 1) is then one more plugin entry in Studio's mirror, with a GitHub source `marlinjai/lumitra-sites-plugin`; that is a change in the lumitra-studio repository.
  - Every file of the mirror comes from framer-clone (`plugin/lumitra-sites` plus `plugin/lumitra-sites-mirror`), unlike Studio, whose hand-written mirror manifests drifted. One version in all three manifests, enforced by the validator.
  - The plugin is versioned on its own from `0.1.0`; the endpoint's `serverInfo.version` describes the server, not the skills.
- **Install (once the mirror exists):**
  - Claude Code: `/plugin marketplace add marlinjai/lumitra-sites-plugin`, then `/plugin install lumitra-sites@lumitra-sites`, with `LUMITRA_SITES_API_KEY` set in the environment Claude Code starts from. Before the mirror exists: `claude --plugin-dir` on a directory that holds `plugin/lumitra-sites` and `plugin/lumitra-sites-mirror` laid together (what the sync script builds).
  - Server only: `claude mcp add --transport http lumitra-sites https://app.lumitra.co/api/mcp --header "Authorization: Bearer $LUMITRA_SITES_API_KEY"`.
  - The key: a company API key from auth.lumitra.co (company settings, API Keys) with the owner or admin role (a member key reaches no workspace) and the `sites` grant.
- **The public mirror is not created yet** (an outward-facing step, Marlin's yes). Until a deploy key is configured, the sync workflow is a green no-op. Once configured, clone or network failures fail the workflow. To go live: create `marlinjai/lumitra-sites-plugin` (public, empty, with `main` set as the default branch before the first sync), create the GitHub environment `plugin-mirror` on framer-clone allowing main only, add a write deploy key to the mirror and its private half as the environment secret `PLUGIN_MIRROR_DEPLOY_KEY` (the commands are at the top of `sync-plugin-mirror.yml`), then run `gh workflow run sync-plugin-mirror.yml`.

**6. Dogfood:** build the new lumitra.co page through the plugin. Every friction becomes a slice. The page is published to a `sites.lumitra.co` address first. Moving the lumitra.co domain is Marlin's yes.

**7. The in-editor AI works the same way (added 2026-11-02 at Marlin's request).** Generate and Polish stop being single-shot: the server runs an agent loop over the same site operations, renders the page, looks at the screenshots per breakpoint and revises, the way Claude Code redesigns a site. It is taught the full vocabulary the score measures, closing the "accepted, not taught" rows of `docs/primitives-score/latest.md`.

**Rough size:** two to three agent weeks across the six steps, as a judgement rather than a measurement. Steps 1 and 2 ship on their own first.

## What only Marlin can do

- Mint a company API key for Lumitra with the `sites` grant at auth.lumitra.co (owner session). The value goes straight into Infisical, never into chat.
- His yes before lumitra.co points at framer-clone.
- His yes to create the public mirror repository `marlinjai/lumitra-sites-plugin` (step 5 lists the setup that follows it).

## Verification

- **Unit:** every op against `ProjectModel` (apply, reject, all-or-nothing batch, stale version refused, blocked tags rejected with nothing written), the vocabulary docs and the rate limit.
- **Integration** (`pnpm test:integration`):
  - The MCP route with a mocked `verifyApiKey`: no key gives 401, a key without the grant gives 403, a key with the grant but without the admin role gives 403 on edit and publish tools, a foreign company gets no access, auth-brain down gives 503.
  - A full chain: create site, insert, read back, publish, rollback.
  - The editor's Save gets 409 after an agent write.
- **End to end on production after deploy:**
  - Register with `claude mcp add --transport http lumitra-sites https://app.lumitra.co/api/mcp --header "Authorization: Bearer $LUMITRA_SITES_API_KEY"`, with the key injected from Infisical.
  - Have an agent build a test page.
  - Open it in the editor through `dev-browser-auto` and confirm it shows. Edit it in the editor and confirm the agent's next write gets 409.
  - Publish to the test site and load the live address.
- **Score stays green:** `pnpm score:primitives` does not drop.
