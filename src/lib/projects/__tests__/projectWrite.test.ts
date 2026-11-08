// The request the editor's save and Publish share (src/lib/projects/projectWrite.ts):
// the attempt key travels in the body, a request made while leaving the page is a
// keepalive one only when its body fits the browser's 64 KB limit, and a 2xx
// without the version is a server error (retried), never a refusal or a conflict.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEEPALIVE_BODY_MAX_BYTES, postProjectWrite } from '../projectWrite';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });

describe('postProjectWrite', () => {
  it('sends the attempt key with the snapshot and the version', async () => {
    fetchMock.mockResolvedValueOnce(ok({ version: 4 }));
    const out = await postProjectWrite('/api/projects/save', { id: 's' }, 3, 'Save failed', { requestKey: 'k_0123456789' });
    expect(out).toMatchObject({ kind: 'ok', version: 4 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ project: { id: 's' }, expectedVersion: 3, requestKey: 'k_0123456789' });
    expect(fetchMock.mock.calls[0][1].keepalive).toBeUndefined();
  });

  it('asks for keepalive when leaving, only while the body fits what is left of the shared budget', async () => {
    fetchMock.mockResolvedValue(ok({ version: 4 }));
    const budget = { remaining: KEEPALIVE_BODY_MAX_BYTES };
    await postProjectWrite('/api/projects/save', { id: 's' }, 3, 'Save failed', { keepaliveBudget: budget });
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(budget.remaining).toBeLessThan(KEEPALIVE_BODY_MAX_BYTES);
    // A second project's body that would overrun the page's 64 KB goes as a normal request.
    await postProjectWrite('/api/projects/save', { id: 't', big: 'x'.repeat(budget.remaining) }, 3, 'Save failed', { keepaliveBudget: budget });
    expect(fetchMock.mock.calls[1][1].keepalive).toBeUndefined();
    await postProjectWrite('/api/projects/save', { id: 's', big: 'x'.repeat(KEEPALIVE_BODY_MAX_BYTES) }, 3, 'Save failed', { keepaliveBudget: { remaining: KEEPALIVE_BODY_MAX_BYTES } });
    expect(fetchMock.mock.calls[2][1].keepalive).toBeUndefined();
  });

  it('a 2xx without a version is a 502 server error with a clear message', async () => {
    fetchMock.mockResolvedValueOnce(ok({ savedPages: [''] }));
    const out = await postProjectWrite('/api/projects/save', {}, 3, 'Save failed');
    expect(out).toEqual({ kind: 'error', status: 502, message: 'The server did not confirm the save (its answer had no project version).' });
  });
});
