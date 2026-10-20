// fetchPageGenTransport: every path ends in exactly one result or one error.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPageGenTransport } from '../client';
import type { PageGenRequest } from '../protocol';

const req: PageGenRequest = {
  brief: 'x',
  breakpoints: [{ label: 'Desktop', minWidth: 1280 }],
  target: { kind: 'newPage' },
};

function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function handlers() {
  return { onProgress: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onUsage: vi.fn() };
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchPageGenTransport', () => {
  it('dispatches progress, result and usage across split chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([
        'event: gen:progress\ndata: {"phase":"generating","receivedChars":0,"attempt":1}\n\n: heartbeat\n\nevent: gen:res',
        'ult\ndata: {"generationId":"g","nodes":[],"warnings":[],"stats":{"nodeCount":0,"maxDepth":0},"model":"m"}\n\n',
        'event: usage\ndata: {"inputTokens":1,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"attempts":1}\n\n',
      ]),
    ));
    const h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onProgress).toHaveBeenCalledTimes(1);
    expect(h.onResult).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'g' }));
    expect(h.onUsage).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('surfaces the JSON error envelope of a guarded failure with its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ error: { code: 'rate_limited', message: 'Wait 30 seconds.', retryAfterSec: 30 } }, { status: 429 }),
    ));
    const h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledWith({ code: 'rate_limited', message: 'Wait 30 seconds.', retryAfterSec: 30 });
  });

  it('a non-JSON error body still errors with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    const h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledWith({ code: 'http_error', message: 'Request failed (502).' });
  });

  it('a stream that closes without a result is an error, never a silent stall', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['event: gen:progress\ndata: {}\n\n'])));
    const h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'network_error' }));
  });

  it('a network failure and an abort are told apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    let h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'network_error' }));

    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'aborted' }));
  });
});
