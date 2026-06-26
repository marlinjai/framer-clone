import { describe, it, expect, vi, beforeEach } from 'vitest';

// The CMS server actions carry a TWO-layer gate: requireWorkspaceScope (mocked
// here to a workspace-A admin) AND the data-layer workspaceGuard (kept REAL), so
// these tests prove the actual end-to-end isolation contract without a database:
//   - a mutating action resolves its workspace from the SESSION scope and lands
//     a create in THAT workspace,
//   - a write whose target entity belongs to ANOTHER workspace is rejected (403)
//     and never reaches the adapter — the core MT-14 isolation guarantee,
//   - a rejected scope (no session / not permitted) propagates as a thrown
//     action, never a silent no-op,
//   - ensureStatusField is idempotent.
//
// The adapter is faked; getTable/getRow return the OWNING workspace of an entity
// so the real guard can resolve ownership. The Prisma singleton is faked for the
// guard's select-option / file-reference scalar-FK reads.

const SCOPE_A = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };

// Tables live in these workspaces; getTable/getRow resolve through this map.
const tableWorkspace: Record<string, string> = {
  t_a: 'ws_a',
  t_b: 'ws_b',
};
const rowTable: Record<string, string> = {
  row_a: 't_a',
  row_b: 't_b',
};

const adapter = {
  createTable: vi.fn(),
  getTable: vi.fn(async (id: string) =>
    tableWorkspace[id] ? { id, workspaceId: tableWorkspace[id], name: id } : null,
  ),
  getRow: vi.fn(async (id: string) =>
    rowTable[id] ? { id, tableId: rowTable[id], cells: {} } : null,
  ),
  getColumn: vi.fn(),
  getView: vi.fn(),
  getColumns: vi.fn(),
  createColumn: vi.fn(),
  getSelectOptions: vi.fn(),
  createSelectOption: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
};

vi.mock('../adapterClient', () => ({
  CMS_SCHEMA: 'public',
  CMS_WORKSPACE_ID: 'test-ws',
  getCmsAdapter: () => adapter,
}));

const prisma = {
  selectOption: { findUnique: vi.fn() },
  dtFile: { findUnique: vi.fn() },
};
vi.mock('@/server/db', () => ({ getPrismaClient: () => prisma }));

const requireWorkspaceScope = vi.fn();
vi.mock('@/server/auth/requireWorkspaceScope', () => ({
  requireWorkspaceScope: (...args: unknown[]) => requireWorkspaceScope(...args),
  AuthError: class AuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  ensureStatusField,
  createTable as createTableAction,
  updateRow as updateRowAction,
} from '../actions';
import { AuthError } from '@/server/auth/requireWorkspaceScope';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: an authorized workspace-A session.
  requireWorkspaceScope.mockResolvedValue(SCOPE_A);
});

describe('CMS server actions — auth-brain workspace scope', () => {
  it('guards a mutating action with requireWorkspaceScope("editSite")', async () => {
    adapter.createTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a', name: 'Events' });
    await createTableAction({ workspaceId: 'ignored-by-server', name: 'Events' });
    expect(requireWorkspaceScope).toHaveBeenCalledWith('editSite');
  });

  it('creates a table in the SESSION workspace, never the client-supplied one', async () => {
    adapter.createTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a', name: 'Events' });
    await createTableAction({ workspaceId: 'attacker-ws', name: 'Events' });
    expect(adapter.createTable).toHaveBeenCalledWith({ workspaceId: 'ws_a', name: 'Events' });
  });

  it('propagates an auth rejection as a thrown action (never a silent no-op)', async () => {
    requireWorkspaceScope.mockRejectedValue(new AuthError(401, 'authentication required'));
    await expect(createTableAction({ workspaceId: 'ws_a', name: 'Events' })).rejects.toThrow(
      /authentication required/,
    );
    expect(adapter.createTable).not.toHaveBeenCalled();
  });
});

