// src/app/projects/books/composer/__tests__/usePreview.test.tsx
//
// The live preview's ordering: changes within the debounce window send one
// request; a newer change aborts the request in flight; an answer that arrives
// after a newer change is dropped even when it could not be aborted; an
// unchanged document sends nothing; a failure keeps the previous pages and
// says why. (Backtrack-and-revise at the request level.)

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreview } from '../usePreview';

type Pending = { body: { document: unknown }; signal: AbortSignal; resolve: (v: unknown) => void; reject: (e: unknown) => void };
let pending: Pending[];

function answer(n: number) {
  return { pdf: 'JVBERi0=', layout: { page: { width: 595, height: 842 }, pageCount: n, blocks: [], tables: [], issues: [] }, renderMs: 5, problems: [] };
}

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const entry: Pending = {
            body: JSON.parse(String(init.body)),
            signal: init.signal as AbortSignal,
            resolve: (v) => resolve(new Response(JSON.stringify(v), { status: 200 })),
            reject,
          };
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          pending.push(entry);
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const subject = { kind: 'sample' as const, variant: 'regular' };

describe('usePreview', () => {
  it('sends one request for changes inside the debounce window, and none for an unchanged document', async () => {
    const third = { n: 3 };
    const { result, rerender } = renderHook(({ doc }) => usePreview(doc, subject, { enabled: true }), { initialProps: { doc: { n: 1 } as unknown } });
    rerender({ doc: { n: 2 } });
    rerender({ doc: third });
    await act(async () => void vi.advanceTimersByTime(350));
    expect(pending).toHaveLength(1);
    expect(pending[0].body.document).toEqual({ n: 3 });
    await act(async () => pending[0].resolve(answer(2)));
    expect(result.current.result?.layout.pageCount).toBe(2);
    expect(result.current.pending).toBe(false);

    // The composer passes Immer's result, which is the same object when a change changed nothing: no request.
    rerender({ doc: third });
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(1);
    expect(result.current.pending).toBe(false);
  });

  it('a newer change aborts the request in flight, and a late answer for an abandoned state is dropped', async () => {
    const { result, rerender } = renderHook(({ doc }) => usePreview(doc, subject, { enabled: true }), { initialProps: { doc: { n: 1 } as unknown } });
    await act(async () => void vi.advanceTimersByTime(350));
    expect(pending).toHaveLength(1);
    rerender({ doc: { n: 2 } });
    await act(async () => void vi.advanceTimersByTime(350));
    expect(pending).toHaveLength(2);
    expect(pending[0].signal.aborted).toBe(true);
    // The aborted request's answer arrives anyway (the server had answered already): dropped.
    await act(async () => pending[0].resolve(answer(9)));
    expect(result.current.result).toBeNull();
    await act(async () => pending[1].resolve(answer(1)));
    expect(result.current.result?.layout.pageCount).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('a failed refresh keeps the previous pages and says why; retry asks again', async () => {
    const { result, rerender } = renderHook(({ doc }) => usePreview(doc, subject, { enabled: true }), { initialProps: { doc: { n: 1 } as unknown } });
    await act(async () => void vi.advanceTimersByTime(350));
    await act(async () => pending[0].resolve(answer(1)));
    rerender({ doc: { n: 2 } });
    await act(async () => void vi.advanceTimersByTime(350));
    await act(async () => pending[1].reject(new TypeError('Failed to fetch')));
    expect(result.current.result?.layout.pageCount).toBe(1);
    expect(result.current.error).toMatch(/could not be reached/);
    await act(async () => result.current.retry());
    await act(async () => void vi.advanceTimersByTime(350));
    expect(pending).toHaveLength(3);
  });

  it('sends nothing while disabled (a document the schema refuses)', async () => {
    renderHook(() => usePreview({ n: 1 }, subject, { enabled: false }));
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(0);
  });
});
