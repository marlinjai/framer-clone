---
name: ai-pattern-a-mst-snapshot-serializer
track: ai-pattern-a
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 7
estimated_cost: 3
owner: unassigned
---

# MST snapshot serializer for AI prompts

## Goal

Produce a deterministic, prompt-friendly serialization of the MST tree (project overview, page subtree, component subtree, registry, breakpoints) suitable for inclusion in Anthropic system / user messages. The serializer is read-only; it does not mutate. Determinism matters for two reasons: (1) prompt caching only hits if the prefix is byte-identical across turns, so we must split snapshots into a stable, cacheable portion (registry + breakpoints + tool schemas, lives in cached system prefix) and a volatile portion (current page tree + selection, lives in the user message AFTER the cache breakpoint); (2) reproducibility for debugging when an AI turn produces a bad mutation, we want to replay against the exact same input.

## Scope

**In:**
- `serializeProjectOverview(projectStore)`: stable shape (project name, page list, breakpoint list, collection placeholders for Phase 2). Goes in cached prefix.
- `serializePageTree(page)`: full subtree of a page in compact JSON. Goes in volatile user message.
- `serializeSubtree(component)`: subtree from a single component. Volatile.
- `serializeRegistry(registry)`: stable serialization of `componentRegistry.ts`. Goes in cached prefix.
- `serializeBreakpoints(project)`: ordered list of breakpoints (id, label, minWidth). Cached prefix.
- `serializeSelection(selection)`: compact list of selected component ids + their types. Volatile.
- Determinism: stable key ordering (alphabetical for objects), no Date.now / random values, snapshots stripped of MST-internal fields (`$meta`, etc.) using MST's `getSnapshot` then a normalization pass.
- Token budget guards: each serializer takes `maxTokens?` and truncates intelligently (drops style maps for deep nodes, keeps tree structure). Default: 8K tokens for page tree, configurable.
- Char-to-token estimator (4 chars / token approximation, well-known heuristic) so we can pre-flight without calling Anthropic's tokenizer.
- Serializers run on the CLIENT (in the editor) before POSTing to `/api/ai/edit`. The server is stateless re: MST.

**Out (explicitly deferred):**
- Server-side MST mirror (Phase 2 if we move toward server-authoritative)
- CMS collection schema serialization (lands with CMS data-bindings track)
- Yjs document serialization (lands with multiplayer track)
- Diff-only updates between turns (optimization, not foundation)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/ai/serializers/projectOverview.ts` | new | Stable shape |
| `src/lib/ai/serializers/pageTree.ts` | new | Volatile subtree |
| `src/lib/ai/serializers/subtree.ts` | new | Subtree by component id |
| `src/lib/ai/serializers/registry.ts` | new | From `componentRegistry.ts` |
| `src/lib/ai/serializers/breakpoints.ts` | new | From `ProjectModel` |
| `src/lib/ai/serializers/selection.ts` | new | From `EditorUIStore` |
| `src/lib/ai/serializers/normalize.ts` | new | Strip MST internals, sort keys |
| `src/lib/ai/serializers/tokenBudget.ts` | new | Char-to-token estimate + truncation helpers |
| `src/lib/ai/serializers/index.ts` | new | Barrel |

## API surface

```ts
// All serializers return plain JSON-serializable objects with sorted keys.
// `toPromptString` wraps with a stable header for the model.

export type ProjectOverview = {
  projectId: string;
  name: string;
  pages: Array<{ id: string; name: string; slug: string }>;
  breakpoints: Array<{ id: string; label: string; minWidth: number }>;
  // collections: [] reserved for Phase 2
};

export function serializeProjectOverview(project: ProjectStoreInstance): ProjectOverview;

export type SerializedComponent = {
  id: string;
  type: string;
  componentType: 'host' | 'function';
  canvasNodeType: 'component' | 'viewport' | 'floating';
  label?: string;
  props: Record<string, unknown>; // sorted keys
  parentId?: string;
  children: SerializedComponent[];
};

