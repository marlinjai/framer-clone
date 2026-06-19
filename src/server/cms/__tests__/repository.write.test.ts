import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the adapter client so the WRITE repository runs against a fake adapter:
// no PrismaClient, no DATABASE_URL, no live database. We test the COLLECTION
// write tier: the name-uniqueness collision contract and the typed not-found
// surfacing, not Prisma itself. In-collection editing (columns/rows) is no
// longer a repository concern; the editor grid drives it through the data-table
// server-actions adapter, covered by cmsServerActionsAdapter.test.ts.
const listTables = vi.fn();
const getTable = vi.fn();
const createTable = vi.fn();
const updateTable = vi.fn();
const deleteTable = vi.fn();

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-workspace',
  getCmsAdapter: () => ({
    listTables,
    getTable,
    createTable,
    updateTable,
    deleteTable,
  }),
}));

import { getCmsWriteRepository } from '../repository';
import { CollectionExistsError, CmsNotFoundError } from '../errors';

const TABLE = {
  id: 'col_events',
  name: 'Events',
  workspaceId: 'test-workspace',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createCollection', () => {
  it('creates a table in the CMS workspace and maps it to a Collection', async () => {
    listTables.mockResolvedValue([]);
    createTable.mockResolvedValue(TABLE);

    const collection = await getCmsWriteRepository().createCollection('Events');

    expect(createTable).toHaveBeenCalledWith({
      workspaceId: 'test-workspace',
      name: 'Events',
    });
    expect(collection).toEqual({
      id: 'col_events',
      slug: 'events',
      name: 'Events',
      columns: [],
    });
  });

  it('throws the TYPED CollectionExistsError (409) on a duplicate name, never creating a second table', async () => {
    listTables.mockResolvedValue([TABLE]);

    const promise = getCmsWriteRepository().createCollection('  events  ');

    await expect(promise).rejects.toBeInstanceOf(CollectionExistsError);
    await expect(promise).rejects.toMatchObject({
      code: 'collection_exists',
      status: 409,
    });
    expect(createTable).not.toHaveBeenCalled();
  });
});

describe('renameCollection / deleteCollection', () => {
  it('renames an existing collection', async () => {
    getTable.mockResolvedValue(TABLE);
    listTables.mockResolvedValue([TABLE]);
    updateTable.mockResolvedValue({ ...TABLE, name: 'Shows' });

    await getCmsWriteRepository().renameCollection('col_events', 'Shows');
    expect(updateTable).toHaveBeenCalledWith('col_events', { name: 'Shows' });
  });

  it('throws CmsNotFoundError when renaming a missing collection', async () => {
    getTable.mockResolvedValue(null);
    await expect(
      getCmsWriteRepository().renameCollection('nope', 'X'),
    ).rejects.toBeInstanceOf(CmsNotFoundError);
    expect(updateTable).not.toHaveBeenCalled();
  });

  it('rejects a rename that collides with another collection name (409)', async () => {
    getTable.mockResolvedValue(TABLE);
    listTables.mockResolvedValue([TABLE, { id: 'col_other', name: 'Shows' }]);
    await expect(
      getCmsWriteRepository().renameCollection('col_events', 'shows'),
    ).rejects.toBeInstanceOf(CollectionExistsError);
  });

  it('deletes an existing collection', async () => {
    getTable.mockResolvedValue(TABLE);
    deleteTable.mockResolvedValue(undefined);
    await getCmsWriteRepository().deleteCollection('col_events');
    expect(deleteTable).toHaveBeenCalledWith('col_events');
  });

  it('updates only the icon without running a name-uniqueness check', async () => {
    getTable.mockResolvedValue(TABLE);
    updateTable.mockResolvedValue({ ...TABLE, icon: 'calendar' });
    await getCmsWriteRepository().updateCollection('col_events', { icon: 'calendar' });
    expect(updateTable).toHaveBeenCalledWith('col_events', { icon: 'calendar' });
    expect(listTables).not.toHaveBeenCalled();
  });
});
