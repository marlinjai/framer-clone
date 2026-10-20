// src/app/api/ai/cms-agent/route.ts
//
// POST /api/ai/cms-agent
//
// The CMS content agent. Accepts a natural-language instruction, runs an
// Anthropic tool-use loop over the CMS data layer, and streams its reasoning +
// per-tool results + a change summary back over Server-Sent Events. Every
// mutation is recorded with an exact inverse (AgentChange) so the run is
// reversible via POST /api/ai/cms-agent/undo.
//
// Auth is the route boundary, using the REAL auth-brain path (the same shape as
// /api/projects/publish): getVerifiedSession -> resolveActiveScope ->
// authenticateRequest. It runs ONCE in the synchronous handler (reading the
// session cookie off the Request, NOT next/headers) BEFORE the detached SSE loop,
// and the resolved workspace scope + already-authorized adapter are passed into
// that loop. No cookie is read after the Response is returned, because
// next/headers is not reliably in scope in that continuation. The run is recorded
// under the request's active workspace, never a constant.
//
// Status codes:
//   200 -> SSE stream (errors after the loop starts are encoded as
//           `event: agent:error` inside the stream)
//   400 -> bad JSON / failed validation / CSV over the size cap
//   401 -> no session / missing ANTHROPIC_API_KEY
//   403 -> no active company / Sites not enabled / not permitted to edit this workspace
//   404 -> the collection is not in the active workspace (or does not exist)
//
// Workspace isolation past the boundary: every adapter call of the run, the
// model's tool calls included, goes through workspaceScopedCmsAdapter
// (./scopedAdapter.ts), so an id from another workspace reads as missing and
// a write to one is refused.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Prisma } from '@prisma/client';
import {
  getAnthropicClient,
  isToolInputParseError,
  mergeBetas,
  MissingAnthropicKeyError,
  modelRequestFields,
  progressUpdateFields,
  refusalMessage,
  replayableAssistantContent,
  resolveModelId,
  type AiModelKey,
} from '@/lib/ai/anthropicClient';
import { buildSystemPrompt } from '@/lib/ai/promptCache';
import { MODEL_CHOICES } from '@/lib/ai/modelChoice';
import { createSseStream, SSE_HEADERS } from '@/lib/ai/sse';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { getCmsAdapter } from '@/server/cms/adapterClient';
import { getPrismaClient } from '@/server/db';
import {
  executeAgentTool,
  type AgentChangeSummary,
  type CmsAdapter,
  type ExecutorContext,
  type RecordedChange,
} from './executor';
import { agentToolDefs } from './tools';
import { workspaceScopedCmsAdapter } from './scopedAdapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Heartbeat cadence; the spec requires 5s to dodge proxy idle timeouts. */
const SSE_HEARTBEAT_MS = 5_000;
/** Hard cap on tool-use iterations so a confused model cannot loop forever. */
const MAX_ITERATIONS = 16;
/** Base64 length ceiling (~3 MB decoded). */
const CSV_MAX_BYTES = 4_000_000;