export function serializePageTree(
  page: PageInstance,
  opts?: { maxTokens?: number }
): SerializedComponent;

export function serializeSubtree(
  component: ComponentInstance,
  opts?: { maxTokens?: number }
): SerializedComponent;

export type SerializedRegistry = Array<{
  type: string;
  defaults: Record<string, unknown>;
  acceptsChildren: boolean;
  description: string;
}>;

export function serializeRegistry(): SerializedRegistry;

export function serializeBreakpoints(project: ProjectStoreInstance): Array<{
  id: string; label: string; minWidth: number;
}>;

export function serializeSelection(ui: EditorUIStoreInstance, project: ProjectStoreInstance): Array<{
  id: string; type: string; label?: string;
}>;

// Token-budget helpers
export function estimateTokens(s: string): number;
export function truncateTreeToBudget<T>(tree: T, maxTokens: number): T;

// Convenience: render to a model-ready string with a labeled header
export function toPromptString(label: string, payload: unknown): string;
```

## Data shapes

```ts
// What the API route receives from the client (assembled using these serializers):
type AiEditRequest = {
  prompt: string;
  sessionId: string;
  pageId: string;
  selection?: string[];
  // Stable (will be cached on the server side via prompt-cache breakpoint):
  registry: SerializedRegistry;
  breakpoints: Array<{ id: string; label: string; minWidth: number }>;
  // Volatile (sits AFTER cache breakpoint):
  pageSnapshot: SerializedComponent;
  selectionSnapshot: Array<{ id: string; type: string; label?: string }>;
};
```

## Test plan

- [ ] Unit: `normalize.test.ts` two equal MST trees produce byte-identical JSON (deterministic key ordering)
- [ ] Unit: `pageTree.test.ts` snapshots a known fixture page (8 components, mixed canvasNodeTypes), output matches committed fixture
- [ ] Unit: `registry.test.ts` output stable across runs (test twice, assert equality)
- [ ] Unit: `tokenBudget.test.ts` `estimateTokens('hello world')` returns ~3, `truncateTreeToBudget` drops deepest nodes first when over budget
- [ ] Integration: a full request payload assembled from a fixture project fits under 12K tokens for a 50-component page (representative of a real customer page)
- [ ] Manual: log the assembled prompt for one real edit session, eyeball it for sanity

## Definition of done

- [ ] All serializers return JSON-stable output (verified by repeat-call equality)
- [ ] Token budget guards prevent runaway prompt sizes
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm test` green
- [ ] No regressions in editor (serializers are read-only, additive)
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Sort order for object keys: alphabetical vs declaration order?** Alphabetical is deterministic across editor versions; declaration order tracks UI intent. Recommend: alphabetical (the model does not care, prompt caching does).
- **Should we send the full registry every turn or hash-and-cache client-side?** Sending it every turn is simpler and the cache breakpoint on the server already neutralizes the cost. Only optimize if we measure churn.
- **Style maps can be huge (responsive maps with 5 breakpoints x 30 props per node).** Truncation strategy: keep base + currently-active breakpoint, drop others if budget tight, mark with `// truncated` comment string. Risk: model may need other breakpoints to set responsive props correctly. Open question for early prototyping.
- **Multiplayer migration:** Once the multiplayer track lands Yjs as canonical, this serializer should consume the Yjs document (or its MST projection) instead of the raw MST. Since Wave 2 multiplayer pattern is "Yjs canonical, MST is derived projection", the MST-based serializer keeps working unchanged: we just ensure we serialize from the projection AFTER Yjs sync settles.

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 4d, 7b
- Code touchpoints: `src/models/ComponentModel.ts:7-22, 77-114, 375-409`, `src/models/PageModel.ts`, `src/models/ProjectModel.ts`, `src/lib/componentRegistry.ts:33-217`, `src/stores/EditorUIStore.ts`
- External: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (cache breakpoint placement)
