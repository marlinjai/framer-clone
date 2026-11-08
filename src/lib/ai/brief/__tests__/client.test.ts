// The browser client of the brief helpers (../client.ts) against a fake fetch:
// every failure ends in one { ok: false } with a usable message.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeBriefError, enhance, fetchIdeas } from '../client';

const enc = new TextEncoder();

function sseResponse(chunks: string[], opts: { error?: unknown } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (opts.error) controller.error(opts.error);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function mockFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const REQ = { targetKind: 'newPage' as const, brief: 'bakery' };

describe('enhance client', () => {
  it('forwards each delta, also when a frame is split across chunks, and returns the done text', async () => {
    const full = frame('enhance:delta', { text: 'A ' }) + frame('enhance:delta', { text: 'bakery' }) + frame('enhance:done', { text: 'A bakery' });
    const fetchFn = mockFetch(async () => sseResponse([full.slice(0, 17), full.slice(17, 50), full.slice(50)]));
    const deltas: string[] = [];
    const out = await enhance(REQ, (d) => deltas.push(d));
    expect(deltas).toEqual(['A ', 'bakery']);
    expect(out).toEqual({ ok: true, value: 'A bakery' });
    expect(fetchFn).toHaveBeenCalledWith('/api/ai/enhance-brief', expect.objectContaining({ method: 'POST' }));
  });

  it('a stream that ends without enhance:done (cut off midway) is stream_interrupted', async () => {
    mockFetch(async () => sseResponse([frame('enhance:delta', { text: 'A half' })]));
    const out = await enhance(REQ, () => {});
    expect(out).toMatchObject({ ok: false, error: { code: 'stream_interrupted' } });
  });

  it('a stream that errors midway is stream_interrupted', async () => {
    mockFetch(async () => sseResponse([frame('enhance:delta', { text: 'A half' })], { error: new TypeError('network') }));
    const out = await enhance(REQ, () => {});
    expect(out).toMatchObject({ ok: false, error: { code: 'stream_interrupted' } });
  });

  it('an enhance:error event carries its code and message', async () => {
    mockFetch(async () => sseResponse([frame('enhance:error', { code: 'overloaded', message: 'busy' })]));
    const out = await enhance(REQ, () => {});
    expect(out).toEqual({ ok: false, error: { code: 'overloaded', message: 'busy' } });
  });

  it('a 429 carries the wait time; a network failure and an abort are told apart', async () => {
    mockFetch(async () =>
      Response.json({ error: { code: 'rate_limited', message: 'Enhance limit reached. Try again in 42 seconds.', retryAfterSec: 42 } }, { status: 429 }),
    );
    let out = await enhance(REQ, () => {});
    expect(out).toMatchObject({ ok: false, error: { code: 'rate_limited', retryAfterSec: 42 } });

    mockFetch(async () => Promise.reject(new TypeError('Failed to fetch')));
    out = await enhance(REQ, () => {});
    expect(out).toMatchObject({ ok: false, error: { code: 'network_error' } });

    const controller = new AbortController();
    controller.abort();
    mockFetch(async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    out = await enhance(REQ, () => {}, controller.signal);
    expect(out).toMatchObject({ ok: false, error: { code: 'aborted' } });
  });

  it('reads the wait from the retry-after header when the body has none', async () => {
    mockFetch(async () => new Response('busy', { status: 429, headers: { 'retry-after': '17' } }));
    const out = await enhance(REQ, () => {});
    expect(out).toMatchObject({ ok: false, error: { code: 'http_429', retryAfterSec: 17 } });
  });
});

describe('fetchIdeas client', () => {
  it('returns the ideas, and an error body as an error', async () => {
    mockFetch(async () => Response.json({ ideas: [{ title: 'Pricing', brief: 'Three plans.' }] }));
    expect(await fetchIdeas({ targetKind: 'newPage' })).toEqual({ ok: true, value: [{ title: 'Pricing', brief: 'Three plans.' }] });
    mockFetch(async () => Response.json({ error: { code: 'invalid_output', message: 'nope' } }, { status: 502 }));
    expect(await fetchIdeas({ targetKind: 'newPage' })).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
    mockFetch(async () => Response.json({ nothing: true }));
    expect(await fetchIdeas({ targetKind: 'newPage' })).toMatchObject({ ok: false, error: { code: 'bad_response' } });
  });
});

describe('describeBriefError', () => {
  it('adds the wait time to a rate limit only when the message lacks it', () => {
    expect(describeBriefError({ code: 'rate_limited', message: 'Slow down.', retryAfterSec: 30 }, 'enhance')).toBe(
      'Slow down. Try again in 30 seconds.',
    );
    expect(
      describeBriefError({ code: 'rate_limited', message: 'Try again in 30 seconds.', retryAfterSec: 30 }, 'enhance'),
    ).toBe('Try again in 30 seconds.');
    expect(describeBriefError({ code: 'unauthorized', message: 'x' }, 'ideas')).toBe('Your session expired. Sign in again.');
  });
});
