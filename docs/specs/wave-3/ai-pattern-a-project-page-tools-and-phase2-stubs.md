---
name: ai-pattern-a-project-page-tools-and-phase2-stubs
track: ai-pattern-a
wave: 3
priority: P2
status: draft
depends_on: [ai-pattern-a-canvas-mutation-tools]
estimated_value: 6
estimated_cost: 4
owner: unassigned
---

# Project / page tools and Phase 2 stub scaffold (MST-WRITE)

> **MST-WRITE.** Mutates `ProjectModel` (creates pages, breakpoints). Same Yjs cutover requirement as `ai-pattern-a-canvas-mutation-tools`: once multiplayer ships, project-level mutations must go through Yjs, not direct MST. See "Multiplayer migration" in Open Questions.

## Goal

Round out the Phase 1 Pattern A surface with project- and page-level mutations (`create_page`, `delete_page`, `set_active_page`, `add_breakpoint`, `update_navigation`) so the AI can scaffold multi-page sites within a Pattern A turn ("add an About page with a hero and a contact form" should be able to create the page first, then add components). Also lock down the Phase 2 stub scaffold: registered=false declarations exist, but this spec verifies (a) the dispatcher correctly refuses Phase 2 tool calls with a clear error, (b) flipping `registered: true` for a Phase 2 tool surfaces it to the model in a single-line change, (c) handler slots are typed correctly so Phase 2 specs can plug in without infrastructure changes. This is the "ready to switch on Phase 2" closing spec.

## Scope

**In:**
- Handler implementations for: `create_page`, `delete_page`, `set_active_page`, `add_breakpoint`, `update_navigation`
- Flip `registered: true` on these declarations
- Idempotency via optional `clientId` for `create_page` and `add_breakpoint`
- Validation: page slugs unique, breakpoint minWidths sorted, navigation links resolve to existing pages
- Same turn-as-transaction grouping as canvas mutations (all project mutations in a turn collapse into one undo entry)
- Phase 2 stub verification:
  - All Phase 2 declarations (`create_collection`, `add_field`, `bind_component_to_data`, `create_query`, `add_form_submission_handler`, `validate_schema`, `add_auth_gate`, `create_login_page`, `add_user_signup_form`) have valid JSON Schemas
  - All Phase 2 declarations have `registered: false` and no `handler`
  - Dispatcher rejects them with `not_registered` error
  - Type slots exist so a Phase 2 spec can plug a handler in without changing types
- Documentation update: short README in `src/lib/ai/tools/README.md` explains how to register a new tool (one declaration + one handler + flip the flag)
- Telemetry: log every `not_registered` rejection so we know which Phase 2 tools the model is reaching for in real sessions (informs Phase 2 prioritization)

