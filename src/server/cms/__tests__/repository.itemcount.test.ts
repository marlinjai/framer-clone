import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the adapter client so listCollections runs against a fake adapter.
// This test focuses on the itemCount plumbing added in slice3.
const getRows = vi.fn();
const getColumns = vi.fn();
const listTables = vi.fn();

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-workspace',
  getCmsAdapter: () => ({ getRows, getColumns, listTables }),
}));

import { getCmsRepository } from '../repository';

const TABLE_EVENTS = { id: 'col_events', name: 'Events', workspaceId: 'test-workspace' };
const TABLE_TEAM = { id: 'col_team', name: 'Team', workspaceId: 'test-workspace' };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no columns on any table.
  getColumns.mockResolvedValue([]);
});

describe('listCollections itemCount', () => {
  it('returns itemCount from getRows().total for each collection', async () => {
    listTables.mockResolvedValue([TABLE_EVENTS, TABLE_TEAM]);
    getRows
      .mockResolvedValueOnce({ items: [], total: 3, hasMore: false })  // Events: 3 rows
      .mockResolvedValueOnce({ items: [], total: 0, hasMore: false }); // Team: 0 rows

    const collections = await getCmsRepository().listCollections();

    expect(collections).toHaveLength(2);
    const events = collections.find((c) => c.id === 'col_events');
    const team = collections.find((c) => c.id === 'col_team');
    expect(events?.itemCount).toBe(3);
    expect(team?.itemCount).toBe(0);
  });

  it('calls getRows with limit:1 (cheapest count, only total needed)', async () => {
    listTables.mockResolvedValue([TABLE_EVENTS]);
    getRows.mockResolvedValue({ items: [], total: 7, hasMore: true });

    await getCmsRepository().listCollections();

    expect(getRows).toHaveBeenCalledWith('col_events', expect.objectContaining({ limit: 1 }));
  });

  it('defaults itemCount to 0 when getRows throws, without crashing listCollections', async () => {
    listTables.mockResolvedValue([TABLE_EVENTS]);
    getRows.mockRejectedValue(new Error('db connection refused'));

    // Must resolve, not reject.
    const collections = await getCmsRepository().listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0].itemCount).toBe(0);
  });

  it('defaults itemCount to 0 when total is undefined', async () => {
    listTables.mockResolvedValue([TABLE_EVENTS]);
    // Some adapter versions may omit total.
    getRows.mockResolvedValue({ items: [], hasMore: false });

    const collections = await getCmsRepository().listCollections();
    expect(collections[0].itemCount).toBe(0);
  });
});
