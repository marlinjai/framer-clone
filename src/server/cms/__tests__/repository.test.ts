import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the adapter client so the repository runs against a fake adapter: no
// PrismaClient, no DATABASE_URL, no live database. We are testing the
// adapter -> binding shape mapping, not Prisma.
const getRows = vi.fn();
const getRow = vi.fn();
const getTable = vi.fn();
const getColumns = vi.fn();
const listTables = vi.fn();

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-workspace',
  getCmsAdapter: () => ({ getRows, getRow, getTable, getColumns, listTables }),
}));

import { getCmsRepository } from '../repository';

// Minimal builders for adapter-prisma shapes. Cast at the call boundary so the
// test does not need a direct data-table-core import (the repository derives
// those types structurally; the runtime objects only need the read fields).
function fileRef(fileUrl: string, id: string) {
  return {
    id,
    rowId: 'row-1',
    columnId: 'cover',
    fileId: `file-${id}`,
    fileUrl,
    originalName: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1234,
    position: 0,
  };
}

const FIXED_DATE = new Date('2026-06-16T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CmsReadRepository.listRows -> RowsPage mapping', () => {
  it('maps cells (including multi-select arrays and file URLs) into a binding RowsPage', async () => {
    getRows.mockResolvedValue({
      items: [
        {
          id: 'row-1',
          tableId: 'collection-1',
          cells: {
            title: 'Hello world',
            count: 42,
            published: true,
            createdOn: FIXED_DATE,
            tags: ['news', 'featured'], // multi_select -> string[]
            cover: [
              // file -> string[] of URLs
              fileRef('https://cdn.example.com/a.png', 'f1'),
              fileRef('https://cdn.example.com/b.png', 'f2'),
            ],
            author: [
              // relation -> string[] of related row ids
              { rowId: 'person-7', displayValue: 'Ada' },
            ],
            missing: null,
          },
          computed: {},
          archived: false,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
      ],
      total: 1,
      hasMore: false,
      cursor: undefined,
    });

    const page = await getCmsRepository().listRows('collection-1');

    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeUndefined();
    expect(page.rows).toHaveLength(1);

    const values = page.rows[0].values;
    expect(page.rows[0].id).toBe('row-1');
    expect(values.title).toBe('Hello world');
    expect(values.count).toBe(42);
    expect(values.published).toBe(true);
    expect(values.createdOn).toBe('2026-06-16T12:00:00.000Z'); // Date -> ISO string
    expect(values.tags).toEqual(['news', 'featured']); // multi-select array preserved
    expect(values.cover).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]); // file URLs as strings
    expect(values.author).toEqual(['person-7']); // relation -> row ids
    expect(values.missing).toBeNull();
  });

  it('eager-loads files/multiSelect/relations and translates the query', async () => {
    getRows.mockResolvedValue({
      items: [],
      total: 100,
      hasMore: true,
      cursor: '100',
    });

    const page = await getCmsRepository().listRows('collection-1', {
      filter: [{ column: 'status', op: 'eq', value: 'published' }],
      sort: [{ column: 'createdOn', direction: 'desc' }],
      limit: 50,
      cursor: '50',
    });

    expect(getRows).toHaveBeenCalledTimes(1);
    expect(getRows).toHaveBeenCalledWith(
      'collection-1',
      expect.objectContaining({
        include: ['files', 'multiSelect', 'relations'],
        filters: [{ columnId: 'status', operator: 'equals', value: 'published' }],
        sorts: [{ columnId: 'createdOn', direction: 'desc' }],
        limit: 50,
        offset: 50, // cursor decoded to absolute offset
        cursor: '50',
      }),
    );
    // The adapter's own cursor (absolute next offset) passes straight through.
    expect(page.nextCursor).toBe('100');
  });

  it('throws on an invalid cursor rather than silently ignoring it', async () => {
    await expect(
      getCmsRepository().listRows('collection-1', { cursor: 'not-a-number' }),
    ).rejects.toThrow(/invalid cursor/);
  });

  it('throws (does not swallow) on an unmappable cell value', async () => {
    getRows.mockResolvedValue({
      items: [
        {
          id: 'row-x',
          tableId: 'collection-1',
          cells: { weird: { nope: true } },
          archived: false,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
      ],
      total: 1,
      hasMore: false,
    });

    await expect(getCmsRepository().listRows('collection-1')).rejects.toThrow(
      /unmappable cell value/,
    );
  });
});

describe('CmsReadRepository.getRow collection guard', () => {
  it('returns the mapped row when it belongs to the requested collection', async () => {
    getRow.mockResolvedValue({
      id: 'row-1',
      tableId: 'collection-1',
      cells: { title: 'In collection' },
      archived: false,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    });

    const row = await getCmsRepository().getRow('collection-1', 'row-1');
    expect(row).not.toBeNull();
    expect(row?.values.title).toBe('In collection');
  });

  it('returns null when the row belongs to a different collection', async () => {
    getRow.mockResolvedValue({
      id: 'row-1',
      tableId: 'other-collection',
      cells: { title: 'Elsewhere' },
      archived: false,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    });

    const row = await getCmsRepository().getRow('collection-1', 'row-1');
    expect(row).toBeNull();
  });

  it('returns null when the adapter finds no row', async () => {
    getRow.mockResolvedValue(null);
    const row = await getCmsRepository().getRow('collection-1', 'missing');
    expect(row).toBeNull();
  });
});

describe('CmsReadRepository.listCollections / getCollection mapping', () => {
  it('maps tables to collections with derived slugs, mapped columns, and itemCount', async () => {
    listTables.mockResolvedValue([
      { id: 'collection-1', name: 'Blog Posts', workspaceId: 'test-workspace' },
    ]);
    getColumns.mockResolvedValue([
      { id: 'c1', tableId: 'collection-1', name: 'Title', type: 'text', position: 0 },
      { id: 'c2', tableId: 'collection-1', name: 'Tags', type: 'multi_select', position: 1 },
      { id: 'c3', tableId: 'collection-1', name: 'Link', type: 'url', position: 2 },
    ]);
    // listCollections now fetches a count per table via getRows (limit:1).
    getRows.mockResolvedValue({ items: [], total: 5, hasMore: false });

    const collections = await getCmsRepository().listCollections();
    expect(listTables).toHaveBeenCalledWith('test-workspace');
    expect(collections).toEqual([
      {
        id: 'collection-1',
        slug: 'blog-posts',
        name: 'Blog Posts',
        itemCount: 5,
        columns: [
          { id: 'c1', name: 'Title', type: 'text' },
          { id: 'c2', name: 'Tags', type: 'multi-select' },
          { id: 'c3', name: 'Link', type: 'text' }, // url -> text fallback
        ],
      },
    ]);
  });

  it('getCollection returns null when the table is missing', async () => {
    getTable.mockResolvedValue(null);
    const collection = await getCmsRepository().getCollection('nope');
    expect(collection).toBeNull();
  });
});
