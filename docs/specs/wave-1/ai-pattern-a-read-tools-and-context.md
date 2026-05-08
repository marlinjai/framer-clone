---
name: ai-pattern-a-read-tools-and-context
track: ai-pattern-a
wave: 1
priority: P1
status: draft
depends_on: [ai-pattern-a-anthropic-sdk-bootstrap, ai-pattern-a-tool-schema-registry, ai-pattern-a-mst-snapshot-serializer]
estimated_value: 7
estimated_cost: 4
owner: unassigned
---

# Read tools and assistant question-answer panel

## Goal

Wire handlers for the six read tools declared in `ai-pattern-a-tool-schema-registry`, ship a minimal assistant panel UI in the editor that lets the user ask questions about the current page ("what components are on this page?", "what's the selected element's color?", "how many viewports?"), and prove the end-to-end loop works: client serializes state, server streams Anthropic with read tools registered, model can issue tool calls that read the snapshot, server returns answers via SSE. No mutations yet. Establishes the full Pattern A pipeline minus writes, so the Wave 2 mutation spec only adds handlers, not infrastructure.

## Scope

**In:**
- Handlers for read tools, all client-side (the snapshot already lives on the client; the server just routes the request back via SSE for the client to resolve, OR the server is given the snapshot in the request payload and answers from that): RECOMMEND server-side, fed from the request payload assembled by serializers. Read tools dispatch synchronously against `request.pageSnapshot`, `request.registry`, `request.breakpoints`.
  - `get_project_overview()` -> from `request.projectOverview` field
  - `get_page_tree(pageId)` -> from `request.pageSnapshot` (only the active page is sent; if `pageId !== request.pageId`, return `not_loaded` error so model knows to ask user to switch)
  - `get_subtree(componentId)` -> walk page snapshot
  - `get_component(componentId)` -> walk page snapshot, return single node
  - `get_registry()` -> from `request.registry`
  - `find_components({ type?, labelContains?, textContains? })` -> walk + filter
- Assistant panel React component: floating panel triggered by `Cmd+K` or a sidebar button, with a prompt input and message thread (user, assistant text, tool-use chips). Phase-1-Wave-1 UI is intentionally minimal: text in, streaming text out, no rich tool-call rendering yet.
- Client request assembler: gathers all serialized inputs, POSTs to `/api/ai/edit`, parses SSE
- Read-only system prompt for this wave: "You are an assistant inside a visual website builder. Use the read tools to answer questions about the user's current page. Do NOT attempt to modify anything; mutation tools are not available in this turn."
- Default model: Haiku 4.5 (cheap, fast for Q&A)
- Cost log surfaced in dev console

**Out (explicitly deferred):**
- Mutation tools (Wave 2: `ai-pattern-a-canvas-mutation-tools`)
- Streaming tool-use UI with rollback (Wave 2: `ai-pattern-a-streaming-assistant-panel`)
- Multi-turn conversation memory (kept session-scoped in this spec, no DB persistence)
- CMS / auth tool answers (Phase 2)
- Authentication of the user (auth-brain dependency, deferred Phase 1 later)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/ai/handlers/read.ts` | new | Implements all six read-tool handlers |
| `src/lib/ai/systemPrompts/readonly.ts` | new | The read-only system prompt for this wave |
| `src/app/api/ai/edit/route.ts` | edit | Plug read handlers into dispatcher; flip read tools to `registered: true` is already done in registry, this wires the handler functions |
| `src/components/ai/AssistantPanel.tsx` | new | Floating panel UI |
| `src/components/ai/AssistantMessage.tsx` | new | Single message bubble |
| `src/components/ai/useAssistant.ts` | new | Client hook: assembles request, POSTs, parses SSE |
| `src/components/EditorApp.tsx` | edit | Mount `AssistantPanel`, wire `Cmd+K` shortcut |
| `src/lib/keyBindings.ts` | edit | Register `Cmd+K` |

## API surface

```ts
// src/lib/ai/handlers/read.ts
import type { SerializedComponent, SerializedRegistry } from '@/lib/ai/serializers';

