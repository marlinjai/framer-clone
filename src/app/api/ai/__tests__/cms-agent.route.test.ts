// @vitest-environment node
//
// src/app/api/ai/__tests__/cms-agent.route.test.ts
//
// Headless tests for POST /api/ai/cms-agent. The Anthropic client, the CMS
// adapter, and the Prisma singleton are all mocked (msw is not installed; direct
// vi.mock is the repo pattern). The real auth-brain path is exercised: the
// auth-brain client (verifySession + can) is mocked while resolveActiveScope is
// kept REAL, so the session -> scope -> permission contract runs for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Scriptable Anthropic client -------------------------------------------
const anthropicState = vi.hoisted(() => ({
  // Each entry is the `finalMessage()` for one stream() call, in order.
  turns: [] as Array<{ content: unknown[]; stop_reason: string }>,
  // The inner non-streaming Haiku reply (translate/generate); JSON text.
  innerJson: '[]',
}));

function makeClient() {
  let turnIndex = 0;
  return {
    messages: {
      stream: () => ({
        on() {
          return this;
        },
        finalMessage: async () => {
          const turn = anthropicState.turns[turnIndex++] ?? { content: [], stop_reason: 'end_turn' };
          return {
            ...turn,
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          };
        },
      }),
      create: async () => ({ content: [{ type: 'text', text: anthropicState.innerJson }] }),
    },
  };
}

vi.mock('@/lib/ai/anthropicClient', () => ({
  AI_MODELS: { HAIKU: 'claude-haiku-4-5', SONNET: 'claude-sonnet-4-6', OPUS: 'claude-opus-4-8' },
  getAnthropicClient: () => makeClient(),
  MissingAnthropicKeyError: class extends Error {},
  resolveModelId: (key: 'HAIKU' | 'SONNET' | 'OPUS') =>
    ({ HAIKU: 'claude-haiku-4-5', SONNET: 'claude-sonnet-4-6', OPUS: 'claude-opus-4-8' })[key],
}));

// --- Adapter mock ----------------------------------------------------------
const adapter = vi.hoisted(() => ({
  listTables: vi.fn(),
  getTable: vi.fn(),
  getColumns: vi.fn(),
  getSelectOptions: vi.fn(),
  getRow: vi.fn(),
  getRows: vi.fn(),
  createRow: vi.fn(),
  bulkCreateRows: vi.fn(),
  updateRow: vi.fn(),
  archiveRow: vi.fn(),
  unarchiveRow: vi.fn(),
  bulkArchiveRows: vi.fn(),
  deleteRow: vi.fn(),
  bulkDeleteRows: vi.fn(),
  createColumn: vi.fn(),
  deleteColumn: vi.fn(),
  createSelectOption: vi.fn(),
  deleteSelectOption: vi.fn(),
}));

vi.mock('@/server/cms/adapterClient', () => ({ getCmsAdapter: () => adapter }));

// --- Prisma mock -----------------------------------------------------------
const prisma = vi.hoisted(() => ({
  agentRun: { create: vi.fn(), update: vi.fn() },
  agentChange: { create: vi.fn() },
}));

vi.mock('@/server/db', () => ({ getPrismaClient: () => prisma }));

// --- auth-brain mock (verifySession + can); resolveActiveScope stays real -----
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

import { POST } from '../cms-agent/route';

// --- Helpers ---------------------------------------------------------------
function makeRequest(body: unknown, opts: { cookie?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return new Request('http://localhost/api/ai/cms-agent', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const authCookie = 'lumitra_session=good';

async function readStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) out += decoder.decode(chunk.value, { stream: true });
  }
  return out;
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return { collectionId: 't1', workspaceId: 'ws1', prompt: 'do it', model: 'OPUS', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockResolvedValue(sessionA());
  mockCan.mockResolvedValue(true);
  anthropicState.turns = [{ content: [], stop_reason: 'end_turn' }];
  anthropicState.innerJson = '[]';
  adapter.getTable.mockResolvedValue({ id: 't1', name: 'Events' });
  adapter.getColumns.mockResolvedValue([]);
  adapter.getRows.mockResolvedValue({ items: [], total: 0, hasMore: false });
  prisma.agentRun.create.mockResolvedValue({ id: 'run1' });
  prisma.agentRun.update.mockResolvedValue({});
  prisma.agentChange.create.mockResolvedValue({});
});

