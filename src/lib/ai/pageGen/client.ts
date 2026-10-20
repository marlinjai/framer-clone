// src/lib/ai/pageGen/client.ts
//
// Browser transport for POST /api/ai/generate-page: POST + ReadableStream
// reader + parseSseFrames (the same pattern as cmsAgentClient). Every failure
// path ends in exactly one onError call (HTTP error envelope, network error, a
// stream that closes without a result), so the dialog never stalls silently.
// Injectable into the dialog for tests.

import { parseSseFrames } from '@/lib/ai/parseSse';
import type {
  PageGenErrorPayload,
  PageGenProgress,
  PageGenRequest,
  PageGenResultPayload,
  PageGenUsagePayload,
} from './protocol';

export interface PageGenHandlers {
  onProgress?: (p: PageGenProgress) => void;
  onResult?: (r: PageGenResultPayload) => void;
  onError?: (e: PageGenErrorPayload) => void;
  onUsage?: (u: PageGenUsagePayload) => void;
}

export type PageGenTransport = (
  req: PageGenRequest,
  handlers: PageGenHandlers,
  signal?: AbortSignal,
) => Promise<void>;

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError';
}

export const fetchPageGenTransport: PageGenTransport = async (req, handlers, signal) => {
  let response: Response;
  try {
    response = await fetch('/api/ai/generate-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    handlers.onError?.(
      isAbort(err)
        ? { code: 'aborted', message: 'Generation was cancelled.' }
        : { code: 'network_error', message: 'Could not reach the server. Check your connection and try again.' },
    );
    return;
  }

  if (!response.ok || !response.body) {
    let payload: PageGenErrorPayload = { code: 'http_error', message: `Request failed (${response.status}).` };
    try {
      const body = (await response.json()) as { error?: Partial<PageGenErrorPayload> };
      if (body.error?.message) {
        payload = {
          code: body.error.code ?? 'http_error',
          message: body.error.message,
          ...(typeof body.error.retryAfterSec === 'number' ? { retryAfterSec: body.error.retryAfterSec } : {}),
        };
      }
    } catch {
      // non-JSON body: keep the status message
    }
    handlers.onError?.(payload);
    return;
  }

  let settled = false;
  const dispatch = (event: string, data: string): void => {
    let payload: unknown;
    try {
      payload = data ? JSON.parse(data) : {};
    } catch {
      return;
    }
    switch (event) {
      case 'gen:progress':
        handlers.onProgress?.(payload as PageGenProgress);
        return;
      case 'gen:result':
        settled = true;
        handlers.onResult?.(payload as PageGenResultPayload);
        return;
      case 'gen:error':
        settled = true;
        handlers.onError?.(payload as PageGenErrorPayload);
        return;
      case 'usage':
        handlers.onUsage?.(payload as PageGenUsagePayload);
        return;
      default:
        return;
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value) {
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const f of parsed.frames) dispatch(f.event, f.data);
      }
      if (chunk.done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const f of parseSseFrames(`${buffer}\n\n`).frames) dispatch(f.event, f.data);
    }
  } catch (err) {
    if (!settled) {
      settled = true;
      handlers.onError?.(
        isAbort(err)
          ? { code: 'aborted', message: 'Generation was cancelled.' }
          : { code: 'network_error', message: 'The connection dropped during generation. Try again.' },
      );
    }
    return;
  }
  if (!settled) {
    handlers.onError?.({ code: 'network_error', message: 'The server closed the connection without a result. Try again.' });
  }
};
