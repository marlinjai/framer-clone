// @vitest-environment node
//
// The Lumitra Sites MCP endpoint (src/server/mcp/handler.ts), driven with real
// Request objects through createMcpHandler, over the REAL site operations
// library (src/server/siteOps) against a fake repository. The key verification
// is injected (its own suite is auth-machine.test.ts; the integration test runs
// the real one), and the caller is built by the real keyCaller, so every
// permission goes through authorizeKeyAction.
//
// Covered: the protocol (initialize and its versions, ping, notifications,
// batches, the size cap, methods), the auth outcomes (none, cookie only,
// refused, forbidden, unavailable, throttled), every tool's happy path and a
// refusal, the publish and rollback confirmation by one-time token (reuse,
// another site, another version, another key, expiry, a version that moves
// after the token was spent) and by elicitation (accept, decline, a client that
// cannot, a dialog without an answer, an answer from another key), the
// per-key write limit, and that no answer ever carries the key.
//
// Fake keys are built at run time (knowledge-base standards/test-credentials.md).

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, isStateTreeNode } from 'mobx-state-tree';
import { z } from 'zod';

const audits = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({
    siteOperationAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => audits.rows.push(data)) },
  }),
}));
vi.mock('@/server/sites/cachedResolver', () => ({
  revalidateSiteCache: () => {},
  revalidateCustomHostsForSiteId: async () => [],
}));
const commerce = vi.hoisted(() => ({ outcome: { ok: true } as Record<string, unknown>, calls: [] as unknown[][] }));
vi.mock('@/server/sites/companyCommerce', () => ({
  ensureCompanyCommerce: async (...args: unknown[]) => {
    commerce.calls.push(args);
    return commerce.outcome;
  },
}));

import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import {
  SiteChangedError,
  SiteErasedSinceLoadError,
  SiteNotFoundError,
  SiteVersionRequiredError,
  type SiteRepository,
} from '@/server/sites';
import { __resetPageGenRateLimiterForTests, createPageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { __resetStockImageCacheForTests, __resetStockOffersForTests } from '@/lib/ai/pageGen/stockImages';
import { OperationSchema } from '@/lib/siteOps/types';
import type { CompanyKey, VerifiedKey } from '@/lib/auth-machine';
import { createMcpHandler, MAX_BODY_BYTES, PROTOCOL_VERSIONS, type McpDeps } from '../handler';
import { APPROVAL_TTL_MS, APPROVALS_PER_KEY, ApprovalStore } from '../approvals';
import { DATA_NOTICE, LISTED_TOOLS, OPERATION_SCHEMAS, UNEXPECTED_FAILURE, type ToolLimits } from '../tools';
import { ELICITATION_PER_KEY, pendingCount } from '../elicitation';
import { plansSnapshot, resetLivePlansForTests } from '../livePlans';
import { resetLiveBusForTests, subscribeSite } from '@/server/sites/liveBus';
import { LIVE_EVENTS, PLAN_LIMITS, type PlanUpdateEvent } from '@/lib/projects/liveEvents';

const fakeCredential = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const fakeKey = () => fakeCredential(['sk', 'live'].join('_'));

const SCOPE = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };

function verifiedKey(role: VerifiedKey['workspaceRole'] = 'admin', keyId = 'key_1'): VerifiedKey {
  return Object.freeze({
    kind: 'key' as const,
    tenantId: 'tenant-a',
    companySlug: 'acme',
    keyId,
    serviceAccountId: 'sa_1',
    scope: Object.freeze({ ...SCOPE }),
    workspaceRole: role,
    appGrants: Object.freeze(['sites']),
  });
}

// ---------- the fake repository ----------

function storedProject(): ProjectModelType {
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: {
          id: 'root', type: 'div', componentType: 'host', props: {}, children: [
            { id: 'title', type: 'h1', componentType: 'host', parentId: 'root', props: { children: 'Fresh bread' }, children: [] },
          ],
        },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

function fakeRepository(version = 3) {
  const state = {
    version,
    saved: [] as Array<{ snapshot: unknown; options: Record<string, unknown> }>,
    published: [] as Array<Record<string, unknown>>,
    rolledBack: [] as number[],
    saveError: null as Error | null,
  };
  const repository = {
    listSites: vi.fn(async () => [
      { siteId: 'site-1', name: 'Bakery', description: '', status: 'draft', lumitraEnabled: false, createdAt: new Date(0), updatedAt: new Date(0), subdomain: null, customDomains: [] },
    ]),
    loadProjectWithVersion: vi.fn(async (_scope: unknown, siteId: string) => {
      if (siteId !== 'site-1' && siteId !== 'site-2') throw new SiteNotFoundError(siteId);
      return { project: storedProject(), version: state.version };
    }),
    saveProject: vi.fn(async (_scope: unknown, project: ProjectModelType, options: Record<string, unknown>) => {
      if (state.saveError) throw state.saveError;
      if (options.expectedVersion !== undefined && options.expectedVersion !== state.version) throw new SiteChangedError(state.version);
      state.saved.push({ snapshot: isStateTreeNode(project) ? getSnapshot(project) : project, options });
      state.version = options.expectedVersion === undefined ? 1 : state.version + 1;
      // As the real repository: after the commit, before the write is announced.
      (options.beforeAnnounce as ((v: number) => void) | undefined)?.(state.version);
      return { version: state.version };
    }),
    publishProject: vi.fn(async (_scope: unknown, _project: unknown, options: Record<string, unknown>) => {
      if (options.expectedVersion !== state.version) throw new SiteChangedError(state.version);
      state.published.push(options);
      state.version += 1;
      return { revision: 7, version: state.version };
    }),
    ensureSiteDomain: vi.fn(async () => ({ subdomain: 'abc123' })),
    getSiteAddress: vi.fn(async () => ({ host: 'abc123.sites.example', everPublished: true })),
    listRevisions: vi.fn(async () => ({
      live: 7,
      status: 'published',
      revisions: [
        { number: 7, kind: 'publish', publishedBy: 'key:key_1', createdAt: new Date('2026-11-01T10:00:00Z'), rewrittenAt: null },
        { number: 6, kind: 'publish', publishedBy: 'user-1', createdAt: new Date('2026-10-30T09:00:00Z'), rewrittenAt: null },
      ],
    })),
    rollbackToRevision: vi.fn(async (_scope: unknown, _siteId: string, number: number) => {
      state.rolledBack.push(number);
    }),
  };
  return { repository: repository as unknown as SiteRepository, state, mock: repository };
}

// ---------- driving the handler ----------

interface Setup {
  handler: ReturnType<typeof createMcpHandler>;
  state: ReturnType<typeof fakeRepository>['state'];
  mock: ReturnType<typeof fakeRepository>['mock'];
  verifyKey: ReturnType<typeof vi.fn>;
  key: string;
  approvals: ApprovalStore;
}

function setup(options: { outcome?: CompanyKey; version?: number; deps?: Partial<McpDeps>; now?: () => number } = {}): Setup {
  const { repository, state, mock } = fakeRepository(options.version ?? 3);
  const key = fakeKey();
  const outcome = options.outcome ?? verifiedKey();
  const verifyKey = vi.fn(async () => outcome);
  const approvals = new ApprovalStore(options.now);
  const handler = createMcpHandler({
    verifyKey,
    siteOps: { repository, publicBaseHost: 'sites.example', editorHost: 'app.example' },
    approvals,
    ...options.deps,
  });
  return { handler, state, mock, verifyKey, key, approvals };
}

/** Fresh per-key limits, with some replaced. */
function limitsWith(over: Partial<ToolLimits>): ToolLimits {
  return {
    reads: createPageGenRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    writes: createPageGenRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    images: createPageGenRateLimiter(),
    approvals: createPageGenRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    plans: createPageGenRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    ...over,
  };
}

function post(key: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.lumitra.co/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let nextId = 1;
const rpc = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });

