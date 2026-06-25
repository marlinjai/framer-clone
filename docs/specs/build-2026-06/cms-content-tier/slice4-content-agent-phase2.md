---
name: slice4-content-agent-phase2
track: cms-content-tier
wave: 4
priority: P0
status: done
type: plan
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice3-cms-workspace-phase1]
touchesSharedState: true
sharedState:
  [
    src/lib/ai/anthropicClient.ts,
    src/lib/bindings/dataSource/types.ts,
    prisma/schema.prisma,
  ]
estimateDays: 4
verify: pnpm exec tsc --noEmit && pnpm lint && pnpm test
owner: CMS Workspace Engineer
date: 2026-06-22
---

# CMS content agent phase 2: right-rail NL content agent

> Add the right **Content agent** column to `CmsWorkspaceOverlay`. The agent
> accepts natural-language instructions ("Import events.csv", "Generate 5 blog
> posts", "Translate all titles to German"), executes them as tool calls against
> the existing admin-guarded `src/server/cms/actions.ts` surface, streams its
> reasoning and change summary back to the UI, and records every mutation with
> an inverse so the user can **Undo all** with one click.
>
> This is the `RIGHT` column in `docs/specs/build-2026-06/cms-workspace-agent-mockup.html`.
> The LEFT + CENTER (rail + grid) already shipped in phase 1. Adding the agent
> column is the CSS-grid extension that was explicitly reserved in phase 1.

---

## 1. Scope

### In

- **Content agent panel** (right column, 348px fixed, `bg-muted/30` backdrop)
  rendered inside `CmsWorkspaceOverlay` alongside the existing rail and grid.
- **API route** `src/app/api/ai/cms-agent/route.ts`: Anthropic tool-use loop,
  SSE streaming, prompt caching. New route; does NOT touch `/api/ai/edit`.
- **Model bump**: `OPUS` key in the `AI_MODELS` registry in
  `src/lib/ai/anthropicClient.ts` bumped from `claude-opus-4-7` to
  `claude-opus-4-8` (one-line change; affects all callers but no behavior
  change since Opus 4.8 is a drop-in upgrade).
- **Agent tool set** (see section 3): 12 tools backed by existing server
  actions. One tool (`csv_import`) does server-side CSV parsing then delegates
  to `bulkCreateRows`. One tool (`translate_field`) calls the Anthropic client
  recursively (secondary completions, NOT nested SSE) to generate translated
  text and writes the result via `updateRow`.
- **Run + Undo persistence**: two new Prisma models (`AgentRun`, `AgentChange`)
  in the `public` schema record every run and its per-entity inverses.
- **Suggestion chips**: four pre-wired prompts rendered below the chat history.
- **Model picker**: UI-only dropdown (Haiku / Sonnet / Opus); the selected
  model drives the API call.
- **File attach (CSV only)**: the paperclip in the input bar opens a native
  file picker scoped to `.csv`; the selected file is base64-encoded and sent
  in the request body as `csvPayload: { name, content }`. The `csv_import`
  tool receives it already parsed server-side.

### Deferred (each its own later slice, do NOT half-build)

- **Image upload**: the `upload_file` tool returns a loud, structured error
  ("Image upload requires Storage Brain integration -- not yet configured")
  and records nothing. The paperclip accept list excludes images; if a user
  somehow sends one via drag-drop into the textarea, the route rejects it with
  a 400 and a human-readable message. This is the honest-disabled pattern, not
  silent failure.
- **Chat history persistence**: runs are persisted (AgentRun model), but the
  chat transcript (user messages + assistant turns) is ephemeral per-session.
  Reloading the workspace clears the chat. Run metadata (status, prompt
  excerpt, change count) is retrievable from `AgentRun` for a future history
  panel (the History button in the mockup opens this; wire the button but leave
  the panel empty with a "Coming soon" notice).
- **Collection groups and sub-collections**: out of scope for the agent; the
  phase 1 flat list is the target.
- **Streaming partial tool results** to the grid: the grid re-fetches after
  `agent:done`; no live incremental push. A later websocket layer can do this.
- **Multi-collection agent runs**: the agent always operates on the currently
  active collection. Cross-collection writes are possible via the `list_collections`
  tool to discover IDs, then targeting other tables by ID in row/column tools.
  No UI affordance for "switch active collection" from within the agent.

---

## 2. Resolved decisions (from Lead approval)

**translate_field: Option A confirmed.** Single batched Haiku call per
`translate_field` invocation. The executor sends all row values for the target
column in one `messages.create` call (Haiku, non-streaming), receives a JSON
array of `{ rowId, translatedValue }` objects, then maps each to a read-before-write
`update_row` call (fetch current cells first, store in `AgentChange.inversePayload`,
then apply the update). All mutations still flow through the outer loop's undo
recording; the inner call is invisible to the SSE stream.

**Admin auth in async context: fixed** (see section 4A).

**SSE client: fetch-based** (see section 7, ContentAgentPanel note).

**Row removal: archive-based** (see section 3 tool table; `archiveRow` /
`unarchiveRow` are the agent's "delete" primitives). Verified: `getRows` in
the PrismaAdapter filters `_archived = 0` by default (line 481 of adapter.ts),
so archived rows vanish from the grid and from storefront reads immediately.
Archive is fully reversible. Hard `deleteRow` / `bulkDeleteRows` are removed
from the agent tool set entirely in phase 2a.

**msw not installed.** Route tests mock `getAnthropicClient()` via `vi.mock`
(same pattern used elsewhere in the repo). No msw.

---

## 3. Tool schema list

All tools are callable from the route's Anthropic tool-use loop. Admin auth is
verified ONCE at the route boundary (section 4A); the executor calls the data
layer directly via `getCmsAdapter()` without re-reading cookies. Read tools are
unguarded. Every mutation tool records the inverse in `AgentChange` (section 5).

**Important: `delete_row` and `bulk_delete_rows` are NOT included in the phase
2a agent tool set.** The agent uses `archive_row` / `bulk_archive_rows` for
removal, which are fully reversible (archive hides rows from the grid;
unarchive restores them). Hard delete comes in a later slice with an explicit
destructive-tool UX.

| Tool | Data layer call(s) | Undo inverse |
| --- | --- | --- |
| `list_collections` | `adapter.listTables(workspaceId)` | read; no inverse |
| `list_columns` | `adapter.getColumns(tableId)` | read; no inverse |
| `list_rows` | `adapter.getRows(tableId, query)` | read; no inverse |
| `create_row` | `adapter.createRow(input)` | `adapter.deleteRow(createdId)` |
| `bulk_create_rows` | `adapter.bulkCreateRows(inputs)` | one `AgentChange` per bulk op; `inversePayload = { rowIds: [all created ids] }` for `bulk_delete_rows` |
| `update_row` | read current cells first, then `adapter.updateRow(rowId, cells)` | `adapter.updateRow(rowId, previousCells)` — previousCells captured before mutation |
| `archive_row` | capture cell snapshot, then `adapter.archiveRow(rowId)` | `adapter.unarchiveRow(rowId)` |
| `bulk_archive_rows` | capture snapshots for all, then `adapter.bulkArchiveRows(rowIds)` | one `AgentChange`; `inversePayload = { rowIds }` for `bulkUnarchiveRows` |
| `bulk_update_status` | read current status per row first, then `adapter.updateRow` per row | `adapter.updateRow` per row with previous status — previousStatus captured before mutation |
| `create_column` | `adapter.createColumn(input)` | `adapter.deleteColumn(createdId)` |
| `create_select_option` | `adapter.createSelectOption(input)` | `adapter.deleteSelectOption(createdId)` |
| `csv_import` | parse CSV server-side (papaparse or split/trim), then `adapter.bulkCreateRows` | one `AgentChange`; `inversePayload = { rowIds: [all created ids] }` for `bulkDeleteRows` |
| `generate_content` | batched inner Haiku call + `adapter.bulkCreateRows` | one `AgentChange`; `inversePayload = { rowIds: [all created ids] }` for `bulkDeleteRows` |
| `translate_field` | read current values, batched inner Haiku call (JSON array), then `adapter.updateRow` per row | one `AgentChange` per row; `inversePayload = { rowId, previousCells }` — previousCells captured before mutation |
| `upload_file` | (none) | returns structured error; records nothing; no undo entry |

### Input schemas (Zod, validated server-side in `tools.ts`)

```typescript
// list_collections
{ workspaceId: z.string() }

// list_columns
{ tableId: z.string() }

// list_rows
{ tableId: z.string(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional(), filter: z.string().optional() }

// create_row
{ tableId: z.string(), cells: z.record(z.string(), z.unknown()) }

// bulk_create_rows
{ tableId: z.string(), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }

// update_row (executor reads current cells first, stores in AgentChange before calling adapter)
{ rowId: z.string(), cells: z.record(z.string(), z.unknown()) }

// archive_row (reversible via unarchive; replaces delete_row in phase 2a)
{ rowId: z.string() }

// bulk_archive_rows (reversible; replaces bulk_delete_rows in phase 2a)
{ rowIds: z.array(z.string()).min(1).max(500) }

// bulk_update_status (executor reads current status per row before mutating)
{ rowIds: z.array(z.string()).min(1).max(500), status: z.string() }

// create_column
{ tableId: z.string(), name: z.string(), type: z.string(), config: z.record(z.unknown()).optional() }

// create_select_option
{ columnId: z.string(), name: z.string(), color: z.string().optional() }

// csv_import (csvPayload is base64-encoded content; rejected if > 3MB or > 1000 rows after parsing)
{ tableId: z.string(), csvPayload: z.object({ name: z.string(), content: z.string().max(4_000_000) }), columnMapping: z.record(z.string()).optional() }

// generate_content
{ tableId: z.string(), prompt: z.string(), count: z.number().int().min(1).max(50), targetColumns: z.array(z.string()) }

// translate_field (executor reads current values, batches into single inner Haiku call)
{ tableId: z.string(), rowIds: z.array(z.string()).min(1).max(200), columnId: z.string(), targetLanguage: z.string() }

// upload_file (always returns loud structured error in phase 2a)
{ tableId: z.string(), rowId: z.string(), columnId: z.string(), fileName: z.string() }
```

---

## 4. Route and streaming contract

### 4A. Admin auth in the streaming async context (CRITICAL)

`requireAdminAction()` reads cookies via Next.js `next/headers`, which is only
reliably available during the synchronous request phase. After the route returns
the `Response`, the async tool-use loop runs in a detached continuation where
`next/headers` is NOT guaranteed to be in scope.

**Fix:** Verify admin auth ONCE at the route boundary, inside the synchronous
handler, before kicking off the loop. Store the result as a plain boolean. The
executor then calls the data layer directly via `getCmsAdapter()` (server-side,
no cookies involved) rather than re-routing through `actions.ts` (which calls
`requireAdminAction()` internally). The route itself is the trust boundary.

```typescript
// route.ts — synchronous portion (before returning Response)
const adminOk = await verifyAdminCookie(request); // reads cookies here, in sync scope
if (!adminOk) return new Response('Unauthorized', { status: 401 });

// Pass adapter (already authorized) into the loop; no cookie reads after this point
const adapter = getCmsAdapter();
void runAgentLoop({ adapter, body, sse, runId }); // detached continuation
return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
```

`verifyAdminCookie` is a new helper in `src/server/auth/adminAction.ts` that
reads `request.cookies.get('admin_secret')?.value` (from the `Request` object
directly, NOT from `next/headers`) and compares it against
`process.env.FRAMER_CLONE_ADMIN_SECRET`. It does NOT use `requireAdminAction()`
(which uses `cookies()` from `next/headers`).

### Route: `src/app/api/ai/cms-agent/route.ts`

```
POST /api/ai/cms-agent
Authorization: Cookie admin_secret=<value>
Content-Type: application/json

Body:
{
  "collectionId": "<tableId>",      // the active collection
  "workspaceId": "<workspaceId>",   // for list_collections
  "prompt": "<user message>",       // the NL instruction
  "model": "HAIKU" | "SONNET" | "OPUS",  // from model picker; default OPUS
  "runId"?: "<uuid>",               // omit for a new run; pass to resume/retry
  "csvPayload"?: { "name": "events.csv", "content": "<base64>", max ~3MB }
}

Response: text/event-stream (SSE)
```

The route:
1. Parses body and validates with Zod. Returns `400` on validation failure.
   Validates CSV size cap: if `csvPayload.content.length > 4_000_000` bytes
   (base64), return `400` with message "CSV too large (max ~3 MB)".
2. Calls `verifyAdminCookie(request)` (reads from `Request`, NOT `next/headers`).
   Returns `401` if absent or invalid.
3. Creates an `AgentRun` record (status: `running`).
4. Creates an SSE stream via `createSseStream()`.
5. Kicks off `runAgentLoop({ adapter, body, sse, runId })` as a detached void
   async call, passing the pre-authorized adapter. Returns
   `new Response(sse.stream, { status: 200, headers: SSE_HEADERS })` immediately.
6. Heartbeats every `SSE_HEARTBEAT_MS` (5000ms) to prevent proxy timeouts.

### Tool-use loop (`runAgentLoop`)

Mirrors `src/app/api/ai/edit/route.ts`:
1. Build system prompt via `buildSystemPrompt(blocks)` (prompt-cached on the
   static instructions block).
2. Call `anthropicClient.messages.create({ model, system, tools, messages, stream: true })`.
3. On `content_block_delta` / `input_json_delta`: accumulate tool input, send
   `agent:thinking` SSE events for text deltas.
4. On `tool_use` content block: execute the tool via the executor (which calls
   `adapter.*` methods directly), record the inverse in `AgentChange`, send
   `agent:tool_call` + `agent:tool_result`.
5. Append the assistant turn + tool result to `messages[]` and loop until
   `stop_reason === 'end_turn'`.
6. On loop end: send `agent:done` with a changes summary, update `AgentRun`
   status to `done`, send `usage` event, close SSE.
7. On any error: send `agent:error` with a human-readable message (never
   swallow), update `AgentRun` status to `failed`, close SSE.

### SSE event types

| Event | Data shape | When |
| --- | --- | --- |
| `agent:thinking` | `{ text: string }` | LLM text delta (reasoning narration before tool calls) |
| `agent:tool_call` | `{ tool: string, input: Record<string, unknown> }` | When a tool call starts |
| `agent:tool_result` | `{ tool: string, success: boolean, summary: string }` | After tool executes; summary is human-readable ("Created 12 items in Events") |
| `agent:done` | `{ runId: string, changes: AgentChangeSummary[] }` | Loop complete |
| `agent:error` | `{ code: string, message: string }` | Any unrecoverable error |
| `usage` | `{ inputTokens: number, outputTokens: number, cacheReadTokens: number }` | After loop end |
| `heartbeat` | `{}` | Every 5s to keep connection alive |

```typescript
// AgentChangeSummary (sent in agent:done and shown in the Changes card)
interface AgentChangeSummary {
  tool: string;            // e.g. "bulk_create_rows"
  entityType: string;      // e.g. "Events"
  icon: string;            // lucide icon name for the Changes card row
  count: number;
  label: string;           // e.g. "+12 items"
}
```

---

## 5. Run + Undo persistence design

### New Prisma models (propose for Lead approval)

Both models go in the `public` schema (same pattern as all `dt_*` models).

```prisma
// prisma/schema.prisma additions

enum AgentRunStatus {
  pending
  running
  done
  failed

  @@schema("public")
}

model AgentRun {
  id           String          @id @default(uuid())
  collectionId String          @map("collection_id")
  workspaceId  String          @map("workspace_id")
  prompt       String          // full user message text
  model        String          // e.g. "claude-opus-4-8"
  status       AgentRunStatus  @default(pending)
  errorMessage String?         @map("error_message")
  createdAt    DateTime        @default(now()) @map("created_at")
  updatedAt    DateTime        @updatedAt @map("updated_at")
  changes      AgentChange[]

  @@map("agent_runs")
  @@schema("public")
}

model AgentChange {
  id             String   @id @default(uuid())
  runId          String   @map("run_id")
  position       Int      // ordering for correct undo sequence; undo applies DESC
  tool           String   // e.g. "bulk_create_rows"
  entityType     String   // "row" | "column" | "option"
  entityId       String?  @map("entity_id")  // nullable for bulk ops (first/representative id, or null)
  inverseTool    String   @map("inverse_tool")   // e.g. "bulkDeleteRows"
  inversePayload Json     @map("inverse_payload") // full args for the inverse call
                                                  // bulk ops: { rowIds: ["a","b",...] }
                                                  // update_row: { rowId, previousCells }
                                                  // archive_row: { rowId } (unarchive needs no snapshot)
  run            AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@map("agent_changes")
  @@schema("public")
}
```

### Undo API route

```
POST /api/ai/cms-agent/undo
Authorization: Cookie admin_secret=<value>  // same verifyAdminCookie check
Body: { "runId": "<uuid>" }
Response: { "undone": number, "skipped": number, "warnings": string[] }
```

Fetches all `AgentChange` records for the run, sorted by `position DESC`
(reverse order of application), and replays each `inverseTool` + `inversePayload`
against the adapter directly (same pattern as the route: `verifyAdminCookie`
at boundary, then `getCmsAdapter()` for dispatch). Since phase 2a has no hard
delete tools, all changes are reversible; the `warnings` array is reserved for
future partial-failure cases. Returns `{ undone: N, skipped: 0, warnings: [] }`
on success. Marks the `AgentRun` status unchanged (a "undone" status is a
future product decision).

### Undo limitations

The undo route is NOT a transaction: each inverse is applied independently.
If a mid-undo inverse fails (e.g. a `deleteColumn` on a column that was
subsequently modified by a manual edit after the run), the undo stops and
returns a partial result with an error message in `warnings`. This is surfaced
to the user in the Changes card ("Undo partial -- 8 of 12 changes reversed.
4 could not be reversed"). The user sees the grid update live (it re-fetches
after undo completes), so they can assess the partial state. Full transactional
undo is deferred. In practice, phase 2a's tool set (create + archive + update)
rarely fails to undo, so partial undo is an edge case, not the common path.

---

## 6. Prompt cache design

The system prompt has two blocks:

1. **Static instructions block** (cache: true) — locked at build time:
   - Role definition: "You are a CMS content agent..."
   - Tool usage rules: always call `list_columns` before writing rows; never
     invent column IDs; when a tool returns an error, surface it to the user
     before proceeding; translate_field uses Option A recursive calls.
   - Undo contract: every mutation must be issued via a tool (no direct DB
     writes), so the undo layer can record the inverse.
   - Image upload rule: if asked to upload images, call `upload_file` and
     report the error to the user; do NOT attempt to work around it.

2. **Dynamic context block** (no cache) — injected per-request:
   - `collectionId`, `workspaceId`
   - Active collection name, column list with types
   - Current row count

The `buildSystemPrompt` call places the `cache_control` breakpoint after block
1 (last `cache: true` block), exactly as the existing `/api/ai/edit` route
does. This saves ~80% of system-prompt tokens on long agentic runs with many
tool-use loop iterations.

---

## 7. UI component breakdown

### Layout change to `CmsWorkspaceOverlay`

The body goes from:

```
[rail 248px | grid 1fr]
```

to:

```
[rail 248px | grid 1fr | agent 348px]
```

When the agent panel is visible (`agentOpen` state, default: true when the
workspace mounts). The agent panel has a toggle (a small chevron button at the
right edge of the center sub-header) so users can collapse it to focus on the
grid. Collapsed state is local-only (not persisted).

### New components

**`src/components/cms/agent/ContentAgentPanel.tsx`**
- Container for the right column. Props: `collectionId`, `workspaceId`,
  `collectionName`, `onCollapsed`.
- Owns `messages` state (ChatMessage[]), `isRunning` state, `lastRunId` state.
- Renders: `AgentHeader`, `AgentChat` (scrollable), `AgentSuggestions`, `AgentInput`.
- Calls `/api/ai/cms-agent` via `fetch()` with a streamed `ReadableStream`
  response reader. Native `EventSource` is GET-only with no body and cannot be
  used here. The client parses SSE frames (`event:` / `data:` lines) from the
  `response.body` reader manually (a small `parseSseFrames` utility in
  `src/lib/ai/parseSse.ts`). This is the first SSE client in the repo; the
  utility is ~30 lines and covers the event types defined in section 4.
- On `agent:done` emits an `onRunComplete(runId)` callback that the workspace
  uses to refresh the grid (`key` bump on CmsGrid is already wired; needs a
  signal from the agent to trigger it).

**`src/components/cms/agent/AgentHeader.tsx`**
- Sparkles tile + "Content agent" label + History button (opens history panel,
  currently "Coming soon" notice) + New chat button (clears `messages` state).

**`src/components/cms/agent/AgentChat.tsx`**
- Scrollable message list. Each message is one of:
  - `UserMessage`: the user's prompt text + optional CSV file chip.
  - `ThinkingIndicator`: "Thought for Ns" with a Loader icon, shown while
    `agent:thinking` events are arriving.
  - `AssistantMessage`: rendered step-list from `agent:tool_result` events,
    followed by a `ChangesCard` on `agent:done`.
  - `AgentErrorMessage`: shown on `agent:error`, with the `message` field
    and a "Try again" affordance.

**`src/components/cms/agent/ChangesCard.tsx`**
- The `changes` block from the mockup. Shows a row per `AgentChangeSummary`
  (icon + entity type + count/label). The "Undo all" link calls
  `POST /api/ai/cms-agent/undo` with the `runId`. While undo is in-flight,
  the link is replaced with a spinner. On partial undo, a warning row appears
  at the bottom of the card.

**`src/components/cms/agent/AgentSuggestions.tsx`**
- Four chip buttons: "Generate 5 blog posts", "Translate to German",
  "Bulk publish drafts", "Fill missing covers". Clicking a chip populates
  the input bar and focuses it (does NOT auto-submit).

**`src/components/cms/agent/AgentInput.tsx`**
- Textarea with placeholder "Ask the content agent to create, import, or
  edit content...". Below the textarea: a model picker select (Haiku /
  Sonnet / Opus, default Opus) + paperclip button (opens file picker,
  `.csv` only; selected file attached as chip in the textarea area) + send
  button. Send is disabled while `isRunning`. On send: clears the textarea,
  appends the UserMessage to the chat, and initiates the SSE call.

---

## 8. Model bump

`src/lib/ai/anthropicClient.ts`:

```typescript
export const AI_MODELS = {
  HAIKU: 'claude-haiku-4-5',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-8',   // bumped from claude-opus-4-7
} as const;
```

One line. No behavior change; Opus 4.8 is a drop-in upgrade. All existing
callers of `resolveModelId('OPUS')` pick up the bump automatically.

---

## 9. Headless test plan

Tests go in `src/components/cms/agent/__tests__/` and
`src/app/api/ai/__tests__/`.

### Route tests (`cms-agent.route.test.ts`)

Route tests mock `getAnthropicClient()` via `vi.mock('src/lib/ai/anthropicClient')`
(msw is not installed; direct vi.mock is the pattern used elsewhere in the repo).
The mock returns a controllable stream of Anthropic SDK events (tool_use, end_turn,
etc.). The Prisma client is also mocked via `vi.mock('src/server/db')`.

- **Auth gate**: POST without admin cookie returns 401. POST with wrong secret
  also returns 401. (Tests call the route with a synthetic `Request` object;
  `verifyAdminCookie` reads `request.cookies`, not `next/headers`.)
- **Validation**: POST with missing `collectionId` returns 400. POST with
  `csvPayload.content.length > 4_000_000` returns 400 with the size cap message.
- **Happy path end-turn**: Anthropic mock emits `end_turn` immediately (no tools
  called); SSE stream contains `agent:done` with empty `changes`.
- **Tool dispatch**: Anthropic mock emits a `create_row` tool call; assert the
  executor calls `adapter.createRow` and the SSE stream contains `agent:tool_call`
  + `agent:tool_result` + `agent:done`.
- **Read-before-write**: Anthropic mock emits an `update_row` tool call; assert
  the executor calls `adapter.getRow(rowId)` BEFORE `adapter.updateRow`, and
  the resulting `AgentChange.inversePayload` contains the previous cell values
  from the read step.
- **AgentRun persistence**: after a successful run, the Prisma mock receives a
  `create` call for `AgentRun` with status `running`, then an `update` call
  setting status to `done`.
- **Error surfaced**: if `adapter.bulkCreateRows` throws, the SSE stream contains
  `agent:error` with the error message, NOT silent success. The `AgentRun` status
  is set to `failed`.
- **CSV size cap**: POST with `csvPayload.content` > 4MB returns 400 before the
  agent loop starts.
- **CSV import**: POST with valid `csvPayload` triggers `csv_import` tool;
  assert executor calls `adapter.bulkCreateRows` with the parsed rows.

### Component tests

**`ContentAgentPanel.test.tsx`**
- Renders the header, suggestion chips, and input bar.
- Clicking a suggestion chip populates the input.
- Send button is disabled while `isRunning` prop is true.
- On `agent:done` SSE event, the ChangesCard appears with the correct summaries.

**`ChangesCard.test.tsx`**
- Renders each change row with icon + entity type + label.
- "Undo all" link calls the undo API endpoint.
- While undo is in-flight, the link shows a spinner.
- On partial undo response, a warning row appears.

**`AgentInput.test.tsx`**
- File picker is limited to `.csv` (assert `accept` attribute on the input).
- Selecting a CSV file attaches a chip and sets `csvPayload` in the next send.
- Send clears the textarea and calls the `onSend` callback.

**`AgentChat.test.tsx`**
- UserMessage renders the prompt text.
- ThinkingIndicator renders during `agent:thinking`.
- AgentErrorMessage renders the message from `agent:error` and shows "Try again".

### Undo route tests (`cms-agent-undo.route.test.ts`)

- Auth gate: POST without admin cookie returns 401.
- Returns `{ undone: N, skipped: 0, warnings: [] }` with correct count after
  replaying inverses in reverse `position` order (DESC).
- Archive inverse: `AgentChange` with `inverseTool: "unarchiveRow"` causes
  executor to call `adapter.unarchiveRow(rowId)`.
- Update inverse: `AgentChange` with `inverseTool: "updateRow"` and
  `inversePayload: { rowId, previousCells }` causes executor to call
  `adapter.updateRow(rowId, previousCells)`.
- Partial failure: one inverse throws; response contains the partial count
  and the error message in `warnings`.

---

## 10. Manual verification plan (Lead, real app)

Setup: `docker start fc-dev-pg`; `DATABASE_URL=... FRAMER_CLONE_ADMIN_SECRET=dev-local-verify pnpm dev`; set `admin_secret=dev-local-verify` cookie. Open the editor → Content → Open.

1. **Panel visible**: workspace shows `[rail | grid | agent]`. Agent panel is
   348px wide with sparkles tile, "Content agent" header, suggestion chips, and
   input bar. Model picker shows "Claude Opus 4.8" by default.
2. **Suggestion chip**: click "Generate 5 blog posts" -- it populates the input
   (does not auto-submit).
3. **Generate content**: type "Generate 3 team member entries with Name, Role,
   and Bio" and send. Observe: ThinkingIndicator appears, then step-list ("Called
   list_columns", "Created 3 items"), then ChangesCard with "+3 items". The grid
   re-fetches and shows the 3 new rows.
4. **Undo all**: click "Undo all" in the ChangesCard. Spinner, then the 3 rows
   disappear from the grid. The Changes card shows a confirmation (or partial-undo
   warning if applicable).
5. **CSV import**: attach `events.csv` (a test file with 5 rows) via the
   paperclip. Send "Import this CSV". Observe 5 rows created, Changes card shows
   "+5 items", Undo removes them.
6. **Error surfaced**: send "Upload a cover image for the first row". Observe the
   agent calls `upload_file` and the AssistantMessage surfaces the error
   ("Image upload requires Storage Brain integration -- not yet configured").
   No rows created, no silent success.
7. **Translate**: send "Translate the Name column to German for all rows". Observe
   `agent:tool_result` events, Changes card shows "N updated". Click "Undo all":
   the original (untranslated) values are restored in the grid. Verify the grid
   re-fetches and shows the previous text.
8. **Collapse**: click the agent column toggle in the center sub-header. The agent
   panel collapses to a 40px icon rail; the grid expands to fill. Click again to
   restore.
9. **New chat**: click the `+` in the agent header. Chat clears; `lastRunId`
   resets. Send a new prompt.
10. **Screen comparison**: screenshot the workspace against the mockup right-column.

---

## 11. Files and changes

| Path | Change | Notes |
| --- | --- | --- |
| `src/lib/ai/anthropicClient.ts` | edit | bump `OPUS` to `claude-opus-4-8` |
| `src/lib/ai/parseSse.ts` | new | SSE frame parser utility for fetch-based streaming client |
| `src/server/auth/adminAction.ts` | edit | add `verifyAdminCookie(req: Request)` helper that reads from the Request object (NOT next/headers) |
| `src/app/api/ai/cms-agent/route.ts` | new | Anthropic tool-use loop + SSE; verifyAdminCookie at boundary |
| `src/app/api/ai/cms-agent/undo/route.ts` | new | undo replay endpoint; verifyAdminCookie at boundary |
| `src/app/api/ai/cms-agent/tools.ts` | new | tool schemas (Zod + Anthropic tool defs) |
| `src/app/api/ai/cms-agent/executor.ts` | new | tool dispatch; calls getCmsAdapter() directly; read-before-write for update/archive; records AgentChange inverses |
| `src/components/cms/agent/ContentAgentPanel.tsx` | new | right-column container; fetch-based SSE reader |
| `src/components/cms/agent/AgentHeader.tsx` | new | sparkles tile + history + new-chat |
| `src/components/cms/agent/AgentChat.tsx` | new | scrollable message list |
| `src/components/cms/agent/ChangesCard.tsx` | new | changes summary + Undo all |
| `src/components/cms/agent/AgentSuggestions.tsx` | new | four suggestion chips |
| `src/components/cms/agent/AgentInput.tsx` | new | textarea + model picker + paperclip (.csv only) + send |
| `src/components/cms/grid/CmsWorkspaceOverlay.tsx` | edit | add 3rd agent column; wire `agentOpen` toggle; emit `onRunComplete` to re-key CmsGrid |
| `prisma/schema.prisma` | edit | add `AgentRunStatus` enum + `AgentRun` + `AgentChange` models |
| `prisma/migrations/<timestamp>_add_agent_run_change/migration.sql` | new | CREATE TABLE for both models |
| `src/components/cms/agent/__tests__/ContentAgentPanel.test.tsx` | new | |
| `src/components/cms/agent/__tests__/ChangesCard.test.tsx` | new | |
| `src/components/cms/agent/__tests__/AgentInput.test.tsx` | new | |
| `src/components/cms/agent/__tests__/AgentChat.test.tsx` | new | |
| `src/app/api/ai/__tests__/cms-agent.route.test.ts` | new | vi.mock for anthropicClient + prisma |
| `src/app/api/ai/__tests__/cms-agent-undo.route.test.ts` | new | |

---

## 12. Definition of done

- [ ] Agent panel visible in the workspace as the right column (348px).
- [ ] Model bump (`claude-opus-4-8`) live and verified in the route response.
- [ ] Admin auth verified ONCE at route boundary via `verifyAdminCookie(request)`;
      no `next/headers` cookie reads inside the detached async loop.
- [ ] SSE client uses `fetch()` + `ReadableStream` reader + `parseSseFrames`
      utility; no `EventSource`.
- [ ] All 15 tools dispatch to `getCmsAdapter()` directly (not through
      `actions.ts`); `upload_file` returns loud structured error.
- [ ] Every mutation tool reads before writing for update/archive/status ops;
      `AgentChange.inversePayload` contains the captured previous state.
- [ ] `archive_row` / `bulk_archive_rows` are the agent's removal primitives;
      hard `deleteRow` / `bulkDeleteRows` not exposed.
- [ ] Undo replays inverses in reverse position order; partial failure is
      surfaced in `warnings`, not silenced.
- [ ] SSE events: `agent:thinking`, `agent:tool_call`, `agent:tool_result`,
      `agent:done`, `agent:error`, `usage`, `heartbeat` all fire correctly.
- [ ] CSV size cap: requests with `csvPayload.content > 4MB` rejected with 400.
- [ ] `translate_field` calls batched inner Haiku call; inversePayload stores
      previous cell values per row.
- [ ] Bulk ops store one `AgentChange` per bulk call with id list in payload.
- [ ] Prisma migration runs cleanly (`prisma migrate dev`).
- [ ] `pnpm exec tsc --noEmit && pnpm lint && pnpm test` green.
- [ ] Lead manual verification (section 10) complete.
