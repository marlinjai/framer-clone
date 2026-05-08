---
name: lumitra-studio-project-binding
track: lumitra-studio
wave: 1
priority: P1
status: draft
depends_on: []
estimated_value: 7
estimated_cost: 2
owner: unassigned
---

# Lumitra project binding on the framer-clone project model

## Goal

Add a small, reserved Lumitra integration block to the framer-clone `ProjectModel` so a published site can be associated with a Lumitra Analytics project. This is a foundation slice: no UI, no snippet emission, no dashboard link yet. It just persists the fields that all later specs (snippet injection, dashboard deep-link, edit-mode heatmap overlay) need to read. Landing it first means the snippet-injection and dashboard-link specs can plug in cleanly without re-shaping MST and re-running migrations.

## Scope

**In:**
- New optional sub-tree on `ProjectModel`: `lumitra: { projectId?: string; ingestionEndpoint?: string; apiKeyRef?: string; enabled?: boolean }`.
- Default values: all undefined / `enabled: false`. Existing projects remain unchanged.
- MST snapshot migration helper to upgrade pre-existing project snapshots to include the (empty) lumitra block. Pre-MVP, no backcompat: rewrite old shapes silently rather than guarding everywhere.
- Persistence through whatever mechanism `ProjectModel` already uses (currently in-memory + history; no DB yet).
- Unit tests covering: default shape, snapshot round-trip, mutation actions (`setLumitraProjectId`, `setLumitraEnabled`).

**Out (explicitly deferred):**
- Settings UI to populate these fields (Wave 2 spec: `lumitra-studio-settings-panel`).
- Snippet injection on publish (Wave 2 spec: `lumitra-studio-snippet-injection`).
- Dashboard deep-link UI (Wave 2 spec: `lumitra-studio-dashboard-link`).
- Edit-mode heatmap overlay (Wave 3 spec: `lumitra-studio-heatmap-overlay-edit-mode`).
- Storing the API key directly. We store an `apiKeyRef` (Infisical path or workspace-scoped reference) so the secret never lives in MST or in the publish output. Resolution happens server-side on the publish path.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/models/ProjectModel.ts` | edit | Add optional `lumitra` sub-tree with the four fields, plus actions |
| `src/models/__tests__/ProjectModel.lumitra.test.ts` | new | Unit tests for default shape, actions, snapshot round-trip |

## API surface

```ts
// Additions to ProjectModel
export const LumitraBindingModel = types.model('LumitraBinding', {
  projectId: types.maybe(types.string),         // Lumitra project UUID
  ingestionEndpoint: types.maybe(types.string), // e.g. https://analytics.lumitra.co/api/collect
  apiKeyRef: types.maybe(types.string),         // server-side reference, NOT the literal key
  enabled: types.optional(types.boolean, false),
});

// On ProjectModel:
//   .lumitra: LumitraBindingModel  (optional)
//   .actions:
//     setLumitraProjectId(id: string | undefined)
//     setLumitraIngestionEndpoint(url: string | undefined)
//     setLumitraApiKeyRef(ref: string | undefined)
//     setLumitraEnabled(on: boolean)
```

## Data shapes

```ts
// MST snapshot shape (additive)
{
  // ...existing project fields
  "lumitra": {
    "projectId": "01H8...UUID",
    "ingestionEndpoint": "https://analytics.lumitra.co/api/collect",
    "apiKeyRef": "infisical:/framer-clone/<workspace-id>/LUMITRA_API_KEY",
    "enabled": true
  }
}
```

## Test plan

- [ ] Unit: new project has `lumitra.enabled === false` and undefined fields by default.
- [ ] Unit: `setLumitraProjectId` updates the field; `setLumitraEnabled(true)` flips the flag.
- [ ] Unit: snapshot round-trip preserves the lumitra block.
- [ ] Unit: pre-existing snapshots without `lumitra` load successfully and report `lumitra.enabled === false`.
- [ ] Unit: typecheck passes against the new MST shape.

## Definition of done

- [ ] MST shape lands and typechecks.
- [ ] All unit tests pass.
- [ ] No regressions in `ProjectModel` history / undo behavior (lumitra mutations participate in the history store like any other action).
- [ ] Status moved to `done` in STATUS.md.

## Open questions

- **`apiKeyRef` resolution path.** The reference points at Infisical or a server-side env. Resolution happens at publish time on the server (NOT in the browser editor). Where does resolution code live: in framer-clone's Next.js API route layer, or in a separate publish service? Recommended: in a thin Next.js route handler colocated with the publish output route, called by the snippet injector. Surface for confirmation.
- **Multi-tenant boundary.** Each framer-clone customer has their own Lumitra project (different `projectId`, different `apiKeyRef`). Is there a workspace-level default that auto-populates new projects? Probably yes (Phase 2 concern), out of scope here.
- **`enabled` field semantics.** Does it gate the snippet injection on publish, the dashboard-link visibility, or both? Recommended: both. Snippet injection short-circuits when `enabled === false`; dashboard link is hidden.

## References

- Plan: `analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md` (Phase A, lines 174 to 180)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` ("Lumitra Studio integration: apps built on framer-clone are instrumented for growth from day zero")
- Code touchpoints: `src/models/ProjectModel.ts`, `src/stores/RootStore.ts`
