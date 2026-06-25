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
// Admin auth is the route boundary: verifyAdminCookie(request) runs ONCE in the
// synchronous handler (reading the cookie off the Request, NOT next/headers),
// and the already-authorized adapter is passed into the detached async loop. No
// cookie is read after the Response is returned, because next/headers is not
// reliably in scope in that continuation.
//
// Status codes:
//   200 -> SSE stream (errors after the loop starts are encoded as
//           `event: agent:error` inside the stream)
//   400 -> bad JSON / failed validation / CSV over the size cap
//   401 -> missing/invalid admin secret, or missing ANTHROPIC_API_KEY

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import {
  getAnthropicClient,
  MissingAnthropicKeyError,
  resolveModelId,
} from '@/lib/ai/anthropicClient';
import { buildSystemPrompt } from '@/lib/ai/promptCache';
import { createSseStream, SSE_HEADERS } from '@/lib/ai/sse';
import { verifyAdminCookie } from '@/server/auth/adminAction';
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
  model: z.enum(['HAIKU', 'SONNET', 'OPUS']).default('OPUS'),
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
  collectionName: string,
  columns: { id: string; name: string; type: string }[],
  rowCount: number,
): string {
  const columnLines = columns.map((c) => `  - ${c.name} [${c.type}] id=${c.id}`).join('\n');
  return [
    'Current request context:',
    `- collectionId: ${body.collectionId}`,
    `- workspaceId: ${body.workspaceId}`,
    `- active collection: ${collectionName}`,
    `- row count: ${rowCount}`,
    columns.length > 0 ? `- columns:\n${columnLines}` : '- columns: (none yet)',
    body.csvPayload ? `- attached CSV: ${body.csvPayload.name}` : '- attached CSV: (none)',
  ].join('\n');
}

export async function POST(request: Request): Promise<Response> {
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

  // ---- 2. Admin auth at the boundary (reads Request, not next/headers) ----
  if (!verifyAdminCookie(request)) {
    return Response.json(
      { error: { message: 'admin secret required or invalid', code: 'unauthorized' } },
      { status: 401 },
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
  await prisma.agentRun.create({
    data: {
      id: runId,
      collectionId: body.collectionId,
      workspaceId: body.workspaceId,
      prompt: body.prompt,
      model: modelId,
      status: 'running',
    },
  });

  // ---- 5. Open the SSE stream and kick off the detached loop -------------
  const sse = createSseStream();
  const adapter = getCmsAdapter() as unknown as CmsAdapter;

  void runAgentLoop({ adapter, anthropic, prisma, body, modelId, runId, sse });

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

interface LoopArgs {
  adapter: CmsAdapter;
  anthropic: Anthropic;
  prisma: ReturnType<typeof getPrismaClient>;
  body: Body;
  modelId: string;
  runId: string;
  sse: ReturnType<typeof createSseStream>;
}

async function runAgentLoop(args: LoopArgs): Promise<void> {
  const { adapter, anthropic, prisma, body, modelId, runId, sse } = args;
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

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: body.prompt }];

    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      const stream = anthropic.messages.stream({
        model: modelId,
        max_tokens: 4096,
        system,
        tools: agentToolDefs,
        messages,
      });
      stream.on('text', (delta: string) => sse.send('agent:thinking', { text: delta }));

      const final = await stream.finalMessage();
      inputTokens += final.usage.input_tokens;
      outputTokens += final.usage.output_tokens;
      cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;

      messages.push({
        role: 'assistant',
        content: final.content as Anthropic.ContentBlockParam[],
      });

      const toolUses = final.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
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
    sse.send('agent:error', { code: 'agent_error', message });
  } finally {
    clearInterval(heartbeat);
    sse.close();
  }
}
