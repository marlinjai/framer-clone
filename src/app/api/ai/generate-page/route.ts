// src/app/api/ai/generate-page/route.ts
//
// POST /api/ai/generate-page
//
// Generates editor components from a natural-language brief: a whole new page,
// a section that replaces the selected component, or a section inserted into
// the selected container (plan docs/plans/ai-driven-page-generation.md, phases
// 1 to 3). The route is STATELESS with respect to the project: the page tree
// lives in the editor's MobX-State-Tree store and reaches the server only
// through the user's Save. So this route authenticates, asks the model,
// validates and repairs the output (src/lib/ai/pageGen/validate.ts) and streams
// a validated result back; the editor applies it as one undoable action.
//
// Auth is the same boundary as the CMS agent: getVerifiedSession ->
// resolveActiveScope -> authenticateRequest('editSite'), once, before the
// detached stream, reading cookies off the Request (never next/headers).
//
// Status codes:
//   200 -> SSE stream: gen:progress*, then gen:result or gen:error, then usage.
//          Errors after the stream opened are `gen:error` events, never a
//          silent close.
//   400 -> bad JSON / failed validation / brief or context over budget
//   401 -> no session / missing ANTHROPIC_API_KEY
//   403 -> no active company / Sites not enabled / not permitted to edit
//   429 -> this user already has a generation running, or hit the window limit
//   503 -> auth-brain (`auth_unavailable`) or OpenFGA (`authz_unavailable`) down
//
// Budget per request: brief <= GENERATION_LIMITS.maxBriefChars, replace/insert
// context <= MAX_CONTEXT_CHARS, max_tokens MAX_OUTPUT_TOKENS per attempt, at
// most one repair attempt, node and depth caps enforced by the validator, and a
// per-user rate limit (src/lib/ai/pageGen/rateLimit.ts).

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessageParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { jsonError } from '@/lib/api/respond';
import {
  getAnthropicClient,
  isToolInputParseError,
  MissingAnthropicKeyError,
  modelRequestFields,
  refusalMessage,
  replayableAssistantContent,
} from '@/lib/ai/anthropicClient';
import { buildSystemPrompt } from '@/lib/ai/promptCache';
import { createSseStream, SSE_HEADERS } from '@/lib/ai/sse';
import { logAiCall, startAiCallTimer, type AiCallStatus } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import { GENERATION_LIMITS, deriveBreakpointKeys, type BreakpointKey } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import {
  EMIT_TOOL_NAME,
  briefMessage,
  emitPageTool,
  repairMessage,
  requestContextText,
  stableSystemText,
} from '@/lib/ai/pageGen/prompt';
import {
  DEFAULT_PAGE_GEN_MODEL,
  PAGE_GEN_MODELS,
  type PageGenErrorPayload,
  type PageGenTarget,
} from '@/lib/ai/pageGen/protocol';
import { classifyProviderError } from '@/lib/ai/pageGen/providerError';
import { getPageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Heartbeat cadence, same as the CMS agent (proxy idle timeouts). */
const SSE_HEARTBEAT_MS = 5_000;
/**
 * Output ceiling per attempt. A 200-node page is roughly 15k tokens of JSON,
 * and on current models adaptive thinking counts toward the same limit, so
 * the cap leaves room for both. Worst case per request (two full attempts on
 * Sonnet 5.5 at $10 per million output tokens): about $0.64.
 */
const MAX_OUTPUT_TOKENS = 32_000;
/**
 * Effort for page generation: `medium`. It is a single structured design pass
 * with a validation gate after it; raise to `high` only if evals show better
 * layouts are worth the extra thinking tokens.
 */
const PAGE_GEN_EFFORT = 'medium' as const;
/** Attempts per request: the first, plus one repair round. */
const MAX_ATTEMPTS = 2;
/** Serialized replace/insert context ceiling (the client truncates to ~8k tokens first). */
const MAX_CONTEXT_CHARS = 60_000;
/** Progress events are throttled to one per this many received characters. */
const PROGRESS_EVERY_CHARS = 1_500;

const BreakpointSchema = z.object({
  label: z.string().max(60),
  minWidth: z.number().int().min(0).max(10_000),
});

const TargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newPage'), title: z.string().max(120).optional() }),
  z.object({ kind: z.literal('replace'), context: z.unknown() }),
  z.object({ kind: z.literal('insert'), context: z.unknown() }),
]);

