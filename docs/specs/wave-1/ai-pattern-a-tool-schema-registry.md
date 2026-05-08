---
name: ai-pattern-a-tool-schema-registry
track: ai-pattern-a
wave: 1
priority: P0
status: draft
depends_on: [ai-pattern-a-anthropic-sdk-bootstrap]
estimated_value: 9
estimated_cost: 4
owner: unassigned
---

# AI tool schema registry and dispatcher contract

## Goal

Define the entire long-term AI tool surface as JSON-Schema-validated declarations in one place, even though only read tools will be registered with the model in Wave 1. Mutation tools, CMS tools, and auth tools land here as DECLARED-BUT-UNREGISTERED stubs so that (a) the surface is reviewed once, holistically, and (b) Wave 2 / Phase 2 specs only have to flip a registration flag and supply a handler. Centralizing the contract here is the highest-leverage decomposition decision: every later spec just plugs handlers in.

## Scope

**In:**
- Tool declaration module: each tool defined with `name`, `description` (LLM-facing), `input_schema` (JSON Schema), `phase: 1 | 2`, `category: 'read' | 'mutate' | 'project' | 'data' | 'auth'`, `registered: boolean`, `handler?` slot
- Tool list (declarations only, handlers wired in later specs):
  - **Read (Phase 1, registered Wave 1):** `get_project_overview`, `get_page_tree`, `get_subtree`, `get_component`, `get_registry`, `find_components`
  - **Mutate canvas (Phase 1, registered Wave 2):** `add_component`, `update_component_props`, `set_responsive_prop`, `delete_component`, `move_component`, `set_text_content`, `set_label`
  - **Project / page (Phase 1, registered Wave 3):** `create_page`, `delete_page`, `set_active_page`, `add_breakpoint`, `update_navigation`
  - **Data layer (Phase 2 stub, NOT registered):** `create_collection`, `add_field`, `bind_component_to_data`, `create_query`, `add_form_submission_handler`, `validate_schema`
  - **Auth (Phase 2 stub, NOT registered):** `add_auth_gate`, `create_login_page`, `add_user_signup_form`
- Dispatcher contract: a `ToolDispatcher` type that the API route calls when the model emits a `tool_use` block. Validates input against the JSON Schema, looks up the registered handler, invokes it, returns the result.
- Idempotency contract documented per mutation tool (same id + same patch = no-op)
- Transactional grouping contract: dispatcher wraps a turn's tool calls so they commit as one undo-stack entry (handler implementation lands in Wave 2)
- Anthropic structured-outputs flag: `disable_parallel_tool_use: false` configurable; structured outputs ON for tool inputs.
- Generated TypeScript types from JSON Schema for compile-time safety on handler signatures

**Out (explicitly deferred):**
- Handler implementations for read tools (separate spec: `ai-pattern-a-read-tools-and-context`)
- Handler implementations for mutation tools (separate spec, Wave 2: `ai-pattern-a-canvas-mutation-tools`)
- Handler implementations for project/page tools (separate spec, Wave 3: `ai-pattern-a-project-page-tools-and-phase2-stubs`)
- All Phase 2 handler implementations (CMS, auth)
- Yjs-routing logic (lives in mutation-tools spec)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/ai/tools/index.ts` | new | Barrel export for the registry |
| `src/lib/ai/tools/declarations.ts` | new | All tool declarations, declarative array |
| `src/lib/ai/tools/schemas/read.ts` | new | JSON Schemas for read tools |
| `src/lib/ai/tools/schemas/mutate.ts` | new | JSON Schemas for canvas mutations |
| `src/lib/ai/tools/schemas/project.ts` | new | JSON Schemas for project/page tools |
| `src/lib/ai/tools/schemas/data.ts` | new | JSON Schemas for Phase 2 data tools (stubs) |
| `src/lib/ai/tools/schemas/auth.ts` | new | JSON Schemas for Phase 2 auth tools (stubs) |
| `src/lib/ai/tools/dispatcher.ts` | new | Validates + dispatches tool_use to handlers |
| `src/lib/ai/tools/types.ts` | new | `ToolDeclaration`, `ToolHandler`, `ToolDispatcher` types |
| `src/app/api/ai/edit/route.ts` | edit | Wire dispatcher into the SSE loop (read-tool path only this wave) |

## API surface

```ts
// src/lib/ai/tools/types.ts
export type ToolPhase = 1 | 2;
export type ToolCategory = 'read' | 'mutate' | 'project' | 'data' | 'auth';

export type ToolDeclaration<TInput = unknown, TOutput = unknown> = {
  name: string;                    // snake_case, LLM-facing
  description: string;             // LLM-facing, sentence form
  input_schema: object;            // JSON Schema draft 2020-12
  phase: ToolPhase;
  category: ToolCategory;
  registered: boolean;             // if false, omitted from messages.create tools[]
  mutates: boolean;                // true => goes through Yjs once multiplayer ships
  handler?: ToolHandler<TInput, TOutput>;
};