async function call(s: Setup, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await s.handler.POST(post(s.key, rpc('tools/call', { name, arguments: args }), headers));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown>; content: Array<{ text: string }> } };
  return body.result;
}

const errorOf = (result: { structuredContent: Record<string, unknown> }) => result.structuredContent.error as Record<string, unknown>;

let infoSpy: { mockRestore: () => void };
let errorSpy: { mockRestore: () => void };
let warnSpy: { mockRestore: () => void };

beforeEach(() => {
  resetLivePlansForTests();
  resetLiveBusForTests();
  audits.rows = [];
  commerce.outcome = { ok: true };
  commerce.calls = [];
  __resetPageGenRateLimiterForTests();
  __resetStockImageCacheForTests();
  __resetStockOffersForTests();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  infoSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ---------- protocol ----------

describe('protocol', () => {
  it('answers initialize with each supported version, the newest for an unknown one, the instructions and a session id', async () => {
    const s = setup();
    for (const version of [...PROTOCOL_VERSIONS, '2099-01-01', undefined]) {
      const res = await s.handler.POST(post(s.key, rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } })));
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeTruthy();
      const { result } = (await res.json()) as { result: Record<string, unknown> };
      expect(result.protocolVersion).toBe(version && (PROTOCOL_VERSIONS as readonly string[]).includes(version) ? version : '2025-06-18');
      expect(result.serverInfo).toMatchObject({ name: 'lumitra-sites' });
      expect(result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(result.instructions).toContain('describe_vocabulary');
      expect(result.instructions).toContain('expectedVersion');
      expect(result.instructions).toContain('site_changed');
      expect(result.instructions).toContain('preview_url');
    }
  });

  it('answers ping, accepts notifications with 202 and refuses unknown methods', async () => {
    const s = setup();
    const ping = await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: 'p', method: 'ping' }));
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    const note = await s.handler.POST(post(s.key, { jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(note.status).toBe(202);
    const unknown = await s.handler.POST(post(s.key, rpc('resources/list')));
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('answers a batch in order, skipping notifications, and refuses empty or oversized batches', async () => {
    const s = setup();
    const res = await s.handler.POST(post(s.key, [rpc('ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list'), { nope: true }]));
    const answers = (await res.json()) as Array<Record<string, unknown>>;
    expect(answers).toHaveLength(3);
    expect(answers[0].result).toEqual({});
    expect((answers[1].result as { tools: unknown[] }).tools.length).toBeGreaterThan(5);
    expect((answers[2].error as { code: number }).code).toBe(-32600);
    for (const body of [[], Array.from({ length: 21 }, () => rpc('ping'))]) {
      const refused = await s.handler.POST(post(s.key, body));
      expect(refused.status).toBe(400);
    }
    const twenty = await s.handler.POST(post(s.key, Array.from({ length: 20 }, () => rpc('ping'))));
    expect(((await twenty.json()) as unknown[]).length).toBe(20);
  });

  it('refuses a body that is not JSON, and one over the size cap whether or not it declares its length', async () => {
    const s = setup();
    expect((await s.handler.POST(post(s.key, '{not json'))).status).toBe(400);
    const declared = await s.handler.POST(post(s.key, '{}', { 'content-length': String(MAX_BODY_BYTES + 1) }));
    expect(declared.status).toBe(413);
    const big = JSON.stringify(rpc('ping', { pad: 'x'.repeat(MAX_BODY_BYTES) }));
    const streamed = new Request('https://app.lumitra.co/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect((await s.handler.POST(streamed)).status).toBe(413);
  });

  it('answers GET with 405 (no stream to listen on), and DELETE needs the key like POST', async () => {
    const s = setup();
    const res = s.handler.GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
    expect((await s.handler.DELETE(new Request('https://app.example/api/mcp', { method: 'DELETE' }))).status).toBe(401);
    const ended = await s.handler.DELETE(new Request('https://app.example/api/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${s.key}` } }));
    expect(ended.status).toBe(204);
  });

  it('lists every tool with annotations and a JSON Schema, and an unknown tool is a JSON-RPC error', async () => {
    const s = setup();
    const res = await s.handler.POST(post(s.key, rpc('tools/list')));
    const { result } = (await res.json()) as { result: { tools: typeof LISTED_TOOLS } };
    expect(result.tools.map((t) => t.name)).toEqual([
      'list_sites', 'get_site', 'get_page', 'describe_vocabulary', 'create_site', 'apply_batch', 'announce_sections', 'clear_sections',
      'generate_page', 'find_images', 'preview_url', 'publish', 'list_revisions', 'rollback',
    ]);
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    for (const name of ['list_sites', 'get_site', 'get_page', 'describe_vocabulary', 'preview_url', 'list_revisions', 'find_images']) {
      expect(byName[name].annotations.readOnlyHint).toBe(true);
    }
    for (const name of ['publish', 'rollback', 'apply_batch', 'generate_page']) {
      expect(byName[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    }
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      expect(tool.description.length).toBeGreaterThan(40);
    }
    expect((byName.publish.inputSchema.properties as Record<string, unknown>).approvalId).toBeDefined();
    const ops = (byName.apply_batch.inputSchema.properties as Record<string, { items: { oneOf: unknown[] } }>).ops;
    expect(ops.items.oneOf).toHaveLength(11);
    const unknown = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'delete_everything', arguments: {} })));
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("keeps apply_batch's operation schemas in step with the library's OperationSchema", () => {
    const library = z.toJSONSchema(OperationSchema, { io: 'input' }) as { oneOf?: unknown[]; anyOf?: unknown[] };
    const options = (library.oneOf ?? library.anyOf) as Array<{ properties: Record<string, { const?: string }>; required?: string[] }>;
    const shape = (o: { properties: Record<string, unknown>; required?: string[] }) => ({
      op: (o.properties.op as { const?: string }).const,
      properties: Object.keys(o.properties).sort(),
      required: [...(o.required ?? [])].sort(),
    });
    const ours = (OPERATION_SCHEMAS as Array<{ properties: Record<string, unknown>; required?: string[] }>).map(shape);
    expect(ours).toEqual(options.map(shape));
  });
});

// ---------- auth ----------

describe('auth: the handler is the gate', () => {
  it('answers 401 with WWW-Authenticate: Bearer to a request without a key, before verifying anything', async () => {
    const s = setup();
    const res = await s.handler.POST(post(null, rpc('tools/list')));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(s.verifyKey).not.toHaveBeenCalled();
  });

  it('never lets a session cookie in: cookie only is 401', async () => {
    const s = setup();
    const res = await s.handler.POST(post(null, rpc('tools/call', { name: 'list_sites', arguments: {} }), { cookie: 'lumitra_session=sess_valid' }));
    expect(res.status).toBe(401);
    expect(s.verifyKey).not.toHaveBeenCalled();
    expect(s.mock.listSites).not.toHaveBeenCalled();
  });

  it('maps every verification outcome to its answer: refused 401, forbidden 403, unavailable 503, throttled 429', async () => {
    const cases: Array<[CompanyKey, number, Record<string, RegExp>]> = [
      [{ kind: 'refused' }, 401, { 'www-authenticate': /^Bearer/ }],
      [{ kind: 'forbidden', reason: 'sites_not_enabled', keyId: 'k', tenantId: 't' }, 403, {}],
      [{ kind: 'unavailable' }, 503, { 'retry-after': /^\d+$/ }],
      [{ kind: 'throttled', retryAfterSeconds: 42 }, 429, { 'retry-after': /^42$/ }],
    ];
    for (const [outcome, status, headers] of cases) {
      const s = setup({ outcome });
      const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'list_sites', arguments: {} })));
      expect(res.status).toBe(status);
      for (const [name, pattern] of Object.entries(headers)) expect(res.headers.get(name)).toMatch(pattern);
      expect(s.mock.listSites).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain(s.key);
    }
  });

  it('a key with a viewer role reads but may not write or publish, through authorizeKeyAction', async () => {
    const s = setup({ outcome: verifiedKey('viewer') });
    expect((await call(s, 'list_sites')).isError).toBe(false);
    const write = await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'removeNode', nodeId: 'title' }] });
    expect(errorOf(write).code).toBe('forbidden');
    const pub = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 });
    expect(errorOf(pub).code).toBe('forbidden');
    expect(pub.structuredContent.approvalId).toBeUndefined();
    const back = await call(s, 'rollback', { siteId: 'site-1', revision: 6 });
    expect(errorOf(back).code).toBe('forbidden');
    expect(s.state.saved).toHaveLength(0);
    expect(s.state.published).toHaveLength(0);
  });

  it('a key with no workspace role reads nothing', async () => {
    const s = setup({ outcome: verifiedKey(null) });
    expect(errorOf(await call(s, 'list_sites')).code).toBe('forbidden');
  });
});

