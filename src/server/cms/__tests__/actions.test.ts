import { describe, it, expect, vi, beforeEach } from 'vitest';

// The CMS server actions carry a TWO-layer gate: requireWorkspaceScope (mocked
// here to a workspace-A admin) AND the data-layer workspaceGuard (kept REAL), so
// these tests prove the actual end-to-end isolation contract without a database:
//   - a mutating action resolves its workspace from the SESSION scope and lands
//     a create in THAT workspace,
//   - a write whose target entity belongs to ANOTHER workspace is rejected (403)
//     and never reaches the adapter — the core MT-14 isolation guarantee,
//   - a rejected scope (no session / not permitted / auth-brain or OpenFGA
//     unavailable) comes back as a structured { ok: false, code } result, never
//     a silent no-op, while an unexpected error still throws,
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
  listTables: vi.fn(),
  getRows: vi.fn(),
  getViews: vi.fn(),
  getRelatedRows: vi.fn(),
  getRelationsForRow: vi.fn(),
  getFileReferences: vi.fn(),
  createRow: vi.fn(),
  bulkCreateRows: vi.fn(),
  reorderColumns: vi.fn(),
  reorderSelectOptions: vi.fn(),
  reorderFileReferences: vi.fn(),
  reorderViews: vi.fn(),
  createRelation: vi.fn(),
  deleteRelation: vi.fn(),
  addFileReference: vi.fn(),
};

// The real owning-workspace resolution the fake adapter answers with.
const getTableImpl = async (id: string) =>
  tableWorkspace[id] ? { id, workspaceId: tableWorkspace[id], name: id } : null;

// The request Host every action sees through next/headers. With EDITOR_HOST
// unset every host counts as the editor host (src/lib/editorHost.ts), so the
// default keeps the existing tests on the editor plane.
let requestHost = 'localhost:3000';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: requestHost }),
}));

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
vi.mock('@/server/auth/requireWorkspaceScope', async (importActual) => {
  // The REAL AuthError (its codes are what the action results carry); only the
  // session guard itself is replaced.
  const actual = await importActual<typeof import('@/server/auth/requireWorkspaceScope')>();
  return {
    AuthError: actual.AuthError,
    requireWorkspaceScope: (...args: unknown[]) => requireWorkspaceScope(...args),
  };
});

