import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the adapter client so the WRITE repository runs against a fake adapter:
// no PrismaClient, no DATABASE_URL, no live database. We test the
// binding -> adapter translation, the name-uniqueness collision contract, and
// the typed not-found / DDL error surfacing, not Prisma itself.
const listTables = vi.fn();
const getTable = vi.fn();
const getColumn = vi.fn();
const createTable = vi.fn();
const updateTable = vi.fn();
const deleteTable = vi.fn();
const createColumn = vi.fn();
const updateColumn = vi.fn();
const deleteColumn = vi.fn();
const createRow = vi.fn();
const updateRow = vi.fn();
const deleteRow = vi.fn();
const getRow = vi.fn();

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-workspace',
  getCmsAdapter: () => ({
    listTables,
    getTable,
    getColumn,
    createTable,
    updateTable,
    deleteTable,
    createColumn,
    updateColumn,
    deleteColumn,
    createRow,
    updateRow,
    deleteRow,
    getRow,
  }),
}));

import { getCmsWriteRepository } from '../repository';
import {
  CollectionExistsError,
  CmsNotFoundError,
  CmsDdlError,
} from '../errors';

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
});

describe('addColumn', () => {
  it('maps the binding type to the adapter type (multi-select -> multi_select) and returns a binding Column', async () => {
    getTable.mockResolvedValue(TABLE);
    createColumn.mockResolvedValue({
      id: 'fld_tags',
      tableId: 'col_events',
      name: 'tags',
      type: 'multi_select',
      position: 3,
    });

    const column = await getCmsWriteRepository().addColumn('col_events', {
      name: 'tags',
      type: 'multi-select',
    });

    expect(createColumn).toHaveBeenCalledWith({
      tableId: 'col_events',
      name: 'tags',
      type: 'multi_select',
    });
    expect(column).toEqual({ id: 'fld_tags', name: 'tags', type: 'multi-select' });
  });

  it('throws CmsNotFoundError when the collection does not exist', async () => {
    getTable.mockResolvedValue(null);
    await expect(
      getCmsWriteRepository().addColumn('nope', { name: 'x', type: 'text' }),
    ).rejects.toBeInstanceOf(CmsNotFoundError);
    expect(createColumn).not.toHaveBeenCalled();
  });

  it('wraps an opaque adapter DDL throw as a typed CmsDdlError (400)', async () => {
    getTable.mockResolvedValue(TABLE);
    createColumn.mockRejectedValue(new Error('relation does not exist'));
    const promise = getCmsWriteRepository().addColumn('col_events', {
      name: 'x',
      type: 'text',
    });
    await expect(promise).rejects.toBeInstanceOf(CmsDdlError);
    await expect(promise).rejects.toMatchObject({ code: 'ddl_failed', status: 400 });
  });
});

describe('renameColumn / retypeColumn / deleteColumn', () => {
  const COLUMN = {
    id: 'fld_date',
    tableId: 'col_events',
    name: 'date',
    type: 'date',
    position: 1,
  };

  it('renames a column that belongs to the collection', async () => {
    getColumn.mockResolvedValue(COLUMN);
    updateColumn.mockResolvedValue({ ...COLUMN, name: 'when' });
    await getCmsWriteRepository().renameColumn('col_events', 'fld_date', 'when');
    expect(updateColumn).toHaveBeenCalledWith('fld_date', { name: 'when' });
  });

  it('throws CmsNotFoundError when the column belongs to a different collection', async () => {
    getColumn.mockResolvedValue({ ...COLUMN, tableId: 'other' });
    await expect(
      getCmsWriteRepository().renameColumn('col_events', 'fld_date', 'when'),
    ).rejects.toBeInstanceOf(CmsNotFoundError);
  });

  it('retypes by dropping and recreating the column with the new type, preserving name and position', async () => {
    getColumn.mockResolvedValue(COLUMN);
    deleteColumn.mockResolvedValue(undefined);
    createColumn.mockResolvedValue({ ...COLUMN, id: 'fld_new', type: 'text' });

    await getCmsWriteRepository().retypeColumn('col_events', 'fld_date', 'text');

    expect(deleteColumn).toHaveBeenCalledWith('fld_date');
    expect(createColumn).toHaveBeenCalledWith({
      tableId: 'col_events',
      name: 'date',
      type: 'text',
      position: 1,
    });
  });

  it('deletes a column that belongs to the collection', async () => {
    getColumn.mockResolvedValue(COLUMN);
    deleteColumn.mockResolvedValue(undefined);
    await getCmsWriteRepository().deleteColumn('col_events', 'fld_date');
    expect(deleteColumn).toHaveBeenCalledWith('fld_date');
  });
});

describe('row writes', () => {
  it('createRow maps binding values to adapter cells and returns a binding Row', async () => {
    getTable.mockResolvedValue(TABLE);
    createRow.mockResolvedValue({
      id: 'row_1',
      tableId: 'col_events',
      cells: { title: 'Launch', tags: ['a', 'b'] },
      archived: false,
    });

    const row = await getCmsWriteRepository().createRow('col_events', {
      title: 'Launch',
      tags: ['a', 'b'],
    });

    expect(createRow).toHaveBeenCalledWith({
      tableId: 'col_events',
      cells: { title: 'Launch', tags: ['a', 'b'] },
    });
    expect(row).toEqual({
      id: 'row_1',
      values: { title: 'Launch', tags: ['a', 'b'] },
    });
  });

  it('updateRow rejects a row that belongs to a different collection (404)', async () => {
    getRow.mockResolvedValue({
      id: 'row_1',
      tableId: 'other',
      cells: {},
      archived: false,
    });
    await expect(
      getCmsWriteRepository().updateRow('col_events', 'row_1', { title: 'x' }),
    ).rejects.toBeInstanceOf(CmsNotFoundError);
    expect(updateRow).not.toHaveBeenCalled();
  });

  it('deleteRow deletes a row that belongs to the collection', async () => {
    getRow.mockResolvedValue({
      id: 'row_1',
      tableId: 'col_events',
      cells: {},
      archived: false,
    });
    deleteRow.mockResolvedValue(undefined);
    await getCmsWriteRepository().deleteRow('col_events', 'row_1');
    expect(deleteRow).toHaveBeenCalledWith('row_1');
  });
});
