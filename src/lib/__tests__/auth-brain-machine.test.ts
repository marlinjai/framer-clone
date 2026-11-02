// @vitest-environment node
//
// The machine door's auth-brain client (src/lib/auth-brain-machine.ts): every
// request carries a deadline, so a hung auth-brain is aborted rather than left
// open, and the client never caches.

import { describe, expect, it, vi } from 'vitest';

const { createAuthBrainClient } = vi.hoisted(() => ({
  createAuthBrainClient: vi.fn<(opts: Record<string, unknown>) => object>(() => ({})),
}));
vi.mock('@marlinjai/auth-brain-sdk', () => ({ createAuthBrainClient }));

import { MACHINE_VERIFY_FETCH_TIMEOUT_MS, fetchWithDeadline } from '../auth-brain-machine';

describe('fetchWithDeadline', () => {
  it('aborts a request that never answers', async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
      );
      const pending = fetchWithDeadline(1_000, hung as unknown as typeof fetch)('http://auth.test/api/verify/api-key', { method: 'POST' });
      const outcome = pending.then(
        () => 'answered',
        (err: unknown) => (err as Error).name,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toBe('TimeoutError');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a signal the caller passed', async () => {
    const seen: AbortSignal[] = [];
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init!.signal!);
      return new Response('{}');
    });
    const caller = new AbortController();
    await fetchWithDeadline(1_000, base as unknown as typeof fetch)('http://x', { signal: caller.signal });
    caller.abort();
    expect(seen[0].aborted).toBe(true);
  });

  it('builds the client with the deadline fetch and no cache', () => {
    const opts = createAuthBrainClient.mock.calls[0][0];
    expect(opts).toMatchObject({ cacheTtlMs: 0 });
    expect(typeof opts.fetch).toBe('function');
    expect(MACHINE_VERIFY_FETCH_TIMEOUT_MS).toBe(5_000);
  });
});
