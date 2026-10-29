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
//   200 -> SSE stream: gen:started { generationId }, gen:progress*, then
//          gen:result or gen:error, then usage. Errors after the stream opened
//          are `gen:error` events, never a silent close.
//   400 -> bad JSON / failed validation / brief or context over budget
//   409 -> the client-chosen `runId` is already taken (`run_exists`)
//   401 -> no session / missing ANTHROPIC_API_KEY
//   403 -> no active company / Sites not enabled / not permitted to edit
//   429 -> this user already has a generation running, or hit the window limit
//   503 -> auth-brain (`auth_unavailable`) or OpenFGA (`authz_unavailable`) down
//
// A generation survives its connection (src/lib/ai/jobRegistry.ts): a phone
// that switches to another app drops the stream, but the model call carries on
// and the outcome is kept for the editor to collect through
// GET /api/ai/generate-page/[id], even after iOS reloaded the tab. Only an
// explicit DELETE on that route stops it. The browser chooses the run's id
// (`runId`) before sending, so it can collect the run even when the phone went
// to the background before the response arrived. The spend stays bounded by the
// attempt cap and the per-user rate limit below; the user's in-flight slot is
// held until the run ends, connected or not.
//
// Every valid output goes through the design-tells screen
// (src/lib/ai/pageGen/tells.ts): the safe fixes (dashes, emoji, banned fonts,
// button arrows) are applied, and tells it cannot fix (bento grids, rows of
// identical cards, purple on black, ...) are sent back in the SAME single
// repair round validation errors use. If that round fails or leaves tells, the
// best valid page is still applied and the tells are reported in the result.
//
// The page-essentials screen (src/lib/ai/pageGen/essentials.ts) runs beside it
// and joins the same repair round: a new marketing page whose hero has no
// primary call to action, and images without a meaningful alt text. An alt
// text still missing after that round is filled from the photo description
// (never "Image") and reported as an automatic fix.
//
// Budget per request: brief <= GENERATION_LIMITS.maxBriefChars, replace/insert
// context <= MAX_CONTEXT_CHARS, max_tokens MAX_OUTPUT_TOKENS per attempt, at
// most one repair attempt, node and depth caps enforced by the validator, and a
// per-user rate limit (src/lib/ai/pageGen/rateLimit.ts). When stock photos were
// placed, one more small call (Haiku, effort low, at most 12 thumbnails, a
// timeout) finds each photo's subject for its crop (src/lib/ai/pageGen/focalPoints.ts);
// it is logged as its own AI call and never fails the generation.

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
import { validateGeneration, type GenerationResult } from '@/lib/ai/pageGen/validate';
import {
  EMIT_TOOL_NAME,
  briefMessage,
  emitPageTool,
  repairMessage,
  requestContextText,
  stableSystemText,
  tellRepairMessage,
} from '@/lib/ai/pageGen/prompt';
import {
  autoFixTells,
  describeFinding,
  detectTells,
  treeStats,
  type TellFinding,
} from '@/lib/ai/pageGen/tells';
import {
  DEFAULT_PAGE_GEN_MODEL,
  PAGE_GEN_MODELS,
  type PageGenErrorPayload,
  type PageGenProgress,
  type PageGenResultPayload,
  type PageGenStarted,
  type PageGenTarget,
  type StockImageSummary,
} from '@/lib/ai/pageGen/protocol';
import { classifyProviderError } from '@/lib/ai/pageGen/providerError';
import { getPageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { getPageGenJobs } from '@/lib/ai/pageGen/jobs';
import type { JobHandle } from '@/lib/ai/jobRegistry';
import {
  applyStockPhotos,
  resolveStockImages,
  triggerStockDownloads,
  type PlacedPhoto,
  type StockImageResolution,
} from '@/lib/ai/pageGen/stockImages';
import { FOCAL_MODEL, detectFocalPoints } from '@/lib/ai/pageGen/focalPoints';
import { detectEssentials, fillMissingAlt, type EssentialsOptions } from '@/lib/ai/pageGen/essentials';
import { SiteContextSchema } from '@/lib/ai/pageGen/promptSections/siteContext';
import type { AiEffort, AiModelKey } from '@/lib/ai/anthropicClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Heartbeat cadence, same as the CMS agent (proxy idle timeouts). */
const SSE_HEARTBEAT_MS = 5_000;
/**
 * Output ceiling per attempt. A 200-node page is roughly 15k tokens of JSON,
 * and on current models adaptive thinking counts toward the same limit, so
 * the cap leaves room for both. Worst case per request (two full attempts):
 * about $0.03 on Haiku 5.5, $0.64 on Sonnet 5.5 and $1.28 on Opus 5.5 ($0.50,
 * $10 and $20 per million output tokens).
 */
const MAX_OUTPUT_TOKENS = 32_000;
/**
 * Effort per model (explicit, because the models' defaults differ). Page
 * generation is a single structured design pass with a validation gate after
 * it, so every step runs at `medium`, the level the generator used before the
 * slider existed; raise one only if evals show better layouts are worth the
 * thinking tokens. (Not exported: a route module may only export handlers.)
 */
const PAGE_GEN_EFFORT: Record<AiModelKey, AiEffort> = {
  HAIKU: 'medium',
  SONNET: 'medium',
  OPUS: 'medium',
};
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

const BodySchema = z.strictObject({
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
  siteContext: SiteContextSchema.optional(),
  /** The run's id, chosen by the browser so it can collect a run whose response it never saw. */
  runId: z.string().uuid().optional(),
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
  if (body.runId && getPageGenJobs().has(body.runId)) {
    return jsonError('run_exists', 'this run id is already in use', 409);
  }
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
  // The run is registered before the stream opens and is not tied to it: a
  // dropped connection leaves it running (see the header).
  const workspaceId = scopeResult.scope.workspaceId;
  const job = getPageGenJobs().create({ id: body.runId ?? newRequestId(), userId, workspaceId });
  const sse = createSseStream();
  void runGeneration({
    anthropic,
    body,
    userId,
    workspaceId,
    sse,
    job,
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
  /** The run's record: its outcome stays collectable after a disconnect, and its signal is the only stop. */
  job: JobHandle<PageGenProgress, PageGenResultPayload, PageGenErrorPayload>;
  /** Frees the user's in-flight slot; called before the stream closes. */
  release: () => void;
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

async function runGeneration(args: RunArgs): Promise<void> {
  const { anthropic, body, userId, sse, job } = args;
  // Nothing that can throw runs before the try: whatever happens, the finally
  // below closes the stream, settles the run, logs the call and releases the
  // user's slot.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const requestId = job.id;
  const timer = startAiCallTimer();
  let modelId: string = body.model;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let attempts = 0;
  let status: AiCallStatus = 'ok';
  let errorCode: string | undefined;
  // Applies the best valid page when the repair round fails; set once the
  // stream runs (returns false while there is none).
  let deliverBest: (reason: string) => Promise<boolean> = async () => false;

  // Every event goes to the run's record as well as to the stream, so a client
  // that lost the stream collects the same thing.
  const progress = (p: PageGenProgress): void => {
    job.progress(p);
    sse.send('gen:progress', p);
  };
  const fail = (payload: PageGenErrorPayload): void => {
    errorCode = String(payload.code);
    status = payload.code === 'rate_limited' ? 'rate_limited' : payload.code === 'overloaded' ? 'overloaded' : 'error';
    job.fail(payload);
    sse.send('gen:error', payload);
  };

  try {
    const started: PageGenStarted = { generationId: requestId };
    sse.send('gen:started', started);
    heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);
    const modelFields = modelRequestFields(body.model, PAGE_GEN_EFFORT[body.model]);
    modelId = modelFields.model;
    const breakpoints: BreakpointKey[] = deriveBreakpointKeys(body.breakpoints);
    // Stop the Anthropic stream (and the spend) only on an explicit cancel
    // (DELETE /api/ai/generate-page/[id]). A dropped connection is a phone in
    // the background, not a user who changed their mind.
    const signal = job.signal;

    const system = buildSystemPrompt([
      { type: 'text', text: stableSystemText(), cache: true },
      {
        type: 'text',
        text: requestContextText({
          breakpoints,
          target: body.target as PageGenTarget,
          projectName: body.projectName,
          existingPageTitles: body.existingPageTitles,
          siteContext: body.siteContext,
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

    // The page-essentials checks of this request (src/lib/ai/pageGen/essentials.ts).
    const essentials: EssentialsOptions = {
      newPage: body.target.kind === 'newPage',
      brief: body.brief,
      ...(body.target.kind === 'newPage' && body.target.title ? { pageTitle: body.target.title } : {}),
    };

    let lastProblems: string[] = [];
    // A valid page that only failed the tells screen: applied if the repair
    // round cannot do better, never thrown away.
    let best: ScreenedGeneration | undefined;
    let tellsBefore = 0;
    let received = 0;

    const deliver = async (c: ScreenedGeneration, attempt: number, notes: string[]): Promise<void> => {
      const { imageRequests, invalidImageQueries, ...screenedResult } = c.result;
      // The last resort for alt texts the repair round did not fix: the photo
      // description (or a meaningful layer name), each one reported.
      const alt = fillMissingAlt(screenedResult.nodes, imageRequests);
      const result = { ...screenedResult, nodes: alt.nodes };
      // Filled alt texts are automatic fixes; an image left without one stays a remaining issue.
      const unfilledAlt = new Set(alt.unfilled);
      const remaining = c.remaining.filter((f) => f.tell !== 'alt-text' || unfilledAlt.has(f.path));
      if (imageRequests.length > 0) {
        progress({ phase: 'images', receivedChars: received, attempt });
      }
      const stock = await resolveStockImagesSafely(imageRequests, signal);
      if (signal.aborted) return;
      // Where each photo's subject is, so every crop keeps it in view.
      const placed = await withFocalPoints(stock.placed, {
        anthropic,
        signal,
        userId,
        workspaceId: args.workspaceId,
      });
      if (signal.aborted) return;
      const repaired = best !== undefined && c !== best;
      const repairNote =
        repaired && tellsBefore > c.remaining.length
          ? [`Design: a repair round removed ${tellsBefore - c.remaining.length} of ${tellsBefore} issues (tells of generated design or missing page essentials)`]
          : [];
      // Counts only, never page content.
      console.info(
        `[generate-page] tells fixed=${c.fixCount} remaining=${c.remaining.length} repaired=${repaired} attempts=${attempt} altFilled=${alt.filled} altMissing=${alt.unfilled.length}`,
      );
      const payload: PageGenResultPayload = {
        generationId: requestId,
        ...result,
        warnings: [...result.warnings, ...c.fixLines, ...alt.notes, ...repairNote, ...notes],
        tells: remaining.map(describeFinding),
        nodes: applyStockPhotos(result.nodes, placed),
        model: modelId,
        images: withInvalidQueries(stock.summary, invalidImageQueries),
      };
      job.succeed(payload);
      sse.send('gen:result', payload);
      // The photos are now in a result the editor applies: tell Unsplash
      // (its download tracking), unless the run was cancelled.
      if (!signal.aborted) triggerStockDownloads(stock.placed);
    };
    deliverBest = async (reason: string) => {
      if (!best || signal.aborted) return false;
      await deliver(best, attempts, [`The design repair round failed (${reason}); the first version was applied`]);
      return true;
    };

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      const attempt = attempts;
      progress({ phase: attempt === 1 ? 'generating' : 'repairing', receivedChars: 0, attempt });

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
      received = 0;
      let lastReported = 0;
      // The raw tool-input fragments, kept for a strict parse below.
      let rawInput = '';
      stream.on('inputJson', (partialJson: string) => {
        rawInput += partialJson;
        received += partialJson.length;
        if (received - lastReported >= PROGRESS_EVERY_CHARS) {
          lastReported = received;
          progress({ phase: attempt === 1 ? 'generating' : 'repairing', receivedChars: received, attempt });
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
        // The attempt was billed even though its output was unusable: count
        // what the stream reported so far (input tokens and the output
        // counted up to the failure).
        const partial = stream.currentMessage?.usage;
        if (partial) {
          inputTokens += partial.input_tokens ?? 0;
          outputTokens += partial.output_tokens ?? 0;
          cacheReadTokens += partial.cache_read_input_tokens ?? 0;
          cacheWriteTokens += partial.cache_creation_input_tokens ?? 0;
        }
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
        if (await deliverBest('the model declined')) return;
        fail({ code: 'refused', message: refusal });
        return;
      }

      // Read by block type: the response may start with thinking blocks.
      const toolUse = final.content.find(
        (b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === EMIT_TOOL_NAME,
      );
      progress({ phase: 'validating', receivedChars: received, attempt });

      let problems: string[];
      let repairText = repairMessage;
      if (final.stop_reason === 'max_tokens') {
        // Checked before validation: a cut-off eager input usually still
        // parses as a valid-looking partial object.
        problems = [`the output was cut off at ${MAX_OUTPUT_TOKENS} tokens (too long)`];
      } else if (!toolUse) {
        problems = [`no ${EMIT_TOOL_NAME} call was made`];
      } else if (malformedInput) {
        problems = [`the ${EMIT_TOOL_NAME} input was not valid JSON`];
      } else {
        const outcome = validateGeneration(toolUse.input, {
          breakpoints,
          allowStickyCta: body.target.kind === 'newPage',
        });
        if (outcome.ok) {
          const screened = screenTells(outcome.result, breakpoints, essentials);
          if (screened.remaining.length === 0 || attempts >= MAX_ATTEMPTS) {
            await deliver(screened, attempt, []);
            return;
          }
          // Usable, but with tells the screen cannot fix: one repair round.
          best = screened;
          tellsBefore = screened.remaining.length;
          problems = screened.remaining.map(describeFinding);
          repairText = tellRepairMessage;
        } else {
          problems = outcome.errors;
        }
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
            content: repairText(problems),
          })),
        });
      } else {
        messages.push({ role: 'user', content: repairText(problems) });
      }
    }

    if (await deliverBest(lastProblems[0] ?? 'no usable output')) return;
    fail({
      code: 'invalid_output',
      message: 'The AI produced a page the editor cannot use. Try again, or simplify the brief.',
      details: lastProblems.slice(0, 20),
    });
  } catch (err) {
    // A provider error in the repair round must not cost the user the valid
    // first page.
    let delivered = false;
    try {
      delivered = await deliverBest(classifyProviderError(err).message);
    } catch {
      delivered = false;
    }
    if (!delivered) fail(classifyProviderError(err));
  } finally {
    // A run that ended without an outcome (cancelled mid-way, an early return)
    // must not stay "running" for a client that polls it. No-op once settled.
    job.fail({ code: job.signal.aborted ? 'aborted' : 'generation_failed', message: 'The generation ended without a result.' });
    sse.send('usage', { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, attempts });
    if (heartbeat) clearInterval(heartbeat);
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

/** A valid generation after the design-tells screen. */
interface ScreenedGeneration {
  /** The validated result with the safe fixes applied (stats recounted). */
  result: GenerationResult;
  /** One line per kind of fix, for the dialog's list of automatic fixes. */
  fixLines: string[];
  fixCount: number;
  /** Tells the screen could not fix. */
  remaining: TellFinding[];
}

/**
 * Run the tells screen (src/lib/ai/pageGen/tells.ts) over a validated result:
 * apply the safe fixes, then detect what is left, plus the page essentials
 * (src/lib/ai/pageGen/essentials.ts). Nodes that will get a stock photo are
 * exempt from the rules that would misread their placeholder.
 */
function screenTells(
  result: GenerationResult,
  breakpoints: BreakpointKey[],
  essentials: EssentialsOptions,
): ScreenedGeneration {
  const opts = {
    photoNodeIds: new Set(result.imageRequests.map((r) => r.nodeId)),
    breakpointKeys: breakpoints.map((b) => b.key),
  };
  const fixed = autoFixTells({ title: result.title, description: result.description, nodes: result.nodes }, opts);
  const remaining = [
    ...fixed.findings,
    ...detectTells(fixed.tree, opts).filter((f) => !f.autoFixable),
    ...detectEssentials(fixed.tree, essentials),
  ];
  const nodes = fixed.tree.nodes;
  return {
    result: {
      ...result,
      ...(fixed.tree.title !== undefined ? { title: fixed.tree.title } : {}),
      ...(fixed.tree.description !== undefined ? { description: fixed.tree.description } : {}),
      nodes,
      stats: treeStats(nodes),
    },
    fixLines: fixed.fixes.map((f) => f.detail),
    fixCount: fixed.fixes.reduce((n, f) => n + f.count, 0),
    remaining,
  };
}

/** Count the images whose description the validator refused as placeholders too. */
function withInvalidQueries(summary: StockImageSummary, invalid: number): StockImageSummary {
  if (invalid === 0) return summary;
  return {
    ...summary,
    requested: summary.requested + invalid,
    fellBack: { ...summary.fellBack, invalid_query: invalid },
  };
}

/**
 * The focal-point pass over the placed photos (src/lib/ai/pageGen/focalPoints.ts):
 * one Haiku vision call, logged as its own AI call (its own request id and
 * model, so the generation's log line keeps one model's tokens). A photo
 * without a point keeps no `focal` and is written as a centred crop. Never
 * throws: a failure here must not cost the user the generated page.
 */
async function withFocalPoints(
  placed: PlacedPhoto[],
  ctx: { anthropic: Anthropic; signal: AbortSignal; userId: string; workspaceId: string },
): Promise<PlacedPhoto[]> {
  if (placed.length === 0) return placed;
  const timer = startAiCallTimer();
  try {
    const pass = await detectFocalPoints(
      placed.map((p) => p.thumbSrc),
      { client: ctx.anthropic, signal: ctx.signal },
    );
    if (pass.status !== 'skipped') {
      recordUsage({
        sessionId: ctx.userId,
        inputTokens: pass.usage.inputTokens,
        outputTokens: pass.usage.outputTokens,
        cachedReadTokens: pass.usage.cacheReadTokens,
        cachedWriteTokens: pass.usage.cacheWriteTokens,
      });
      logAiCall({
        requestId: newRequestId(),
        sessionId: `generate-page-focal:${ctx.workspaceId}`,
        userId: ctx.userId,
        model: FOCAL_MODEL,
        promptChars: 0,
        inputTokens: pass.usage.inputTokens,
        outputTokens: pass.usage.outputTokens,
        cachedReadTokens: pass.usage.cacheReadTokens,
        cachedWriteTokens: pass.usage.cacheWriteTokens,
        latencyMs: timer.latencyMs(),
        status: pass.status === 'failed' ? 'error' : 'ok',
        ...(pass.reason ? { errorCode: pass.reason } : {}),
      });
    }
    return placed.map((p, i) => {
      const focal = pass.points[i];
      return focal ? { ...p, focal } : p;
    });
  } catch (err) {
    console.warn(`[focal-points] pass threw, crops stay centred ${err instanceof Error ? err.name : 'error'}`);
    return placed;
  }
}

/**
 * Stock photos are a nicety on top of a valid generation: whatever goes wrong
 * there (the resolver itself never throws, this is the belt and braces), the
 * generation still succeeds with placeholders and a note.
 */
async function resolveStockImagesSafely(
  requests: Parameters<typeof resolveStockImages>[0],
  signal: AbortSignal,
): Promise<StockImageResolution> {
  try {
    return await resolveStockImages(requests, { signal });
  } catch (err) {
    console.warn(`[stock-images] resolver failed ${err instanceof Error ? err.name : 'error'}`);
    return {
      placed: [],
      summary: {
        requested: requests.length,
        resolved: 0,
        fellBack: requests.length > 0 ? { unavailable: requests.length } : {},
        credits: [],
      },
    };
  }
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
