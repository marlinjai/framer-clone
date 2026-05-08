---
name: ai-pattern-a-canvas-mutation-tools
track: ai-pattern-a
wave: 2
priority: P0
status: draft
depends_on: [ai-pattern-a-tool-schema-registry, ai-pattern-a-read-tools-and-context]
estimated_value: 10
estimated_cost: 7
owner: unassigned
---

# Canvas mutation tools (MST-WRITE)

> **MST-WRITE.** This spec mutates the canvas tree. If the multiplayer track has shipped Yjs as canonical by the time this spec executes, mutations MUST go through Yjs transactions, not direct MST. See "Multiplayer migration" in Open Questions for the cutover. If multiplayer has NOT shipped, this spec writes directly to MST as a transitional Wave 2 state.

## Goal

Implement the seven canvas mutation tool handlers so the AI can edit the user's page in response to natural-language prompts ("make the hero bigger", "add a CTA button to this section", "duplicate this card three times with different copy"). This is the moment Pattern A becomes valuable: the user types, the canvas changes. Every mutation is wrapped in a single transaction per agent turn so undo collapses the whole turn into one history entry, matching the existing drag-gesture batching pattern in `HistoryStore`.

## Scope

**In:**
- Handler implementations for: `add_component`, `update_component_props`, `set_responsive_prop`, `delete_component`, `move_component`, `set_text_content`, `set_label`
- Turn-as-transaction grouping using `HistoryStore.startBatch(label)` / `commitBatch()` so the entire AI turn lands as one undo entry labeled `ai: <user prompt summary>` (max 80 chars)
- Idempotency: `add_component` accepts an optional `clientId` so retries don't double-create; if `clientId` already exists, returns the existing id (no-op)
- Validation: handlers check parent exists, type is in registry (or refuse), index is in bounds, componentId resolves
- Conflict detection: if the user manually mutates the canvas mid-turn (rare but possible), detect the divergence and abort the AI turn cleanly with a `conflict` SSE event (see Open Questions on whose mutation wins)
- Flip `registered: true` on these declarations in the registry
- Default model upgrade for any prompt that triggers mutation: Sonnet 4.6 (multi-step, needs planning), keep Haiku 4.5 only for read-only Q&A
- Server -> client tool dispatch: since the MST lives client-side, the server emits a `tool_use` SSE event, the client applies the mutation, the client POSTs `tool_result` back to a sibling endpoint `/api/ai/edit/result` that resumes the model loop. (Reverse-tunnel via SSE is one option; explicit second POST is simpler and more debuggable.)
- Per-turn rollback: client buffers all applied tool results until `done`; if the user hits "rollback" before commit, the client undoes the batch via `HistoryStore.undo()` once
- System prompt expanded with mutation instructions: how to use responsive props, how to chain tool calls, when to ask the user for clarification before mutating

**Out (explicitly deferred):**
- Project / page level tools (Wave 3: `ai-pattern-a-project-page-tools-and-phase2-stubs`)
- Streaming-tool-use UX polish, rollback button, cost cap (separate Wave 2 spec: `ai-pattern-a-streaming-assistant-panel`)
- Yjs integration (deferred until multiplayer track lands; see Multiplayer migration)
- CMS data-binding mutations (Phase 2)
- Multi-page edits (this turn touches one page at a time)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/ai/handlers/mutate.ts` | new | All seven handlers, client-side |
| `src/lib/ai/handlers/turnTransaction.ts` | new | Wraps a turn's mutations in `HistoryStore.startBatch` / `commitBatch` |
| `src/lib/ai/tools/declarations.ts` | edit | Flip `registered: true` for the seven mutation tools |
| `src/lib/ai/systemPrompts/edit.ts` | new | Mutation-capable system prompt |
| `src/components/ai/useAssistant.ts` | edit | Add tool-result POST loop, batch tracking, rollback action |
| `src/app/api/ai/edit/result/route.ts` | new | Receives `tool_result`, resumes model stream |
| `src/models/PageModel.ts` | possibly edit | Expose any actions needed for `move_component` if not already present |

## API surface

```ts
// src/lib/ai/handlers/mutate.ts (client-side, runs in editor)
export function createMutateHandlers(rootStore: RootStoreInstance): {
  add_component: (input: {
    parentId: string;
    type: string;
    props?: Record<string, unknown>;
    index?: number;
    clientId?: string;
  }) => { id: string };

  update_component_props: (input: {
    componentId: string;
    propPatch: Record<string, unknown>;
  }) => { ok: true } | { error: 'not_found' };

  set_responsive_prop: (input: {
    componentId: string;
    prop: string;
    breakpointId: string;
    value: unknown;
  }) => { ok: true } | { error: 'not_found' | 'unknown_breakpoint' };

  delete_component: (input: { componentId: string }) => { ok: true } | { error: 'not_found' };

  move_component: (input: {
    componentId: string;
    newParentId: string;
    index?: number;
  }) => { ok: true } | { error: 'not_found' | 'cycle' };

  set_text_content: (input: { componentId: string; value: string }) =>
    { ok: true } | { error: 'not_found' };

  set_label: (input: { componentId: string; label: string }) =>
    { ok: true } | { error: 'not_found' };
};

