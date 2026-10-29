// src/app/api/ai/review-page/route.ts
//
// POST /api/ai/review-page
//
// The visual review pass (plan docs/plans/2026-10-23-ai-design-quality-round-2.md,
// decision 4). The editor sends the page tree (responsive maps keyed by
// breakpoint KEY), the layout findings it measured in the rendered DOM
// (src/lib/ai/review/layoutAudit.ts), up to two captured frames and the
// original brief. A vision model answers with patch operations through one
// tool; every operation is validated against the tree that was sent
// (src/lib/ai/review/ops.ts) and the refused ones are reported, never applied.
// Stateless like generate-page: the editor applies the result as one undo step.
//
// Auth is the same boundary as generate-page: getVerifiedSession ->
// resolveActiveScope -> authenticateRequest('editSite'), once, before the
// detached stream, reading cookies off the Request.
//
// Status codes:
//   200 -> SSE stream: review:started { reviewId }, review:progress*, then
//          review:result or review:error, then usage. Errors after the stream
//          opened are `review:error`.
//   400 -> bad JSON / failed validation / tree or images over budget
//   401 -> no session / missing ANTHROPIC_API_KEY
//   403 -> no active company / Sites not enabled / not permitted to edit
//   429 -> a review is already running for this user, or the window limit
//   503 -> auth-brain (`auth_unavailable`) or OpenFGA (`authz_unavailable`) down
//
// Like generate-page, a review survives its connection
// (src/lib/ai/jobRegistry.ts): a phone switching apps drops the stream but not
// the model call, the editor collects the outcome from
// GET /api/ai/review-page/[id] when it comes back, and only a DELETE there
// stops it. The user's in-flight slot is held until the run ends.
//
// Budget per request: tree <= REVIEW_LIMITS.maxTreeChars, at most two JPEGs of
// at most maxImageBase64Chars each, MAX_OUTPUT_TOKENS of output, ONE attempt
// (no repair round: invalid operations are dropped and reported), a per-user
// rate limit (src/lib/ai/review/rateLimit.ts). Worst case on Sonnet 5.5: about
// 50k input tokens ($0.10) plus 16k output ($0.16); Opus doubles it.

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
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
  type AiEffort,
} from '@/lib/ai/anthropicClient';
import { buildSystemPrompt } from '@/lib/ai/promptCache';
import { createSseStream, SSE_HEADERS } from '@/lib/ai/sse';
import { logAiCall, startAiCallTimer, type AiCallStatus } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { classifyProviderError } from '@/lib/ai/pageGen/providerError';
import {
  DEFAULT_REVIEW_MODEL,
  REVIEW_LIMITS,
  REVIEW_MODELS,
  type ReviewErrorPayload,
  type ReviewProgress,
  type ReviewResultPayload,
  type ReviewStarted,
  type ReviewTreeNode,
} from '@/lib/ai/review/protocol';
import { indexReviewTree, validateReviewOps } from '@/lib/ai/review/ops';
import { REVIEW_TOOL_NAME, reviewContextText, reviewSystemText, reviewTool, reviewUserContent } from '@/lib/ai/review/prompt';
import { getReviewRateLimiter } from '@/lib/ai/review/rateLimit';
import { getReviewJobs } from '@/lib/ai/review/jobs';
import type { JobHandle } from '@/lib/ai/jobRegistry';
import type { LayoutFinding } from '@/lib/ai/review/layoutAudit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_HEARTBEAT_MS = 5_000;
/** Output ceiling: up to 40 small operations plus adaptive thinking. */
const MAX_OUTPUT_TOKENS = 16_000;
/** A review is a careful look at a few concrete problems: medium on both models. */
const REVIEW_EFFORT: AiEffort = 'medium';
/** Progress events are throttled to one per this many received characters. */
const PROGRESS_EVERY_CHARS = 1_000;
/** Most nodes and the deepest nesting accepted in a sent tree. */
const MAX_TREE_NODES = 800;
const MAX_TREE_DEPTH = 40;

const FindingSchema = z.object({
  kind: z.string().max(40),
  severity: z.enum(['error', 'warning']),
  nodeId: z.string().max(100),
  breakpoint: z.string().max(60),
  relatedNodeId: z.string().max(100).optional(),
  measured: z.record(z.string().max(40), z.union([z.number(), z.string().max(60)])),
  message: z.string().max(500),
});

const ImageSchema = z.object({
  breakpoint: z.string().max(60),
  mediaType: z.literal('image/jpeg'),
  data: z
    .string()
    .min(100)
    .max(REVIEW_LIMITS.maxImageBase64Chars)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image data must be base64'),
  width: z.number().int().min(1).max(8000),
  height: z.number().int().min(1).max(8000),
  cssWidth: z.number().int().min(1).max(10_000),
  truncated: z.boolean(),
});

