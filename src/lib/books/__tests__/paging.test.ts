// src/lib/books/__tests__/paging.test.ts
//
// The Books client's paged lists: a picker that needs every customer follows
// every cursor, and a cursor that never ends is an error, never an endless loop.
// fetch stubbed; synthetic data only.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { booksApi } from '../api';

afterEach(() => vi.unstubAllGlobals());

const customer = (id: string) => ({ id, contactId: `c-${id}`, customerType: 'b2c', vatId: null, countryCode: 'DE', taxNumber: null, archivedAt: null, contact: { name: `Example ${id}` }, contactStatus: 'ok', drift: [] });

describe('booksApi.allCustomers', () => {
  it('follows every cursor and returns all customers in order', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const cursor = new URL(url, 'http://x').searchParams.get('cursor');
        const page = cursor === null ? { items: [customer('a'), customer('b')], nextCursor: 'b' } : cursor === 'b' ? { items: [customer('c')], nextCursor: null } : null;
        return new Response(JSON.stringify({ ...page, total: 3 }), { status: 200 });
      }),
    );
    const all = await booksApi.allCustomers();
    expect(all.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(urls).toEqual(['/api/books/customers', '/api/books/customers?cursor=b']);
  });

  it('a cursor that never ends is an error, not an endless loop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [customer('x')], nextCursor: 'again', total: 1 }), { status: 200 })));
    await expect(booksApi.allCustomers()).rejects.toMatchObject({ code: 'list_too_long' });
  });
});
