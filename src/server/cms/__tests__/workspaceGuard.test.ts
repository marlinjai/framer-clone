import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the data-layer workspace-ownership guard. The adapter (the
// storage source of truth for table/column/row/view resolution) and the Prisma
// singleton (the scalar-FK reads for select-option / file-reference owners) are
// mocked, so these assert the resolve-and-reject contract directly:
//   - an entity in the active workspace is allowed,
//   - an entity in another workspace is a 403,
//   - a missing entity is also a 403 (existence is never leaked across tenants).

const adapter = {
  getTable: vi.fn(),
  getColumn: vi.fn(),
  getRow: vi.fn(),
  getView: vi.fn(),
};
vi.mock('../adapterClient', () => ({ getCmsAdapter: () => adapter }));

const prisma = {
  selectOption: { findUnique: vi.fn() },
  dtFile: { findUnique: vi.fn() },
};
vi.mock('@/server/db', () => ({ getPrismaClient: () => prisma }));

import {
  assertTableInWorkspace,
  assertColumnInWorkspace,
  assertRowInWorkspace,
  assertRowsInWorkspace,
  assertViewInWorkspace,
  assertSelectOptionInWorkspace,
  assertFileReferenceInWorkspace,
} from '../workspaceGuard';

const WS = 'ws_a';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertTableInWorkspace', () => {
  it('allows a table owned by the workspace', async () => {
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a' });
    await expect(assertTableInWorkspace('t1', WS)).resolves.toBeUndefined();
  });
  it('rejects a table owned by another workspace (403)', async () => {
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_b' });
    await expect(assertTableInWorkspace('t1', WS)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a missing table (403)', async () => {
    adapter.getTable.mockResolvedValue(null);
    await expect(assertTableInWorkspace('nope', WS)).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertColumnInWorkspace', () => {
  it('resolves column -> table -> workspace and allows a match', async () => {
    adapter.getColumn.mockResolvedValue({ id: 'c1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a' });
    await expect(assertColumnInWorkspace('c1', WS)).resolves.toBeUndefined();
  });
  it('rejects a column whose table is in another workspace', async () => {
    adapter.getColumn.mockResolvedValue({ id: 'c1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_b' });
    await expect(assertColumnInWorkspace('c1', WS)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a missing column', async () => {
    adapter.getColumn.mockResolvedValue(null);
    await expect(assertColumnInWorkspace('nope', WS)).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertRowInWorkspace / assertRowsInWorkspace', () => {
  it('resolves row -> table -> workspace and allows a match', async () => {
    adapter.getRow.mockResolvedValue({ id: 'r1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a' });
    await expect(assertRowInWorkspace('r1', WS)).resolves.toBeUndefined();
  });
  it('rejects a row owned by another workspace', async () => {
    adapter.getRow.mockResolvedValue({ id: 'r1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_b' });
    await expect(assertRowInWorkspace('r1', WS)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects the whole batch if ANY row is foreign', async () => {
    adapter.getRow.mockImplementation(async (id: string) => ({ id, tableId: id === 'r_b' ? 't_b' : 't_a' }));
    adapter.getTable.mockImplementation(async (id: string) => ({
      id,
      workspaceId: id === 't_b' ? 'ws_b' : 'ws_a',
    }));
    await expect(assertRowsInWorkspace(['r_a', 'r_b'], WS)).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertViewInWorkspace', () => {
  it('resolves view -> table -> workspace', async () => {
    adapter.getView.mockResolvedValue({ id: 'v1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a' });
    await expect(assertViewInWorkspace('v1', WS)).resolves.toBeUndefined();
  });
  it('rejects a view in another workspace', async () => {
    adapter.getView.mockResolvedValue({ id: 'v1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_b' });
    await expect(assertViewInWorkspace('v1', WS)).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertSelectOptionInWorkspace (scalar-FK -> column -> table)', () => {
  it('allows an option whose column-table is in the workspace', async () => {
    prisma.selectOption.findUnique.mockResolvedValue({ columnId: 'c1' });
    adapter.getColumn.mockResolvedValue({ id: 'c1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a' });
    await expect(assertSelectOptionInWorkspace('opt1', WS)).resolves.toBeUndefined();
  });
  it('rejects an option in another workspace', async () => {
    prisma.selectOption.findUnique.mockResolvedValue({ columnId: 'c1' });
    adapter.getColumn.mockResolvedValue({ id: 'c1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_b' });
    await expect(assertSelectOptionInWorkspace('opt1', WS)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a missing option', async () => {
    prisma.selectOption.findUnique.mockResolvedValue(null);
    await expect(assertSelectOptionInWorkspace('nope', WS)).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertFileReferenceInWorkspace (scalar-FK -> row -> table)', () => {
  it('allows a file ref whose row-table is in the workspace', async () => {
    prisma.dtFile.findUnique.mockResolvedValue({ rowId: 'r1' });
    adapter.getRow.mockResolvedValue({ id: 'r1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_a' });
    await expect(assertFileReferenceInWorkspace('f1', WS)).resolves.toBeUndefined();
  });
  it('rejects a file ref in another workspace', async () => {
    prisma.dtFile.findUnique.mockResolvedValue({ rowId: 'r1' });
    adapter.getRow.mockResolvedValue({ id: 'r1', tableId: 't1' });
    adapter.getTable.mockResolvedValue({ id: 't1', workspaceId: 'ws_b' });
    await expect(assertFileReferenceInWorkspace('f1', WS)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a missing file ref', async () => {
    prisma.dtFile.findUnique.mockResolvedValue(null);
    await expect(assertFileReferenceInWorkspace('nope', WS)).rejects.toMatchObject({ status: 403 });
  });
});
