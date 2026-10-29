// The resumable transport: a dropped stream or a tab coming back to the
// foreground switches to collecting the run by id; the user's cancel stops the
// run on the server, a detach does not; every path ends in one outcome.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResumableRun, DETACH } from '../resumableRun';

const enc = new TextEncoder();

/** An SSE response whose stream the test feeds and breaks by hand. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => controller.close(),
    fail: () => controller.error(new TypeError('The network connection was lost.')),
  };
}

function setup(responses: Record<string, Array<() => Response | Promise<Response>>>) {
  const calls: Array<{ url: string; method: string; keepalive?: boolean }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, keepalive: init.keepalive });
    const queue = responses[`${method} ${url}`];
    const next = queue?.length ? queue.length > 1 ? queue.shift()! : queue[0] : undefined;
    if (!next) throw new TypeError('Failed to fetch');
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return next();
  });
  const run = createResumableRun<{ brief: string }, { phase: string }, { page: string }, { code: string; message: string }, unknown>({
    url: '/api/run',
    events: { started: 'x:started', progress: 'x:progress', result: 'x:result', error: 'x:error' },
    messages: {
      cancelled: 'cancelled',
      unreachable: 'unreachable',
      dropped: 'dropped',
      closedWithoutResult: 'closed',
      gone: 'gone',
      cancelledElsewhere: 'cancelled elsewhere',
    },
    pollIntervalMs: 1,
    maxPollFailures: 3,
    fetch: fetchMock as unknown as typeof fetch,
  });
  const handlers = { onStarted: vi.fn(), onProgress: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onUsage: vi.fn() };
  return { run, calls, handlers };
}

const json = (body: unknown, status = 200) => () => Response.json(body, { status });

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('createResumableRun', () => {
  it('a stream that dies after the id was announced is collected by id', async () => {
    const live = liveStream();
    const { run, calls, handlers } = setup({
      'POST /api/run': [() => live.response],
      'GET /api/run/r1': [json({ status: 'running', progress: { phase: 'images' } }), json({ status: 'done', result: { page: 'p' } })],
    });
    const done = run.start({ brief: 'b' }, handlers);
    live.send('x:started', { generationId: 'r1' });
    live.send('x:progress', { phase: 'generating' });
    await vi.waitFor(() => expect(handlers.onProgress).toHaveBeenCalledTimes(1));
    live.fail();
    await done;
    expect(handlers.onStarted).toHaveBeenCalledWith('r1');
    expect(handlers.onProgress).toHaveBeenLastCalledWith({ phase: 'images' });
    expect(handlers.onResult).toHaveBeenCalledWith({ page: 'p' });
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('coming back to the foreground stops waiting on the stream and collects the run', async () => {
    const live = liveStream();
    const { run, handlers } = setup({
      'POST /api/run': [() => live.response],
      'GET /api/run/r1': [json({ status: 'done', result: { page: 'p' } })],
    });
    const done = run.start({ brief: 'b' }, handlers);
    live.send('x:started', { generationId: 'r1' });
    await vi.waitFor(() => expect(handlers.onStarted).toHaveBeenCalled());
    // The stream hangs without erroring (iOS): the tab becoming visible moves on.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await done;
    expect(handlers.onResult).toHaveBeenCalledWith({ page: 'p' });
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('a result on the stream settles once; nothing is collected', async () => {
    const live = liveStream();
    const { run, calls, handlers } = setup({ 'POST /api/run': [() => live.response] });
    const done = run.start({ brief: 'b' }, handlers);
    live.send('x:started', { generationId: 'r1' });
    live.send('x:result', { page: 'p' });
    live.send('usage', { tokens: 1 });
    live.close();
    await done;
    expect(handlers.onResult).toHaveBeenCalledTimes(1);
    expect(handlers.onUsage).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  it('a stream lost before the id was announced is a plain network error', async () => {
    const live = liveStream();
    const { run, handlers } = setup({ 'POST /api/run': [() => live.response] });
    const done = run.start({ brief: 'b' }, handlers);
    live.fail();
    await done;
    expect(handlers.onError).toHaveBeenCalledWith({ code: 'network_error', message: 'dropped' });
  });

  it('the user cancelling stops the run on the server (keepalive DELETE); a detach does not', async () => {
    for (const [reason, expectDelete] of [[undefined, true], [DETACH, false]] as const) {
      const live = liveStream();
      const { run, calls, handlers } = setup({
        'POST /api/run': [() => live.response],
        'DELETE /api/run/r1': [() => new Response(null, { status: 204 })],
      });
      const controller = new AbortController();
      const done = run.start({ brief: 'b' }, handlers, controller.signal);
      live.send('x:started', { generationId: 'r1' });
      await vi.waitFor(() => expect(handlers.onStarted).toHaveBeenCalled());
      controller.abort(reason);
      await done;
      const del = calls.find((c) => c.method === 'DELETE');
      expect(!!del).toBe(expectDelete);
      if (del) expect(del.keepalive).toBe(true);
      expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'aborted' }));
      expect(handlers.onResult).not.toHaveBeenCalled();
    }
  });

  it('resume: a run the server no longer has is one actionable error', async () => {
    const { run, handlers } = setup({ 'GET /api/run/r1': [json({ error: { code: 'not_found', message: 'x' } }, 404)] });
    await run.resume('r1', handlers);
    expect(handlers.onError).toHaveBeenCalledWith({ code: 'run_gone', message: 'gone' });
  });

  it('resume: a failed run reports its own error; a run cancelled elsewhere says so', async () => {
    let s = setup({ 'GET /api/run/r1': [json({ status: 'failed', error: { code: 'invalid_output', message: 'bad' } })] });
    await s.run.resume('r1', s.handlers);
    expect(s.handlers.onError).toHaveBeenCalledWith({ code: 'invalid_output', message: 'bad' });
    s = setup({ 'GET /api/run/r1': [json({ status: 'cancelled' })] });
    await s.run.resume('r1', s.handlers);
    expect(s.handlers.onError).toHaveBeenCalledWith({ code: 'cancelled', message: 'cancelled elsewhere' });
  });

  it('resume: rides out a short outage, then gives up with one error', async () => {
    let s = setup({
      'GET /api/run/r1': [() => new Response('bad gateway', { status: 502 }), json({ status: 'done', result: { page: 'p' } })],
    });
    await s.run.resume('r1', s.handlers);
    expect(s.handlers.onResult).toHaveBeenCalledWith({ page: 'p' });

    s = setup({ 'GET /api/run/r1': [() => new Response('bad gateway', { status: 502 })] });
    await s.run.resume('r1', s.handlers);
    expect(s.handlers.onError).toHaveBeenCalledTimes(1);
    expect(s.handlers.onError).toHaveBeenCalledWith({ code: 'network_error', message: 'dropped' });
  });

  it('resume: waits while the tab is hidden, then collects', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { run, calls, handlers } = setup({ 'GET /api/run/r1': [json({ status: 'done', result: { page: 'p' } })] });
    const done = run.resume('r1', handlers);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await done;
    expect(handlers.onResult).toHaveBeenCalledWith({ page: 'p' });
  });

  it('resume: the user cancelling stops the run on the server', async () => {
    const { run, calls, handlers } = setup({
      'GET /api/run/r1': [json({ status: 'running' })],
      'DELETE /api/run/r1': [() => new Response(null, { status: 204 })],
    });
    const controller = new AbortController();
    const done = run.resume('r1', handlers, controller.signal);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    controller.abort();
    await done;
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'aborted' }));
  });
});
