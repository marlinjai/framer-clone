// src/app/api/ai/enhance-brief/route.ts
//
// POST /api/ai/enhance-brief
//
// Enhance in the Generate dialog (plan
// docs/plans/2026-11-04-page-generator-ideas-and-streaming.md, pull request
// 1): the brief rewritten by Haiku with more structure, streamed back word by
// word so the textarea fills as the model writes (src/lib/ai/brief/enhance.ts).
//
// Auth is the generator's boundary (src/lib/ai/brief/routeGuard.ts):
// getVerifiedSession -> resolveActiveScope -> authenticateRequest('editSite'),
// all before the stream opens.
//
// Unlike a page generation, an Enhance does NOT outlive its connection: it is
// a few seconds long and the dialog restores the original brief when the
// stream breaks, so a client that went away (Stop, a closed dialog, a dropped
// network) stops the model call and the spend at once.
//
// Status codes:
//   200 -> SSE stream: enhance:delta { text }*, then enhance:done { text } or
//          enhance:error { code, message }, then usage. An error after the
//          stream opened is an `enhance:error` event, never a silent close.
//   400 -> bad JSON / failed validation (empty brief, over 4000 characters) / context over budget
//   401 -> no session / missing ANTHROPIC_API_KEY
//   403 -> no active company / Sites not enabled / not permitted to edit
//   429 -> an Enhance is already running for this user, or 20 in 10 minutes (retry-after)
// A rewrite that takes longer than ENHANCE_TIMEOUT_MS ends in enhance:error `timeout`.
//   503 -> auth-brain (`auth_unavailable`) or OpenFGA (`authz_unavailable`) down

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { createSseStream, SSE_HEADERS } from '@/lib/ai/sse';
import { logAiCall, startAiCallTimer, type AiCallStatus } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import {
  ENHANCE_EVENTS,
  EnhanceBodySchema,
  type BriefErrorPayload,
  type EnhanceDelta,
  type EnhanceDone,
} from '@/lib/ai/brief/schema';
import { ENHANCE_MODEL, streamEnhance } from '@/lib/ai/brief/enhance';
import { getEnhanceRateLimiter } from '@/lib/ai/brief/rateLimit';
import { guardBriefRequest } from '@/lib/ai/brief/routeGuard';
import { logStatusFor } from '@/lib/ai/brief/errors';
import { emptyBriefUsage } from '@/lib/ai/brief/usage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A rewrite takes seconds; a hung provider must not hold the slot. */
const ENHANCE_TIMEOUT_MS = 60_000;

async function handlePOST(request: Request): Promise<Response> {
  const guard = await guardBriefRequest(request, EnhanceBodySchema, getEnhanceRateLimiter(), 'enhance');
  if (!guard.ok) return guard.response;
  const { body, userId, workspaceId, anthropic } = guard;
  const sse = createSseStream();

  void (async () => {
    const requestId = globalThis.crypto.randomUUID();
    const timer = startAiCallTimer();
    let usage = emptyBriefUsage();
    let status: AiCallStatus = 'ok';
    let errorCode: string | undefined;
    try {
      const timeout = AbortSignal.timeout(ENHANCE_TIMEOUT_MS);
      const signal = AbortSignal.any([sse.signal, request.signal, timeout]);
      const outcome = await streamEnhance(body, {
        anthropic,
        signal,
        onText: (text) => sse.send(ENHANCE_EVENTS.delta, { text } satisfies EnhanceDelta),
      });
      usage = outcome.usage;
      if (outcome.ok) {
        sse.send(ENHANCE_EVENTS.done, { text: outcome.text } satisfies EnhanceDone);
      } else {
        // The timeout surfaces as an abort; it is not the person pressing Stop.
        const error: BriefErrorPayload =
          outcome.error.code === 'aborted' && timeout.aborted
            ? { code: 'timeout', message: 'The rewrite took too long. Try again.' }
            : outcome.error;
        errorCode = error.code;
        status = logStatusFor(error.code);
        sse.send(ENHANCE_EVENTS.error, error);
      }
    } catch (err) {
      // streamEnhance reports its own failures; this is a bug guard so the
      // stream never closes without an outcome.
      errorCode = 'enhance_failed';
      status = 'error';
      console.error('[enhance-brief] unexpected failure', err);
      sse.send(ENHANCE_EVENTS.error, {
        code: 'enhance_failed',
        message: 'Enhance failed on the server. Your brief is unchanged.',
      } satisfies BriefErrorPayload);
    } finally {
      sse.send('usage', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      // Release before closing, so an Enhance started the moment this stream
      // ends is never told one is still running.
      guard.release();
      sse.close();
      recordUsage({
        sessionId: userId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedReadTokens: usage.cacheReadTokens,
        cachedWriteTokens: usage.cacheWriteTokens,
      });
      logAiCall({
        requestId,
        sessionId: `enhance-brief:${workspaceId}`,
        userId,
        model: ENHANCE_MODEL,
        promptChars: body.brief.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedReadTokens: usage.cacheReadTokens,
        cachedWriteTokens: usage.cacheWriteTokens,
        latencyMs: timer.latencyMs(),
        status,
        errorCode,
      });
    }
  })();

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

// An auth-brain outage answers JSON 503 `auth_unavailable`, an OpenFGA failure
// JSON 503 `authz_unavailable` (src/lib/authBrainAvailability.ts).
export const POST = withAuthAvailability(handlePOST);
