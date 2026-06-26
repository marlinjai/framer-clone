// @vitest-environment node
//
// src/app/api/ai/__tests__/cms-agent-undo.route.test.ts
//
// Headless tests for POST /api/ai/cms-agent/undo. Replays recorded inverses in
// reverse `position` order against a mocked adapter; the real auth-brain path
// runs (verifySession + can mocked, resolveActiveScope real). Prisma + adapter
// are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const adapter = vi.hoisted(() => ({
  deleteRow: vi.fn(),
  bulkDeleteRows: vi.fn(),
  updateRow: vi.fn(),
  unarchiveRow: vi.fn(),
  deleteColumn: vi.fn(),
  deleteSelectOption: vi.fn(),
}));

vi.mock('@/server/cms/adapterClient', () => ({ getCmsAdapter: () => adapter }));

const prisma = vi.hoisted(() => ({
  agentChange: { findMany: vi.fn() },
}));

vi.mock('@/server/db', () => ({ getPrismaClient: () => prisma }));

const mockVerifySession = vi.fn();
const mockCan = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: (...args: unknown[]) => mockCan(...args),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

function sessionA() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', group_id: 'tg_a' }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
    active_workspace: { id: 'ws_a' },
  };
}

import { POST } from '../cms-agent/undo/route';

function makeRequest(body: unknown, opts: { cookie?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return new Request('http://localhost/api/ai/cms-agent/undo', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const authCookie = 'lumitra_session=good';

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockResolvedValue(sessionA());
  mockCan.mockResolvedValue(true);
});

describe('POST /api/ai/cms-agent/undo', () => {
  it('returns 401 without a session cookie', async () => {
    prisma.agentChange.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ runId: 'run1' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user is not a workspace admin', async () => {
    mockCan.mockResolvedValue(false);
    prisma.agentChange.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ runId: 'run1' }, { cookie: authCookie }));
    expect(res.status).toBe(403);
  });

  it('replays inverses (already DESC) and returns the undone count', async () => {
    // findMany is ordered position DESC by the route; the mock returns that order.
    prisma.agentChange.findMany.mockResolvedValue([
      { tool: 'update_row', inverseTool: 'updateRow', inversePayload: { rowId: 'r2', previousCells: { c1: 'b' } } },
      { tool: 'create_row', inverseTool: 'deleteRow', inversePayload: { rowId: 'r1' } },
    ]);
    const res = await POST(makeRequest({ runId: 'run1' }, { cookie: authCookie }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { undone: number; skipped: number; warnings: string[] };
    expect(json).toEqual({ undone: 2, skipped: 0, warnings: [] });

    expect(prisma.agentChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { position: 'desc' } }),
    );
    // Reverse order: the updateRow inverse runs before the deleteRow inverse.
    expect(adapter.updateRow.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.deleteRow.mock.invocationCallOrder[0],
    );
  });

  it('replays an archive inverse via unarchiveRow', async () => {
    prisma.agentChange.findMany.mockResolvedValue([
      { tool: 'archive_row', inverseTool: 'unarchiveRow', inversePayload: { rowId: 'r9' } },
    ]);
    await POST(makeRequest({ runId: 'run1' }, { cookie: authCookie }));
    expect(adapter.unarchiveRow).toHaveBeenCalledWith('r9');
  });

  it('replays an update inverse via updateRow with previousCells', async () => {
    prisma.agentChange.findMany.mockResolvedValue([
      { tool: 'update_row', inverseTool: 'updateRow', inversePayload: { rowId: 'r3', previousCells: { c1: 'old' } } },
    ]);
    await POST(makeRequest({ runId: 'run1' }, { cookie: authCookie }));
    expect(adapter.updateRow).toHaveBeenCalledWith('r3', { c1: 'old' });
  });

  it('returns a partial result with a warning when an inverse throws', async () => {
    adapter.deleteRow.mockRejectedValue(new Error('row is referenced'));
    prisma.agentChange.findMany.mockResolvedValue([
      { tool: 'create_row', inverseTool: 'deleteRow', inversePayload: { rowId: 'r1' } },
      { tool: 'archive_row', inverseTool: 'unarchiveRow', inversePayload: { rowId: 'r2' } },
    ]);
    const res = await POST(makeRequest({ runId: 'run1' }, { cookie: authCookie }));
    const json = (await res.json()) as { undone: number; skipped: number; warnings: string[] };
    expect(json.undone).toBe(0);
    expect(json.skipped).toBe(2);
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0]).toContain('row is referenced');
  });
});