describe('POST /api/ai/cms-agent auth + validation', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the session fails to verify', async () => {
    mockVerifySession.mockResolvedValue(null);
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user is not a workspace admin', async () => {
    mockCan.mockResolvedValue(false);
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when collectionId is missing', async () => {
    const res = await POST(
      makeRequest({ workspaceId: 'ws1', prompt: 'hi' }, { cookie: authCookie }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when csvPayload exceeds the size cap', async () => {
    const big = 'a'.repeat(4_000_001);
    const res = await POST(
      makeRequest(baseBody({ csvPayload: { name: 'big.csv', content: big } }), {
        cookie: authCookie,
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('csv_too_large');
  });
});

describe('POST /api/ai/cms-agent streaming', () => {
  it('streams agent:done with empty changes on an immediate end_turn', async () => {
    anthropicState.turns = [{ content: [{ type: 'text', text: 'nothing to do' }], stop_reason: 'end_turn' }];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    expect(res.status).toBe(200);
    const body = await readStream(res);
    expect(body).toContain('event: agent:done');
    expect(body).toContain('"changes":[]');
  });

  it('dispatches a create_row tool call to the adapter and streams tool events', async () => {
    adapter.createRow.mockResolvedValue({ id: 'row1', tableId: 't1', cells: { c1: 'x' } });
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'create_row', input: { tableId: 't1', cells: { c1: 'x' } } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    const body = await readStream(res);
    expect(adapter.createRow).toHaveBeenCalledWith({ tableId: 't1', cells: { c1: 'x' } });
    expect(body).toContain('event: agent:tool_call');
    expect(body).toContain('event: agent:tool_result');
    expect(body).toContain('event: agent:done');
  });

  it('reads the row BEFORE updating it and captures previous cells in the inverse', async () => {
    adapter.getRow.mockResolvedValue({ id: 'row1', tableId: 't1', cells: { c1: 'old' } });
    adapter.updateRow.mockResolvedValue({ id: 'row1', tableId: 't1', cells: { c1: 'new' } });
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'update_row', input: { rowId: 'row1', cells: { c1: 'new' } } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    await readStream(res);

    const getOrder = adapter.getRow.mock.invocationCallOrder[0];
    const updateOrder = adapter.updateRow.mock.invocationCallOrder[0];
    expect(getOrder).toBeLessThan(updateOrder);

    const changeData = prisma.agentChange.create.mock.calls[0][0].data;
    expect(changeData.inverseTool).toBe('updateRow');
    expect(changeData.inversePayload).toEqual({ rowId: 'row1', previousCells: { c1: 'old' } });
  });

  it('persists the AgentRun as running then updates it to done', async () => {
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    await readStream(res);
    expect(prisma.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) }),
    );
    expect(prisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'done' }) }),
    );
  });

  it('surfaces agent:error and marks the run failed when the adapter throws', async () => {
    adapter.bulkCreateRows.mockRejectedValue(new Error('db exploded'));
    anthropicState.turns = [
      {
        content: [
          { type: 'tool_use', id: 'tu1', name: 'bulk_create_rows', input: { tableId: 't1', rows: [{ c1: 'a' }] } },
        ],
        stop_reason: 'tool_use',
      },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    const body = await readStream(res);
    expect(body).toContain('event: agent:error');
    expect(body).toContain('db exploded');
    expect(prisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('imports an attached CSV via csv_import into bulkCreateRows', async () => {
    adapter.getColumns.mockResolvedValue([
      { id: 'cName', name: 'Name', type: 'text' },
      { id: 'cCity', name: 'City', type: 'text' },
    ]);
    adapter.bulkCreateRows.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    const csv = 'Name,City\nAda,London\nGrace,NYC';
    const content = Buffer.from(csv, 'utf-8').toString('base64');
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'csv_import', input: { tableId: 't1' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(
      makeRequest(baseBody({ csvPayload: { name: 'people.csv', content } }), { cookie: authCookie }),
    );
    await readStream(res);
    expect(adapter.bulkCreateRows).toHaveBeenCalledWith([
      { tableId: 't1', cells: { cName: 'Ada', cCity: 'London' } },
      { tableId: 't1', cells: { cName: 'Grace', cCity: 'NYC' } },
    ]);
  });
});