// ---------- tools ----------

describe('reads', () => {
  it('list_sites, get_site, get_page with a cursor, describe_vocabulary and preview_url', async () => {
    const s = setup();
    const sites = await call(s, 'list_sites');
    expect((sites.structuredContent.sites as unknown[])[0]).toMatchObject({ siteId: 'site-1', name: 'Bakery' });

    const site = await call(s, 'get_site', { siteId: 'site-1' });
    expect(site.isError).toBe(false);
    expect(site.structuredContent).toMatchObject({ siteId: 'site-1', version: 3, address: 'https://abc123.sites.example' });
    expect(site.content[0].text).toContain('"version": 3');

    const first = await call(s, 'get_page', { siteId: 'site-1', pageId: 'home', maxChars: 2000 });
    expect(first.structuredContent).toMatchObject({ pageId: 'home', version: 3 });
    const nodes = first.structuredContent.nodes as Array<{ id: string }>;
    expect(nodes.map((n) => n.id)).toContain('root');

    const vocab = await call(s, 'describe_vocabulary', {});
    expect(vocab.structuredContent.operations).toContain('insertNodes');
    expect(vocab.structuredContent.generationFormat).toBeTruthy();
    const withSite = await call(s, 'describe_vocabulary', { siteId: 'site-1' });
    expect((withSite.structuredContent.site as { pages: unknown[] }).pages).toHaveLength(1);

    const revisions = await call(s, 'list_revisions', { siteId: 'site-1' });
    expect(revisions.structuredContent).toMatchObject({ live: 7, status: 'published' });
    expect((revisions.structuredContent.revisions as Array<{ number: number }>).map((r) => r.number)).toEqual([7, 6]);

    const preview = await call(s, 'preview_url', { siteId: 'site-1', pageId: 'home' });
    expect(preview.structuredContent.url).toBe('https://app.example/projects/site-1/preview?page=home');
  });

  it('refuses reads of what is not there, and bad arguments, with the library codes', async () => {
    const s = setup();
    expect(errorOf(await call(s, 'get_site', { siteId: 'nope' })).code).toBe('site_not_found');
    expect(errorOf(await call(s, 'get_page', { siteId: 'site-1', pageId: 'missing' })).code).toBe('page_not_found');
    expect(errorOf(await call(s, 'get_page', { siteId: 'site-1', pageId: 'home', cursor: 'no-such-node' })).code).toBe('invalid_request');
    expect(errorOf(await call(s, 'preview_url', { siteId: 'site-1', pageId: 'missing' })).code).toBe('page_not_found');
    expect(errorOf(await call(s, 'describe_vocabulary', { siteId: 'nope' })).code).toBe('site_not_found');
    s.mock.listRevisions.mockRejectedValueOnce(new SiteNotFoundError('nope'));
    expect(errorOf(await call(s, 'list_revisions', { siteId: 'nope' })).code).toBe('site_not_found');
    s.mock.listSites.mockRejectedValueOnce(new Error('database down'));
    expect(errorOf(await call(s, 'list_sites')).code).toBe('failed');
    const bad = await call(s, 'get_site', { siteId: 42, extra: true });
    expect(errorOf(bad)).toMatchObject({ code: 'invalid_request' });
    expect((errorOf(bad).issues as string[]).length).toBeGreaterThan(0);
  });
});

describe('writes', () => {
  it('create_site provisions the shop under the slug of the verified key and answers version 1', async () => {
    const s = setup();
    const created = await call(s, 'create_site', { name: 'Agent site' });
    expect(created.isError).toBe(false);
    expect(created.structuredContent).toMatchObject({ version: 1 });
    expect(commerce.calls[0]).toEqual(['tg_a', 'acme']);
    expect(s.state.saved[0].options).toMatchObject({ companyId: 'tenant-a' });
    expect(audits.rows[0]).toMatchObject({ operation: 'create_site', actorKind: 'key', actorId: 'key_1' });
    // No name on the key and no client name: no label stored, the editor says "Agent".
    expect(audits.rows[0].actorDetail).toEqual({ serviceAccountId: 'sa_1' });
  });

  it("stores the agent's label in the audit row, so the editor's feed names it again after a reload", async () => {
    const s = setup({ outcome: Object.freeze({ ...verifiedKey(), keyName: 'Claude' }) });
    await call(s, 'create_site', { name: 'Agent site' });
    expect(audits.rows[0].actorDetail).toEqual({ serviceAccountId: 'sa_1', label: 'Claude' });
  });

  it('create_site answers the shop refusal and writes nothing', async () => {
    const s = setup();
    commerce.outcome = { ok: false, code: 'commerce_busy', message: 'the shop is being set up, retry', status: 503, retryAfterSec: 3 };
    const created = await call(s, 'create_site', {});
    expect(errorOf(created)).toMatchObject({ code: 'unavailable', retryAfterSec: 3 });
    expect(s.state.saved).toHaveLength(0);
  });

  it('apply_batch saves on expectedVersion and maps refs to ids', async () => {
    const s = setup();
    const res = await call(s, 'apply_batch', {
      siteId: 'site-1',
      expectedVersion: 3,
      ops: [
        { op: 'insertNodes', pageId: 'home', nodes: [{ ref: 'hero', type: 'section', children: [{ type: 'p', props: { children: 'Hi' } }] }] },
        { op: 'updateText', nodeId: 'title', text: 'Bread at four' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({ siteId: 'site-1', version: 4 });
    expect((res.structuredContent.created as Record<string, string>).hero).toBeTruthy();
    expect(s.state.saved[0].options).toMatchObject({ expectedVersion: 3, mustExist: true });
  });

  it('apply_batch on a stale version is site_changed with currentVersion, and nothing is written', async () => {
    const s = setup({ version: 5 });
    const res = await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'removeNode', nodeId: 'title' }] });
    expect(errorOf(res)).toMatchObject({ code: 'site_changed', currentVersion: 5 });
    expect(s.state.saved).toHaveLength(0);
  });

  it('apply_batch refuses a bad operation by index and reason, all or nothing', async () => {
    const s = setup();
    const res = await call(s, 'apply_batch', {
      siteId: 'site-1',
      expectedVersion: 3,
      ops: [
        { op: 'updateText', nodeId: 'title', text: 'fine' },
        { op: 'insertNodes', pageId: 'home', nodes: [{ type: 'script', props: { children: 'alert(1)' } }] },
      ],
    });
    expect(res.isError).toBe(true);
    const error = errorOf(res);
    expect(error.code).toBe('rejected');
    expect(error.rejected).toEqual([expect.objectContaining({ index: 1, op: 'insertNodes', reason: expect.any(String) })]);
    expect(s.state.saved).toHaveLength(0);
  });

  it('words the repository refusals for an agent, never for an editor tab', async () => {
    const s = setup();
    s.state.saveError = new SiteVersionRequiredError();
    const required = errorOf(await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] }));
    expect(required.code).toBe('invalid_request');
    expect(required.message).toContain('expectedVersion');
    s.state.saveError = new SiteErasedSinceLoadError();
    const erased = errorOf(await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] }));
    expect(erased.code).toBe('failed');
    for (const message of [required.message, erased.message] as string[]) {
      expect(message).not.toMatch(/tab|reload the page/i);
    }
  });

  it('limits writes per key and says when to retry', async () => {
    const s = setup({ deps: { limits: limitsWith({ writes: createPageGenRateLimiter({ maxPerWindow: 1, windowMs: 60_000 }) }) } });
    expect((await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'a' }] })).isError).toBe(false);
    const second = await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 4, ops: [{ op: 'updateText', nodeId: 'title', text: 'b' }] });
    expect(errorOf(second)).toMatchObject({ code: 'rate_limited', retryAfterSec: expect.any(Number) });
    expect(s.state.saved).toHaveLength(1);
  });
});