**Out (explicitly deferred):**
- Phase 2 handler implementations (CMS, auth)
- AI-driven schema generation (Phase 2 by definition; needs CMS plan to land first)
- Pattern B full-app scaffolding orchestration (Phase 2)
- Multi-page coordinated edits with cross-page links (defer until customer demand surfaces)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/ai/handlers/project.ts` | new | Five handlers, client-side |
| `src/lib/ai/tools/declarations.ts` | edit | Flip `registered: true` for project-level Phase 1 tools; verify Phase 2 stubs |
| `src/lib/ai/tools/README.md` | new | Brief: how to add a new tool |
| `src/models/ProjectModel.ts` | possibly edit | Expose actions if `create_page`/`delete_page`/`add_breakpoint`/`update_navigation` aren't already MST actions |
| `src/lib/ai/handlers/__tests__/phase2Stubs.test.ts` | new | Verifies Phase 2 stubs are in the right state |
| `src/lib/ai/systemPrompts/edit.ts` | edit | Mention project-level capabilities |

## API surface

```ts
// src/lib/ai/handlers/project.ts
export function createProjectHandlers(rootStore: RootStoreInstance): {
  create_page: (input: {
    name: string;
    slug: string;
    clientId?: string;
  }) => { id: string };

  delete_page: (input: { pageId: string }) =>
    { ok: true } | { error: 'not_found' | 'last_page' };

  set_active_page: (input: { pageId: string }) =>
    { ok: true } | { error: 'not_found' };

  add_breakpoint: (input: {
    label: string;
    minWidth: number;
    clientId?: string;
  }) => { id: string } | { error: 'duplicate_minwidth' };

  update_navigation: (input: {
    links: Array<{ label: string; pageId: string }>;
  }) => { ok: true } | { error: 'unknown_page'; pageId: string };
};
```

## Data shapes

```ts
// `update_navigation` open question: does navigation live in ProjectModel as a
// dedicated field, or as a regular component subtree?
// Recommended: ProjectModel field for Phase 1 (simple, structured). When customer
// designs need fully custom nav, transition to component subtree.
type NavigationConfig = {
  links: Array<{ label: string; pageId: string }>;
};
```

## Test plan

- [ ] Unit: each handler against fixture project, asserts MST state and one batched history entry per turn
- [ ] Unit: `delete_page` on the last page returns `last_page` (refuse to leave project pageless)
- [ ] Unit: `add_breakpoint` with duplicate minWidth returns `duplicate_minwidth`
- [ ] Unit: `update_navigation` with a non-existent pageId rejects
- [ ] Unit: `phase2Stubs.test.ts` enumerates every Phase 2 declaration, asserts `registered: false`, `handler === undefined`, `phase === 2`, valid JSON Schema
- [ ] Integration: dispatcher called with `create_collection` returns `not_registered` and is logged with intent
- [ ] Manual: ask AI "create a Contact page with a hero", verify page created and visible in pages sidebar, undo collapses page+component creation into one entry

## Definition of done

- [ ] All five Phase 1 project handlers pass tests
- [ ] Phase 2 stub guards in place
- [ ] Telemetry logs `not_registered` events with tool name
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm test` green
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Multiplayer migration:** Project-level mutations (especially `create_page`, `delete_page`, `add_breakpoint`) interact with the multiplayer plan's "page tree" Yjs document. Per `docs/plans/2026-05-05-editor-multiplayer-research.md`, Yjs is canonical for editor state; project-level mutations must go through Yjs transactions in the cutover spec. The `update_navigation` field is the most likely to need explicit conflict resolution (two users reordering nav simultaneously); rely on Yjs CRDT semantics by default, revisit if customers report nav-order surprises.
- **Coordination with editor user actions in multiplayer:** if user A is editing page X and the AI (acting on user B's behalf) deletes page X, the right behavior is the multiplayer plan's "deleted-while-editing toast" pattern. Surface this to that integration spec.
- **Should `update_navigation` be project-level or page-level?** Recommend project-level for Phase 1 (one nav per project). Multi-nav (header + footer + sidebar) is Phase 2 customer-driven scope.
- **Cross-track dep on `data-bindings`:** When data-bindings ships, the AI may want to read CMS schemas to suggest pages ("add a Products page bound to the Products collection"). The read-only data-bindings track delivers `serializeProjectOverview`'s `collections` field, which feeds the AI snapshot. No code change needed here when that lands.
- **Phase 2 readiness:** The success criterion for "Phase 2 ready" is that a Phase 2 spec needs only (a) flip `registered: true`, (b) plug a handler, (c) update the system prompt's tool description list. If a Phase 2 spec needs to touch dispatcher / SDK / SSE infrastructure, this scaffold has failed.

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 3c, 3d, 3e, 8 (sequencing)
- Plan (multiplayer): `docs/plans/2026-05-05-editor-multiplayer-research.md`
- Plan (CMS, future read-side): `docs/plans/2026-05-05-cms-data-layer-research.md`
- Code touchpoints: `src/models/ProjectModel.ts`, `src/models/PageModel.ts`, `src/stores/HistoryStore.ts`
