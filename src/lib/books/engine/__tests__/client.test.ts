// src/lib/books/engine/__tests__/client.test.ts
//
// The page side of the browser's draft render (client.ts) with a fake worker:
// answers reach the request they belong to, a cancelled render rejects at once
// with `aborted` and its late answer is dropped, a worker that dies rejects
// everything in flight with `worker_failed` and the next render starts a fresh
// one, a browser without workers gets `worker_unsupported`, a worker's error
// arrives as the same coded error, and the render input route's error
// envelope reaches the caller as `render_input_failed` with the server's code.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserRenderError } from '../errors';
import { DraftRenderer, fetchRenderInput, renderDraftInBrowser, disposeBrowserRenderer, type WorkerLike } from '../client';
import type { RenderInputPayload } from '../payload';
import type { WorkerRequest, WorkerResponse } from '../protocol';

class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  postMessage(m: WorkerRequest) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  answer(m: WorkerResponse) {
    this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
  }
}

const PAYLOAD = { format: 1 } as unknown as RenderInputPayload;
const LAYOUT = { page: { width: 1, height: 1 }, pageCount: 1, blocks: [], tables: [], issues: [] };

function renderer() {
  const workers: FakeWorker[] = [];
  const r = new DraftRenderer(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { r, workers };
}

async function rejection(p: Promise<unknown>): Promise<BrowserRenderError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BrowserRenderError);
  return e as BrowserRenderError;
}

afterEach(() => {
  vi.unstubAllGlobals();
  disposeBrowserRenderer();
});

describe('DraftRenderer', () => {
  it('answers each render with its own result, in one worker', async () => {
    const { r, workers } = renderer();
    const a = r.render(PAYLOAD);
    const b = r.render(PAYLOAD);
    expect(workers).toHaveLength(1);
    const [ra, rb] = workers[0].sent as Array<Extract<WorkerRequest, { type: 'render' }>>;
    workers[0].answer({ type: 'rendered', id: rb.id, bytes: new Uint8Array([2]).buffer, layout: LAYOUT, renderMs: 5 });
    workers[0].answer({ type: 'rendered', id: ra.id, bytes: new Uint8Array([1]).buffer, layout: LAYOUT, renderMs: 4 });
    expect([...(await a).bytes]).toEqual([1]);
    expect([...(await b).bytes]).toEqual([2]);
    expect((await b).renderMs).toBe(5);
  });

  it('a cancelled render rejects with aborted at once, tells the worker, and drops the late answer', async () => {
    const { r, workers } = renderer();
    const ctl = new AbortController();
    const p = r.render(PAYLOAD, { signal: ctl.signal });
    const id = (workers[0].sent[0] as { id: number }).id;
    ctl.abort();
    expect((await rejection(p)).code).toBe('aborted');
    expect(workers[0].sent[1]).toEqual({ type: 'cancel', id });
    workers[0].answer({ type: 'rendered', id, bytes: new ArrayBuffer(1), layout: LAYOUT, renderMs: 1 });
    // An already aborted signal never reaches the worker.
    const done = new AbortController();
    done.abort();
    expect((await rejection(r.render(PAYLOAD, { signal: done.signal }))).code).toBe('aborted');
    expect(workers[0].sent).toHaveLength(2);
  });

  it('a worker error rejects everything in flight, and the next render starts a fresh worker', async () => {
    const { r, workers } = renderer();
    const a = r.render(PAYLOAD);
    const b = r.render(PAYLOAD);
    workers[0].onerror?.({ message: 'boom', preventDefault() {} } as unknown as ErrorEvent);
    expect((await rejection(a)).code).toBe('worker_failed');
    expect((await rejection(b)).code).toBe('worker_failed');
    expect(workers[0].terminated).toBe(true);
    const c = r.render(PAYLOAD);
    expect(workers).toHaveLength(2);
    const id = (workers[1].sent[0] as { id: number }).id;
    workers[1].answer({ type: 'rendered', id, bytes: new ArrayBuffer(0), layout: LAYOUT, renderMs: 1 });
    await expect(c).resolves.toBeTruthy();
  });

  it('a failure in the worker arrives as the same coded error', async () => {
    const { r, workers } = renderer();
    const p = r.render(PAYLOAD);
    const id = (workers[0].sent[0] as { id: number }).id;
    workers[0].answer({ type: 'failed', id, error: { code: 'font_hash_mismatch', message: 'not the pinned file', details: { file: 'x' } } });
    const e = await rejection(p);
    expect(e.code).toBe('font_hash_mismatch');
    expect(e.details).toEqual({ file: 'x' });
  });

  it('dispose rejects what is in flight with worker_failed', async () => {
    const { r, workers } = renderer();
    const p = r.render(PAYLOAD);
    r.dispose();
    expect((await rejection(p)).code).toBe('worker_failed');
    expect(workers[0].terminated).toBe(true);
  });
});

describe('renderDraftInBrowser', () => {
  it('without Web Workers: worker_unsupported', async () => {
    vi.stubGlobal('Worker', undefined);
    expect((await rejection(renderDraftInBrowser(PAYLOAD))).code).toBe('worker_unsupported');
  });
});

describe('fetchRenderInput', () => {
  it("the route's error reaches the caller with its code", async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'not_renderable', message: 'only a draft' } }, { status: 409 }));
    const e = await rejection(fetchRenderInput('doc-1'));
    expect(e.code).toBe('render_input_failed');
    expect(e.details).toEqual({ status: 409, code: 'not_renderable' });
    expect(e.message).toBe('only a draft');
  });

  it('a network failure: render_input_failed; an abort: aborted', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await rejection(fetchRenderInput('doc-1'))).code).toBe('render_input_failed');
    const ctl = new AbortController();
    ctl.abort();
    expect((await rejection(fetchRenderInput('doc-1', { signal: ctl.signal }))).code).toBe('aborted');
  });

  it('a malformed answer: invalid_input', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ format: 99 }));
    expect((await rejection(fetchRenderInput('doc-1'))).code).toBe('invalid_input');
  });
});
