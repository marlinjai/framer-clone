import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the adapter client + admin guard so the server action runs against a fake
// adapter (no Prisma, no next/headers cookies). We test the ensure-status-field
// contract: it creates a "Status" select column with Draft/Published/Scheduled
// options in the engine's palette colors, and is idempotent.
const getColumns = vi.fn();
const createColumn = vi.fn();
const getSelectOptions = vi.fn();
const createSelectOption = vi.fn();

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-ws',
  getCmsAdapter: () => ({ getColumns, createColumn, getSelectOptions, createSelectOption }),
}));
vi.mock('@/server/auth/adminAction', () => ({
  requireAdminAction: vi.fn().mockResolvedValue(undefined),
}));

import { ensureStatusField } from '../actions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureStatusField', () => {
  it('creates a Status select column + Draft/Published/Scheduled options (engine palette colors) when absent', async () => {
    getColumns.mockResolvedValue([]);
    createColumn.mockResolvedValue({ id: 'c_status', tableId: 't1', name: 'Status', type: 'select' });
    getSelectOptions.mockResolvedValue([]);
    createSelectOption
      .mockResolvedValueOnce({ id: 'opt_draft' })
      .mockResolvedValueOnce({ id: 'opt_pub' })
      .mockResolvedValueOnce({ id: 'opt_sched' });

    const result = await ensureStatusField('t1');

    expect(createColumn).toHaveBeenCalledWith({ tableId: 't1', name: 'Status', type: 'select' });
    expect(createSelectOption).toHaveBeenCalledWith({ columnId: 'c_status', name: 'Draft', color: 'orange' });
    expect(createSelectOption).toHaveBeenCalledWith({ columnId: 'c_status', name: 'Published', color: 'green' });
    expect(createSelectOption).toHaveBeenCalledWith({ columnId: 'c_status', name: 'Scheduled', color: 'blue' });
    expect(result).toEqual({
      columnId: 'c_status',
      options: { draft: 'opt_draft', published: 'opt_pub', scheduled: 'opt_sched' },
    });
  });

  it('is idempotent: reuses the existing Status column + options, creating no duplicates', async () => {
    getColumns.mockResolvedValue([{ id: 'c_status', name: 'Status', type: 'select' }]);
    getSelectOptions.mockResolvedValue([
      { id: 'o1', name: 'Draft', color: 'orange' },
      { id: 'o2', name: 'Published', color: 'green' },
      { id: 'o3', name: 'Scheduled', color: 'blue' },
    ]);

    const result = await ensureStatusField('t1');

    expect(createColumn).not.toHaveBeenCalled();
    expect(createSelectOption).not.toHaveBeenCalled();
    expect(result).toEqual({
      columnId: 'c_status',
      options: { draft: 'o1', published: 'o2', scheduled: 'o3' },
    });
  });
});