describe('generate_page', () => {
  const page = { title: 'Menu', description: 'What we bake', nodes: [{ type: 'section', children: [{ type: 'h1', props: { children: 'Our bread' } }] }] };
  const scriptedAnthropic = (input: unknown) => () =>
    ({
      beta: {
        messages: {
          stream: () => ({
            on() {
              return this;
            },
            currentMessage: undefined,
            finalMessage: async () => ({
              content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_page', input }],
              stop_reason: 'tool_use',
              stop_details: null,
              usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }),
          }),
        },
      },
    }) as never;

  it('generates a new page and saves it on the version read', async () => {
    const { repository, state } = fakeRepository(3);
    const handler = createMcpHandler({ verifyKey: async () => verifiedKey(), siteOps: { repository, anthropic: scriptedAnthropic(page) } });
    const res = await handler.POST(post(fakeKey(), rpc('tools/call', { name: 'generate_page', arguments: { siteId: 'site-1', expectedVersion: 3, brief: 'A bakery menu', target: { kind: 'newPage', title: 'Menu' } } })));
    const { result } = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ siteId: 'site-1', version: 4 });
    expect(state.saved).toHaveLength(1);
  });

  it('refuses a stale version before calling the model, and an empty brief', async () => {
    const anthropic = vi.fn(scriptedAnthropic(page));
    const { repository, state } = fakeRepository(5);
    const handler = createMcpHandler({ verifyKey: async () => verifiedKey(), siteOps: { repository, anthropic } });
    const res = await handler.POST(post(fakeKey(), rpc('tools/call', { name: 'generate_page', arguments: { siteId: 'site-1', expectedVersion: 3, brief: 'x', target: { kind: 'newPage' } } })));
    const { result } = (await res.json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(errorOf(result)).toMatchObject({ code: 'site_changed', currentVersion: 5 });
    expect(anthropic).not.toHaveBeenCalled();
    const empty = await handler.POST(post(fakeKey(), rpc('tools/call', { name: 'generate_page', arguments: { siteId: 'site-1', expectedVersion: 5, brief: '', target: { kind: 'newPage' } } })));
    expect(errorOf(((await empty.json()) as { result: { structuredContent: Record<string, unknown> } }).result).code).toBe('invalid_request');
    expect(state.saved).toHaveLength(0);
  });
});

describe('find_images', () => {
  const photo = (id: string) => ({
    id,
    urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=1`, regular: `https://images.unsplash.com/photo-${id}?w=1080` },
    user: { name: 'Ana Baker', links: { html: 'https://unsplash.com/@ana' } },
    links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
    alt_description: 'a loaf of bread',
  });

  it('returns credited photos and never the provider key', async () => {
    const secret = ['unit', 'test', 'access', 'value'].join('-');
    vi.stubEnv('UNSPLASH_ACCESS_KEY', secret);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [photo('a1')] }), { status: 200 })));
    const s = setup();
    const res = await call(s, 'find_images', { query: 'sourdough', count: 1 });
    expect(res.isError).toBe(false);
    expect((res.structuredContent.photos as Array<{ imgProps: Record<string, string> }>)[0].imgProps['data-credit-name']).toBe('Ana Baker');
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it('says when stock photos are not configured', async () => {
    vi.stubEnv('UNSPLASH_ACCESS_KEY', '');
    const s = setup();
    expect(errorOf(await call(s, 'find_images', { query: 'bread' })).code).toBe('unavailable');
  });
});

// ---------- publish and rollback: the confirmation by token ----------

