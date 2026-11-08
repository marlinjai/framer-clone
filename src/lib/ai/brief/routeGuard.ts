// src/lib/ai/brief/routeGuard.ts
//
// The guard chain of the two brief routes (page-ideas, enhance-brief), the
// same boundary as POST /api/ai/generate-page: a zod body, getVerifiedSession,
// resolveActiveScope, authenticateRequest(..., 'editSite'), the Anthropic
// client (fast-fail on a missing key) and the per-user rate limit, in that
// order, so nothing reaches the model before every check passed. Reads the
// cookies off the Request (never next/headers). Server-only.
//
// The routes wrap their handler in withAuthAvailability, which turns an
// auth-brain or OpenFGA outage into a JSON 503, never a 401 or 403.

import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { jsonError } from '@/lib/api/respond';
import { getAnthropicClient, MissingAnthropicKeyError } from '@/lib/ai/anthropicClient';
import type { PageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { rateLimitMessage } from './rateLimit';
import { contextFits } from './schema';
import { boundedText } from '@/server/books/http/boundedBody';

/** Largest brief request body. A valid one (brief, context and titles at their caps) is well under 128 KB. */
const BRIEF_BODY_MAX_BYTES = 256 * 1024;

export interface BriefGuardPass<T> {
  ok: true;
  body: T;
  userId: string;
  workspaceId: string;
  anthropic: Anthropic;
  /** Frees the user's in-flight slot (a no-op for a window-only limiter). Call when the call ended. */
  release: () => void;
}

export async function guardBriefRequest<S extends z.ZodType<{ targetKind: string; context?: unknown }>>(
  request: Request,
  schema: S,
  limiter: PageGenRateLimiter,
  what: 'ideas' | 'enhance',
): Promise<BriefGuardPass<z.infer<S>> | { ok: false; response: Response }> {
  const deny = (response: Response) => ({ ok: false as const, response });

  // ---- 1. Parse + validate body ------------------------------------------
  // Read as a stream with a limit: request.json() would buffer a body of any size.
  const text = await boundedText(request, BRIEF_BODY_MAX_BYTES);
  if (text === null) return deny(jsonError('body_too_large', 'the request body is too large', 413));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return deny(jsonError('bad_json', 'invalid JSON body', 400));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return deny(jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues }));
  }
  const body = parsed.data as z.infer<S>;
  if (!contextFits(body.context)) {
    return deny(jsonError('context_too_large', 'the selected component is too large to send as context', 400));
  }

  // ---- 2. Auth at the boundary -------------------------------------------
  const session = await getVerifiedSession(request);
  if (!session) return deny(jsonError('unauthorized', 'authentication required', 401));
  const scopeResult = resolveActiveScope(session, readCompanySelectors(request));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return deny(jsonError(denial.code, denial.message, 403));
  }
  const workspaceId = scopeResult.scope.workspaceId;
  const auth = await authenticateRequest(request, workspaceId, 'editSite');
  if (!auth.authenticated) {
    return deny(jsonError(auth.status === 401 ? 'unauthorized' : 'forbidden', auth.error, auth.status));
  }

  // ---- 3. Anthropic client -----------------------------------------------
  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (e) {
    if (e instanceof MissingAnthropicKeyError) return deny(jsonError(e.code, e.message, 401));
    throw e;
  }

  // ---- 4. Per-user budget ------------------------------------------------
  const slot = limiter.acquire(auth.userId);
  if (!slot.ok) {
    const res = jsonError('rate_limited', rateLimitMessage(what, slot.reason, slot.retryAfterSec), 429, {
      retryAfterSec: slot.retryAfterSec,
    });
    res.headers.set('retry-after', String(slot.retryAfterSec));
    return deny(res);
  }

  return { ok: true, body, userId: auth.userId, workspaceId, anthropic, release: slot.release };
}