const BodySchema = z.object({
  collectionId: z.string().min(1, 'collectionId is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  prompt: z.string().min(1, 'prompt must not be empty'),
  // The slider's allowlist of model KEYS (never a raw model id); the key maps
  // to the configured id on the server (resolveModelId / AI_MODELS).
  model: z.enum(MODEL_CHOICES).default('OPUS'),
  runId: z.string().optional(),
  csvPayload: z
    .object({ name: z.string(), content: z.string() })
    .optional(),
});

type Body = z.infer<typeof BodySchema>;

const STATIC_INSTRUCTIONS = [
  'You are the CMS content agent for framer-clone. You help an admin create,',
  'import, edit, translate, and organize content in a collection (a database',
  'table) by calling tools. You never write to the database except through the',
  'provided tools, because each tool records an inverse so the user can undo the',
  'whole run with one click.',
  '',
  'Rules:',
  '- ALWAYS call list_columns before writing rows so you use real column ids;',
  '  never invent a column id. cells maps a column id to a value.',
  '- For removal use archive_row / bulk_archive_rows (reversible). There is no',
  '  hard delete.',
  '- To change publish state across many rows use bulk_update_status with the',
  '  Status option name (e.g. "Published").',
  '- When a tool returns an error, STOP and report it to the user in plain',
  '  language before doing anything else. Do not retry blindly or work around it.',
  '- If asked to upload an image or file, call upload_file and report its error',
  '  verbatim; image storage is not configured yet.',
  '- translate_field and generate_content do their own batched generation; you',
  '  just call them with the right ids.',
  '- Keep narration brief. Prefer one tool call at a time so each result informs',
  '  the next step.',
].join('\n');

function dynamicContext(
  body: Body,
  workspaceId: string,
  collectionName: string,
  columns: { id: string; name: string; type: string }[],
  rowCount: number,
): string {
  const columnLines = columns.map((c) => `  - ${c.name} [${c.type}] id=${c.id}`).join('\n');
  return [
    'Current request context:',
    `- collectionId: ${body.collectionId}`,
    `- workspaceId: ${workspaceId}`,
    `- active collection: ${collectionName}`,
    `- row count: ${rowCount}`,
    columns.length > 0 ? `- columns:\n${columnLines}` : '- columns: (none yet)',
    body.csvPayload ? `- attached CSV: ${body.csvPayload.name}` : '- attached CSV: (none)',
  ].join('\n');
}

async function handlePOST(request: Request): Promise<Response> {
  // ---- 1. Parse + validate body ------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: { message: 'invalid JSON body', code: 'bad_json' } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: { message: 'invalid request body', code: 'bad_body', issues: parsed.error.issues } },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.csvPayload && body.csvPayload.content.length > CSV_MAX_BYTES) {
    return Response.json(
      { error: { message: 'CSV too large (max ~3 MB)', code: 'csv_too_large' } },
      { status: 400 },
    );
  }

  // ---- 2. Auth at the boundary (reads Request, not next/headers) ----------
  // The verified session is the ONLY source of the workspace scope below; the
  // client-sent workspaceId is NOT trusted. This resolves at the SYNC point,
  // before the detached SSE loop.
  const session = await getVerifiedSession(request);
  if (!session) {
    return Response.json(
      { error: { message: 'authentication required', code: 'unauthorized' } },
      { status: 401 },
    );
  }
  const scopeResult = resolveActiveScope(session, readCompanySelectors(request));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return Response.json(
      { error: { message: denial.message, code: denial.code } },
      { status: 403 },
    );
  }
  const { scope } = scopeResult;
  const auth = await authenticateRequest(request, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return Response.json(
      {
        error: {
          message: auth.error,
          code: auth.status === 401 ? 'unauthorized' : 'forbidden',
        },
      },
      { status: auth.status },
    );
  }

  // ---- 2b. The collection must live in the active workspace ---------------
  // Every adapter call of this run goes through the workspace-scoped adapter
  // (./scopedAdapter.ts), so neither the client-sent collectionId nor an id the
  // model is talked into can reach another workspace. A collection outside the
  // active workspace answers the same 404 as a missing one (no existence leak),
  // before any run is recorded.
  const adapter = workspaceScopedCmsAdapter(
    getCmsAdapter() as unknown as CmsAdapter,
    scope.workspaceId,
  );
  if (!(await adapter.getTable(body.collectionId))) {
    return Response.json(
      { error: { message: 'collection not found', code: 'not_found' } },
      { status: 404 },
    );
  }

  // ---- 3. Resolve the Anthropic client (fast-fail on missing key) --------
  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (e) {
    if (e instanceof MissingAnthropicKeyError) {
      return Response.json({ error: { message: e.message, code: e.code } }, { status: 401 });
    }
    throw e;
  }

  // ---- 4. Create the AgentRun record (status: running) -------------------
  const prisma = getPrismaClient();
  const runId = body.runId ?? crypto.randomUUID();
  const modelId = resolveModelId(body.model);
  // The run is recorded under the request's active workspace (scope.workspaceId),
  // never the client-sent body.workspaceId.
  const workspaceId = scope.workspaceId;
  await prisma.agentRun.create({
    data: {
      id: runId,
      collectionId: body.collectionId,
      workspaceId,
      prompt: body.prompt,
      model: modelId,
      status: 'running',
    },
  });

  // ---- 5. Open the SSE stream and kick off the detached loop -------------
  const sse = createSseStream();

  // Stop spending when the client goes away: the request is aborted, or the
  // SSE stream was cancelled / a write hit a closed connection.
  const signal = AbortSignal.any([request.signal, sse.signal]);
  void runAgentLoop({ adapter, anthropic, prisma, body, workspaceId, modelKey: body.model, runId, sse, signal });

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