describe('publish approved through the approval link', () => {
  const approve = (s: Setup, id: unknown, decision: 'approve' | 'decline' = 'approve') => s.approvals.decide(String(id), 'user-1', decision);

  it('first call checks everything, publishes nothing and answers a link; the call after the approval publishes once', async () => {
    const s = setup();
    const first = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ approvalRequired: true, expiresInSeconds: APPROVAL_TTL_MS / 1000 });
    const id = first.structuredContent.approvalId as string;
    expect(Buffer.from(id, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(first.structuredContent.approvalUrl).toBe(`https://app.example/projects/site-1/confirm/${id}`);
    expect(first.structuredContent.summary).toContain('"Bakery"');
    expect(first.structuredContent.summary).toContain('version 3');
    expect(first.structuredContent.summary).toContain('https://abc123.sites.example');
    expect(first.content[0].text.startsWith(DATA_NOTICE)).toBe(true);
    expect(s.state.published).toHaveLength(0);

    // Not approved yet: the id alone proves nothing, and is kept for later.
    const early = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(early.structuredContent).toMatchObject({ approvalPending: true, approvalId: id });
    expect(s.state.published).toHaveLength(0);

    approve(s, id);
    const second = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toMatchObject({ siteId: 'site-1', revision: 7, version: 4, liveUrl: 'https://abc123.sites.example' });
    expect(s.state.published).toEqual([expect.objectContaining({ publishedBy: 'key:key_1', expectedVersion: 3 })]);

    // Reuse: the approval is spent; a new link comes back instead.
    const reuse = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 4, approvalId: id });
    expect(reuse.structuredContent).toMatchObject({ approvalRequired: true });
    expect(reuse.structuredContent.note).toMatch(/unknown, expired, already used/);
    expect(s.state.published).toHaveLength(1);
  });

  it('a declined request publishes nothing and is spent', async () => {
    const s = setup();
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    approve(s, id, 'decline');
    const res = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(res.structuredContent).toMatchObject({ declined: true, confirmed: false });
    expect(s.state.published).toHaveLength(0);
    expect((await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id })).structuredContent.approvalRequired).toBe(true);
  });

  it('an approval works only for the site, version and key it was opened for, and a foreign key cannot spend it', async () => {
    const s = setup();
    const open = async (siteId = 'site-1', expectedVersion = 3) => {
      const id = (await call(s, 'publish', { siteId, expectedVersion })).structuredContent.approvalId as string;
      approve(s, id);
      return id;
    };

    // Another site.
    const forSite1 = await open();
    expect((await call(s, 'publish', { siteId: 'site-2', expectedVersion: 3, approvalId: forSite1 })).structuredContent.approvalRequired).toBe(true);

    // Another key of the same company: refused, and the approval stays for its own key.
    const other = createMcpHandler({
      verifyKey: async () => verifiedKey('admin', 'key_2'),
      siteOps: { repository: s.mock as unknown as SiteRepository, publicBaseHost: 'sites.example' },
      approvals: s.approvals,
    });
    const res = await other.POST(post(fakeKey(), rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3, approvalId: forSite1 } })));
    expect(((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent.approvalRequired).toBe(true);
    expect(s.state.published).toHaveLength(0);
    expect((await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: forSite1 })).isError).toBe(false);
    expect(s.state.published).toHaveLength(1);
  });

  it('a version that moves after the approval refuses the publish with site_changed', async () => {
    const s = setup();
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    approve(s, id);
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'changed' }] });
    const stale = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(errorOf(stale)).toMatchObject({ code: 'site_changed', currentVersion: 4 });
    // Naming the new version with the old approval is not approved either.
    expect((await call(s, 'publish', { siteId: 'site-1', expectedVersion: 4, approvalId: id })).structuredContent.approvalRequired).toBe(true);
    expect(s.state.published).toHaveLength(0);
  });

  it('a version that moves between the confirmed call\'s checks and its write still refuses it', async () => {
    const s = setup();
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    approve(s, id);
    s.mock.publishProject.mockImplementationOnce(async () => {
      throw new SiteChangedError(4);
    });
    const res = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(errorOf(res)).toMatchObject({ code: 'site_changed', currentVersion: 4 });
    expect(s.state.published).toHaveLength(0);
  });

  it('a stale expectedVersion is site_changed before any link is opened', async () => {
    const s = setup({ version: 6 });
    const res = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 });
    expect(errorOf(res)).toMatchObject({ code: 'site_changed', currentVersion: 6 });
    expect(s.approvals.size).toBe(0);
  });

  it('an approval expires', async () => {
    let now = 1_000_000;
    const s = setup({ now: () => now });
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    approve(s, id);
    now += APPROVAL_TTL_MS + 1;
    expect((await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id })).structuredContent.approvalRequired).toBe(true);
    expect(s.state.published).toHaveLength(0);
  });

  it('two concurrent calls with one approval publish once', async () => {
    const s = setup();
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    approve(s, id);
    const [a, b] = await Promise.all([
      call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id }),
      call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id }),
    ]);
    expect(s.state.published).toHaveLength(1);
    const outcomes = [a, b].map((r) => (r.isError ? String(errorOf(r).code) : r.structuredContent.revision ? 'published' : 'other'));
    expect(outcomes.filter((o) => o === 'published')).toHaveLength(1);
  });

  it('a rate limit on the approved call does not spend the approval', async () => {
    const writes = createPageGenRateLimiter({ maxPerWindow: 1, windowMs: 60_000 });
    const s = setup({ deps: { limits: limitsWith({ writes }) } });
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    approve(s, id);
    expect(writes.acquire('key:tenant-a:key_1').ok).toBe(true);
    expect(errorOf(await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id })).code).toBe('rate_limited');
    expect(s.approvals.size).toBe(1);
    expect(s.state.published).toHaveLength(0);
  });

  it('opening links is rate limited per key, and one key holds at most a few open requests, never pushing out another key\'s', async () => {
    const s = setup({ deps: { limits: limitsWith({ approvals: createPageGenRateLimiter({ maxPerWindow: 3, windowMs: 60_000 }) }) } });
    for (let i = 0; i < 3; i++) expect((await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalRequired).toBe(true);
    expect(errorOf(await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).code).toBe('rate_limited');

    const store = new ApprovalStore();
    const subject = (keyId: string) => ({ action: 'publish' as const, tenantId: 'tenant-a', keyId, scope: SCOPE, siteId: 'site-1', version: 3 });
    const theirs = store.open(subject('key_b'), 'theirs');
    for (let i = 0; i < 50; i++) store.open(subject('key_a'), `mine ${i}`);
    expect(store.countFor('tenant-a', 'key_a')).toBe(APPROVALS_PER_KEY);
    expect(store.get(theirs.id)).not.toBeNull();
  });
});

describe('rollback approved through the approval link', () => {
  it('summarises, then serves the revision once approved', async () => {
    const s = setup();
    const first = await call(s, 'rollback', { siteId: 'site-1', revision: 6 });
    expect(first.structuredContent).toMatchObject({ approvalRequired: true });
    expect(first.structuredContent.summary).toContain('version 6');
    expect(first.structuredContent.summary).toContain('instead of version 7');
    expect(s.state.rolledBack).toHaveLength(0);
    s.approvals.decide(String(first.structuredContent.approvalId), 'user-1', 'approve');
    const done = await call(s, 'rollback', { siteId: 'site-1', revision: 6, approvalId: first.structuredContent.approvalId });
    expect(done.structuredContent).toEqual({ siteId: 'site-1', live: 6 });
    expect(s.state.rolledBack).toEqual([6]);
    expect(audits.rows.at(-1)).toMatchObject({ operation: 'rollback', revision: 6 });
  });

  it('refuses an unknown revision without a link, and an approval for another revision', async () => {
    const s = setup();
    expect(errorOf(await call(s, 'rollback', { siteId: 'site-1', revision: 99 })).code).toBe('revision_not_found');
    const id = (await call(s, 'rollback', { siteId: 'site-1', revision: 6 })).structuredContent.approvalId;
    s.approvals.decide(String(id), 'user-1', 'approve');
    const other = await call(s, 'rollback', { siteId: 'site-1', revision: 7, approvalId: id });
    expect(other.structuredContent.approvalRequired).toBe(true);
    expect(s.state.rolledBack).toHaveLength(0);
  });
});

// ---------- publish and rollback: the confirmation by elicitation ----------

