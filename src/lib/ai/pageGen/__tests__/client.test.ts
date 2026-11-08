// fetchPageGenTransport: every path ends in exactly one result or one error.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPageGenTransport, resumePageGen } from '../client';
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
  return { onProgress: vi.fn(), onSection: vi.fn(), onOutline: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onUsage: vi.fn() };
}

const SECTION = (index: number) => ({ generationId: 'g', index, slot: index, attempt: 1, node: { id: `s${index}`, type: 'section', props: {}, children: [] } });
const OUTLINE = (n: number) => ({ generationId: 'g', attempt: 1, outline: Array.from({ length: n }, (_, i) => ({ title: `S${i}`, kind: 'generic' })) });
const RESULT = 'event: gen:result\ndata: {"generationId":"g","nodes":[],"warnings":[],"stats":{"nodeCount":0,"maxDepth":0},"model":"m"}\n\n';

afterEach(() => vi.unstubAllGlobals());

describe('fetchPageGenTransport', () => {
  it('dispatches preview sections from the stream, before the result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([
        `event: gen:section\ndata: ${JSON.stringify(SECTION(0))}\n\nevent: gen:sec`,
        `tion\ndata: ${JSON.stringify(SECTION(1))}\n\n`,
        'event: gen:result\ndata: {"generationId":"g","nodes":[],"warnings":[],"stats":{"nodeCount":0,"maxDepth":0},"model":"m"}\n\n',
        // A section after the outcome is never delivered.
        `event: gen:section\ndata: ${JSON.stringify(SECTION(2))}\n\n`,
      ]),
    ));
    const h = handlers();
    const order: string[] = [];
    h.onSection.mockImplementation((s: { index: number }) => order.push(`section ${s.index}`));
    h.onResult.mockImplementation(() => order.push('result'));
    await fetchPageGenTransport(req, h);
    expect(order).toEqual(['section 0', 'section 1', 'result']);
  });

  it('resume: rebuilds the sections from the running snapshot, then the result', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      polls += 1;
      if (polls === 1) return Response.json({ status: 'running', sections: [SECTION(0)], progress: { phase: 'generating', receivedChars: 10, attempt: 1 } });
      if (polls === 2) return Response.json({ status: 'running', sections: [SECTION(0), SECTION(1)] });
      return Response.json({ status: 'done', result: { generationId: 'g', nodes: [], warnings: [], stats: { nodeCount: 0, maxDepth: 0 }, model: 'm' } });
    }));
    const h = handlers();
    await resumePageGen('g', h);
    // Every poll sends what the run holds; the caller dedupes by index.
    expect(h.onSection.mock.calls.map(([s]) => (s as { index: number }).index)).toEqual([0, 0, 1]);
    expect(h.onResult).toHaveBeenCalledTimes(1);
  });

  it('dispatches the outline from the stream before the sections, and never after the result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([
        `event: gen:outline\ndata: ${JSON.stringify(OUTLINE(3))}\n\nevent: gen:out`,
        `line\ndata: ${JSON.stringify(OUTLINE(4))}\n\nevent: gen:section\ndata: ${JSON.stringify(SECTION(0))}\n\n`,
        RESULT,
        `event: gen:outline\ndata: ${JSON.stringify(OUTLINE(5))}\n\n`,
      ]),
    ));
    const h = handlers();
    const order: string[] = [];
    h.onOutline.mockImplementation((o: { outline: unknown[] }) => order.push(`outline ${o.outline.length}`));
    h.onSection.mockImplementation((s: { index: number }) => order.push(`section ${s.index}`));
    h.onResult.mockImplementation(() => order.push('result'));
    await fetchPageGenTransport(req, h);
    expect(order).toEqual(['outline 3', 'outline 4', 'section 0', 'result']);
  });

  it('resume: every poll hands back the latest outline with the sections', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      polls += 1;
      if (polls === 1) return Response.json({ status: 'running', outline: OUTLINE(4) });
      if (polls === 2) return Response.json({ status: 'running', outline: OUTLINE(4), sections: [SECTION(0)] });
      return Response.json({ status: 'done', result: { generationId: 'g', nodes: [], warnings: [], stats: { nodeCount: 0, maxDepth: 0 }, model: 'm' } });
    }));
    const h = handlers();
    await resumePageGen('g', h);
    expect(h.onOutline).toHaveBeenCalledTimes(2);
    expect(h.onSection).toHaveBeenCalledTimes(1);
    expect(h.onResult).toHaveBeenCalledTimes(1);
  });

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
    // The transport collects the run by id; this server no longer has it.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? streamResponse(['event: gen:progress\ndata: {}\n\n'])
        : Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 }),
    ));
    const h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'run_gone' }));
  });

  it('a network failure and an abort are told apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    let h = handlers();
    await fetchPageGenTransport(req, h);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'network_error' }));

    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));
    h = handlers();
    await fetchPageGenTransport(req, h, controller.signal);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'aborted' }));
  });
});
