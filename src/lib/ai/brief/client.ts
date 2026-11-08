// src/lib/ai/brief/client.ts
//
// Browser side of the two brief helpers of the Generate dialog:
//   - fetchIdeas: POST /api/ai/page-ideas (JSON),
//   - enhance: POST /api/ai/enhance-brief, read as a Server-Sent Events (SSE)
//     stream; each delta goes to `onDelta` as it arrives.
//
// Every failure ends in one `{ ok: false, error }` with a message a person can
// act on: an HTTP error (429 with its wait time), the network, an error event,
// and a stream that ended without its `enhance:done` (cut off midway). Nothing
// throws. Injectable into the dialog (BriefApi) for tests.

import { parseSseFrames } from '@/lib/ai/parseSse';
import {
  ENHANCE_EVENTS,
  type BriefErrorPayload,
  type EnhanceRequest,
  type IdeasRequest,
  type IdeasResponse,
  type PageIdea,
} from './schema';

export type BriefResult<T> = { ok: true; value: T } | { ok: false; error: BriefErrorPayload };

export interface BriefApi {
  fetchIdeas(req: IdeasRequest, signal?: AbortSignal): Promise<BriefResult<PageIdea[]>>;
  enhance(req: EnhanceRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<BriefResult<string>>;
}

const ABORTED: BriefErrorPayload = { code: 'aborted', message: 'Stopped.' };

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && err.name === 'AbortError');
}

/** The error a non-2xx response carries, with the wait time of a 429. */
export async function errorFromResponse(res: Response): Promise<BriefErrorPayload> {
  let code = `http_${res.status}`;
  let message = `The server answered ${res.status}.`;
  let retryAfterSec: number | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown; retryAfterSec?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.retryAfterSec === 'number') retryAfterSec = body.error.retryAfterSec;
  } catch {
    // not JSON: keep the status
  }
  if (retryAfterSec === undefined) {
    const header = Number(res.headers.get('retry-after'));
    if (Number.isFinite(header) && header > 0) retryAfterSec = header;
  }
  return { code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) };
}

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
}

const UNREACHABLE: BriefErrorPayload = {
  code: 'network_error',
  message: 'Could not reach the server. Check your connection and try again.',
};

export async function fetchIdeas(req: IdeasRequest, signal?: AbortSignal): Promise<BriefResult<PageIdea[]>> {
  let res: Response;
  try {
    res = await post('/api/ai/page-ideas', req, signal);
  } catch (err) {
    return { ok: false, error: isAbort(err, signal) ? ABORTED : UNREACHABLE };
  }
  if (!res.ok) return { ok: false, error: await errorFromResponse(res) };
  try {
    const body = (await res.json()) as IdeasResponse;
    if (!Array.isArray(body.ideas)) throw new Error('no ideas');
    return { ok: true, value: body.ideas };
  } catch (err) {
    if (isAbort(err, signal)) return { ok: false, error: ABORTED };
    return { ok: false, error: { code: 'bad_response', message: 'The server sent ideas the editor cannot read.' } };
  }
}

export const STREAM_INTERRUPTED: BriefErrorPayload = {
  code: 'stream_interrupted',
  message: 'The connection dropped while the brief was being rewritten.',
};

export async function enhance(
  req: EnhanceRequest,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<BriefResult<string>> {
  let res: Response;
  try {
    res = await post('/api/ai/enhance-brief', req, signal);
  } catch (err) {
    return { ok: false, error: isAbort(err, signal) ? ABORTED : UNREACHABLE };
  }
  if (!res.ok) return { ok: false, error: await errorFromResponse(res) };
  if (!res.body) return { ok: false, error: STREAM_INTERRUPTED };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const { frames, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        let data: unknown;
        try {
          data = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const d = data as { text?: unknown; code?: unknown; message?: unknown; retryAfterSec?: unknown };
        if (frame.event === ENHANCE_EVENTS.delta && typeof d.text === 'string') {
          onDelta(d.text);
        } else if (frame.event === ENHANCE_EVENTS.done && typeof d.text === 'string') {
          void reader.cancel().catch(() => {});
          return { ok: true, value: d.text };
        } else if (frame.event === ENHANCE_EVENTS.error) {
          void reader.cancel().catch(() => {});
          return {
            ok: false,
            error: {
              code: typeof d.code === 'string' ? d.code : 'enhance_failed',
              message: typeof d.message === 'string' ? d.message : 'Enhance failed.',
              ...(typeof d.retryAfterSec === 'number' ? { retryAfterSec: d.retryAfterSec } : {}),
            },
          };
        }
      }
    }
  } catch (err) {
    if (isAbort(err, signal)) return { ok: false, error: ABORTED };
    return { ok: false, error: STREAM_INTERRUPTED };
  }
  // The stream ended without an outcome: cut off midway.
  return { ok: false, error: signal?.aborted ? ABORTED : STREAM_INTERRUPTED };
}

export const fetchBriefApi: BriefApi = { fetchIdeas, enhance };

/** The message the dialog shows for an error, per code. */
export function describeBriefError(error: BriefErrorPayload, what: 'ideas' | 'enhance'): string {
  const subject = what === 'ideas' ? 'Ideas' : 'Enhance';
  switch (error.code) {
    case 'rate_limited':
      return error.retryAfterSec && !/\d+ seconds/.test(error.message)
        ? `${error.message} Try again in ${error.retryAfterSec} seconds.`
        : error.message;
    case 'unauthorized':
      return 'Your session expired. Sign in again.';
    case 'forbidden':
      return 'You are not allowed to edit this site.';
    case 'missing_anthropic_key':
    case 'provider_auth':
      return 'AI is not configured on this server. Ask an administrator.';
    case 'auth_unavailable':
      return 'The sign-in service is unavailable. Try again shortly.';
    case 'authz_unavailable':
      return 'The permission service is unavailable. Try again shortly.';
    case 'overloaded':
      return 'The AI provider is overloaded right now. Try again in a minute.';
    case 'provider_unavailable':
      return 'The AI provider is unavailable right now. Try again shortly.';
    case 'aborted':
      return what === 'ideas' ? 'Ideas took too long to load. Try again.' : 'Stopped.';
    default:
      return error.message || `${subject} failed. Try again.`;
  }
}
