// src/lib/ai/brief/errors.ts
//
// How a brief-helper error code maps to an HTTP status (page-ideas answers
// JSON) and to the AI call log's status. Enhance reports errors inside its
// stream, so only the log status applies there.

import type { AiCallStatus } from '@/lib/ai/aiLogger';

export function statusForBriefError(code: string): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'overloaded':
    case 'provider_unavailable':
      return 503;
    case 'aborted':
      // The client went away or the call timed out.
      return 504;
    default:
      // invalid_output, refused, provider_auth, generation_failed: the
      // upstream answer was unusable.
      return 502;
  }
}

export function logStatusFor(code: string): AiCallStatus {
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'overloaded') return 'overloaded';
  return 'error';
}