const BodySchema = z.strictObject({
  model: z.enum(REVIEW_MODELS).default(DEFAULT_REVIEW_MODEL),
  breakpoints: z.array(z.object({ label: z.string().max(60), minWidth: z.number().int().min(0).max(10_000) })).min(1).max(8),
  tree: z.unknown(),
  findings: z.array(FindingSchema).max(REVIEW_LIMITS.maxFindings),
  images: z.array(ImageSchema).max(REVIEW_LIMITS.maxImages),
  brief: z.string().trim().max(REVIEW_LIMITS.maxBriefChars).optional(),
  notes: z.array(z.string().max(300)).max(10).optional(),
});

type Body = z.infer<typeof BodySchema>;

/** A structurally valid review tree (ids, types, props, children), within the node and depth caps. */
function checkTree(raw: unknown): { ok: true; tree: ReviewTreeNode } | { ok: false; reason: string } {
  let count = 0;
  const ids = new Set<string>();
  const walk = (n: unknown, depth: number): string | null => {
    if (depth > MAX_TREE_DEPTH) return `the tree is deeper than ${MAX_TREE_DEPTH}`;
    if (++count > MAX_TREE_NODES) return `the tree has more than ${MAX_TREE_NODES} nodes`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) return 'a node is not an object';
    const node = n as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id || node.id.length > 100) return 'a node has no valid id';
    if (ids.has(node.id)) return `duplicate node id ${node.id}`;
    ids.add(node.id);
    if (typeof node.type !== 'string' || node.type.length > 60) return `node ${node.id} has no valid type`;
    if (!node.props || typeof node.props !== 'object' || Array.isArray(node.props)) return `node ${node.id} has no props object`;
    if (!Array.isArray(node.children)) return `node ${node.id} has no children list`;
    for (const c of node.children) {
      const problem = walk(c, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  const problem = walk(raw, 1);
  return problem ? { ok: false, reason: problem } : { ok: true, tree: raw as ReviewTreeNode };
}

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
  if (JSON.stringify(body.tree ?? null).length > REVIEW_LIMITS.maxTreeChars) {
    return jsonError('tree_too_large', 'the page is too large to review in one pass', 400);
  }
  const tree = checkTree(body.tree);
  if (!tree.ok) return jsonError('bad_body', `invalid page tree: ${tree.reason}`, 400);

  // ---- 2. Auth at the boundary --------------------------------------------
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

  // ---- 3. Anthropic client --------------------------------------------------
  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (e) {
    if (e instanceof MissingAnthropicKeyError) return jsonError(e.code, e.message, 401);
    throw e;
  }

  // ---- 4. Per-user budget ---------------------------------------------------
  const slot = getReviewRateLimiter().acquire(userId);
  if (!slot.ok) {
    const message =
      slot.reason === 'in_flight'
        ? 'A review is already running for you. Wait for it to finish.'
        : `Review limit reached. Try again in ${slot.retryAfterSec} seconds.`;
    const res = jsonError('rate_limited', message, 429, { retryAfterSec: slot.retryAfterSec });
    res.headers.set('retry-after', String(slot.retryAfterSec));
    return res;
  }

  // ---- 5. Stream -------------------------------------------------------------
  // Registered before the stream opens and not tied to it (see the header).
  const workspaceId = scopeResult.scope.workspaceId;
  const job = getReviewJobs().create({ id: globalThis.crypto.randomUUID(), userId, workspaceId });
  const sse = createSseStream();
  void runReview({
    anthropic,
    body,
    tree: tree.tree,
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
  tree: ReviewTreeNode;
  userId: string;
  workspaceId: string;
  sse: ReturnType<typeof createSseStream>;
  /** The run's record: collectable after a disconnect; its signal is the only stop. */
  job: JobHandle<ReviewProgress, ReviewResultPayload, ReviewErrorPayload>;
  release: () => void;
}

async function runReview(args: RunArgs): Promise<void> {
  const { anthropic, body, sse, job } = args;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const requestId = job.id;
  const timer = startAiCallTimer();
  let modelId: string = body.model;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let status: AiCallStatus = 'ok';
  let errorCode: string | undefined;

  const fail = (payload: ReviewErrorPayload): void => {
    errorCode = payload.code;
    status = payload.code === 'rate_limited' ? 'rate_limited' : payload.code === 'overloaded' ? 'overloaded' : 'error';
    job.fail(payload);
    sse.send('review:error', payload);
  };
  // Every event also goes to the run's record, for a client that lost the stream.
  const progress = (p: ReviewProgress): void => {
    job.progress(p);
    sse.send('review:progress', p);
  };

  try {
    const started: ReviewStarted = { reviewId: requestId };
    sse.send('review:started', started);
    heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);
    const modelFields = modelRequestFields(body.model, REVIEW_EFFORT);
    modelId = modelFields.model;
    const breakpoints = deriveBreakpointKeys(body.breakpoints);
    // Only an explicit cancel stops the model call, never a dropped connection.
    const signal = job.signal;
    progress({ phase: 'reviewing', receivedChars: 0 });

    const stream = anthropic.beta.messages.stream(
      {
        ...modelFields,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt([
          { type: 'text', text: reviewSystemText(), cache: true },
          { type: 'text', text: reviewContextText(breakpoints), cache: false },
        ]),
        tools: [reviewTool()],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [
          {
            role: 'user',
            content: reviewUserContent({
              tree: args.tree,
              findings: body.findings as LayoutFinding[],
              images: body.images,
              brief: body.brief,
              notes: body.notes,
            }),
          },
        ],
      },
      { signal },
    );
    let received = 0;
    let lastReported = 0;
    // The raw tool-input fragments, parsed strictly below: with eager input
    // streaming the SDK parses tolerantly, and a malformed input can come back
    // as a shorter, well-formed object (fewer fixes than the model wrote).
    let rawInput = '';
    stream.on('inputJson', (partialJson: string) => {
      rawInput += partialJson;
      received += partialJson.length;
      if (received - lastReported >= PROGRESS_EVERY_CHARS) {
        lastReported = received;
        progress({ phase: 'reviewing', receivedChars: received });
      }
    });

    let final;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      // Bill what the stream counted before it failed, then classify.
      const partial = stream.currentMessage?.usage;
      if (partial) {
        inputTokens += partial.input_tokens ?? 0;
        outputTokens += partial.output_tokens ?? 0;
        cacheReadTokens += partial.cache_read_input_tokens ?? 0;
        cacheWriteTokens += partial.cache_creation_input_tokens ?? 0;
      }
      if (isToolInputParseError(err)) {
        fail({ code: 'invalid_output', message: 'The AI returned fixes the editor cannot read. Try again.' });
        return;
      }
      throw err;
    }
    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;
    cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0;

    const refusal = refusalMessage(final);
    if (refusal) {
      fail({ code: 'refused', message: refusal });
      return;
    }
    if (final.stop_reason === 'max_tokens') {
      fail({ code: 'invalid_output', message: 'The review was cut off before it finished. Try again.' });
      return;
    }
    const toolUse = final.content.find(
      (b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === REVIEW_TOOL_NAME,
    );
    if (!toolUse) {
      fail({ code: 'invalid_output', message: 'The AI did not return any fixes. Try again.' });
      return;
    }
    if (rawInput.length > 0) {
      try {
        JSON.parse(rawInput);
      } catch {
        fail({ code: 'invalid_output', message: 'The AI returned fixes the editor cannot read. Try again.' });
        return;
      }
    }
    progress({ phase: 'validating', receivedChars: received });
    const input = (toolUse.input ?? {}) as { summary?: unknown; ops?: unknown };
    const { ops, rejected } = validateReviewOps(input.ops ?? [], {
      breakpointKeys: breakpoints.map((b) => b.key),
      nodes: indexReviewTree(args.tree),
    });
    const result: ReviewResultPayload = {
      reviewId: requestId,
      summary: typeof input.summary === 'string' ? input.summary.slice(0, 1000) : '',
      ops,
      rejected,
      model: modelId,
    };
    job.succeed(result);
    sse.send('review:result', result);
  } catch (err) {
    const classified = classifyProviderError(err);
    fail(
      classified.code === 'aborted'
        ? { code: 'aborted', message: 'The review was cancelled.' }
        : { code: String(classified.code), message: classified.message, ...(classified.retryAfterSec ? { retryAfterSec: classified.retryAfterSec } : {}) },
    );
  } finally {
    // Never leave a polled run "running" (no-op once it has an outcome).
    job.fail({ code: job.signal.aborted ? 'aborted' : 'review_failed', message: 'The review ended without a result.' });
    sse.send('usage', { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
    if (heartbeat) clearInterval(heartbeat);
    args.release();
    sse.close();
    recordUsage({
      sessionId: args.userId,
      inputTokens,
      outputTokens,
      cachedReadTokens: cacheReadTokens,
      cachedWriteTokens: cacheWriteTokens,
    });
    logAiCall({
      requestId,
      sessionId: `review-page:${args.workspaceId}`,
      userId: args.userId,
      model: modelId,
      promptChars: (body.brief?.length ?? 0) + JSON.stringify(args.tree).length,
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

export const POST = withAuthAvailability(handlePOST);
