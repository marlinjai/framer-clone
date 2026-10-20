// src/lib/ai/pageGen/providerError.ts
//
// Map an Anthropic SDK failure to a page-generation error code and a message a
// user can act on. Duck-typed on `status` / `name` (like the edit route), so it
// also classifies the SDK's typed errors without importing them.

import type { PageGenErrorPayload } from './protocol';

export function classifyProviderError(err: unknown): PageGenErrorPayload {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'AbortError' || name === 'APIUserAbortError') {
    return { code: 'aborted', message: 'Generation was cancelled.' };
  }
  const status =
    err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : undefined;
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: 'The AI provider is rate limiting requests right now. Try again in a minute.',
      retryAfterSec: 60,
    };
  }
  if (status === 529 || status === 503) {
    return { code: 'overloaded', message: 'The AI provider is overloaded right now. Try again in a minute.' };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'provider_auth',
      message: 'The AI provider rejected the server credentials. An administrator has to fix the configuration.',
    };
  }
  if (status !== undefined && status >= 500) {
    return { code: 'provider_unavailable', message: `The AI provider failed (${status}). Try again shortly.` };
  }
  if (status !== undefined) {
    return { code: 'generation_failed', message: `The AI provider refused the request (${status}).` };
  }
  return {
    code: 'provider_unavailable',
    message: 'Could not reach the AI provider. Try again shortly.',
  };
}
