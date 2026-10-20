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
  turns: [] as Array<{ content: unknown[]; stop_reason: string; stop_details?: unknown } | { throws: unknown }>,
  // The inner non-streaming Haiku reply (translate/generate); JSON text.
  innerJson: '[]',
  streamCalls: [] as Array<Record<string, unknown>>,
  createCalls: [] as Array<Record<string, unknown>>,
}));

function makeClient() {
  let turnIndex = 0;
  const stream = (params: Record<string, unknown>) => {
    anthropicState.streamCalls.push({ ...params, messages: structuredClone(params.messages) });
    return {
      on() {
        return this;
      },
      finalMessage: async () => {
        const turn = anthropicState.turns[turnIndex++] ?? { content: [], stop_reason: 'end_turn' };
        if ('throws' in turn) throw turn.throws;
        return {
          stop_details: null,
          ...turn,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        };
      },
    };
  };
  const create = async (params: Record<string, unknown>) => {
    anthropicState.createCalls.push(params);
    // A leading (empty) thinking block, as current models return.
    return {
      stop_reason: 'end_turn',
      stop_details: null,
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'text', text: anthropicState.innerJson },
      ],
    };
  };
  return { beta: { messages: { stream, create } } };
}

vi.mock('@/lib/ai/anthropicClient', async (importActual) => {
  // Real registry and request helpers; only the client is scripted.
  const actual = await importActual<typeof import('@/lib/ai/anthropicClient')>();
  return { ...actual, getAnthropicClient: () => makeClient() };
});

