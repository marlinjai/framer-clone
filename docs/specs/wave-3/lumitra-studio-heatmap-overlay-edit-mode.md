---
name: lumitra-studio-heatmap-overlay-edit-mode
track: lumitra-studio
wave: 3
priority: P1
status: draft
depends_on: [lumitra-studio-component-id-attribution, lumitra-studio-project-binding, lumitra-studio-snippet-injection, lumitra-studio-settings-panel]
estimated_value: 8
estimated_cost: 6
owner: unassigned
---

# Heatmap overlay rendered on the framer-clone canvas

## Goal

This is the Phase B payoff: once `data-component-id` survives to the published DOM and clicks have been flowing into Lumitra for a while, render those clicks AS A HEATMAP directly on top of the framer-clone editor canvas, in design mode, per breakpoint. Multi-device canvases (Framer's distinctive feature, already present in framer-clone via the responsive page renderer) become multi-viewport heatmap views by construction: each artboard size renders the heatmap data filtered to viewports matching that artboard's width. This is the moat call-out from the strategic thesis: "competitors sell analytics that integrate via SDK. None of them own the design surface." This spec is the smallest end-to-end demonstration of that integration.

## Scope

**In:**
- A "Heatmap mode" toggle in the editor (suggested: top bar, near the Preview button).
- When active, the editor canvas renders a translucent heatmap layer on top of each viewport node, fed by Lumitra click data filtered to that viewport's breakpoint.
- A small `LumitraHeatmapClient` that fetches `GET /api/heatmap?projectId=<id>&days=7&viewportBucket=<bucket>` from the Lumitra dashboard API (proxied through a framer-clone server route to avoid CORS / leak the api key).
- Click positions are matched to canvas nodes by `data-component-id` (because the editor renderer also emits this attribute today). No fingerprint matching needed inside the editor: the editor knows every node's id directly.
- Date range picker (1d / 7d / 30d) and a "match-by-id" toggle.
- Caching: heatmap data is cached per (projectId, dateRange, breakpoint) for 60 seconds in memory.

**Out (explicitly deferred):**
- DOM-fingerprint match for clicks captured before the corresponding canvas node existed (deferred: requires Pillar 1 from the analytics-platform plan to be consumed bidirectionally, which is heavier).
- Variants-as-design-alternatives (Phase C, Phase 2 of strategic thesis).
- Live experiment results in the editor sidebar (Phase D, Phase 2 of strategic thesis).
- Session replay scrubber (Phase 2).
- Filter by browser / OS / country / source. Phase 2 polish.
- Real-time heatmap updates (poll-based; no websocket).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/lumitra/HeatmapClient.ts` | new | Fetch + cache the heatmap data |
| `src/components/canvas/HeatmapOverlay.tsx` | new | Renders the heatmap on top of a viewport node |
| `src/components/canvas/HeatmapModeToggle.tsx` | new | The top-bar toggle |
| `src/stores/EditorUIStore.ts` | edit | Add `heatmapMode: { enabled, dateRange }` |
| `src/app/api/lumitra/heatmap/route.ts` | new | Server proxy: validates project ownership, calls Lumitra dashboard API with the resolved key, returns aggregated click positions |
| `src/components/Canvas.tsx` | edit | Mount `HeatmapOverlay` per viewport when `heatmapMode.enabled` |
| `src/components/TopBar.tsx` | edit | Mount the toggle |
| `src/lib/lumitra/__tests__/HeatmapClient.test.ts` | new | Unit tests |
| `src/components/canvas/__tests__/HeatmapOverlay.test.tsx` | new | Component tests |

## API surface

```ts
// src/lib/lumitra/HeatmapClient.ts
export interface HeatmapPoint {
  componentId: string; // matches data-component-id on the canvas
  x: number;           // element-relative offset (ox)
  y: number;           // element-relative offset (oy)
  w: number;           // element width at click time (ew)
  h: number;           // element height (eh)
  count: number;       // aggregated click count
}

export interface HeatmapQuery {
  projectId: string;
  days: 1 | 7 | 30;
  viewportBucket: 'mobile' | 'tablet' | 'desktop';
}

export class LumitraHeatmapClient {
  fetch(query: HeatmapQuery): Promise<HeatmapPoint[]>;
}

// src/components/canvas/HeatmapOverlay.tsx
export interface HeatmapOverlayProps {
  viewportNodeId: string;
  breakpoint: { id: string; minWidth: number };
  points: HeatmapPoint[];
}
```

## Data shapes

```ts
// Server proxy response shape
{
  "viewportBucket": "desktop",
  "dateRange": "7d",
  "points": [
    { "componentId": "node_42", "x": 40, "y": 18, "w": 200, "h": 32, "count": 137 },
    ...
  ],
  "fetchedAt": 1735689600000
}

// Mapping from breakpointId to viewportBucket
// (until analytics-platform exposes a richer query surface):
//   minWidth < 640  -> mobile
//   640..1024       -> tablet
//   >= 1024         -> desktop
```

## Test plan

- [ ] Unit: `HeatmapClient.fetch` returns parsed points, caches subsequent calls within 60s.
- [ ] Unit: `HeatmapOverlay` renders a circle (or canvas blob) per point at the correct offset relative to the matched DOM node.
- [ ] Unit: when no DOM node matches a point's componentId, the point is silently dropped (logged at debug).
- [ ] Unit (server): `/api/lumitra/heatmap` rejects requests for projects the caller does not own; resolves the apiKeyRef server-side; calls Lumitra with the literal key.
- [ ] Integration: in a fixture editor, toggle heatmap mode, assert the overlay renders points only on viewports matching the bucket.
- [ ] Manual: real end-to-end against a staging Lumitra project that has actual click data: heatmap mode renders coherent blobs on the matching design elements at all three viewports simultaneously.

## Definition of done

- [ ] Heatmap mode toggle works.
- [ ] Overlay renders on each viewport's design.
- [ ] Server proxy never leaks the literal API key.
- [ ] Caching prevents request storms when toggling between viewports.
- [ ] All tests pass.
- [ ] Manual e2e demo recorded on the staging Lumitra project (this is the moat artifact for investor demos).
- [ ] Status moved to `done` in STATUS.md.

## Open questions

- **Lumitra dashboard heatmap query API.** What endpoint exposes click aggregation by `data-component-id` AND by viewport bucket? Source of truth: `analytics-platform/packages/dashboard/src/app/api/heatmap/`. The current API may need extension on the analytics side; this spec assumes `componentId` and `viewportBucket` filters are queryable. If not, file a coordination issue against analytics-platform.
- **Viewport bucket mapping.** The breakpoints framer-clone exposes are user-defined per project. Lumitra clusters viewport widths into mobile / tablet / desktop. Mapping is approximate and lives in this spec for now. Phase 2 may negotiate a richer per-breakpoint query.
- **Heatmap render style.** Simple circles per click (cheap, easy to reason about) vs Gaussian blob via canvas (matches Lumitra dashboard). Recommended: circles in v1, blob in a later polish pass. Surface to Marlin.
- **Caching window.** 60s is a guess. May need to be longer to avoid hammering the analytics API, shorter for "live" feel. Defer tuning.
- **Real-time updates.** Out of scope. Phase 2 may revisit if customer signal demands it (matches the strategic thesis: "Real-time on published apps: Phase 1 ships polling").
- **Multi-tenant boundary.** The `/api/lumitra/heatmap` route MUST verify the caller owns the framer-clone project AND that the project's `apiKeyRef` matches the requested Lumitra `projectId`. Otherwise a malicious user with editor access could pivot to read another project's analytics. Pin this assertion in the route's tests.

## References

- Plan: `analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md` (Phase B, lines 181 to 184)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` (Lumitra Studio integration, "moat")
- Code touchpoints: `src/components/Canvas.tsx`, `src/components/ResponsivePageRenderer.tsx`, `src/components/ComponentRenderer.tsx`
- External: `analytics-platform/packages/dashboard/src/app/api/heatmap/` (heatmap query API to coordinate against)
