import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDataSourceProvider } from '../inMemoryProvider';

describe('InMemoryDataSourceProvider', () => {
  let provider: InMemoryDataSourceProvider;

  beforeEach(() => {
    provider = new InMemoryDataSourceProvider();
  });

  describe('listCollections', () => {
    it('returns the two seed collections', async () => {
      const collections = await provider.listCollections();
      expect(collections).toHaveLength(2);
      expect(collections.map((c) => c.id).sort()).toEqual(['col_posts', 'col_team']);
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

    it('returns null for an unknown collection', async () => {
      expect(await provider.getCollection('does_not_exist')).toBeNull();
    });
  });

  describe('listRows — sort', () => {
    it('sorts by date descending', async () => {
      const page = await provider.listRows('col_posts', {
        sort: [{ column: 'published_at', direction: 'desc' }],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['post_3', 'post_2', 'post_1']);
    });

    it('sorts by date ascending', async () => {
      const page = await provider.listRows('col_posts', {
        sort: [{ column: 'published_at', direction: 'asc' }],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['post_1', 'post_2', 'post_3']);
    });
  });

  describe('listRows — filter', () => {
    it('narrows by eq', async () => {
      const page = await provider.listRows('col_team', {
        filter: [{ column: 'role', op: 'eq', value: 'CEO' }],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['team_1']);
    });

    it('narrows by ne', async () => {
      const page = await provider.listRows('col_team', {
        filter: [{ column: 'role', op: 'ne', value: 'CEO' }],
      });
      expect(page.rows.map((r) => r.id).sort()).toEqual(['team_2', 'team_3']);
    });

    it('narrows by contains (case-insensitive)', async () => {
      const page = await provider.listRows('col_posts', {
        filter: [{ column: 'title', op: 'contains', value: 'WORLD' }],
      });
      expect(page.rows.map((r) => r.id)).toEqual(['post_1']);
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

  describe('listRows — limit', () => {
    it('caps the number of rows returned', async () => {
      const page = await provider.listRows('col_posts', { limit: 2 });
      expect(page.rows).toHaveLength(2);
    });

    it('returns total ignoring limit', async () => {
      const page = await provider.listRows('col_posts', { limit: 1 });
      expect(page.total).toBe(3);
    });

    it('limit 0 returns no rows', async () => {
      const page = await provider.listRows('col_posts', { limit: 0 });
      expect(page.rows).toHaveLength(0);
    });
  });

  describe('listRows — unknown collection', () => {
    it('returns an empty page', async () => {
      const page = await provider.listRows('nope');
      expect(page.rows).toEqual([]);
      expect(page.total).toBe(0);
    });
  });

  describe('getRow', () => {
    it('returns the requested row', async () => {
      const row = await provider.getRow('col_posts', 'post_2');
      expect(row?.values.title).toBe('Shipping data bindings');
    });

    it('returns null for an unknown row', async () => {
      expect(await provider.getRow('col_posts', 'nope')).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('fires the callback when the seed mutates via _mutate', () => {
      let calls = 0;
      const unsub = provider.subscribe('col_posts', undefined, () => {
        calls += 1;
      });
      provider._mutate((seed) => {
        seed.rows.col_posts.push({
          id: 'post_4',
          values: { title: 'Hot new post', body: 'x', published_at: '2026-05-09' },
        });
      });
      expect(calls).toBe(1);
      provider._mutate(() => {});
      expect(calls).toBe(2);
      unsub();
      provider._mutate(() => {});
      expect(calls).toBe(2);
    });

    it('supports multiple independent subscribers', () => {
      let a = 0;
      let b = 0;
      const unsubA = provider.subscribe('col_posts', undefined, () => {
        a += 1;
      });
      const unsubB = provider.subscribe('col_posts', undefined, () => {
        b += 1;
      });
      provider._mutate(() => {});
      expect(a).toBe(1);
      expect(b).toBe(1);
      unsubA();
      provider._mutate(() => {});
      expect(a).toBe(1);
      expect(b).toBe(2);
      unsubB();
    });

    it('safely unsubscribes synchronously inside the callback', () => {
      let calls = 0;
      let unsub: (() => void) | null = null;
      unsub = provider.subscribe('col_posts', undefined, () => {
        calls += 1;
        unsub?.();
      });
      provider._mutate(() => {});
      provider._mutate(() => {});
      expect(calls).toBe(1);
    });
  });

  describe('isolation', () => {
    it('does not leak mutations to a freshly constructed provider', async () => {
      provider._mutate((seed) => {
        seed.rows.col_posts = [];
      });
      const fresh = new InMemoryDataSourceProvider();
      const page = await fresh.listRows('col_posts');
      expect(page.rows).toHaveLength(3);
    });
  });
});
