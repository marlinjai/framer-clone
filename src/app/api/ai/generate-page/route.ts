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
// context <= MAX_CONTEXT_CHARS, max_tokens MAX_OUTPUT_TOKENS per attempt
// (the model loop itself lives in src/lib/ai/pageGen/runPageGeneration.ts, shared
// with the site operations' generatePage), at
// most one repair attempt, node and depth caps enforced by the validator, and a
// per-user rate limit (src/lib/ai/pageGen/rateLimit.ts). When stock photos were
// placed, one more small call (Haiku, effort low, at most 12 thumbnails, a
// timeout) finds each photo's subject for its crop (src/lib/ai/pageGen/focalPoints.ts);
// it is logged as its own AI call and never fails the generation.

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { jsonError } from '@/lib/api/respond';
import { getAnthropicClient, MissingAnthropicKeyError } from '@/lib/ai/anthropicClient';
import { createSseStream, SSE_HEADERS } from '@/lib/ai/sse';
import { logAiCall, startAiCallTimer, type AiCallStatus } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';
import {
  DEFAULT_PAGE_GEN_MODEL,
  PAGE_GEN_MODELS,
  type PageGenErrorPayload,
  type PageGenProgress,
  type PageGenResultPayload,
  type PageGenStarted,
  type PageGenTarget,
} from '@/lib/ai/pageGen/protocol';
import { getPageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { getPageGenJobs } from '@/lib/ai/pageGen/jobs';
import type { JobHandle } from '@/lib/ai/jobRegistry';
import { triggerStockDownloads } from '@/lib/ai/pageGen/stockImages';
import { runPageGeneration, type PageGenerationUsage } from '@/lib/ai/pageGen/runPageGeneration';
import { SiteContextSchema } from '@/lib/ai/pageGen/promptSections/siteContext';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Heartbeat cadence, same as the CMS agent (proxy idle timeouts). */
const SSE_HEARTBEAT_MS = 5_000;
/** Serialized replace/insert context ceiling (the client truncates to ~8k tokens first). */
const MAX_CONTEXT_CHARS = 60_000;

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
  let usage: PageGenerationUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    attempts: 0,
    model: body.model,
  };
  let status: AiCallStatus = 'ok';
  let errorCode: string | undefined;

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
    // Stop the Anthropic stream (and the spend) only on an explicit cancel
    // (DELETE /api/ai/generate-page/[id]). A dropped connection is a phone in
    // the background, not a user who changed their mind.
    const signal = job.signal;
    const run = await runPageGeneration(
      {
        brief: body.brief,
        model: body.model,
        breakpoints: body.breakpoints,
        target: body.target as PageGenTarget,
        projectName: body.projectName,
        existingPageTitles: body.existingPageTitles,
        siteContext: body.siteContext,
      },
      { anthropic, signal, userId, workspaceId: args.workspaceId, onProgress: progress },
      requestId,
    );
    usage = run.usage;
    if (run.outcome.kind === 'result') {
      job.succeed(run.outcome.payload);
      sse.send('gen:result', run.outcome.payload);
      // The photos are now in a result the editor applies: tell Unsplash
      // (its download tracking), unless the run was cancelled.
      if (!signal.aborted) triggerStockDownloads(run.outcome.placed);
    } else if (run.outcome.kind === 'error') {
      fail(run.outcome.error);
    }
  } finally {
    // A run that ended without an outcome (cancelled mid-way, an early return)
    // must not stay "running" for a client that polls it. No-op once settled.
    job.fail({ code: job.signal.aborted ? 'aborted' : 'generation_failed', message: 'The generation ended without a result.' });
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, attempts } = usage;
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
      model: usage.model,
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