import {
  ensureStatusField,
  createTable as createTableAction,
  updateRow as updateRowAction,
  getTable as getTableAction,
  listTables as listTablesAction,
  getColumns as getColumnsAction,
  getColumn as getColumnAction,
  getSelectOptions as getSelectOptionsAction,
  getRow as getRowAction,
  getRows as getRowsAction,
  getRelatedRows as getRelatedRowsAction,
  getRelationsForRow as getRelationsForRowAction,
  getFileReferences as getFileReferencesAction,
  getViews as getViewsAction,
  getView as getViewAction,
  createRow as createRowAction,
  bulkCreateRows as bulkCreateRowsAction,
  reorderColumns as reorderColumnsAction,
  reorderSelectOptions as reorderSelectOptionsAction,
  reorderFileReferences as reorderFileReferencesAction,
  reorderViews as reorderViewsAction,
  createRelation as createRelationAction,
  deleteRelation as deleteRelationAction,
  addFileReference as addFileReferenceAction,
} from '../actions';
import { AuthError } from '@/server/auth/requireWorkspaceScope';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  requestHost = 'localhost:3000';
  adapter.getTable.mockImplementation(getTableImpl);
  adapter.getColumns.mockResolvedValue([]);
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

  it('returns { ok: true, value } on success', async () => {
    const table = { id: 't1', workspaceId: 'ws_a', name: 'Events' };
    adapter.createTable.mockResolvedValue(table);
    await expect(createTableAction({ workspaceId: 'ws_a', name: 'Events' })).resolves.toEqual({
      ok: true,
      value: table,
    });
  });

  it.each([
    [new AuthError(401, 'authentication required'), 'unauthorized', /session has expired/],
    [new AuthError(403, 'forbidden'), 'forbidden', /do not have permission/],
    [
      new AuthError(403, 'no active company', 'no_active_company'),
      'no_active_company',
      /No company is selected/,
    ],
    [
      new AuthError(403, 'Lumitra Sites is not enabled for this company', 'sites_not_enabled'),
      'sites_not_enabled',
      /Lumitra Sites is not enabled/,
    ],
    [
      new AuthError(503, 'sign-in service unavailable, retry'),
      'auth_unavailable',
      /sign-in service is temporarily unavailable/,
    ],
    [
      new AuthError(503, 'permission service unavailable, retry', 'authz_unavailable'),
      'authz_unavailable',
      /permission service is temporarily unavailable/,
    ],
  ])(
    'returns an expected auth failure as a result, not a throw (%s)',
    async (rejection, code, message) => {
      requireWorkspaceScope.mockRejectedValue(rejection);
      const result = await createTableAction({ workspaceId: 'ws_a', name: 'Events' });
      expect(result).toEqual({ ok: false, code, message: expect.stringMatching(message) });
      expect(adapter.createTable).not.toHaveBeenCalled();
    },
  );

  it('still THROWS an unexpected error (a database failure is not an auth result)', async () => {
    adapter.createTable.mockRejectedValue(new Error('connection reset'));
    await expect(createTableAction({ workspaceId: 'ws_a', name: 'Events' })).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('CMS server actions — data-layer workspace isolation', () => {
  it('updates a row that belongs to the SESSION workspace', async () => {
    adapter.updateRow.mockResolvedValue({ id: 'row_a', tableId: 't_a', cells: { c1: 'x' } });
    const result = await updateRowAction('row_a', { c1: 'x' });
    expect(result.ok).toBe(true);
    expect(adapter.updateRow).toHaveBeenCalledWith('row_a', { c1: 'x' });
  });

  it('REJECTS a write to a row owned by ANOTHER workspace (forbidden) and never hits the adapter', async () => {
    // Session is workspace A; row_b is owned by workspace B.
    await expect(updateRowAction('row_b', { c1: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(adapter.updateRow).not.toHaveBeenCalled();
  });

  it('REJECTS a write to a non-existent row (existence is not leaked across the boundary)', async () => {
    await expect(updateRowAction('row_missing', { c1: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
    });
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
      ok: true,
      value: {
        columnId: 'c_status',
        options: { draft: 'opt_draft', published: 'opt_pub', scheduled: 'opt_sched' },
      },
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
      ok: true,
      value: { columnId: 'c_status', options: { draft: 'o1', published: 'o2', scheduled: 'o3' } },
    });
  });

  it('REJECTS ensureStatusField on a table owned by another workspace', async () => {
    adapter.getTable.mockResolvedValue({ id: 't_b', workspaceId: 'ws_b', name: 'Other' });
    await expect(ensureStatusField('t_b')).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    expect(adapter.createColumn).not.toHaveBeenCalled();
  });
});

describe('CMS server actions: editor-host only (decision D2)', () => {
  beforeEach(() => {
    vi.stubEnv('EDITOR_HOST', 'app.lumitra.co');
  });

  it('refuses a write on a published-site host before reading the session', async () => {
    requestHost = 'alpha.sites.lumitra.co';
    const result = await updateRowAction('row_a', { c1: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(requireWorkspaceScope).not.toHaveBeenCalled();
    expect(adapter.updateRow).not.toHaveBeenCalled();
  });

  it('refuses a read on a published-site host before reading the session', async () => {
    requestHost = 'alpha.sites.lumitra.co';
    await expect(getTableAction('t_a')).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    await expect(listTablesAction('ws_a')).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    await expect(getRowsAction('t_a')).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    expect(requireWorkspaceScope).not.toHaveBeenCalled();
    expect(adapter.getTable).not.toHaveBeenCalled();
    expect(adapter.listTables).not.toHaveBeenCalled();
    expect(adapter.getRows).not.toHaveBeenCalled();
  });

  it('serves the editor host', async () => {
    requestHost = 'app.lumitra.co';
    await expect(getTableAction('t_a')).resolves.toMatchObject({ ok: true });
    expect(requireWorkspaceScope).toHaveBeenCalledWith('viewSite');
  });
});

describe('CMS server actions: guarded reads', () => {
  it('checks viewSite (not editSite) on the active workspace for a read', async () => {
    await getTableAction('t_a');
    expect(requireWorkspaceScope).toHaveBeenCalledWith('viewSite');
  });

  it.each([
    ['getTable', () => getTableAction('t_a')],
    ['listTables', () => listTablesAction('ws_a')],
    ['getColumns', () => getColumnsAction('t_a')],
    ['getRow', () => getRowAction('row_a')],
    ['getRows', () => getRowsAction('t_a')],
    ['getViews', () => getViewsAction('t_a')],
  ])('%s without a session is an unauthorized result, never data', async (_name, call) => {
    requireWorkspaceScope.mockRejectedValue(new AuthError(401, 'authentication required'));
    await expect(call()).resolves.toMatchObject({ ok: false, code: 'unauthorized' });
    expect(adapter.listTables).not.toHaveBeenCalled();
    expect(adapter.getRows).not.toHaveBeenCalled();
    expect(adapter.getColumns).not.toHaveBeenCalled();
    expect(adapter.getViews).not.toHaveBeenCalled();
  });

  it('listTables lists the SESSION workspace and ignores the client-sent id', async () => {
    adapter.listTables.mockResolvedValue([{ id: 't_a', workspaceId: 'ws_a', name: 't_a' }]);
    const result = await listTablesAction('ws_b');
    expect(adapter.listTables).toHaveBeenCalledWith('ws_a');
    expect(adapter.listTables).not.toHaveBeenCalledWith('ws_b');
    expect(result).toEqual({ ok: true, value: [{ id: 't_a', workspaceId: 'ws_a', name: 't_a' }] });
  });

  it('reads an own table, row, rows page, columns and views', async () => {
    const page = { items: [{ id: 'row_a', tableId: 't_a', cells: {} }], total: 1, hasMore: false };
    adapter.getRows.mockResolvedValue(page);
    adapter.getColumns.mockResolvedValue([{ id: 'c1', tableId: 't_a' }]);
    adapter.getViews.mockResolvedValue([{ id: 'v1', tableId: 't_a' }]);

    await expect(getTableAction('t_a')).resolves.toEqual({
      ok: true,
      value: { id: 't_a', workspaceId: 'ws_a', name: 't_a' },
    });
    await expect(getRowAction('row_a')).resolves.toEqual({
      ok: true,
      value: { id: 'row_a', tableId: 't_a', cells: {} },
    });
    await expect(getRowsAction('t_a')).resolves.toEqual({ ok: true, value: page });
    await expect(getColumnsAction('t_a')).resolves.toEqual({
      ok: true,
      value: [{ id: 'c1', tableId: 't_a' }],
    });
    await expect(getViewsAction('t_a')).resolves.toEqual({
      ok: true,
      value: [{ id: 'v1', tableId: 't_a' }],
    });
  });

  it('answers another workspace\'s entities with the not-found shape and never reads them', async () => {
    adapter.getColumn.mockResolvedValue({ id: 'c_b', tableId: 't_b' });
    adapter.getView.mockResolvedValue({ id: 'v_b', tableId: 't_b' });

    await expect(getTableAction('t_b')).resolves.toEqual({ ok: true, value: null });
    await expect(getRowAction('row_b')).resolves.toEqual({ ok: true, value: null });
    await expect(getColumnAction('c_b')).resolves.toEqual({ ok: true, value: null });
    await expect(getViewAction('v_b')).resolves.toEqual({ ok: true, value: null });
    await expect(getRowsAction('t_b')).resolves.toEqual({
      ok: true,
      value: { items: [], total: 0, hasMore: false },
    });
    await expect(getColumnsAction('t_b')).resolves.toEqual({ ok: true, value: [] });
    await expect(getViewsAction('t_b')).resolves.toEqual({ ok: true, value: [] });
    await expect(getSelectOptionsAction('c_b')).resolves.toEqual({ ok: true, value: [] });
    await expect(getRelatedRowsAction('row_b', 'c_rel')).resolves.toEqual({ ok: true, value: [] });
    await expect(getRelationsForRowAction('row_b')).resolves.toEqual({ ok: true, value: [] });
    await expect(getFileReferencesAction('row_b', 'c_file')).resolves.toEqual({
      ok: true,
      value: [],
    });

    expect(adapter.getRows).not.toHaveBeenCalled();
    expect(adapter.getColumns).not.toHaveBeenCalled();
    expect(adapter.getViews).not.toHaveBeenCalled();
    expect(adapter.getSelectOptions).not.toHaveBeenCalled();
    expect(adapter.getRelatedRows).not.toHaveBeenCalled();
    expect(adapter.getRelationsForRow).not.toHaveBeenCalled();
    expect(adapter.getFileReferences).not.toHaveBeenCalled();
  });

  it('answers a missing entity with the same not-found shape as a foreign one', async () => {
    await expect(getTableAction('t_missing')).resolves.toEqual({ ok: true, value: null });
    await expect(getRowAction('row_missing')).resolves.toEqual({ ok: true, value: null });
    await expect(getRowsAction('t_missing')).resolves.toEqual({
      ok: true,
      value: { items: [], total: 0, hasMore: false },
    });
  });

  it('drops related rows whose own table is outside the workspace', async () => {
    adapter.getRelatedRows.mockResolvedValue([
      { id: 'row_a2', tableId: 't_a', cells: {} },
      { id: 'row_b', tableId: 't_b', cells: {} },
    ]);
    await expect(getRelatedRowsAction('row_a', 'c_rel')).resolves.toEqual({
      ok: true,
      value: [{ id: 'row_a2', tableId: 't_a', cells: {} }],
    });
  });
});

// Ownership of the ids a write STORES (a reorder's children, a parent row, a
// select option, a relation's column and target), not only of the entity it
// writes to. Workspace A owns t_a / t_a2 (rows row_a, row_a2); B owns t_b.
describe('CMS server actions: stored-id ownership', () => {
  beforeEach(() => {
    tableWorkspace.t_a2 = 'ws_a';
    rowTable.row_a2 = 't_a2';
    adapter.getColumns.mockImplementation(async (tableId: string) =>
      tableId === 't_a'
        ? [
            { id: 'c_sel', tableId: 't_a', type: 'select' },
            { id: 'c_multi', tableId: 't_a', type: 'multi_select' },
            { id: 'c_text', tableId: 't_a', type: 'text' },
          ]
        : tableId === 't_b'
          ? [{ id: 'c_b', tableId: 't_b', type: 'select' }]
          : [],
    );
    adapter.getSelectOptions.mockImplementation(async (columnId: string) =>
      columnId === 'c_sel'
        ? [{ id: 'opt_a1' }, { id: 'opt_a2' }]
        : columnId === 'c_multi'
          ? [{ id: 'opt_m1' }, { id: 'opt_m2' }]
          : columnId === 'c_b'
            ? [{ id: 'opt_b' }]
            : [],
    );
    adapter.getColumn.mockImplementation(async (id: string) => {
      const columns: Record<string, unknown> = {
        c_rel: { id: 'c_rel', tableId: 't_a', type: 'relation', config: { targetTableId: 't_a2' } },
        c_rel_open: { id: 'c_rel_open', tableId: 't_a', type: 'relation' },
        c_text: { id: 'c_text', tableId: 't_a', type: 'text' },
        c_rel_b: { id: 'c_rel_b', tableId: 't_b', type: 'relation' },
        c_file: { id: 'c_file', tableId: 't_a', type: 'file' },
        c_sel: { id: 'c_sel', tableId: 't_a', type: 'select' },
      };
      return columns[id] ?? null;
    });
    adapter.getViews.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }]);
    adapter.getFileReferences.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]);
  });

  describe('reorders name only the parent\'s own children', () => {
    it('reorders own columns, refuses the whole call with one foreign id', async () => {
      await expect(reorderColumnsAction('t_a', ['c_text', 'c_sel'])).resolves.toMatchObject({ ok: true });
      expect(adapter.reorderColumns).toHaveBeenCalledWith('t_a', ['c_text', 'c_sel']);
      adapter.reorderColumns.mockClear();
      await expect(reorderColumnsAction('t_a', ['c_text', 'c_b'])).resolves.toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(adapter.reorderColumns).not.toHaveBeenCalled();
    });

    it('reorderSelectOptions refuses an option of another column', async () => {
      await expect(reorderSelectOptionsAction('c_sel', ['opt_a2', 'opt_a1'])).resolves.toMatchObject({ ok: true });
      await expect(reorderSelectOptionsAction('c_sel', ['opt_a1', 'opt_b'])).resolves.toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(adapter.reorderSelectOptions).toHaveBeenCalledTimes(1);
    });

    it('reorderFileReferences refuses a file that is not this row\'s in this column', async () => {
      await expect(reorderFileReferencesAction('row_a', 'c_file', ['f2', 'f1'])).resolves.toMatchObject({ ok: true });
      await expect(reorderFileReferencesAction('row_a', 'c_file', ['f1', 'f_other'])).resolves.toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(adapter.reorderFileReferences).toHaveBeenCalledTimes(1);
    });

    it('reorderViews refuses a view of another table', async () => {
      await expect(reorderViewsAction('t_a', ['v2', 'v1'])).resolves.toMatchObject({ ok: true });
      await expect(reorderViewsAction('t_a', ['v1', 'v_b'])).resolves.toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(adapter.reorderViews).toHaveBeenCalledTimes(1);
    });
  });

  describe('relations', () => {
    it('creates a relation through an own relation column into its target table', async () => {
      const input = { sourceRowId: 'row_a', sourceColumnId: 'c_rel', targetRowId: 'row_a2' };
      await expect(createRelationAction(input)).resolves.toMatchObject({ ok: true });
      expect(adapter.createRelation).toHaveBeenCalledWith(input);
    });

    it.each([
      ['a column of another table', { sourceRowId: 'row_a', sourceColumnId: 'c_rel_b', targetRowId: 'row_a2' }],
      ['a non-relation column', { sourceRowId: 'row_a', sourceColumnId: 'c_text', targetRowId: 'row_a2' }],
      ['an unknown column', { sourceRowId: 'row_a', sourceColumnId: 'c_nope', targetRowId: 'row_a2' }],
      ['a target outside the column\'s target table', { sourceRowId: 'row_a', sourceColumnId: 'c_rel', targetRowId: 'row_a' }],
      ['a target row of another workspace', { sourceRowId: 'row_a', sourceColumnId: 'c_rel_open', targetRowId: 'row_b' }],
    ])('refuses createRelation with %s', async (_label, input) => {
      await expect(createRelationAction(input)).resolves.toMatchObject({ ok: false, code: 'forbidden' });
      expect(adapter.createRelation).not.toHaveBeenCalled();
    });

    it('deleteRelation applies the same column and target checks', async () => {
      await expect(deleteRelationAction('row_a', 'c_rel', 'row_a2')).resolves.toMatchObject({ ok: true });
      await expect(deleteRelationAction('row_a', 'c_rel_b', 'row_a2')).resolves.toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(adapter.deleteRelation).toHaveBeenCalledTimes(1);
    });
  });

  describe('rows: parent row and select options', () => {
    it('creates a row with a parent of the same table and own options', async () => {
      const input = {
        tableId: 't_a',
        parentRowId: 'row_a',
        cells: { c_sel: 'opt_a1', c_multi: ['opt_m1', 'opt_m2'], c_text: 'free text' },
      };
      await expect(createRowAction(input)).resolves.toMatchObject({ ok: true });
      expect(adapter.createRow).toHaveBeenCalledWith(input);
    });

    it.each([
      ['a parent row of another table', { tableId: 't_a', parentRowId: 'row_a2' }],
      ['a parent row of another workspace', { tableId: 't_a', parentRowId: 'row_b' }],
      ['a select option of another column', { tableId: 't_a', cells: { c_sel: 'opt_b' } }],
      ['a multi_select option of another column', { tableId: 't_a', cells: { c_multi: ['opt_m1', 'opt_a1'] } }],
      ['a non-string select value', { tableId: 't_a', cells: { c_sel: 42 } }],
    ])('refuses createRow with %s', async (_label, input) => {
      await expect(createRowAction(input as never)).resolves.toMatchObject({ ok: false, code: 'forbidden' });
      expect(adapter.createRow).not.toHaveBeenCalled();
    });

    it('bulkCreateRows refuses the whole batch when one row carries a foreign option', async () => {
      await expect(
        bulkCreateRowsAction([
          { tableId: 't_a', cells: { c_sel: 'opt_a1' } },
          { tableId: 't_a', cells: { c_sel: 'opt_b' } },
        ]),
      ).resolves.toMatchObject({ ok: false, code: 'forbidden' });
      expect(adapter.bulkCreateRows).not.toHaveBeenCalled();
    });

    it('updateRow allows own options and clearing, refuses a foreign option', async () => {
      adapter.updateRow.mockResolvedValue({ id: 'row_a', tableId: 't_a', cells: {} });
      await expect(updateRowAction('row_a', { c_sel: 'opt_a2' })).resolves.toMatchObject({ ok: true });
      await expect(updateRowAction('row_a', { c_sel: null })).resolves.toMatchObject({ ok: true });
      await expect(updateRowAction('row_a', { c_multi: ['opt_b'] })).resolves.toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(adapter.updateRow).toHaveBeenCalledTimes(2);
    });
  });

  it('addFileReference refuses a column of another table', async () => {
    const base = { rowId: 'row_a', fileId: 'f', fileUrl: 'u', originalName: 'n', mimeType: 'image/png' };
    await expect(addFileReferenceAction({ ...base, columnId: 'c_file' })).resolves.toMatchObject({ ok: true });
    await expect(addFileReferenceAction({ ...base, columnId: 'c_rel_b' })).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(adapter.addFileReference).toHaveBeenCalledTimes(1);
  });
});

