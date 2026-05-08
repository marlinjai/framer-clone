---
name: lumitra-studio-dashboard-link
track: lumitra-studio
wave: 2
priority: P2
status: draft
depends_on: [lumitra-studio-project-binding, lumitra-studio-settings-panel]
estimated_value: 5
estimated_cost: 1
owner: unassigned
---

# Deep-link from framer-clone editor to the Lumitra dashboard

## Goal

Once a project has a Lumitra binding configured, surface a link in the editor that opens the matching Lumitra dashboard for that project (analytics overview, heatmap, replay) in a new tab. This is the lightweight Phase A glue: until Phase B brings analytics into the editor canvas, the user still needs a one-click way to see their data. Cheap, high-discoverability, sets up Phase B's deeper integration.

## Scope

**In:**
- A small UI affordance (button or menu item) in the editor that opens `https://analytics.lumitra.co/projects/<projectId>` in a new tab.
- The link is hidden when `lumitra.enabled === false` or when no binding is configured.
- Sub-links: "Overview", "Heatmaps", "Sessions" (matching the Lumitra dashboard's top-level routes).
- A `buildLumitraDashboardUrl(binding, view: 'overview' | 'heatmap' | 'sessions')` helper.

**Out (explicitly deferred):**
- Embedded dashboard iframe inside the editor (rejected: complicates auth, CSP, replicates the heatmap overlay work coming in Wave 3).
- SSO from framer-clone into Lumitra (Phase 2, depends on auth-brain Phase 3.5).
- Live data preview in the editor (Wave 3 spec: `lumitra-studio-heatmap-overlay-edit-mode`).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/lumitra/buildDashboardUrl.ts` | new | URL helper |
| `src/lib/lumitra/__tests__/buildDashboardUrl.test.ts` | new | Unit tests |
| `src/components/TopBar.tsx` | edit | Add the link affordance (icon + dropdown for views) |

## API surface

```ts
export type LumitraDashboardView = 'overview' | 'heatmap' | 'sessions';

export interface LumitraDashboardUrlInput {
  projectId: string;
  baseUrl?: string; // defaults to https://analytics.lumitra.co
}

export function buildLumitraDashboardUrl(
  input: LumitraDashboardUrlInput,
  view: LumitraDashboardView,
): string;
```

## Data shapes

```ts
// URL conventions (assumed; coordinate with analytics-platform if Lumitra changes them):
//   /projects/<projectId>
//   /projects/<projectId>/heatmap
//   /projects/<projectId>/sessions
//
// If the dashboard's URL shape changes, this helper is the single point of update.
```

## Test plan

- [ ] Unit: `buildLumitraDashboardUrl({ projectId: "abc" }, "overview")` returns `https://analytics.lumitra.co/projects/abc`.
- [ ] Unit: heatmap and sessions views produce the matching paths.
- [ ] Unit: custom `baseUrl` overrides the default (for self-hosted Lumitra).
- [ ] Manual: in the editor, the link opens the correct dashboard view in a new tab; opens at all only when `lumitra.enabled === true`.

## Definition of done

- [ ] Helper lands with full test coverage.
- [ ] Link appears in the editor only when Lumitra is enabled for the current project.
- [ ] All views deep-link correctly against the staging Lumitra dashboard.
- [ ] Status moved to `done` in STATUS.md.

## Open questions

- **Lumitra dashboard URL contract.** Does `/projects/<id>` or `/projects/<id>/overview` exist today? Source of truth is `analytics-platform/packages/dashboard/src/app/(dashboard)/`. Confirm before pinning the helper.
- **Tenant boundary.** A framer-clone customer's Lumitra account is theirs (their auth, their workspace). When they click the link, they may not be logged in to Lumitra. Should we open a generic `/login?redirect=...` instead and rely on Lumitra's own auth? Recommended: just open the project URL directly; Lumitra handles its own login redirect. Confirm.

## References

- Plan: `analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md` (Phase A and Phase D)
- External: `analytics-platform/packages/dashboard/` (URL shape)
- Code touchpoints: `src/components/TopBar.tsx`
