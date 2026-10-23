// src/lib/ai/review/client.ts
//
// Browser transport for POST /api/ai/review-page: POST + ReadableStream reader
// + parseSseFrames, the same pattern as the page generator's transport
// (src/lib/ai/pageGen/client.ts). Every failure path ends in exactly one
// onError call, so the review never stalls silently. Injectable for tests.

import { parseSseFrames } from '@/lib/ai/parseSse';
import type {
  ReviewErrorPayload,
  ReviewProgress,
  ReviewRequest,
  ReviewResultPayload,
  ReviewUsagePayload,
} from './protocol';

export interface ReviewHandlers {
  onProgress?: (p: ReviewProgress) => void;
  onResult?: (r: ReviewResultPayload) => void;
  onError?: (e: ReviewErrorPayload) => void;
  onUsage?: (u: ReviewUsagePayload) => void;
}

export type ReviewTransport = (req: ReviewRequest, handlers: ReviewHandlers, signal?: AbortSignal) => Promise<void>;

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError';
}

export const fetchReviewTransport: ReviewTransport = async (req, handlers, signal) => {
  let response: Response;
  try {
    response = await fetch('/api/ai/review-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    handlers.onError?.(
      isAbort(err)
        ? { code: 'aborted', message: 'The review was cancelled.' }
        : { code: 'network_error', message: 'Could not reach the server for the review.' },
    );
    return;
  }

  if (!response.ok || !response.body) {
    let payload: ReviewErrorPayload = { code: 'http_error', message: `The review request failed (${response.status}).` };
    try {
      const body = (await response.json()) as { error?: Partial<ReviewErrorPayload> };
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
      case 'review:progress':
        handlers.onProgress?.(payload as ReviewProgress);
        return;
      case 'review:result':
        settled = true;
        handlers.onResult?.(payload as ReviewResultPayload);
        return;
      case 'review:error':
        settled = true;
        handlers.onError?.(payload as ReviewErrorPayload);
        return;
      case 'usage':
        handlers.onUsage?.(payload as ReviewUsagePayload);
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
          ? { code: 'aborted', message: 'The review was cancelled.' }
          : { code: 'network_error', message: 'The connection dropped during the review.' },
      );
    }
    return;
  }
  if (!settled) {
    handlers.onError?.({ code: 'network_error', message: 'The server closed the connection without a review result.' });
  }
};
