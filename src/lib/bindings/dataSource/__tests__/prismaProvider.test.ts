// @vitest-environment node
//
// src/lib/bindings/dataSource/__tests__/prismaProvider.test.ts
//
// PrismaDataSourceProvider must pass the SAME read contract the
// InMemoryDataSourceProvider passes (listCollections / getCollection / listRows
// with filter + sort + limit / getRow / subscribe-fires-on-poll). We mock
// `fetch` with a stub that mirrors the /api/cms/* route shapes, backed by an
// InMemoryDataSourceProvider so the provider's HTTP plumbing + query encoding
// round-trip through the same filter/sort/limit logic the contract expects.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaDataSourceProvider } from '../prismaProvider';
import { InMemoryDataSourceProvider } from '../inMemoryProvider';

const BASE = 'http://cms.test';

// A fetch stub that routes /api/cms/* requests onto an in-memory backend,
// reproducing the real route handlers' success shapes and 404 envelope.
function makeFetchStub(backend: InMemoryDataSourceProvider) {
  return async (input: string | URL | Request): Promise<Response> => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(href, BASE);
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    // Expect ['api', 'cms', 'collections', ...rest].
    const rest = parts.slice(3);

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const notFound = (message: string): Response =>
      json({ error: { code: 'not_found', message } }, 404);

    if (rest.length === 0) {
      return json(await backend.listCollections());
    }
    const id = decodeURIComponent(rest[0]);
    if (rest.length === 1) {
      const collection = await backend.getCollection(id);
      return collection ? json(collection) : notFound(`collection ${id}`);
    }
    if (rest[1] === 'rows' && rest.length === 2) {
      const raw = url.searchParams.get('query');
      const query = raw ? JSON.parse(raw) : undefined;
      return json(await backend.listRows(id, query));
    }
    if (rest[1] === 'rows' && rest.length === 3) {
      const rowId = decodeURIComponent(rest[2]);
      const row = await backend.getRow(id, rowId);
      return row ? json(row) : notFound(`row ${rowId}`);
    }
    return json({ error: { code: 'bad_route', message: url.pathname } }, 400);
  };
}

describe('PrismaDataSourceProvider (contract parity over /api/cms/*)', () => {
  let provider: PrismaDataSourceProvider;

  beforeEach(() => {
    const backend = new InMemoryDataSourceProvider();
    vi.stubGlobal('fetch', vi.fn(makeFetchStub(backend)));
    provider = new PrismaDataSourceProvider({ baseUrl: BASE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listCollections', () => {
    it('returns the two seed collections', async () => {
      const collections = await provider.listCollections();
      expect(collections).toHaveLength(2);
      expect(collections.map((c) => c.id).sort()).toEqual([
        'col_posts',
        'col_team',
      ]);
    });

    it('returns columns alongside the collection', async () => {
      const collections = await provider.listCollections();
      const posts = collections.find((c) => c.id === 'col_posts');
      expect(posts?.columns.map((c) => c.id)).toEqual([
        'title',
        'body',
        'published_at',
      ]);
    });
  });

  describe('getCollection', () => {
    it('returns the requested collection', async () => {
      const team = await provider.getCollection('col_team');
      expect(team?.slug).toBe('team');
    });

    it('returns null for an unknown collection (404 -> null)', async () => {
      expect(await provider.getCollection('does_not_exist')).toBeNull();
    });
  });

  describe('listRows (sort)', () => {
    it('sorts by date descending', async () => {
      const page = await provider.listRows('col_posts', {
        sort: [{ column: 'published_at', direction: 'desc' }],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['post_3', 'post_2', 'post_1']);
    });
  });

  describe('listRows (filter)', () => {
    it('narrows by eq', async () => {
      const page = await provider.listRows('col_team', {
        filter: [{ column: 'role', op: 'eq', value: 'CEO' }],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['team_1']);
    });

    it('combines multiple filters with AND', async () => {
      const page = await provider.listRows('col_posts', {
        filter: [
          { column: 'published_at', op: 'gt', value: '2026-04-01' },
          { column: 'title', op: 'contains', value: 'shipping' },
        ],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['post_2']);
    });
  });

  describe('listRows (limit)', () => {
    it('caps the number of rows returned but reports full total', async () => {
      const page = await provider.listRows('col_posts', { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.total).toBe(3);
    });
  });

  describe('getRow', () => {
    it('returns the requested row', async () => {
      const row = await provider.getRow('col_posts', 'post_2');
      expect(row?.values.title).toBe('Shipping data bindings');
    });

    it('returns null for an unknown row (404 -> null)', async () => {
      expect(await provider.getRow('col_posts', 'nope')).toBeNull();
    });
  });

  describe('error surfacing', () => {
    it('throws (never resolves empty) when a list read returns a 5xx', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({ error: { code: 'cms_read_failed', message: 'db down' } }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      const p = new PrismaDataSourceProvider({ baseUrl: BASE });
      await expect(p.listCollections()).rejects.toThrow(/db down/);
    });

    it('throws on a non-404 single-resource failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('nope', { status: 500 })),
      );
      const p = new PrismaDataSourceProvider({ baseUrl: BASE });
      await expect(p.getCollection('col_posts')).rejects.toThrow();
    });
  });
});

describe('PrismaDataSourceProvider.subscribe (polling)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-invokes onChange on the poll cadence until unsubscribed', () => {
    const provider = new PrismaDataSourceProvider({ baseUrl: BASE, pollMs: 1000 });
    let calls = 0;
    const unsub = provider.subscribe('col_posts', undefined, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
    unsub();
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(2);
  });

  it('defaults to a 5s cadence', () => {
    const provider = new PrismaDataSourceProvider({ baseUrl: BASE });
    let calls = 0;
    const unsub = provider.subscribe('col_posts', undefined, () => {
      calls += 1;
    });
    vi.advanceTimersByTime(4999);
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
    unsub();
  });
});
