// @vitest-environment node
// src/lib/books/engine/__tests__/worker.test.ts
//
// The draft render worker's plumbing (render.worker.ts), with the drawing
// replaced: requests run one at a time in order; a render cancelled before it
// starts is skipped (never drawn, never answered); a cancel that comes after
// its render started changes nothing (the page side drops the answer); a
// failure is answered as a coded error; the bytes are transferred.

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { BrowserRenderError } from '../errors';
import type { WorkerRequest, WorkerResponse } from '../protocol';

const drawn: number[] = [];
const gates = new Map<number, () => void>();

vi.mock('../render', () => ({
  renderDraftPayload: async (_f: unknown, payload: { documentVersion: number }) => {
    const n = payload.documentVersion;
    drawn.push(n);
    if (n === 99) throw new BrowserRenderError('font_hash_mismatch', 'not the pinned file', { file: 'x' });
    await new Promise<void>((resolve) => gates.set(n, resolve));
    return { bytes: new Uint8Array([n]), layout: { pageCount: 1 } };
  },
}));

const posted: Array<{ msg: WorkerResponse; transfer?: Transferable[] }> = [];
const fakeSelf = {
  location: { origin: 'http://localhost:3000' },
  onmessage: null as ((e: { data: WorkerRequest }) => void) | null,
  postMessage(msg: WorkerResponse, transfer?: Transferable[]) {
    posted.push({ msg, transfer });
  },
};

beforeAll(async () => {
  vi.stubGlobal('self', fakeSelf);
  await import('../render.worker');
});

const send = (m: WorkerRequest) => fakeSelf.onmessage!({ data: m });
const render = (id: number, version = id) => send({ type: 'render', id, payload: { documentVersion: version } as never });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('render.worker', () => {
  it('runs in order, skips a render cancelled before it starts, ignores a cancel that comes too late', async () => {
    render(1);
    render(2);
    render(3);
    await tick();
    expect(drawn).toEqual([1]);
    send({ type: 'cancel', id: 2 }); // not started yet: skipped
    send({ type: 'cancel', id: 1 }); // already running: finishes
    gates.get(1)!();
    await tick();
    await tick();
    expect(drawn).toEqual([1, 3]);
    gates.get(3)!();
    await tick();
    await tick();
    const answers = posted.map((p) => p.msg);
    expect(answers.map((a) => [a.type, a.id])).toEqual([
      ['rendered', 1],
      ['rendered', 3],
    ]);
    // The PDF's buffer is handed over, not copied.
    expect(posted[0].transfer).toEqual([(answers[0] as Extract<WorkerResponse, { type: 'rendered' }>).bytes]);
  });

  it('answers a failure as the coded error', async () => {
    posted.length = 0;
    render(4, 99);
    await tick();
    await tick();
    expect(posted.map((p) => p.msg)).toEqual([{ type: 'failed', id: 4, error: { code: 'font_hash_mismatch', message: 'not the pinned file', details: { file: 'x' } } }]);
  });
});
