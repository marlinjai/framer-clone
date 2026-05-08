---
name: ai-pattern-a-streaming-assistant-panel
track: ai-pattern-a
wave: 2
priority: P1
status: draft
depends_on: [ai-pattern-a-canvas-mutation-tools]
estimated_value: 7
estimated_cost: 5
owner: unassigned
---

# Streaming assistant panel with live preview and rollback

## Goal

Upgrade the Wave 1 minimal assistant panel into the production UX: streaming tool-call rendering (the user sees "adding hero", "setting fontSize on heading", as the AI works), live canvas preview of each mutation as it arrives, a single rollback button that undoes the entire turn, multi-turn conversation thread scoped to the current page session, and a per-user cost cap surface ("AI usage today: 32 of 100 turns"). This is the polish layer that makes Pattern A feel like a real product instead of a debug console.

## Scope

**In:**
- Tool-call chip rendering: each `tool_use` SSE event becomes a chip in the assistant message ("set_text_content on Hero · 'Welcome to Bakery'")
- Live canvas preview: each tool result applies to MST/Yjs immediately, the canvas re-renders, the user watches the agent work
- Rollback button: visible during a turn, undoes the current AI batch via `HistoryStore.undo()` (or Y.UndoManager.undo() once multiplayer ships) once. After 5s post-`done`, the button collapses (turn is committed; further changes are normal undo entries).
- Loading / heartbeat states: typing indicator while waiting for first token, "AI is thinking" if heartbeat arrives without tokens, "AI is busy, retrying" on 529
- Error envelopes: rate-limit, invalid input, schema-violation, conflict surfaced as friendly inline messages
- Cost cap surface: shows turns-today counter pulled from `aiUsageStub` (or the real usage backend if it lands first); upsell modal when at cap
- Conversation memory: messages array kept in `EditorUIStore` keyed by `(projectId, pageId, sessionId)`, cleared on page change, persisted only in-memory (no DB this wave)
- Keyboard UX: `Cmd+K` opens panel, `Cmd+Enter` submits, `Esc` rolls back current turn if mid-stream
- Panel design: floating, draggable, snaps to right edge by default; collapsed state shows just the input; expanded state shows full thread

**Out (explicitly deferred):**
- Persistent conversation history across sessions (Phase 2; needs a `ai_turns` table)
- Voice input (out of scope)
- Suggestion chips ("Try: add a contact form") (Phase 2 nice-to-have)
- Per-tool detailed result views (a user-facing way to inspect what each tool did)
- Cost dashboard (separate Lumitra Studio integration)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/components/ai/AssistantPanel.tsx` | edit | Major upgrade: thread, chips, rollback, cost surface |
| `src/components/ai/AssistantMessage.tsx` | edit | Render tool-call chips |
| `src/components/ai/ToolCallChip.tsx` | new | Single tool-call render |
| `src/components/ai/RollbackButton.tsx` | new | Floating button during stream |
| `src/components/ai/CostCapBanner.tsx` | new | Inline banner near input when near/at cap |
| `src/components/ai/useAssistant.ts` | edit | Wire rollback, cost surface, error envelopes |
| `src/stores/EditorUIStore.ts` | edit | Persist conversation thread by page key |
| `src/lib/keyBindings.ts` | edit | `Cmd+K`, `Cmd+Enter`, `Esc` bindings inside panel |

## API surface

```ts
// EditorUIStore additions
type AssistantThread = {
  pageId: string;
  sessionId: string;
  messages: AssistantMessage[];
  costToday: { turns: number; cap: number };
};
// Actions: appendMessage, clearThread, setCostToday

// useAssistant hook expanded
export function useAssistant(): {
  messages: AssistantMessage[];
  send: (prompt: string) => Promise<void>;
  rollback: () => void;             // undoes current/most-recent AI turn
  cancel: () => void;                // aborts mid-stream, applies rollback
  isStreaming: boolean;
  currentToolCalls: Array<{ name: string; input: unknown; status: 'pending' | 'done' | 'error' }>;
  costToday: { turns: number; cap: number };
  error: AssistantError | null;
};

type AssistantError =
  | { code: 'rate_limited'; retryAt?: number }
  | { code: 'overloaded' }
  | { code: 'cost_cap_reached' }
  | { code: 'conflict'; reason: string }
  | { code: 'tool_validation_failed'; tool: string; details: string }
  | { code: 'unknown'; message: string };
```

## Data shapes

```ts
// Tool-call chip status lifecycle:
//   tool_use SSE event       -> status: 'pending'
//   client applies handler   -> status: 'done' (or 'error')
//   tool_result POST sent    -> chip stays 'done'
```

## Test plan

- [ ] Unit: `useAssistant.test.ts` rollback during stream cancels stream and undoes batch
- [ ] Unit: `AssistantPanel.test.tsx` renders tool-call chips in order received
- [ ] Unit: cost-cap reached returns `cost_cap_reached` error and disables input
- [ ] Integration: full turn with 4 tool calls, panel renders 4 chips, canvas updates after each, rollback undoes all 4 in one step
- [ ] Integration: heartbeat without tokens triggers "AI is thinking" after 5s
- [ ] Manual: ask "add a 3-card pricing section", watch chips stream, hit `Esc` mid-stream, confirm canvas reverts
- [ ] Manual: simulate rate limit (mock 429), confirm friendly error message shows

## Definition of done

- [ ] All chips render correctly in real session
- [ ] Rollback works mid-stream and post-`done` within 5s window
- [ ] Cost cap banner appears at 80% of cap, blocks input at 100%
- [ ] No regressions in manual drag/drop, undo, multi-page navigation
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm test` green
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Multiplayer migration:** When multiplayer ships, rollback must use `Y.UndoManager.undo()` scoped to the current user's tracking origin (not `HistoryStore.undo()`). The panel UI is unchanged; only the rollback hook implementation swaps. Add a follow-up bullet to the `ai-pattern-a-yjs-cutover` migration spec.
- **What happens to a multi-turn conversation when another user edits the same page in multiplayer?** Recommended: thread continues; the snapshot the AI sees in the next turn already reflects the merged state. The conflict event from the mutation spec only fires when the model is actively writing during a peer edit.
- **Should rollback be available for the LAST AI turn (committed) too, or only mid-stream?** Recommended: yes, for 5s post-`done`. After 5s, treat as a normal undo entry that the user can `ctrl+z` like any other.
- **Cost cap UX when hit:** Hard block vs soft warning? Recommend hard block at 100% to protect Marlin from runaway bills, with a `Contact us for higher limits` CTA. Configurable per-account once auth-brain integrates billing.
- **Cross-track dep on `multiplayer`:** This spec is technically Yjs-naive; if multiplayer ships first, `useAssistant.rollback` swaps to `Y.UndoManager.undo()` in the cutover spec. If this spec ships first, rollback uses `HistoryStore`.

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 7c, 7e
- Plan (multiplayer): `docs/plans/2026-05-05-editor-multiplayer-research.md`
- Code touchpoints: `src/stores/EditorUIStore.ts`, `src/stores/HistoryStore.ts`, `src/components/EditorApp.tsx`
- External: https://platform.claude.com/docs/en/build-with-claude/streaming