// src/lib/ai/handlers/turnTransaction.ts
export function withAiTurn<T>(
  history: HistoryStoreInstance,
  label: string,
  fn: () => T
): T;
// Implementation: history.startBatch(label); try { return fn(); } finally { history.commitBatch(); }
```

## Data shapes

```ts
// Tool-result POST shape
type ToolResultRequest = {
  turnId: string;
  toolUseId: string;
  result: { ok: true; output: unknown } | { ok: false; error: { code: string; message: string } };
};

// SSE conflict event (new)
// event: conflict
// data: { reason: 'user_edited_during_turn' | 'page_changed'; turnId: string }
```

## Test plan

- [ ] Unit: `mutate.test.ts` each handler against a fixture page; assert MST state after, assert one history entry written labeled `ai: ...`
- [ ] Unit: `add_component` with a `clientId` retried twice yields one component (idempotent)
- [ ] Unit: `move_component` rejects creating a cycle (component into its own descendant)
- [ ] Unit: `update_component_props` deep-merges (existing keys not overwritten unless in patch)
- [ ] Unit: `set_responsive_prop` writes into the responsive map, leaves other breakpoints untouched
- [ ] Integration: full turn: model emits 5 tool calls, all applied, one history entry, `ctrl+z` undoes the entire turn
- [ ] Integration: model emits 3 tool calls, user manually drags a component mid-stream, abort path runs, `conflict` SSE event delivered, no partial mutations remain
- [ ] Manual: open editor, ask "add a hero with a heading and a button below it", verify three components appear, undo collapses to one entry

## Definition of done

- [ ] All seven handlers pass unit tests
- [ ] Turn-transaction grouping verified by integration test
- [ ] Conflict abort path verified
- [ ] Rollback button works in dev preview
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm test` green
- [ ] No regressions in manual drag/drop, manual undo, manual edit
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Multiplayer migration (CRITICAL).** Once the multiplayer track ships Yjs as canonical (Wave 2 / 3 of `multiplayer` track, recommendation in `docs/plans/2026-05-05-editor-multiplayer-research.md`: self-hosted Yjs + Hocuspocus, MST as derived projection), every handler in this spec MUST be rewritten to mutate the Yjs document inside a `Y.Transaction`, not the MST directly. The MST projection auto-updates from Yjs. Additionally:
  - Use `Y.UndoManager` per-user (per the multiplayer plan) instead of `HistoryStore.startBatch`. The "ai turn = one undo entry" semantics must be preserved by configuring the UndoManager's tracking origin to the AI turn id.
  - Conflict resolution becomes Yjs's responsibility (CRDT merge), so the `conflict` SSE event's purpose narrows to "user explicitly cancelled" rather than "concurrent edit detected".
  - Cutover plan: when multiplayer is ready to merge, dispatch a single follow-up spec `ai-pattern-a-yjs-cutover` that swaps `mutate.ts` handlers and `turnTransaction.ts` to the Yjs equivalents. The tool schemas and dispatcher do NOT change.
- **Whose mutation wins in a multiplayer session: AI or human?** Open question for the multiplayer-AI integration spec. Default proposal: human edits always win, AI turn aborts on detected human edit during streaming. Alternative: CRDT-merge both (Yjs default), accept that AI may produce nonsensical state if a human moved a component mid-turn. Decision deferred to integration phase.
- **Undo grouping in multiplayer:** Per-user undo is the multiplayer plan's recommendation. AI turns issued by user A should be undoable only by user A (the AI acts on A's behalf). Encode the AI turn's UndoManager origin as user A's identity.
- **Should `add_component` allow `type` values outside the registry?** Recommend: NO. Validate against `componentRegistry.getEntry(type)`, reject unknown types with clear error. Prevents the model from inventing component types.
- **Cost cap enforcement:** Wave 1 stub is in-memory; enforcement (block further turns when daily cap hit) lands here or in the streaming-panel spec. Recommended: enforce here, surface upsell in the panel spec.

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 3b, 3f
- Plan (multiplayer dependency): `docs/plans/2026-05-05-editor-multiplayer-research.md`
- Memory: `memory/project_strategic_thesis_bubble_killer.md`
- Code touchpoints: `src/models/ComponentModel.ts:112+` (mutation actions), `src/models/PageModel.ts`, `src/stores/HistoryStore.ts:35-243` (batch API), `src/lib/componentRegistry.ts:33-217`
- External: https://platform.claude.com/docs/en/build-with-claude/tool-use