/** Read server-sent events from a streamed answer, one JSON message at a time. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async function next(): Promise<Record<string, unknown>> {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6)) as Record<string, unknown>;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

async function initialize(s: Setup, capabilities: Record<string, unknown>, protocolVersion = '2025-06-18', key = s.key) {
  const res = await s.handler.POST(post(key, rpc('initialize', { protocolVersion, capabilities, clientInfo: { name: 'test', version: '1' } })));
  return res.headers.get('mcp-session-id')!;
}

describe('publish confirmed through the client dialog (elicitation)', () => {
  it('asks the person on a stream, publishes on accept, and answers the result on the same stream', async () => {
    const s = setup();
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const next = sseReader(res);
    const question = await next();
    expect(question).toMatchObject({ method: 'elicitation/create', params: { message: expect.stringContaining('"Bakery"') } });
    expect(s.state.published).toHaveLength(0);

    const answer = await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: question.id, result: { action: 'accept', content: { confirm: true } } }, { 'mcp-session-id': session }));
    expect(answer.status).toBe(202);
    const final = (await next()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(final.result.isError).toBe(false);
    expect(final.result.structuredContent).toMatchObject({ revision: 7, version: 4 });
    expect(s.state.published).toHaveLength(1);
    expect(pendingCount()).toBe(0);
  });

  it('a decline (or an accept without confirm) publishes nothing', async () => {
    for (const result of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }]) {
      const s = setup();
      const session = await initialize(s, { elicitation: {} });
      const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
      const next = sseReader(res);
      const question = await next();
      await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: question.id, result }, { 'mcp-session-id': session }));
      const final = (await next()) as { result: { structuredContent: Record<string, unknown> } };
      expect(final.result.structuredContent).toMatchObject({ declined: true, confirmed: false });
      expect(final.result.structuredContent.approvalId).toBeUndefined();
      expect(s.state.published).toHaveLength(0);
    }
  });

  it('falls back to an approval link when the client answers with an error or the dialog gets no answer', async () => {
    const s = setup({ deps: { elicitationTimeoutMs: 30 } });
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
    const next = sseReader(res);
    const question = await next();
    await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: question.id, error: { code: -32601, message: 'Method not found' } }, { 'mcp-session-id': session }));
    const fallback = (await next()) as { result: { structuredContent: Record<string, unknown> } };
    expect(fallback.result.structuredContent).toMatchObject({ approvalRequired: true });
    expect(fallback.result.structuredContent.approvalId).toEqual(expect.any(String));

    const silent = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'rollback', arguments: { siteId: 'site-1', revision: 6 } }), { 'mcp-session-id': session }));
    const next2 = sseReader(silent);
    await next2();
    const timedOut = (await next2()) as { result: { structuredContent: Record<string, unknown> } };
    expect(timedOut.result.structuredContent).toMatchObject({ approvalRequired: true, note: expect.stringContaining('no answer') });
    expect(s.state.published).toHaveLength(0);
    expect(s.state.rolledBack).toHaveLength(0);
    expect(pendingCount()).toBe(0);
  });

  it('an answer from another key cannot confirm, and the question stays open for its own key', async () => {
    const s = setup({ deps: { elicitationTimeoutMs: 2_000 } });
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
    const next = sseReader(res);
    const question = await next();
    const intruder = await s.handler.POST(post(fakeKey(), { jsonrpc: '2.0', id: question.id, result: { action: 'accept', content: { confirm: true } } }));
    expect(intruder.status).toBe(400);
    expect(s.state.published).toHaveLength(0);
    await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: question.id, result: { action: 'decline' } }));
    expect(((await next()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent.declined).toBe(true);
  });

  it('no dialog without the capability, on an older protocol, or with a session id of another key: plain JSON with an approval link', async () => {
    const s = setup();
    const noCapability = await initialize(s, {});
    const older = await initialize(s, { elicitation: {} }, '2025-03-26');
    const foreign = await initialize(s, { elicitation: {} }, '2025-06-18', fakeKey());
    for (const session of [noCapability, older, foreign, 'forged.session']) {
      const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
      expect(res.headers.get('content-type')).toBe('application/json');
      const { result } = (await res.json()) as { result: { structuredContent: Record<string, unknown> } };
      expect(result.structuredContent.approvalRequired).toBe(true);
    }
    expect(s.state.published).toHaveLength(0);
  });

  it('a client that does not accept a stream gets plain JSON and an approval link even with the dialog capability', async () => {
    const s = setup();
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session, accept: 'application/json' }));
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent.approvalRequired).toBe(true);
  });

  it('a read tool is plain JSON even with the dialog capability', async () => {
    const s = setup();
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'list_sites', arguments: {} }), { 'mcp-session-id': session }));
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

// ---------- skeleton plans ----------

describe('skeleton plans (announce_sections, clear_sections)', () => {
  /** Every plan:update the site's open editors hear. */
  function planEvents(siteId = 'site-1'): PlanUpdateEvent[] {
    const heard: PlanUpdateEvent[] = [];
    subscribeSite(siteId, (event, data) => {
      if (event === LIVE_EVENTS.planUpdate) heard.push(data as PlanUpdateEvent);
    });
    return heard;
  }
  const three = [
    { ref: 'hero', title: 'Hero', kind: 'hero' },
    { ref: 'about', title: 'About us' },
    { ref: 'faq', title: 'Questions', kind: 'faq' },
  ];
  const section = (ref: string) => ({ op: 'insertNodes', pageId: 'home', nodes: [{ ref, type: 'section', children: [{ type: 'p', props: { children: 'Hi' } }] }] });

  it('announces on an existing page: writes nothing, moves no version, and every open editor hears the plan', async () => {
    const s = setup();
    const heard = planEvents();
    const res = await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', after: 'title', sections: three });
    expect(res.isError).toBe(false);
    const planId = res.structuredContent.planId as string;
    expect(planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(res.structuredContent.expiresAt as string)).toBeGreaterThan(Date.now());
    expect(s.state.saved).toHaveLength(0);
    expect(s.state.version).toBe(3);
    expect(audits.rows).toHaveLength(0);
    expect(heard).toHaveLength(1);
    expect(heard[0].plan).toMatchObject({ planId, pageId: 'home', after: 'title', label: 'Agent' });
    expect(heard[0].plan.sections.map((x) => [x.ref, x.title, x.kind])).toEqual([
      ['hero', 'Hero', 'hero'],
      ['about', 'About us', 'generic'],
      ['faq', 'Questions', 'faq'],
    ]);
    // No key id travels: the agent is a hash.
    expect(JSON.stringify(heard)).not.toContain('key_1');
    expect(plansSnapshot('site-1', SCOPE)).toHaveLength(1);
  });

  it('refuses arguments outside the bounds and names the problem', async () => {
    const s = setup();
    const bad = async (args: Record<string, unknown>) => errorOf(await call(s, 'announce_sections', { siteId: 'site-1', ...args })).code;
    const many = Array.from({ length: PLAN_LIMITS.sectionsPerPlan + 1 }, (_, i) => ({ ref: `s${i}`, title: `S${i}` }));
    expect(await bad({ pageId: 'home', sections: many })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', sections: [] })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', sections: [{ ref: 'a', title: 'x'.repeat(PLAN_LIMITS.titleMax + 1) }] })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', sections: [{ ref: 'a', title: '​‮\u0007' }] })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', sections: [{ ref: 'has space', title: 'A' }] })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', sections: [{ ref: 'a', title: 'A', kind: 'carousel' }] })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', sections: [{ ref: 'a', title: 'A' }, { ref: 'a', title: 'B' }] })).toBe('invalid_request');
    expect(await bad({ sections: [{ ref: 'a', title: 'A' }] })).toBe('invalid_request');
    expect(await bad({ pageId: 'home', newPage: { ref: 'p', title: 'P' }, sections: [{ ref: 'a', title: 'A' }] })).toBe('invalid_request');
    expect(await bad({ newPage: { ref: 'p', title: 'P' }, after: 'title', sections: [{ ref: 'a', title: 'A' }] })).toBe('invalid_request');
    expect(await bad({ newPage: { ref: 'a', title: 'P' }, sections: [{ ref: 'a', title: 'A' }] })).toBe('invalid_request');
    expect(await bad({ pageId: 'missing', sections: [{ ref: 'a', title: 'A' }] })).toBe('page_not_found');
    expect(await bad({ pageId: 'home', after: 'nope', sections: [{ ref: 'a', title: 'A' }] })).toBe('invalid_request');
    expect(plansSnapshot('site-1', SCOPE)).toHaveLength(0);
  });

  it('a site outside the key\'s scope is not found, and nothing is announced there', async () => {
    const s = setup();
    const heard = planEvents('site-x');
    expect(errorOf(await call(s, 'announce_sections', { siteId: 'site-x', pageId: 'home', sections: three })).code).toBe('site_not_found');
    expect(heard).toHaveLength(0);
    expect(plansSnapshot('site-x', SCOPE)).toHaveLength(0);
  });

  it('a key that may not edit the site may not announce on it', async () => {
    const s = setup({ outcome: verifiedKey('viewer') });
    expect(errorOf(await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three })).code).toBe('forbidden');
  });

  it('titles are plain text: control and bidirectional characters removed, one line', async () => {
    const s = setup();
    const heard = planEvents();
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'a', title: 'Pri‮cing\n<b>x</b>' }] });
    expect(heard[0].plan.sections[0].title).toBe('Pri cing <b>x</b>');
  });

  it(`holds at most ${PLAN_LIMITS.plansPerSite} plans per site and ${PLAN_LIMITS.plansPerKeyPerSite} per key; more are refused`, async () => {
    const keys = [setup(), setup({ outcome: verifiedKey('admin', 'key_2') })];
    for (let i = 0; i < PLAN_LIMITS.plansPerSite; i += 1) {
      const s = keys[i % 2];
      expect((await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: `a${i}`, title: 'A' }] })).isError).toBe(false);
    }
    // The first key holds two: its third is refused for the key, the second key's for the site.
    expect(errorOf(await call(keys[0], 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'z', title: 'Z' }] })).code).toBe('too_many_plans');
    expect(errorOf(await call(keys[1], 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'z', title: 'Z' }] })).code).toBe('too_many_plans');
  });

  it('fulfils before the write is announced, so an editor hears plan:update before the site:version that makes it fetch', async () => {
    const s = setup();
    const order: string[] = [];
    subscribeSite('site-1', (event) => order.push(event));
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three.slice(0, 2) });
    // The fake repository runs beforeAnnounce as the real one does; the real one then publishes site:version.
    s.mock.saveProject.mockImplementationOnce(async (_scope: unknown, _project: unknown, options: Record<string, unknown>) => {
      s.state.version += 1;
      (options.beforeAnnounce as (v: number) => void)(s.state.version);
      order.push('site:version');
      return { version: s.state.version };
    });
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [section('hero')] });
    expect(order.filter((e) => e !== 'agent:activity')).toEqual(['plan:update', 'plan:update', 'site:version']);
  });

  it('a section written on another page fulfils nothing', async () => {
    const s = setup();
    const heard = planEvents();
    await call(s, 'announce_sections', { siteId: 'site-1', newPage: { ref: 'pp', title: 'Pricing' }, sections: [three[0]] });
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [section('hero')] });
    expect(heard).toHaveLength(1);
  });

  it('is limited per key: announcements and clears share their budget', async () => {
    const s = setup({ deps: { limits: limitsWith({ plans: createPageGenRateLimiter({ maxPerWindow: 2, windowMs: 60_000 }) }) } });
    const first = await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'a', title: 'A' }] });
    await call(s, 'clear_sections', { siteId: 'site-1', planId: first.structuredContent.planId });
    expect(errorOf(await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'a', title: 'A' }] })).code).toBe('rate_limited');
  });

  it('each batch fulfils the sections whose ref it created; the last one ends the plan', async () => {
    const s = setup();
    const heard = planEvents();
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three.slice(0, 2) });
    const first = await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [section('hero')] });
    const heroId = (first.structuredContent.created as Record<string, string>).hero;
    expect(heard.at(-1)?.ended).toBeUndefined();
    expect(heard.at(-1)?.plan.sections).toEqual([
      { ref: 'hero', title: 'Hero', kind: 'hero', fulfilledAt: 4, nodeId: heroId },
      { ref: 'about', title: 'About us', kind: 'generic' },
    ]);
    // A batch that creates no announced ref changes nothing.
    const updates = heard.length;
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 4, ops: [{ op: 'updateText', nodeId: 'title', text: 'Bread' }] });
    expect(heard).toHaveLength(updates);
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 5, ops: [section('about')] });
    expect(heard.at(-1)?.ended).toBe('fulfilled');
    expect(heard.at(-1)?.plan.sections.map((x) => x.fulfilledAt)).toEqual([4, 6]);
    expect(plansSnapshot('site-1', SCOPE)).toHaveLength(0);
  });

  it('a refused batch fulfils nothing', async () => {
    const s = setup();
    const heard = planEvents();
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three });
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 2, ops: [section('hero')] });
    expect(heard).toHaveLength(1);
    expect(plansSnapshot('site-1', SCOPE)[0].sections.every((x) => x.fulfilledAt === undefined)).toBe(true);
  });

  it("another key's batch never fulfils, and another key cannot clear or replace the plan", async () => {
    const owner = setup();
    const other = setup({ outcome: verifiedKey('admin', 'key_2') });
    const heard = planEvents();
    const announced = await call(owner, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three });
    const planId = announced.structuredContent.planId as string;
    await call(other, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [section('hero')] });
    expect(heard).toHaveLength(1);
    expect(errorOf(await call(other, 'clear_sections', { siteId: 'site-1', planId })).code).toBe('plan_not_found');
    expect(errorOf(await call(other, 'announce_sections', { siteId: 'site-1', pageId: 'home', replaces: planId, sections: three })).code).toBe('plan_not_found');
    expect(plansSnapshot('site-1', SCOPE).map((p) => p.planId)).toEqual([planId]);
  });

  it('clear_sections ends the plan at once; a second clear finds nothing', async () => {
    const s = setup();
    const heard = planEvents();
    const announced = await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three });
    const planId = announced.structuredContent.planId as string;
    const cleared = await call(s, 'clear_sections', { siteId: 'site-1', planId });
    expect(cleared.structuredContent).toEqual({ cleared: true, planId });
    expect(heard.at(-1)).toMatchObject({ ended: 'cleared', plan: { planId } });
    expect(errorOf(await call(s, 'clear_sections', { siteId: 'site-1', planId })).code).toBe('plan_not_found');
  });

  it('replaces swaps a plan in one step, and a ref already created stays fulfilled', async () => {
    const s = setup();
    const heard = planEvents();
    const announced = await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: three });
    const oldId = announced.structuredContent.planId as string;
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [section('hero')] });
    const replaced = await call(s, 'announce_sections', {
      siteId: 'site-1',
      pageId: 'home',
      replaces: oldId,
      sections: [three[0], { ref: 'team', title: 'Team' }, three[2]],
    });
    const newId = replaced.structuredContent.planId as string;
    const swap = heard.at(-1)!;
    expect(swap.replaces).toBe(oldId);
    expect(swap.ended).toBeUndefined();
    expect(swap.plan.planId).toBe(newId);
    expect(swap.plan.sections.map((x) => [x.ref, x.fulfilledAt])).toEqual([['hero', 4], ['team', undefined], ['faq', undefined]]);
    // The old plan ended without an end event of its own: the swap said it.
    expect(heard.filter((e) => e.plan.planId === oldId && e.ended)).toHaveLength(0);
    expect(plansSnapshot('site-1', SCOPE).map((p) => p.planId)).toEqual([newId]);
    // A replace frees the old plan's slot: two plans of the key and a replace still fit.
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'x', title: 'X' }] });
    expect((await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', replaces: newId, sections: three })).isError).toBe(false);
  });

  it('a new page: its createPage ref gives the plan its page, and the sections fulfil on it', async () => {
    const s = setup();
    const heard = planEvents();
    await call(s, 'announce_sections', { siteId: 'site-1', newPage: { ref: 'pricing-page', title: 'Pricing' }, sections: [three[0], three[1]] });
    expect(heard[0].plan).toMatchObject({ newPage: { ref: 'pricing-page', title: 'Pricing' } });
    expect(heard[0].plan.pageId).toBeUndefined();
    const res = await call(s, 'apply_batch', {
      siteId: 'site-1',
      expectedVersion: 3,
      ops: [
        { op: 'createPage', title: 'Pricing', ref: 'pricing-page' },
        { op: 'insertNodes', pageId: 'ref:pricing-page', nodes: [{ ref: 'hero', type: 'section', children: [] }] },
      ],
    });
    const created = res.structuredContent.created as Record<string, string>;
    const plan = heard.at(-1)!.plan;
    expect(plan).toMatchObject({ pageId: created['pricing-page'], pageAt: 4 });
    expect(plan.sections[0]).toMatchObject({ ref: 'hero', fulfilledAt: 4, nodeId: created.hero });
  });

  it('the end of the MCP session (DELETE) ends the plans that session announced, and only those', async () => {
    const s = setup();
    const heard = planEvents();
    const session = await initialize(s, {});
    const otherSession = await initialize(s, {});
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [three[0]] }, { 'mcp-session-id': session });
    await call(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [three[1]] }, { 'mcp-session-id': otherSession });
    // A plan announced without a session (another key, since one key holds two plans per site) is not the session's.
    await call(setup({ outcome: verifiedKey('admin', 'key_2') }), 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [three[2]] });
    const del = (headers: Record<string, string>) =>
      s.handler.DELETE(new Request('https://app.lumitra.co/api/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${s.key}`, ...headers } }));
    // A forged id, or one issued to another key, ends nothing.
    expect((await del({ 'mcp-session-id': `${session.split('.')[0]}.forged` })).status).toBe(204);
    const stranger = fakeKey();
    const foreign = await initialize(s, {}, '2025-06-18', stranger);
    expect((await del({ 'mcp-session-id': foreign })).status).toBe(204);
    expect(plansSnapshot('site-1', SCOPE)).toHaveLength(3);
    expect((await del({ 'mcp-session-id': session })).status).toBe(204);
    expect(heard.at(-1)).toMatchObject({ ended: 'session_ended' });
    expect(plansSnapshot('site-1', SCOPE).map((p) => p.sections[0].ref).sort()).toEqual(['about', 'faq']);
  });
});

