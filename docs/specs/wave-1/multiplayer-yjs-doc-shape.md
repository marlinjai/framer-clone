---
name: multiplayer-yjs-doc-shape
track: multiplayer
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 9
estimated_cost: 4
owner: unassigned
---

# Yjs document shape mirroring the MST tree

## Goal

Define and freeze the Yjs document schema that mirrors the persisted fields of `ComponentModel` / `PageModel` / `ProjectModel`. Once multiplayer ships, this Yjs doc is the canonical source of truth for canvas state. MST becomes a derived projection (Shape C). Every other multiplayer spec depends on this schema being stable, so we get it right once and document it before any sync code lands.

## Scope

**In:**
- A pure-TypeScript module that exports factory functions for a fresh `Y.Doc` shaped to hold one project (with pages, breakpoints, component trees).
- `Y.Map` per node, keyed by component ID, stored under a top-level `nodes: Y.Map<Y.Map<any>>` (flat ID-keyed registry, not nested children).
- `Y.Array<string>` for `children` (ID references), per node, to avoid pathological nested-map flatten/unflatten cost.
- Per-node fields: scalar props (`type`, `componentType`, `canvasNodeType`, `canvasX`, `canvasY`, `canvasScale`, `canvasRotation`, `canvasZIndex`, `canvasVisible`, `canvasLocked`, `parentId`, `breakpointId`, `viewportWidth`, `viewportHeight`, `breakpointMinWidth`, `label`) as `Y.Map` keys. `props` as a nested `Y.Map`. `style` as a nested `Y.Map` under `props`.
- Top-level `pages: Y.Array<string>` (page ID references) and `pages_by_id: Y.Map<Y.Map<any>>` for page metadata (slug, name, root component IDs, breakpoint list).
- Top-level `project: Y.Map<any>` for project-scope metadata.
- Schema version constant (`YJS_DOC_SCHEMA_VERSION = 1`) stored in `project.schemaVersion`. Used by future migrations.
- Conversion helpers: `mstSnapshotToYDoc(snapshot): Y.Doc` and `yDocToMstSnapshot(doc): ProjectSnapshotIn`. Pure functions, no MST instance required.
- Vitest fixtures covering: floating element, viewport node, nested children, responsive style maps, text-content prop.

**Out (explicitly deferred):**
- Wiring this schema to MST live (see `multiplayer-yjs-mst-binding-slice` for the vertical slice and `multiplayer-yjs-mst-binding-full` in wave 2).
- `Y.Text` for inline text (v2 concern, called out in research plan caveats).
- Awareness/presence shape (see `multiplayer-presence-awareness`).
- Y.UndoManager wiring (see `multiplayer-per-user-undo`).
- Schema migrations beyond v1.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/multiplayer/yjsDocShape.ts` | new | Schema constants, factory `createEmptyProjectYDoc()`, conversion helpers. |
| `src/lib/multiplayer/yjsDocShape.test.ts` | new | Vitest unit coverage for round-trip conversion + schema constants. |
| `src/lib/multiplayer/index.ts` | new | Barrel export for the multiplayer lib. |
| `package.json` | edit | Add `yjs` dep (latest stable, MIT). |

## API surface

```ts
export const YJS_DOC_SCHEMA_VERSION = 1;

export const YJS_KEYS = {
  nodes: 'nodes',
  pagesById: 'pages_by_id',
  pageOrder: 'pages',
  project: 'project',
} as const;

export interface YProjectMeta {
  schemaVersion: number;
  projectId: string;
  name: string;
  primaryBreakpointId: string;
  // breakpoint list lives on each page; project holds default
}

export function createEmptyProjectYDoc(args: {
  projectId: string;
  name: string;
  primaryBreakpointId: string;
}): Y.Doc;

export function mstSnapshotToYDoc(snapshot: ProjectSnapshotIn): Y.Doc;

export function yDocToMstSnapshot(doc: Y.Doc): ProjectSnapshotIn;

// Path helpers used by the binding layer (wave 1 slice, wave 2 full).
export function getNodeMap(doc: Y.Doc, nodeId: string): Y.Map<any> | undefined;
export function getChildrenArray(doc: Y.Doc, nodeId: string): Y.Array<string> | undefined;
```

## Data shapes

```ts
// Top-level Y.Doc layout:
//
// doc.getMap('project'): Y.Map
//   - schemaVersion: number
//   - projectId: string
//   - name: string
//   - primaryBreakpointId: string
//
// doc.getArray('pages'): Y.Array<string>           // page IDs in order
//
// doc.getMap('pages_by_id'): Y.Map<Y.Map>
//   key: pageId
//   value: Y.Map { id, slug, name, breakpoints: Y.Array<Y.Map>, rootComponentIds: Y.Array<string> }
//
// doc.getMap('nodes'): Y.Map<Y.Map>                // flat node registry, ID-keyed
//   key: componentId
//   value: Y.Map {
//     id, type, componentType, canvasNodeType,
//     canvasX, canvasY, canvasScale, canvasRotation, canvasZIndex,
//     canvasVisible, canvasLocked,
//     parentId, breakpointId, breakpointMinWidth,
//     viewportWidth, viewportHeight, label,
//     props: Y.Map { ...scalars, style: Y.Map { ... } },
//     children: Y.Array<string>                    // child component IDs
//   }
```

## Test plan

- [ ] Unit (`yjsDocShape.test.ts`): `createEmptyProjectYDoc` produces a doc with the four top-level keys present and `schemaVersion === 1`.
- [ ] Unit: `mstSnapshotToYDoc(snap)` then `yDocToMstSnapshot(doc)` round-trips structurally for a fixture covering: viewport node with nested container with nested text, one floating element with `canvasX`/`canvasY`, one responsive style map (`width: { base: '100%', mobile: '50%' }`).
- [ ] Unit: `getNodeMap` and `getChildrenArray` return live references that, when mutated, are observable on the doc.
- [ ] Unit: encoding the doc to a `Uint8Array` (`Y.encodeStateAsUpdate`) and decoding back into a fresh doc preserves the round-trip.

## Definition of done

- [ ] Code lands and typechecks.
- [ ] `pnpm test` passes including the new suite.
- [ ] No regressions in existing `pnpm test` (the binding is not yet wired, so MST behavior is unchanged).
- [ ] Schema constants documented at the top of `yjsDocShape.ts` with rationale (why flat ID-keyed registry, why ID references in `children`).
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Should `props.style` be a `Y.Map` or stay as a frozen JSON blob via `Y.Map.set('style', plainObject)`? `Y.Map` gives per-property LWW (so two users editing different style props don't conflict). Plain blob means whole-style LWW on every edit, which is wrong. **Default: `Y.Map`.** Confirm with Marlin.
- Responsive maps (`{ base: '100%', mobile: '50%' }`) are nested inside a style key. Do we represent these as a `Y.Map` (per-breakpoint LWW) or plain object? **Default: `Y.Map`.** Same reasoning.
- Page-level breakpoints array: `Y.Array<Y.Map>` (per-breakpoint reactivity) or `Y.Array<plainObject>` (atomic replacement)? Breakpoints rarely change at runtime: **Default: plain object,** simpler.

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (sections 2c, 3)
- Code touchpoints: `src/models/ComponentModel.ts`, `src/models/PageModel.ts`, `src/models/ProjectModel.ts`
- External: https://docs.yjs.dev/api/shared-types
- External: https://docs.yjs.dev/api/document-updates (encoding format used for persistence)
