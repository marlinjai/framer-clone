// src/server/uploads/rateLimit.ts
//
// A per-user limit on image uploads (site images: the favicon and sharing
// images), the editor's sibling of the public form limiter
// (src/server/forms/rateLimit.ts, whose sliding window it reuses). Every
// upload attempt counts, before the body is read, so a script with a valid
// session cannot fill the database or keep the server hashing at full speed;
// a person uploading and retrying a few files never meets it.
//
// Process-local and bounded like the form limiter: one container today, a
// restart forgets the windows, and the user id is only a key of the map.

import { jsonError } from '@/lib/api/respond';
import { SlidingWindow, type LimitResult, type WindowLimit } from '@/server/forms/rateLimit';

/** Upload attempts one user may make per window, per kind of upload. */
export const UPLOAD_RATE_LIMIT: WindowLimit = { max: 30, windowMs: 10 * 60_000 };

export interface UploadRateLimiter {
  /** One upload attempt by `userId` to `area` (for example `site-images`), recorded. */
  hit(area: string, userId: string, now: number): LimitResult;
}

export function createUploadRateLimiter(limit: WindowLimit = UPLOAD_RATE_LIMIT): UploadRateLimiter {
  const window = new SlidingWindow(limit);
  return { hit: (area, userId, now) => window.hit(`${area}:${userId}`, now) };
}

let _limiter: UploadRateLimiter | null = null;

export function getUploadRateLimiter(): UploadRateLimiter {
  if (!_limiter) _limiter = createUploadRateLimiter();
  return _limiter;
}

/** Test-only: start from empty windows. */
export function __resetUploadRateLimiterForTests(): void {
  _limiter = null;
}

/** The 429 for an upload over the limit, with Retry-After and the next step. */
export function uploadRateLimitedResponse(retryAfterSec: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const response = jsonError(
    'rate_limited',
    `Too many uploads in a short time. Wait about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, then upload the file again.`,
    429,
    { retryAfterSec },
  );
  response.headers.set('retry-after', String(retryAfterSec));
  return response;
}
