---
name: lumitra-studio-settings-panel
track: lumitra-studio
wave: 2
priority: P1
status: draft
depends_on: [lumitra-studio-project-binding]
estimated_value: 6
estimated_cost: 3
owner: unassigned
---

# Settings panel for Lumitra Analytics binding

## Goal

Give the user a place inside the framer-clone editor to enable Lumitra Analytics for the current project, paste their Lumitra project ID and API key (stored as a server-side reference, never as a literal in MST), and verify connection. Without this, the `lumitra-studio-snippet-injection` spec has no values to inject. This is Phase A user-facing configuration: small, scoped, opinionated, mirrors the existing `analytics-platform/packages/dashboard` onboarding shape so users who already integrated Lumitra in a non-framer site recognize the flow.

## Scope

**In:**
- A new settings page or modal accessible from the editor (location to confirm; suggested: project settings panel reachable from the project title in `TopBar.tsx`).
- Inputs: Lumitra project ID, ingestion endpoint (defaults to `https://analytics.lumitra.co/api/collect`), API key field (write-only after first submit; renders as `••••` after persistence).
- Actions: enable / disable toggle (binds to `lumitra.enabled`), "Test connection" button hitting a server-side validator that pings the configured endpoint with the key.
- Server-side route to receive the API key, store it via the workspace's secret store (Infisical), and persist back the resulting `apiKeyRef` to MST (so the literal never lives in MST or in git).
- Inline link out to `analytics.lumitra.co` to provision a project if the user does not have one yet.

**Out (explicitly deferred):**
- Workspace-level default Lumitra binding (auto-populate new projects from a workspace setting). Phase 2 multi-tenant concern.
- OAuth / SSO flow into the Lumitra dashboard. Phase 2 polish, separate plan.
- Visual editor for experiments / variants (Phase C in the analytics-platform plan, deferred to Phase 2 of strategic thesis).
- Heatmap overlay in edit mode (Wave 3 spec: `lumitra-studio-heatmap-overlay-edit-mode`).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/components/settings/LumitraSettingsPanel.tsx` | new | UI for the binding fields |
| `src/components/settings/index.ts` | new (or edit) | Registry of project settings panels |
| `src/components/TopBar.tsx` | edit | Add a settings entry point (e.g. gear icon next to project title) |
| `src/app/api/lumitra/store-key/route.ts` | new | Server route that pushes the literal key to Infisical and returns the `apiKeyRef` |
| `src/app/api/lumitra/test-connection/route.ts` | new | Server route that pings the ingestion endpoint with the resolved key, returns 200 / 4xx |
| `src/components/settings/__tests__/LumitraSettingsPanel.test.tsx` | new | Component tests |

## API surface

```ts
// Client-side calls
POST /api/lumitra/store-key
  body: { projectId: string; ingestionEndpoint: string; apiKey: string }
  -> 200 { apiKeyRef: string }
  -> 4xx { error: string }

POST /api/lumitra/test-connection
  body: { apiKeyRef: string; ingestionEndpoint: string; projectId: string }
  -> 200 { ok: true; latencyMs: number }
  -> 4xx { ok: false; error: string }
```

## Data shapes

```ts
// On submit, the panel:
// 1. POSTs the literal apiKey to /api/lumitra/store-key.
// 2. Receives the apiKeyRef back.
// 3. Calls project.lumitra.setLumitraProjectId / setIngestionEndpoint / setLumitraApiKeyRef.
// 4. Calls /api/lumitra/test-connection to verify.
// 5. If ok, calls project.lumitra.setLumitraEnabled(true).
//
// The literal apiKey never lives in MST and is never echoed back from the server.
```

## Test plan

- [ ] Unit: `LumitraSettingsPanel` renders with empty fields when binding is empty.
- [ ] Unit: typing values and clicking save triggers the expected sequence of fetches.
- [ ] Unit: panel shows masked `••••` when `apiKeyRef` is set.
- [ ] Unit (server): `/api/lumitra/store-key` rejects invalid input shapes, calls a mocked Infisical client, returns the ref.
- [ ] Unit (server): `/api/lumitra/test-connection` calls the configured endpoint with the resolved key.
- [ ] Manual: real end-to-end against a staging Lumitra project: paste real values, click save, confirm "Test connection" returns ok, publish a sample page, confirm the tracker boots in the browser.

## Definition of done

- [ ] Settings panel reachable from the editor.
- [ ] Save flow persists the binding and returns a non-literal `apiKeyRef`.
- [ ] Test connection returns success against a live Lumitra staging project.
- [ ] No literal API keys logged or stored in MST.
- [ ] All tests pass.
- [ ] Status moved to `done` in STATUS.md.

## Open questions

- **Settings UI location.** TopBar gear icon vs a dedicated `/settings` route vs a slide-over panel from the right sidebar. Recommended: slide-over panel triggered from a gear icon adjacent to the project title in `TopBar.tsx`. Surface to Marlin.
- **Secret storage backend.** Infisical is the project default per global rules. But framer-clone's runtime might not have an Infisical machine identity in production; in that case fall back to `process.env.LUMITRA_API_KEY_*` keyed by project id. Decision: ship with Infisical assumption, document the env-var fallback. Confirm with Marlin.
- **`apiKeyRef` shape.** Suggest `infisical:/framer-clone/<workspaceId>/<projectId>/LUMITRA_API_KEY` so the path is human-readable and namespaced. Pin in this spec.
- **Self-hosted Lumitra deployments.** Some users may want to point at their own analytics endpoint, not `analytics.lumitra.co`. The endpoint field is editable specifically to allow this. Confirm this is desired behavior for Phase 1.

## References

- Plan: `analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md` (Phase A)
- Memory: `memory/project_strategic_thesis_bubble_killer.md`
- Code touchpoints: `src/components/TopBar.tsx`, `src/models/ProjectModel.ts`
- External: `analytics-platform/packages/dashboard/src/app/(onboarding)/` for the matching SDK setup UX