describe('CMS server actions — data-layer workspace isolation', () => {
  it('updates a row that belongs to the SESSION workspace', async () => {
    adapter.updateRow.mockResolvedValue({ id: 'row_a', tableId: 't_a', cells: { c1: 'x' } });
    await updateRowAction('row_a', { c1: 'x' });
    expect(adapter.updateRow).toHaveBeenCalledWith('row_a', { c1: 'x' });
  });

  it('REJECTS a write to a row owned by ANOTHER workspace (403) and never hits the adapter', async () => {
    // Session is workspace A; row_b is owned by workspace B.
    await expect(updateRowAction('row_b', { c1: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(adapter.updateRow).not.toHaveBeenCalled();
  });

  it('REJECTS a write to a non-existent row (existence is not leaked across the boundary)', async () => {
    await expect(updateRowAction('row_missing', { c1: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(adapter.updateRow).not.toHaveBeenCalled();
  });
});

describe('ensureStatusField', () => {
  beforeEach(() => {
    // The target table belongs to the session workspace so the ownership guard
    // passes; the status-field behavior is what these assert.
    adapter.getTable.mockResolvedValue({ id: 't_a', workspaceId: 'ws_a', name: 'Events' });
  });

  it('creates a Status select column + Draft/Published/Scheduled options (engine palette colors) when absent', async () => {
    adapter.getColumns.mockResolvedValue([]);
    adapter.createColumn.mockResolvedValue({ id: 'c_status', tableId: 't_a', name: 'Status', type: 'select' });
    adapter.getSelectOptions.mockResolvedValue([]);
    adapter.createSelectOption
      .mockResolvedValueOnce({ id: 'opt_draft' })
      .mockResolvedValueOnce({ id: 'opt_pub' })
      .mockResolvedValueOnce({ id: 'opt_sched' });

    const result = await ensureStatusField('t_a');

    expect(requireWorkspaceScope).toHaveBeenCalledWith('editSite');
    expect(adapter.createColumn).toHaveBeenCalledWith({ tableId: 't_a', name: 'Status', type: 'select' });
    expect(adapter.createSelectOption).toHaveBeenCalledWith({ columnId: 'c_status', name: 'Draft', color: 'orange' });
    expect(adapter.createSelectOption).toHaveBeenCalledWith({ columnId: 'c_status', name: 'Published', color: 'green' });
    expect(adapter.createSelectOption).toHaveBeenCalledWith({ columnId: 'c_status', name: 'Scheduled', color: 'blue' });
    expect(result).toEqual({
      columnId: 'c_status',
      options: { draft: 'opt_draft', published: 'opt_pub', scheduled: 'opt_sched' },
    });
  });

  it('is idempotent: reuses the existing Status column + options, creating no duplicates', async () => {
    adapter.getColumns.mockResolvedValue([{ id: 'c_status', name: 'Status', type: 'select' }]);
    adapter.getSelectOptions.mockResolvedValue([
      { id: 'o1', name: 'Draft', color: 'orange' },
      { id: 'o2', name: 'Published', color: 'green' },
      { id: 'o3', name: 'Scheduled', color: 'blue' },
    ]);

    const result = await ensureStatusField('t_a');

    expect(adapter.createColumn).not.toHaveBeenCalled();
    expect(adapter.createSelectOption).not.toHaveBeenCalled();
    expect(result).toEqual({
      columnId: 'c_status',
      options: { draft: 'o1', published: 'o2', scheduled: 'o3' },
    });
  });

  it('REJECTS ensureStatusField on a table owned by another workspace', async () => {
    adapter.getTable.mockResolvedValue({ id: 't_b', workspaceId: 'ws_b', name: 'Other' });
    await expect(ensureStatusField('t_b')).rejects.toMatchObject({ status: 403 });
    expect(adapter.createColumn).not.toHaveBeenCalled();
  });
});