// --- Adapter mock ----------------------------------------------------------
const adapter = vi.hoisted(() => ({
  listTables: vi.fn(),
  getTable: vi.fn(),
  getColumn: vi.fn(),
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
    tenants: [{ id: 'tenant-a', app_grants: ['sites'], group_id: 'tg_a' }],
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
  anthropicState.streamCalls = [];
  anthropicState.createCalls = [];
  // t1 is the session workspace's collection, t_b belongs to workspace B.
  adapter.getTable.mockImplementation(async (id: string) =>
    id === 't1'
      ? { id: 't1', workspaceId: 'ws_a', name: 'Events' }
      : id === 't_b'
        ? { id: 't_b', workspaceId: 'ws_b', name: 'Secret B' }
        : null,
  );
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

describe('POST /api/ai/cms-agent: workspace isolation', () => {
  it('answers 404 for a collection of another workspace and records no run', async () => {
    const res = await POST(makeRequest(baseBody({ collectionId: 't_b' }), { cookie: authCookie }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    expect(adapter.getColumns).not.toHaveBeenCalled();
    expect(adapter.getRows).not.toHaveBeenCalled();
  });

  it('answers the same 404 for an unknown collection', async () => {
    const res = await POST(makeRequest(baseBody({ collectionId: 'nope' }), { cookie: authCookie }));
    expect(res.status).toBe(404);
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('list_collections lists the SESSION workspace, whatever workspace id the model sends', async () => {
    adapter.listTables.mockResolvedValue([{ id: 't1', workspaceId: 'ws_a', name: 'Events' }]);
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'list_collections', input: { workspaceId: 'ws_b' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    await readStream(res);
    expect(adapter.listTables).toHaveBeenCalledWith('ws_a');
    expect(adapter.listTables).not.toHaveBeenCalledWith('ws_b');
  });

  it('list_rows on another workspace\'s collection reads nothing from it', async () => {
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'list_rows', input: { tableId: 't_b' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    const body = await readStream(res);
    expect(adapter.getRows).not.toHaveBeenCalledWith('t_b', expect.anything());
    expect(body).toContain('Read 0 rows (total 0)');
  });

  it('refuses a write to another workspace\'s row and never reaches the adapter write', async () => {
    adapter.getRow.mockImplementation(async (id: string) =>
      id === 'row_b' ? { id: 'row_b', tableId: 't_b', cells: { c1: 'secret' } } : null,
    );
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'archive_row', input: { rowId: 'row_b' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    await readStream(res);
    expect(adapter.archiveRow).not.toHaveBeenCalled();
    expect(prisma.agentChange.create).not.toHaveBeenCalled();
  });

  it('refuses creating rows in another workspace\'s collection', async () => {
    anthropicState.turns = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'create_row', input: { tableId: 't_b', cells: { c1: 'x' } } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    await readStream(res);
    expect(adapter.createRow).not.toHaveBeenCalled();
  });

  it('refuses a select value that is not an option of that cell\'s column', async () => {
    adapter.getColumns.mockResolvedValue([{ id: 'c_status', tableId: 't1', name: 'Status', type: 'select' }]);
    adapter.getSelectOptions.mockResolvedValue([{ id: 'opt_published', name: 'Published' }]);
    adapter.getRow.mockResolvedValue({ id: 'row1', tableId: 't1', cells: {} });
    anthropicState.turns = [
      {
        content: [
          { type: 'tool_use', id: 'tu1', name: 'update_row', input: { rowId: 'row1', cells: { c_status: 'opt_of_b' } } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [
          { type: 'tool_use', id: 'tu2', name: 'create_row', input: { tableId: 't1', cells: { c_status: 'opt_of_b' } } },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    const res = await POST(makeRequest(baseBody(), { cookie: authCookie }));
    await readStream(res);
    expect(adapter.updateRow).not.toHaveBeenCalled();
    expect(adapter.createRow).not.toHaveBeenCalled();
  });
});

// --- Current-model request surface (Opus 5.5 / Sonnet 5.5 / Haiku 5.5) -------
describe('POST /api/ai/cms-agent on current models', () => {
  const createTurn = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-a' },
      { type: 'tool_use', id: 'tu1', name: 'create_row', input: { tableId: 't1', cells: { c1: 'x' } } },
    ],
    stop_reason: 'tool_use',
  };

  it('defaults to Opus 5.5 at low effort with fallbacks, progress updates and eager tool input', async () => {
    await readStream(await POST(makeRequest(baseBody({ model: undefined }), { cookie: authCookie })));
    const params = anthropicState.streamCalls[0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18']);
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'updates' });
    expect(params.max_tokens).toBe(16_000);
    for (const banned of ['temperature', 'top_p', 'top_k', 'tool_choice']) expect(params).not.toHaveProperty(banned);
    expect((params.tools as Array<{ eager_input_streaming?: boolean }>).every((t) => t.eager_input_streaming)).toBe(true);
  });

  it('Haiku 5.5: no fallbacks, no betas, adaptive thinking left at its default', async () => {
    await readStream(await POST(makeRequest(baseBody({ model: 'HAIKU' }), { cookie: authCookie })));
    const params = anthropicState.streamCalls[0];
    expect(params.model).toBe('claude-haiku-5-5');
    for (const absent of ['fallbacks', 'betas', 'thinking']) expect(params).not.toHaveProperty(absent);
  });

  it('sends the assistant turn back unchanged, thinking blocks included', async () => {
    adapter.createRow.mockResolvedValue({ id: 'row1', tableId: 't1', cells: { c1: 'x' } });
    anthropicState.turns = [createTurn, { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }];
    await readStream(await POST(makeRequest(baseBody(), { cookie: authCookie })));
    const second = anthropicState.streamCalls[1].messages as Array<{ role: string; content: unknown }>;
    expect(second[1]).toEqual({ role: 'assistant', content: createTurn.content });
  });

  it('a refusal stops the run before any tool of that turn runs', async () => {
    anthropicState.turns = [{ ...createTurn, stop_reason: 'refusal', stop_details: { category: 'cyber' } }];
    const body = await readStream(await POST(makeRequest(baseBody(), { cookie: authCookie })));
    expect(adapter.createRow).not.toHaveBeenCalled();
    expect(body).toContain('"code":"refused"');
    expect(body).not.toContain('event: agent:done');
    expect(prisma.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }));
  });

  it('a turn cut off at max_tokens never runs its (possibly partial) tool call', async () => {
    anthropicState.turns = [{ ...createTurn, stop_reason: 'max_tokens' }];
    const body = await readStream(await POST(makeRequest(baseBody(), { cookie: authCookie })));
    expect(adapter.createRow).not.toHaveBeenCalled();
    expect(body).toContain('"code":"truncated"');
  });

  it('unparseable eager tool JSON stops with invalid_tool_input, not a generic failure', async () => {
    const { AnthropicError } = await import('@anthropic-ai/sdk');
    anthropicState.turns = [{ throws: new AnthropicError('Unable to parse tool parameter JSON from model. JSON: {"tab') }];
    const body = await readStream(await POST(makeRequest(baseBody(), { cookie: authCookie })));
    expect(body).toContain('"code":"invalid_tool_input"');
  });

  it('the inner Haiku call (generate_content) uses Haiku 5.5 at low effort and reads text past a thinking block', async () => {
    adapter.getColumns.mockResolvedValue([{ id: 'c1', name: 'Title', type: 'text' }]);
    adapter.bulkCreateRows.mockResolvedValue([{ id: 'r1' }]);
    anthropicState.innerJson = '[{"c1":"Hello"}]';
    anthropicState.turns = [
      {
        content: [
          { type: 'tool_use', id: 'tu1', name: 'generate_content', input: { tableId: 't1', prompt: 'greetings', count: 1, targetColumns: ['c1'] } },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ];
    await readStream(await POST(makeRequest(baseBody(), { cookie: authCookie })));
    const inner = anthropicState.createCalls[0];
    expect(inner.model).toBe('claude-haiku-5-5');
    expect(inner.output_config).toEqual({ effort: 'low' });
    expect(inner).not.toHaveProperty('fallbacks');
    expect(adapter.bulkCreateRows).toHaveBeenCalledWith([{ tableId: 't1', cells: { c1: 'Hello' } }]);
  });
});