export function createReadHandlers(snapshot: {
  projectOverview: ProjectOverview;
  pageId: string;
  pageSnapshot: SerializedComponent;
  registry: SerializedRegistry;
  breakpoints: Array<{ id: string; label: string; minWidth: number }>;
}): {
  get_project_overview: () => ProjectOverview;
  get_page_tree: (input: { pageId: string }) => SerializedComponent | { error: 'not_loaded' };
  get_subtree: (input: { componentId: string }) => SerializedComponent | null;
  get_component: (input: { componentId: string }) => Omit<SerializedComponent, 'children'> | null;
  get_registry: () => SerializedRegistry;
  find_components: (input: {
    type?: string;
    labelContains?: string;
    textContains?: string;
  }) => Array<{ id: string; type: string; label?: string }>;
};

// src/components/ai/useAssistant.ts
export type AssistantMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: Array<{ name: string; input: unknown; output?: unknown }> };

export function useAssistant(): {
  messages: AssistantMessage[];
  send: (prompt: string) => Promise<void>;
  isStreaming: boolean;
  error: Error | null;
};
```

## Data shapes

```ts
// SSE event types this spec consumes (extends Wave 1 SDK bootstrap):
type SseEvent =
  | { event: 'token'; data: { delta: string } }
  | { event: 'tool_use'; data: { name: string; input: unknown } }
  | { event: 'tool_result'; data: { name: string; output: unknown } }
  | { event: 'usage'; data: { inputTokens: number; outputTokens: number; cachedReadTokens: number } }
  | { event: 'error'; data: { code: string; message: string } }
  | { event: 'done'; data: { turnId: string } };
```

## Test plan

- [ ] Unit: `read.test.ts` each handler returns expected output for a fixture snapshot (10-component page covering all canvasNodeTypes)
- [ ] Unit: `find_components` returns empty array on no match, all matches on broad query, respects all three filter fields combined
- [ ] Unit: `get_page_tree` returns `not_loaded` error when pageId differs from sent snapshot
- [ ] Integration: full SSE roundtrip with a stub Anthropic that issues `get_subtree` then text answer; assert tool_use event, tool_result event, token deltas, done event in order
- [ ] Integration: prompt "how many viewports does this page have?" against fixture project returns correct count
- [ ] Manual: open editor, hit `Cmd+K`, ask "what components are selected?", confirm correct answer streams in
- [ ] Manual: ask "what's the brand color used on the hero?" on a styled fixture, model should call `get_component` on the hero and read its `props.style.color`

## Definition of done

- [ ] All six read handlers pass unit tests
- [ ] Assistant panel mounts and answers a real question end-to-end
- [ ] Prompt cache hit-rate logged on the second turn of the same session (verifies caching works)
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm test` green
- [ ] No regressions in editor canvas / drag / undo
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Should read handlers run client-side (after the model decides) or server-side (handler reads from request payload)?** Client-side is more powerful (handler can call back into MST, no payload size limit) but requires a roundtrip per tool call (server -> client -> server). Server-side is faster and simpler but limited to data sent in the initial request. Recommended: server-side for Wave 1, revisit if model frequently asks for components outside the sent snapshot.
- **What if the model invokes a tool that requires a different page than the one the user is on?** For Wave 1, return `not_loaded`; the model should respond by asking the user to switch pages. Future spec could auto-load other pages.
- **Cmd+K conflict with browser save / find?** `Cmd+K` is widely used for command palettes (Linear, Notion, Vercel). Browser default for `Cmd+K` is "focus search bar" which we can preventDefault on safely inside the editor. Confirm with Marlin.
- **Multiplayer migration:** Read tools never mutate, so they have NO Yjs cutover. They will continue to read from the MST projection (which Wave 2 multiplayer makes derived from Yjs). No code change required when multiplayer lands.
- **Cross-track dep on `data-bindings`:** Once data-bindings ships, `serializeProjectOverview` will include collections; the read tools do not need updating because they read whatever is in the snapshot.

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 3a, 7b, 7c
- Code touchpoints: `src/components/EditorApp.tsx`, `src/stores/EditorUIStore.ts`, `src/lib/keyBindings.ts`
- External: https://platform.claude.com/docs/en/build-with-claude/tool-use