export type ToolHandlerContext = {
  projectId: string;
  pageId: string;
  selection?: string[];
  turnId: string;
  // Wave 2: yjsDoc?: Y.Doc; multiplayer cutover
};

export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  ctx: ToolHandlerContext
) => Promise<TOutput>;

// src/lib/ai/tools/dispatcher.ts
export type DispatcherResult =
  | { ok: true; output: unknown }
  | { ok: false; error: { code: 'unknown_tool' | 'invalid_input' | 'not_registered' | 'handler_failed'; message: string; details?: unknown } };

export function createDispatcher(decls: ToolDeclaration[]): {
  registeredFor(phase: ToolPhase): ToolDeclaration[];
  toAnthropicTools(): Anthropic.Tool[];
  dispatch(name: string, input: unknown, ctx: ToolHandlerContext): Promise<DispatcherResult>;
};

// src/lib/ai/tools/declarations.ts
export const TOOL_DECLARATIONS: ToolDeclaration[];
```

## Data shapes

```ts
// Example declaration shape (read-tool, registered in Wave 1)
{
  name: 'get_subtree',
  description: 'Returns the MST subtree rooted at the given component id, including all descendants and their resolved props.',
  input_schema: {
    type: 'object',
    properties: { componentId: { type: 'string', minLength: 1 } },
    required: ['componentId'],
    additionalProperties: false,
  },
  phase: 1,
  category: 'read',
  registered: true,
  mutates: false,
};

// Example declaration shape (mutation-tool, declared but unregistered in Wave 1)
{
  name: 'add_component',
  description: 'Creates a new HOST or FUNCTION component as a child of parentId at optional index. Returns the new component id.',
  input_schema: {
    type: 'object',
    properties: {
      parentId: { type: 'string', minLength: 1 },
      type: { type: 'string', minLength: 1 },
      props: { type: 'object', additionalProperties: true },
      index: { type: 'integer', minimum: 0 },
    },
    required: ['parentId', 'type'],
    additionalProperties: false,
  },
  phase: 1,
  category: 'mutate',
  registered: false, // flipped to true in Wave 2 spec
  mutates: true,
};

// Example Phase 2 stub (declared, never registered in Phase 1)
{
  name: 'create_collection',
  description: 'Creates a new CMS collection with the given fields. Phase 2 only.',
  input_schema: { /* ... */ },
  phase: 2,
  category: 'data',
  registered: false,
  mutates: true,
};
```

## Test plan

- [ ] Unit: `dispatcher.test.ts` rejects unknown tool name with `unknown_tool`
- [ ] Unit: `dispatcher.test.ts` rejects invalid input against JSON Schema with `invalid_input` and field path
- [ ] Unit: `dispatcher.test.ts` rejects unregistered tool with `not_registered` (defends against the model hallucinating Phase 2 tools)
- [ ] Unit: `dispatcher.test.ts` `toAnthropicTools()` returns ONLY `registered: true` declarations
- [ ] Unit: every declaration has a unique snake_case name, valid JSON Schema (Ajv `validateSchema` passes), required `phase` and `category`
- [ ] Snapshot: `TOOL_DECLARATIONS` shape matches a committed fixture so accidental schema drift surfaces in PR review
- [ ] Manual: open `/api/ai/edit` with a prompt that names a Phase 2 tool, confirm 422 with `not_registered`

## Definition of done

- [ ] All declarations land with valid JSON Schemas
- [ ] Dispatcher passes unit tests
- [ ] `pnpm tsc --noEmit` clean
- [ ] No handler implementations land in this spec (just declarations + dispatcher contract)
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Tool naming: snake_case (Anthropic convention) vs camelCase (codebase convention)?** Recommend snake_case for the LLM-facing name, camelCase for the TypeScript handler. Anthropic's docs uniformly use snake_case for tool names.
- **JSON Schema validator: Ajv vs Zod-to-JSON-Schema?** Zod gives nicer ergonomics for handler authoring but Anthropic accepts JSON Schema directly. Recommend: define schemas as Zod, use `zod-to-json-schema` for the LLM-facing form, validate inputs with Zod's `.parse()` for handlers.
- **Should `find_components` use a structured filter or a free-text query?** Plan suggests both. Recommend structured (`{ type?, labelContains?, textContains? }`) to keep the schema tight; free-text is harder to validate.
- **Multiplayer migration:** Once Wave 2 multiplayer spec lands (track `multiplayer`, Yjs canonical), the dispatcher must accept a `yjsDoc` in `ToolHandlerContext` and route every `mutates: true` handler through Yjs transactions, not direct MST. The `mutates` flag on every declaration exists specifically to power that migration: a single grep for `mutates: true` enumerates the cutover surface.

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 3a-3f, 7c
- Memory: `memory/project_strategic_thesis_bubble_killer.md` (Phase 2 stubs reserved)
- Code touchpoints: `src/lib/componentRegistry.ts` (component types referenced in mutation tool schemas)
- External: https://platform.claude.com/docs/en/build-with-claude/tool-use, https://platform.claude.com/docs/en/build-with-claude/structured-outputs