/** Strict JSON check of a raw streamed tool input (empty means `{}`: no fragments). */
function isStrictJson(raw: string): boolean {
  if (raw.trim() === '') return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** A deliberate stop of the loop with a user-facing code (refusal, truncation, bad tool JSON). */
class AgentStopError extends Error {
  constructor(readonly code: 'refused' | 'truncated' | 'invalid_tool_input' | 'cancelled', message: string) {
    super(message);
    this.name = 'AgentStopError';
  }
}

interface LoopArgs {
  adapter: CmsAdapter;
  anthropic: Anthropic;
  prisma: ReturnType<typeof getPrismaClient>;
  body: Body;
  workspaceId: string;
  modelKey: AiModelKey;
  runId: string;
  sse: ReturnType<typeof createSseStream>;
  /** Aborts when the client disconnected (see handlePOST). */
  signal: AbortSignal;
}

async function runAgentLoop(args: LoopArgs): Promise<void> {
  const { adapter, anthropic, prisma, body, workspaceId, modelKey, runId, sse, signal } = args;
  const heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);

  const changeSummaries: AgentChangeSummary[] = [];
  let position = 0;
  const recordChange = async (change: RecordedChange): Promise<void> => {
    await prisma.agentChange.create({
      data: {
        runId,
        position: position++,
        tool: change.tool,
        entityType: change.entityType,
        entityId: change.entityId,
        inverseTool: change.inverseTool,
        inversePayload: change.inversePayload as Prisma.InputJsonValue,
      },
    });
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  try {
    // Gather the dynamic collection context for the system prompt.
    const [columns, rowsResult, table] = await Promise.all([
      adapter.getColumns(body.collectionId),
      adapter.getRows(body.collectionId, { limit: 1 }),
      adapter.getTable(body.collectionId),
    ]);
    const collectionName = table?.name ?? 'collection';

    const system = buildSystemPrompt([
      { type: 'text', text: STATIC_INSTRUCTIONS, cache: true },
      {
        type: 'text',
        text: dynamicContext(
          body,
          workspaceId,
          collectionName,
          columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
          rowsResult.total,
        ),
        cache: false,
      },
    ]);

    const ctx: ExecutorContext = {
      adapter,
      anthropic,
      recordChange,
      csvPayload: body.csvPayload,
      collectionName,
    };

    const messages: BetaMessageParam[] = [{ role: 'user', content: body.prompt }];
    // Effort is the thinking and spend control on current models. Opus and
    // Sonnet run at `medium` (multi-step tool work over real data, where a
    // wrong write costs an undo); Haiku stays at `low` (its fast, cheap tier).
    // Sonnet and Opus also add the server-side fallback opt-in and
    // progress-update narration.
    const modelFields = modelRequestFields(modelKey, modelKey === 'HAIKU' ? 'low' : 'medium');
    const progress = progressUpdateFields(modelKey);
    const betas = mergeBetas<string>(modelFields.betas, progress.betas);

    // Disconnect handling: the Anthropic stream is aborted at once, and the
    // loop checks the signal before every tool call, so a tool that already
    // started finishes and records its inverse (the run stays undoable) and
    // nothing after it runs. A turn is never left half-applied mid-tool.
    const stopIfDisconnected = (): void => {
      if (signal.aborted) {
        throw new AgentStopError('cancelled', 'The client disconnected; the run stopped and every change made so far can be undone.');
      }
    };

    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      stopIfDisconnected();
      const stream = anthropic.beta.messages.stream({
        ...modelFields,
        ...(progress.thinking ? { thinking: progress.thinking } : {}),
        ...(betas ? { betas } : {}),
        // Thinking counts toward max_tokens on current models.
        max_tokens: 16_000,
        system,
        tools: agentToolDefs,
        messages,
      }, { signal });
      stream.on('text', (delta: string) => sse.send('agent:thinking', { text: delta }));
      // Raw tool-input JSON per content block index. With eager input
      // streaming the SDK parses inputs tolerantly, so malformed JSON can
      // arrive as a silently SHORTER object (a cut-off string value) that
      // still passes the executor's schema check. The raw text is parsed
      // strictly below before any tool of the turn runs.
      const rawToolInput = new Map<number, string>();
      stream.on('streamEvent', (event) => {
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          rawToolInput.set(event.index, (rawToolInput.get(event.index) ?? '') + event.delta.partial_json);
        }
      });
      // Progress-update notes between tool calls (display: "updates").
      stream.on('thinking', (delta: string) => {
        if (delta) sse.send('agent:thinking', { text: delta });
      });

      let final;
      try {
        final = await stream.finalMessage();
      } catch (err) {
        stopIfDisconnected(); // an abort is a cancellation, not an upstream error
        if (!isToolInputParseError(err)) throw err;
        throw new AgentStopError('invalid_tool_input', 'The agent produced an unreadable tool call. Nothing more was changed; run it again.');
      }
      inputTokens += final.usage.input_tokens;
      outputTokens += final.usage.output_tokens;
      cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;

      // A classifier decline is an HTTP 200: stop before reading content or
      // running any tool of this turn (a refusal can cut a tool call off).
      const refusal = refusalMessage(final);
      if (refusal) throw new AgentStopError('refused', refusal);

      // Append the assistant turn unchanged (thinking blocks included).
      messages.push({ role: 'assistant', content: replayableAssistantContent(final.content) });

      const toolUses = final.content.filter(
        (block): block is BetaToolUseBlock => block.type === 'tool_use',
      );

      if (final.stop_reason === 'max_tokens' && toolUses.length > 0) {
        // With eager input streaming a cut-off tool input can still parse as a
        // partial object: never run it.
        throw new AgentStopError('truncated', 'The agent ran out of output space mid tool call. Nothing more was changed; try a smaller request.');
      }
      if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      const toolResults: BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        stopIfDisconnected();
        const raw = rawToolInput.get(final.content.indexOf(toolUse));
        if (raw !== undefined && !isStrictJson(raw)) {
          // Run nothing from this block; tell the model so it can call again.
          const summary = `INVALID_JSON: the input for ${toolUse.name} was not valid JSON, so nothing was run. Call the tool again with valid JSON.`;
          sse.send('agent:tool_result', { tool: toolUse.name, success: false, summary });
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: summary, is_error: true });
          continue;
        }
        sse.send('agent:tool_call', { tool: toolUse.name, input: toolUse.input });
        const result = await executeAgentTool(toolUse.name, toolUse.input, ctx);
        sse.send('agent:tool_result', {
          tool: toolUse.name,
          success: result.success,
          summary: result.summary,
        });
        if (result.changeSummary) changeSummaries.push(result.changeSummary);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.success ? result.summary : result.error ?? result.summary,
          is_error: !result.success,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'done' } });
    sse.send('agent:done', { runId, changes: changeSummaries });
    sse.send('usage', { inputTokens, outputTokens, cacheReadTokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'agent run failed';
    try {
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: 'failed', errorMessage: message },
      });
    } catch {
      // The run-status update is best-effort; the SSE error is the source of truth.
    }
    const code = err instanceof AgentStopError ? err.code : 'agent_error';
    sse.send('agent:error', { code, message });
  } finally {
    clearInterval(heartbeat);
    sse.close();
  }
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
