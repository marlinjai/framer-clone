// @vitest-environment node
//
// The OpenFGA structure read a company API key is mapped through
// (src/lib/openfgaRead.ts): request shape, pagination, the type filter, and
// every failure throwing (never answering "no such company").

import { describe, it, expect, vi } from 'vitest';
import { OpenFgaReadError, readCompanyStructure, readTuples } from '@/lib/openfgaRead';

const ENV = {
  OPENFGA_API_URL: 'http://fga.test/',
  OPENFGA_STORE_ID: 'store-1',
  OPENFGA_API_TOKEN: 'test-preshared-key',
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('readTuples', () => {
  it('posts the tuple key to the store read endpoint with the pre-shared key', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ tuples: [], continuation_token: '' }));
    await readTuples({ object: 'tenant:t1', relation: 'group' }, { env: ENV, fetch: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://fga.test/stores/store-1/read');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-preshared-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ tuple_key: { object: 'tenant:t1', relation: 'group' } });
  });

  it('sends no authorization header for a local OpenFGA without a key', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ tuples: [] }));
    await readTuples({ object: 'tenant:t1' }, {
      env: { ...ENV, OPENFGA_API_TOKEN: '  ' },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('follows continuation tokens across pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ tuples: [{ key: { object: 'workspace:a' } }], continuation_token: 'next' }))
      .mockResolvedValueOnce(json({ tuples: [{ key: { object: 'workspace:b' } }], continuation_token: '' }));
    const tuples = await readTuples({ user: 'tenant:t1' }, { env: ENV, fetch: fetchImpl as unknown as typeof fetch });
    expect(tuples.map((t) => t.object)).toEqual(['workspace:a', 'workspace:b']);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body)).continuation_token).toBe('next');
  });

  it('throws when OpenFGA is not configured', async () => {
    await expect(readTuples({}, { env: {}, fetch: vi.fn() as unknown as typeof fetch })).rejects.toBeInstanceOf(OpenFgaReadError);
  });

  it('throws on a network error, a non-OK status, an unreadable body, a body without tuples, and endless pages', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => json({ code: 'unauthenticated' }, 401),
      async () => new Response('not json', { status: 200 }),
      async () => json({}),
      async () => json({ tuples: [], continuation_token: 'again' }),
    ];
    for (const impl of cases) {
      await expect(
        readTuples({ object: 'tenant:t1' }, { env: ENV, fetch: vi.fn(impl) as unknown as typeof fetch }),
      ).rejects.toBeInstanceOf(OpenFgaReadError);
    }
  });
});

describe('readCompanyStructure', () => {
  it('reads the group edge and the workspace edges of exactly this company', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = JSON.parse(String(init?.body)).tuple_key;
      if (key.relation === 'group') {
        return json({
          tuples: [
            { key: { user: 'tenant_group:g1', relation: 'group', object: 'tenant:t1' } },
            { key: { user: 'user:u1', relation: 'group', object: 'tenant:t1' } },
          ],
        });
      }
      return json({
        tuples: [
          { key: { user: 'tenant:t1', relation: 'tenant', object: 'workspace:w1' } },
          { key: { user: 'tenant:t2', relation: 'tenant', object: 'workspace:w2' } },
          { key: { user: 'tenant:t1', relation: 'tenant', object: 'workspace:w1' } },
        ],
      });
    });
    const structure = await readCompanyStructure('t1', { env: ENV, fetch: fetchImpl as unknown as typeof fetch });
    expect(structure).toEqual({ groupIds: ['g1'], workspaceIds: ['w1'] });
    const keys = fetchImpl.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).tuple_key);
    expect(keys).toContainEqual({ object: 'tenant:t1', relation: 'group' });
    expect(keys).toContainEqual({ user: 'tenant:t1', relation: 'tenant', object: 'workspace:' });
  });
});
