---
type: plan
status: decided
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
2. **The endpoint lives inside framer-clone, like Booking, not as a separate npm server like Studio.** One deploy, no version drift, and it works with `claude mcp add --transport http` and claude.ai connectors. The plugin is skills plus an `.mcp.json` pointing at that URL, with the key taken from an environment variable.
3. **Auth is a company API key with the `sites` grant,** checked through `verifyApiKey`, failing closed with a 503 when auth-brain is down. A bearer header never falls back to the cookie. The scope is the key's company: its sites workspace via `resolveScopeForCompanyWorkspace` (`src/server/sites/scope.ts:294`). The service account counts as workspace admin only if the key's role allows it.
4. **One operations vocabulary, shared by the agent, the in-editor AI and later the CLI,** as the 2026-05-31 platform plan says ("do not build a separate agent API"). It extends the existing review ops (`src/lib/ai/review/ops.ts`) and maps one-to-one onto existing editor actions, which already run on the server (`POST /api/projects` calls `ProjectModel.create`).
5. **Every agent write is applied on the server:** load the project, apply the ops as `ProjectModel` and `PageModel` actions, check them, then save with a version check. Nothing reaches storage without passing `ProjectModel.create` and the generation validator.
6. **Publish is allowed,** with an explicit confirmation step (MCP elicitation, or a one-time token like Studio's `manageTools.ts`). It can be undone through revision rollback. Deleting sites or domains is not exposed in the first version.
7. **First rollout is limited to Marlin's company.** The `sites` grant is operator-only today, so access is limited already. Opening it to customers comes later and is a separate decision.

## Work, in order

**1. Version lock (needed by both the agent and the editor).**
- Add a `version` integer column to `sites` (additive migration). `saveProject` and `publishProject` take an `expectedVersion` and refuse a stale write with 409 `site_changed`.
- The editor's Save sends the version it loaded. On 409 the editor shows "this site was changed elsewhere, reload or keep yours" instead of overwriting.
- Files: `src/server/sites/repository.ts`, `src/app/api/projects/_schema.ts`, the save and publish routes, `src/stores/openProject.ts` (it already compares baseline, server and working copies on load).

**2. Machine door.**
- New `src/lib/auth-machine.ts`: `verifyCompanyKey(req)`, modelled on Booking's `session.ts` and Studio's `verifyRequest.ts`, returning `{kind:'key', tenantId, keyId, serviceAccountId, scope}`, `refused` or `unavailable`.
- Middleware lets a bearer request reach `/api/mcp` only. Cross-origin writes stay refused for cookie requests.
- Every agent action is audited with the key id and service account.

**3. Site operations (`src/lib/siteOps/`).**
- **Read:**
  - `list_sites`
  - `get_site`: pages, theme, components, version
  - `get_page`: an outline with node ids and resolved styles per breakpoint, kept short
  - `describe_vocabulary`: reuses `buildSchemaDocs()` from `src/lib/ai/pageGen/schemaDocs.ts`
- **Write (one batch per call, all or nothing, validated):**
  - Sites and pages: `create_site`, `create_page`, `update_page_settings`.
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
- **Every write** takes `expectedVersion`, returns the new version, refuses blocked tags and props, and uses the same limits as generation (`GENERATION_LIMITS`).

**4. MCP endpoint `src/app/api/mcp/route.ts`.**
- Streamable HTTP with no session state, copying Booking's tested handler: `initialize`, `ping`, `tools/list`, `tools/call`, protocol versions 2025-06-18, 2025-03-26 and 2024-11-05, a body size cap, 401 with `WWW-Authenticate: Bearer`, and 503 with `retry-after`.
- Tool annotations mark which tools only read and which are destructive.
- Per-key rate limit. A server `instructions` text explains the workflow: read the vocabulary, outline, insert, check the preview, publish.

**5. Plugin `plugin/lumitra-sites/` in framer-clone (Agent Plugins format, as Studio's).**
- `plugin.json` and an `.mcp.json` of type http with `Authorization: Bearer ${LUMITRA_SITES_API_KEY}`.
- Skills:
  - `build-a-site`: brief, design direction, structure, build, check the preview in a browser, publish.
  - `edit-a-site`: read first, make small batched edits.
- A public mirror and marketplace entry following Studio's `sync-plugin-mirror.yml`.

**6. Dogfood:** build the new lumitra.co page through the plugin. Every friction becomes a slice. The page is published to a `sites.lumitra.co` address first. Moving the lumitra.co domain is Marlin's yes.

**7. The in-editor AI works the same way (added 2026-11-02 at Marlin's request).** Generate and Polish stop being single-shot: the server runs an agent loop over the same site operations, renders the page, looks at the screenshots per breakpoint and revises, the way Claude Code redesigns a site. It is taught the full vocabulary the score measures, closing the "accepted, not taught" rows of `docs/primitives-score/latest.md`.

**Rough size:** two to three agent weeks across the six steps, as a judgement rather than a measurement. Steps 1 and 2 ship on their own first.

## What only Marlin can do

- Mint a company API key for Lumitra with the `sites` grant at auth.lumitra.co (owner session). The value goes straight into Infisical, never into chat.
- His yes before lumitra.co points at framer-clone.

## Verification

- **Unit:** every op against `ProjectModel` (apply, reject, all-or-nothing batch, stale version refused, blocked tags dropped), the vocabulary docs and the rate limit.
- **Integration** (`pnpm test:integration`):
  - The MCP route with a mocked `verifyApiKey`: no key gives 401, a key without the grant gives 403, a foreign company gets no access, auth-brain down gives 503.
  - A full chain: create site, insert, read back, publish, rollback.
  - The editor's Save gets 409 after an agent write.
- **End to end on production after deploy:**
  - Register with `claude mcp add --transport http lumitra-sites https://app.lumitra.co/api/mcp --header "Authorization: Bearer $LUMITRA_SITES_API_KEY"`, with the key injected from Infisical.
  - Have an agent build a test page.
  - Open it in the editor through `dev-browser-auto` and confirm it shows. Edit it in the editor and confirm the agent's next write gets 409.
  - Publish to the test site and load the live address.
- **Score stays green:** `pnpm score:primitives` does not drop.