describe('secrets', () => {
  it('never answers the key, in results, errors or denials', async () => {
    const s = setup();
    const bodies: string[] = [];
    for (const name of ['list_sites', 'get_site', 'apply_batch', 'publish']) {
      const res = await s.handler.POST(post(s.key, rpc('tools/call', { name, arguments: { siteId: 'site-1', expectedVersion: 99, ops: [{ op: 'x' }] } })));
      bodies.push(await res.text());
    }
    bodies.push(await (await s.handler.POST(post(s.key, rpc('tools/call', { name: s.key, arguments: {} })))).text());
    for (const body of bodies) {
      expect(body).not.toContain(s.key);
      expect(body).not.toMatch(/\n\s+at .+\(.+:\d+:\d+\)/);
    }
  });
});

describe('hardening', () => {
  it('one key fills only its own share of open dialog questions; another key still gets its dialog', async () => {
    const s = setup({ deps: { elicitationTimeoutMs: 5_000 } });
    const session = await initialize(s, { elicitation: {} });
    const questions: Array<{ id: unknown; next: () => Promise<Record<string, unknown>> }> = [];
    for (let i = 0; i < ELICITATION_PER_KEY; i++) {
      const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
      const next = sseReader(res);
      const question = await next();
      expect(question.method).toBe('elicitation/create');
      questions.push({ id: question.id, next });
    }
    // Past its cap the same key gets an approval link at once, not another question.
    const over = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
    const overResult = (await sseReader(over)()) as { result?: { structuredContent: Record<string, unknown> } };
    expect(overResult.result?.structuredContent.approvalRequired).toBe(true);

    // Another key is unaffected.
    const otherKey = fakeKey();
    const otherSession = await initialize(s, { elicitation: {} }, '2025-06-18', otherKey);
    const theirs = await s.handler.POST(post(otherKey, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': otherSession }));
    const theirNext = sseReader(theirs);
    const question = await theirNext();
    expect(question.method).toBe('elicitation/create');
    await s.handler.POST(post(otherKey, { jsonrpc: '2.0', id: question.id, result: { action: 'decline' } }));
    expect(((await theirNext()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent.declined).toBe(true);

    // Close the first key's questions.
    for (const q of questions) {
      await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: q.id, result: { action: 'decline' } }));
      await q.next();
    }
    expect(s.state.published).toHaveLength(0);
  });

  it('a stream the client cancels mid-question ends the question and publishes nothing', async () => {
    const s = setup({ deps: { elicitationTimeoutMs: 5_000 } });
    const session = await initialize(s, { elicitation: {} });
    const before = pendingCount();
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    const question = JSON.parse(new TextDecoder().decode(first.value).split('data: ')[1]) as { id: string; method: string };
    expect(question.method).toBe('elicitation/create');
    expect(pendingCount()).toBe(before + 1);
    await reader.cancel();
    await vi.waitFor(() => expect(pendingCount()).toBe(before));
    // A late accept finds no question, and nothing was published.
    const late = await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: question.id, result: { action: 'accept', content: { confirm: true } } }));
    expect(late.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.state.published).toHaveLength(0);
  });

  it('an unexpected repository error never reaches the agent: a fixed message, the detail in the server log', async () => {
    const s = setup();
    const leak = 'relation "tg_secret.sites" does not exist at db.internal:5432';
    const prismaLike = Object.assign(new Error(leak), { name: 'PrismaClientKnownRequestError', code: 'P2010', clientVersion: '6.19.3' });
    s.mock.listSites.mockRejectedValueOnce(prismaLike);
    const res = await call(s, 'list_sites');
    expect(errorOf(res).code).toBe('failed');
    expect(JSON.stringify(res)).not.toContain('tg_secret');
    s.state.saveError = prismaLike;
    const write = await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] });
    expect(JSON.stringify(write)).not.toContain('tg_secret');
    expect(errorOf(write).message).toMatch(/^the operation failed/);
  });

  it('replaces any failure text the library did not word itself', async () => {
    const s = setup();
    s.mock.publishProject.mockImplementationOnce(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), { name: 'PrismaClientInitializationError' });
    });
    const id = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    s.approvals.decide(String(id), 'user-1', 'approve');
    const res = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(JSON.stringify(res)).not.toContain('10.0.0.7');
    expect(typeof errorOf(res).message).toBe('string');
    expect(UNEXPECTED_FAILURE).not.toContain('5432');
  });

  it('refuses an MCP-Protocol-Version it does not speak, and accepts the ones it does', async () => {
    const s = setup();
    expect((await s.handler.POST(post(s.key, rpc('ping'), { 'mcp-protocol-version': '1999-01-01' }))).status).toBe(400);
    for (const v of PROTOCOL_VERSIONS) expect((await s.handler.POST(post(s.key, rpc('ping'), { 'mcp-protocol-version': v }))).status).toBe(200);
  });

  it('caps tool calls per batch and truncates an echoed unknown name', async () => {
    const s = setup();
    const res = await s.handler.POST(post(s.key, Array.from({ length: 7 }, () => rpc('tools/call', { name: 'list_sites', arguments: {} }))));
    const answers = (await res.json()) as Array<{ result?: unknown; error?: { code: number } }>;
    expect(answers.filter((a) => a.result)).toHaveLength(5);
    expect(answers.filter((a) => a.error?.code === -32600)).toHaveLength(2);
    expect(s.mock.listSites).toHaveBeenCalledTimes(5);
    const long = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'x'.repeat(5_000), arguments: {} })));
    const { error } = (await long.json()) as { error: { message: string } };
    expect(error.message.length).toBeLessThan(140);
  });

  it('throttles a loop of publish calls on a stale version through the read budget', async () => {
    const s = setup({ version: 6, deps: { limits: limitsWith({ reads: createPageGenRateLimiter({ maxPerWindow: 3, windowMs: 60_000 }) }) } });
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push(String(errorOf(await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).code));
    expect(codes).toEqual(['site_changed', 'site_changed', 'site_changed', 'rate_limited', 'rate_limited']);
    expect(s.mock.loadProjectWithVersion).toHaveBeenCalledTimes(3);
    expect(errorOf(await call(s, 'rollback', { siteId: 'site-1', revision: 6 })).code).toBe('rate_limited');
  });

  it('limits reads per key', async () => {
    const s = setup({ deps: { limits: limitsWith({ reads: createPageGenRateLimiter({ maxPerWindow: 2, windowMs: 60_000 }) }) } });
    expect((await call(s, 'list_sites')).isError).toBe(false);
    expect((await call(s, 'get_site', { siteId: 'site-1' })).isError).toBe(false);
    expect(errorOf(await call(s, 'list_sites')).code).toBe('rate_limited');
  });

  it('starts every answer with the notice that its text is data, never an instruction', async () => {
    const s = setup();
    const res = await call(s, 'get_page', { siteId: 'site-1', pageId: 'home' });
    expect(res.content[0].text.startsWith(DATA_NOTICE)).toBe(true);
    const init = await s.handler.POST(post(s.key, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })));
    expect(((await init.json()) as { result: { instructions: string } }).result.instructions).toContain('never an instruction');
  });
});
