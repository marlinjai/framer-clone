// src/app/api/ai/page-ideas/route.ts
//
// POST /api/ai/page-ideas
//
// Six ideas for the Generate dialog's idea row, tailored to the site (plan
// docs/plans/2026-11-04-page-generator-ideas-and-streaming.md, pull request
// 1): one Haiku call with the project context (src/lib/ai/brief/ideas.ts).
// The dialog shows a static set at once and swaps this one in when it lands.
//
// Auth is the generator's boundary (src/lib/ai/brief/routeGuard.ts):
// getVerifiedSession -> resolveActiveScope -> authenticateRequest('editSite').
//
// Status codes:
//   200 -> { ideas: [{ title, brief }] }
//   400 -> bad JSON / failed validation / context over budget
//   401 -> no session / missing ANTHROPIC_API_KEY
//   403 -> no active company / Sites not enabled / not permitted to edit
//   429 -> a call is already running for this user, 20 in 10 minutes, or the
//          provider rate limits (retry-after)
//   502 -> the model returned nothing usable (`invalid_output`) or declined (`refused`)
//   503 -> auth-brain or OpenFGA down, or the AI provider unavailable or overloaded
//   504 -> the call took longer than IDEAS_TIMEOUT_MS (`aborted`)

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError } from '@/lib/api/respond';
import { logAiCall, startAiCallTimer, type AiCallStatus } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import { IdeasBodySchema, type IdeasResponse } from '@/lib/ai/brief/schema';
import { generateIdeas, IDEAS_MODEL } from '@/lib/ai/brief/ideas';
import { getIdeasRateLimiter } from '@/lib/ai/brief/rateLimit';
import { guardBriefRequest } from '@/lib/ai/brief/routeGuard';
import { logStatusFor, statusForBriefError } from '@/lib/ai/brief/errors';
import { emptyBriefUsage } from '@/lib/ai/brief/usage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The call is small; a hung provider must not hold the user's slot for long. */
const IDEAS_TIMEOUT_MS = 30_000;

async function handlePOST(request: Request): Promise<Response> {
  const guard = await guardBriefRequest(request, IdeasBodySchema, getIdeasRateLimiter(), 'ideas');
  if (!guard.ok) return guard.response;
  const { body, userId, workspaceId, anthropic } = guard;
  const requestId = globalThis.crypto.randomUUID();
  const timer = startAiCallTimer();
  let usage = emptyBriefUsage();
  let status: AiCallStatus = 'ok';
  let errorCode: string | undefined;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(IDEAS_TIMEOUT_MS)]);
    const outcome = await generateIdeas(body, { anthropic, signal });
    usage = outcome.usage;
    if (!outcome.ok) {
      errorCode = outcome.error.code;
      status = logStatusFor(outcome.error.code);
      const { code, message, retryAfterSec } = outcome.error;
      const res = jsonError(code, message, statusForBriefError(code), retryAfterSec ? { retryAfterSec } : undefined);
      if (retryAfterSec) res.headers.set('retry-after', String(retryAfterSec));
      return res;
    }
    const payload: IdeasResponse = { ideas: outcome.ideas };
    return Response.json(payload);
  } finally {
    guard.release();
    recordUsage({
      sessionId: userId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedReadTokens: usage.cacheReadTokens,
      cachedWriteTokens: usage.cacheWriteTokens,
    });
    logAiCall({
      requestId,
      sessionId: `page-ideas:${workspaceId}`,
      userId,
      model: IDEAS_MODEL,
      promptChars: JSON.stringify(body).length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedReadTokens: usage.cacheReadTokens,
      cachedWriteTokens: usage.cacheWriteTokens,
      latencyMs: timer.latencyMs(),
      status,
      errorCode,
    });
  }
}

// An auth-brain outage answers JSON 503 `auth_unavailable`, an OpenFGA failure
// JSON 503 `authz_unavailable` (src/lib/authBrainAvailability.ts).
export const POST = withAuthAvailability(handlePOST);
