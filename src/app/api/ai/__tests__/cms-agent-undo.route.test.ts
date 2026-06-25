// @vitest-environment node
//
// src/app/api/ai/__tests__/cms-agent-undo.route.test.ts
//
// Headless tests for POST /api/ai/cms-agent/undo. Replays recorded inverses in
// reverse `position` order against a mocked adapter; verifyAdminCookie runs for
// real. Prisma + adapter are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const ADMIN_SECRET = 'test-secret';

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

const authCookie = `admin_secret=${ADMIN_SECRET}`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRAMER_CLONE_ADMIN_SECRET = ADMIN_SECRET;
});

describe('POST /api/ai/cms-agent/undo', () => {
  it('returns 401 without an admin cookie', async () => {
    prisma.agentChange.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ runId: 'run1' }));
    expect(res.status).toBe(401);
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