const BodySchema = z.object({
  brief: z
    .string()
    .trim()
    .min(1, 'brief must not be empty')
    .max(GENERATION_LIMITS.maxBriefChars, `brief must be at most ${GENERATION_LIMITS.maxBriefChars} characters`),
  model: z.enum(PAGE_GEN_MODELS).default(DEFAULT_PAGE_GEN_MODEL),
  breakpoints: z.array(BreakpointSchema).min(1).max(8),
  target: TargetSchema,
  projectName: z.string().max(120).optional(),
  existingPageTitles: z.array(z.string().max(120)).max(100).optional(),
});

type Body = z.infer<typeof BodySchema>;

async function handlePOST(request: Request): Promise<Response> {
  // ---- 1. Parse + validate body ------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('bad_json', 'invalid JSON body', 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const body = parsed.data;
  if (body.target.kind !== 'newPage') {
    const contextChars = JSON.stringify(body.target.context ?? null).length;
    if (body.target.context === undefined || body.target.context === null) {
      return jsonError('bad_body', 'replace and insert need the selected component as context', 400);
    }
    if (contextChars > MAX_CONTEXT_CHARS) {
      return jsonError('context_too_large', 'the selected component is too large to send as context', 400);
    }
  }

  // ---- 2. Auth at the boundary (reads the Request, not next/headers) -----
  const session = await getVerifiedSession(request);
  if (!session) return jsonError('unauthorized', 'authentication required', 401);
  const scopeResult = resolveActiveScope(session, readCompanySelectors(request));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const auth = await authenticateRequest(request, scopeResult.scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return jsonError(auth.status === 401 ? 'unauthorized' : 'forbidden', auth.error, auth.status);
  }
  const userId = auth.userId;

  // ---- 3. Anthropic client (fast-fail on a missing key) ------------------
  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (e) {
    if (e instanceof MissingAnthropicKeyError) return jsonError(e.code, e.message, 401);
    throw e;
  }

  // ---- 4. Per-user budget --------------------------------------------------
  const slot = getPageGenRateLimiter().acquire(userId);
  if (!slot.ok) {
    const message =
      slot.reason === 'in_flight'
        ? 'A generation is already running for you. Wait for it to finish.'
        : `Generation limit reached. Try again in ${slot.retryAfterSec} seconds.`;
    const res = jsonError('rate_limited', message, 429, { retryAfterSec: slot.retryAfterSec });
    res.headers.set('retry-after', String(slot.retryAfterSec));
    return res;
  }

  // ---- 5. Stream -----------------------------------------------------------
  const sse = createSseStream();
  void runGeneration({
    anthropic,
    body,
    userId,
    workspaceId: scopeResult.scope.workspaceId,
    sse,
    signal: request.signal,
    release: slot.release,
  });
  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

interface RunArgs {
  anthropic: Anthropic;
  body: Body;
  userId: string;
  workspaceId: string;
  sse: ReturnType<typeof createSseStream>;
  signal: AbortSignal;
  /** Frees the user's in-flight slot; called before the stream closes. */
  release: () => void;
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

async function runGeneration(args: RunArgs): Promise<void> {
  const { anthropic, body, userId, sse, signal } = args;
  const heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);
  const requestId = newRequestId();
  const timer = startAiCallTimer();
  const modelFields = modelRequestFields(body.model, PAGE_GEN_EFFORT);
  const modelId = modelFields.model;
  const breakpoints: BreakpointKey[] = deriveBreakpointKeys(body.breakpoints);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let attempts = 0;
  let status: AiCallStatus = 'ok';
  let errorCode: string | undefined;

  const fail = (payload: PageGenErrorPayload): void => {
    errorCode = String(payload.code);
    status = payload.code === 'rate_limited' ? 'rate_limited' : payload.code === 'overloaded' ? 'overloaded' : 'error';
    sse.send('gen:error', payload);
  };

  try {
    const system = buildSystemPrompt([
      { type: 'text', text: stableSystemText(), cache: true },
      {
        type: 'text',
        text: requestContextText({
          breakpoints,
          target: body.target as PageGenTarget,
          projectName: body.projectName,
          existingPageTitles: body.existingPageTitles,
        }),
        cache: false,
      },
    ]);
    const tools = [emitPageTool()];
    const messages: BetaMessageParam[] = [
      {
        role: 'user',
        content: briefMessage(body.brief, body.target.kind === 'newPage' ? undefined : body.target.context),
      },
    ];

    let lastProblems: string[] = [];
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      const attempt = attempts;
      sse.send('gen:progress', { phase: attempt === 1 ? 'generating' : 'repairing', receivedChars: 0, attempt });

      // Sonnet 5.5 carries the server-side fallback opt-in (modelRequestFields);
      // Haiku 5.5 has none.
      const stream = anthropic.beta.messages.stream(
        {
          ...modelFields,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools,
          // `auto` plus the instruction, not a forced tool: current models
          // reject forced tool_choice, and a missing call is handled as a
          // repairable problem below.
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          messages,
        },
        { signal },
      );
      let received = 0;
      let lastReported = 0;
      // The raw tool-input fragments, kept for a strict parse below.
      let rawInput = '';
      stream.on('inputJson', (partialJson: string) => {
        rawInput += partialJson;
        received += partialJson.length;
        if (received - lastReported >= PROGRESS_EVERY_CHARS) {
          lastReported = received;
          sse.send('gen:progress', { phase: attempt === 1 ? 'generating' : 'repairing', receivedChars: received, attempt });
        }
      });

      let final;
      try {
        final = await stream.finalMessage();
      } catch (err) {
        // Eager input streaming hands over unvalidated JSON; JSON the SDK
        // cannot parse at all is invalid model output, not an outage. There
        // is no assistant turn to send back, so the repair turn is a plain
        // user message. Every other error (API, network, abort) propagates.
        if (!isToolInputParseError(err)) throw err;
        lastProblems = [`the ${EMIT_TOOL_NAME} input was not valid JSON`];
        messages.push({ role: 'user', content: repairMessage(lastProblems) });
        continue;
      }
      inputTokens += final.usage.input_tokens;
      outputTokens += final.usage.output_tokens;
      cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0;

      // With eager input streaming the SDK parses the tool input tolerantly:
      // malformed JSON (an unescaped quote, a missing bracket) can come back
      // as a SHORTER but well-formed object that would pass validation as a
      // smaller page. Parse the raw fragments strictly; if they are not valid
      // JSON, the parsed input is not trusted.
      let malformedInput = false;
      if (rawInput.length > 0) {
        try {
          JSON.parse(rawInput);
        } catch {
          malformedInput = true;
        }
      }

      // A classifier decline (after any server-side fallback) is an HTTP 200:
      // checked before content, never repaired (a refusal can also cut the
      // tool input off mid-way).
      const refusal = refusalMessage(final);
      if (refusal) {
        fail({ code: 'refused', message: refusal });
        return;
      }

      // Read by block type: the response may start with thinking blocks.
      const toolUse = final.content.find(
        (b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === EMIT_TOOL_NAME,
      );
      sse.send('gen:progress', { phase: 'validating', receivedChars: received, attempt });

      let problems: string[];
      if (final.stop_reason === 'max_tokens') {
        // Checked before validation: a cut-off eager input usually still
        // parses as a valid-looking partial object.
        problems = [`the output was cut off at ${MAX_OUTPUT_TOKENS} tokens (too long)`];
      } else if (!toolUse) {
        problems = [`no ${EMIT_TOOL_NAME} call was made`];
      } else if (malformedInput) {
        problems = [`the ${EMIT_TOOL_NAME} input was not valid JSON`];
      } else {
        const outcome = validateGeneration(toolUse.input, { breakpoints });
        if (outcome.ok) {
          sse.send('gen:result', {
            generationId: requestId,
            ...outcome.result,
            model: modelId,
          });
          return;
        }
        problems = outcome.errors;
      }
      lastProblems = problems;

      // Feed the problems back for one repair round. The assistant turn is
      // appended as returned; a tool_use block must be answered by a
      // tool_result in the next user turn.
      messages.push({ role: 'assistant', content: replayableAssistantContent(final.content) });
      const toolUses = final.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length > 0) {
        messages.push({
          role: 'user',
          content: toolUses.map((t) => ({
            type: 'tool_result' as const,
            tool_use_id: t.id,
            is_error: true,
            content: repairMessage(problems),
          })),
        });
      } else {
        messages.push({ role: 'user', content: repairMessage(problems) });
      }
    }

    fail({
      code: 'invalid_output',
      message: 'The AI produced a page the editor cannot use. Try again, or simplify the brief.',
      details: lastProblems.slice(0, 20),
    });
  } catch (err) {
    fail(classifyProviderError(err));
  } finally {
    sse.send('usage', { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, attempts });
    clearInterval(heartbeat);
    // Release before closing, so a client that starts the next generation the
    // moment this stream ends is never told one is still running.
    args.release();
    sse.close();
    recordUsage({
      sessionId: userId,
      inputTokens,
      outputTokens,
      cachedReadTokens: cacheReadTokens,
      cachedWriteTokens: cacheWriteTokens,
    });
    logAiCall({
      requestId,
      sessionId: `generate-page:${args.workspaceId}`,
      userId,
      model: modelId,
      promptChars: body.brief.length,
      inputTokens,
      outputTokens,
      cachedReadTokens: cacheReadTokens,
      cachedWriteTokens: cacheWriteTokens,
      latencyMs: timer.latencyMs(),
      status,
      errorCode,
    });
  }
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
