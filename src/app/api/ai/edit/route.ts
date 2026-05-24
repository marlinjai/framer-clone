// src/app/api/ai/edit/route.ts
//
// POST /api/ai/edit
//
// Wave-1 scaffold for the Pattern A AI surface. Accepts a prompt, opens
// a Server-Sent Events stream, runs a non-tool messages.create against
// Anthropic, and forwards token deltas + a usage summary + a done
// event. No tool registry, no MST mutations — those land in later
// specs. The system prompt is a stub that announces "AI not yet
// wired".
//
// Status codes:
//   200 -> SSE stream (success path; errors are encoded as `event: error`
//           inside the stream so the client can show them inline)
//   400 -> Malformed JSON body / failed schema validation
//   401 -> `ANTHROPIC_API_KEY` missing on the server
//
// The route is intentionally additive — nothing else in the editor
// reads from it yet.

import { z } from 'zod';
import {
  getAnthropicClient,
  MissingAnthropicKeyError,
  resolveModelId,
} from '@/lib/ai/anthropicClient';
import { buildSystemPrompt, type SystemBlock } from '@/lib/ai/promptCache';
import {
  createSseStream,
  SSE_HEADERS,
  SSE_HEARTBEAT_MS,
} from '@/lib/ai/sse';
import {
  logAiCall,
  startAiCallTimer,
  type AiCallStatus,
} from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  prompt: z.string().min(1, 'prompt must not be empty'),
  sessionId: z.string().min(1, 'sessionId is required'),
  pageId: z.string().min(1, 'pageId is required'),
  selection: z.array(z.string()).optional(),
});

type Body = z.infer<typeof BodySchema>;

// Cheap, dependency-free request ID. Node ≥18 has globalThis.crypto.
function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const STUB_SYSTEM_TEXT =
  'You are the framer-clone editor assistant scaffold. The full tool ' +
  'registry is not yet wired (see spec ai-pattern-a-tool-schema-registry). ' +
  'For now, respond briefly with: "AI not yet wired".';

function stubSystemBlocks(body: Body): SystemBlock[] {
  return [
    // Stable prefix — cache-eligible.
    {
      type: 'text',
      text: STUB_SYSTEM_TEXT,
      cache: true,
    },
    // Volatile state — must sit after the cache breakpoint. The real
    // page snapshot lands with read-tools-and-context; for the scaffold
    // we just echo the routing context so the model has *some* signal.
    {
      type: 'text',
      text: JSON.stringify(
        { pageId: body.pageId, selection: body.selection ?? [] },
        null,
        2,
      ),
      cache: false,
    },
  ];
}

export async function POST(req: Request): Promise<Response> {
  // ---- 1. Parse + validate body ------------------------------------
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: { message: 'invalid JSON body', code: 'bad_json' } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          message: 'invalid request body',
          code: 'bad_body',
          issues: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // ---- 2. Resolve client (fast-fail on missing key) ----------------
  let client;
  try {
    client = getAnthropicClient();
  } catch (e) {
    if (e instanceof MissingAnthropicKeyError) {
      return Response.json(
        { error: { message: e.message, code: e.code } },
        { status: 401 },
      );
    }
    throw e;
  }

  // ---- 3. Open SSE stream ------------------------------------------
  const sse = createSseStream();
  const requestId = newRequestId();
  const timer = startAiCallTimer();
  const modelId = resolveModelId();

  // Heartbeat keeper. Cleared in finally below.
  const heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);

  // Kick the actual call off the event loop so we can return the
  // Response immediately and stream into it.
  void (async () => {
    let status: AiCallStatus = 'ok';
    let errorCode: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedReadTokens = 0;
    let cachedWriteTokens = 0;

    try {
      const system = buildSystemPrompt(stubSystemBlocks(body));
      const stream = client.messages.stream({
        model: modelId,
        max_tokens: 256,
        system,
        messages: [{ role: 'user', content: body.prompt }],
      });

      stream.on('text', (delta: string) => {
        sse.send('token', { delta });
      });

      const finalMessage = await stream.finalMessage();
      inputTokens = finalMessage.usage.input_tokens;
      outputTokens = finalMessage.usage.output_tokens;
      cachedReadTokens = finalMessage.usage.cache_read_input_tokens ?? 0;
      cachedWriteTokens = finalMessage.usage.cache_creation_input_tokens ?? 0;

      sse.send('usage', {
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cachedWriteTokens,
      });
      sse.send('done', { turnId: requestId });

      recordUsage({
        sessionId: body.sessionId,
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cachedWriteTokens,
      });
    } catch (err: unknown) {
      const code = getErrorCode(err);
      status = mapStatus(code);
      errorCode = code;
      const message =
        err instanceof Error ? err.message : 'unknown upstream error';
      sse.send('error', { message, code });
    } finally {
      clearInterval(heartbeat);
      sse.close();
      logAiCall({
        requestId,
        sessionId: body.sessionId,
        userId: 'anonymous',
        model: modelId,
        promptChars: body.prompt.length,
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cachedWriteTokens,
        latencyMs: timer.latencyMs(),
        status,
        errorCode,
      });
    }
  })();

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

function getErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (s === 429) return 'rate_limited';
    if (s === 529) return 'overloaded';
    if (typeof s === 'number') return `upstream_${s}`;
  }
  return 'upstream_error';
}

function mapStatus(code: string): AiCallStatus {
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'overloaded') return 'overloaded';
  return 'error';
}
