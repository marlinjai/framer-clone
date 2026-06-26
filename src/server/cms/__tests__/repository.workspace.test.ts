import { describe, it, expect, vi, beforeEach } from 'vitest';

// MT-03: the repository factory is parameterized by workspaceId. We mock the
// adapter so the bound repo runs against a fake adapter (no Prisma, no live DB)
// and assert that the workspaceId passed to getCmsRepository / getCmsWriteRepository
// is the one threaded into the workspace-scoped adapter calls (listTables,
// createTable) — NOT the module constant. The no-arg default must still be
// CMS_WORKSPACE_ID.
const listTables = vi.fn();
const getColumns = vi.fn();
const getRows = vi.fn();
const createTable = vi.fn();

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-workspace',
  getCmsAdapter: () => ({ listTables, getColumns, getRows, createTable }),
}));

import { getCmsRepository, getCmsWriteRepository } from '../repository';
import { CMS_WORKSPACE_ID } from '../adapterClient';

beforeEach(() => {
  vi.clearAllMocks();
  listTables.mockResolvedValue([]);
  getColumns.mockResolvedValue([]);
  getRows.mockResolvedValue({ items: [], total: 0 });
});

describe('getCmsRepository(workspaceId) — read isolation', () => {
  it('threads workspaceId "ws-a" into adapter.listTables', async () => {
    await getCmsRepository('ws-a').listCollections();
    expect(listTables).toHaveBeenCalledWith('ws-a');
  });

  it('threads a DIFFERENT workspaceId "ws-b" into adapter.listTables', async () => {
    await getCmsRepository('ws-b').listCollections();
    expect(listTables).toHaveBeenCalledWith('ws-b');
  });

  it('isolates listTables results between two workspaces', async () => {
    listTables.mockImplementation((ws: string) =>
      ws === 'ws-a'
        ? Promise.resolve([{ id: 't_a', name: 'A', workspaceId: 'ws-a' }])
        : Promise.resolve([{ id: 't_b', name: 'B', workspaceId: 'ws-b' }]),
    );

    const a = await getCmsRepository('ws-a').listCollections();
    const b = await getCmsRepository('ws-b').listCollections();

    expect(a.map((c) => c.id)).toEqual(['t_a']);
    expect(b.map((c) => c.id)).toEqual(['t_b']);
  });

  it('defaults to CMS_WORKSPACE_ID when no workspaceId is passed', async () => {
    await getCmsRepository().listCollections();
    expect(listTables).toHaveBeenCalledWith(CMS_WORKSPACE_ID);
  });
});

describe('getCmsWriteRepository(workspaceId) — write isolation', () => {
  it('threads workspaceId into the createCollection uniqueness check + createTable', async () => {
    createTable.mockResolvedValue({ id: 't_x', name: 'X', workspaceId: 'ws-a' });

    await getCmsWriteRepository('ws-a').createCollection('X');

    expect(listTables).toHaveBeenCalledWith('ws-a');
    expect(createTable).toHaveBeenCalledWith({ workspaceId: 'ws-a', name: 'X' });
  });

  it('defaults createTable to CMS_WORKSPACE_ID when no workspaceId is passed', async () => {
    createTable.mockResolvedValue({
      id: 't_x',
      name: 'X',
      workspaceId: CMS_WORKSPACE_ID,
    });

    await getCmsWriteRepository().createCollection('X');

    expect(listTables).toHaveBeenCalledWith(CMS_WORKSPACE_ID);
    expect(createTable).toHaveBeenCalledWith({
      workspaceId: CMS_WORKSPACE_ID,
      name: 'X',
    });
  });
});
