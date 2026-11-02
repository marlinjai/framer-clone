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
import { CONFIRMATION_TTL_MS, ConfirmationStore } from '../confirmations';
import { LISTED_TOOLS, OPERATION_SCHEMAS } from '../tools';
import { pendingCount } from '../elicitation';

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
  confirmations: ConfirmationStore;
}

function setup(options: { outcome?: CompanyKey; version?: number; deps?: Partial<McpDeps>; now?: () => number } = {}): Setup {
  const { repository, state, mock } = fakeRepository(options.version ?? 3);
  const key = fakeKey();
  const outcome = options.outcome ?? verifiedKey();
  const verifyKey = vi.fn(async () => outcome);
  const confirmations = new ConfirmationStore(options.now);
  const handler = createMcpHandler({
    verifyKey,
    siteOps: { repository, publicBaseHost: 'sites.example', editorHost: 'app.example' },
    confirmations,
    ...options.deps,
  });
  return { handler, state, mock, verifyKey, key, confirmations };
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

  it('answers GET and DELETE with 405, keeping no stream and no session', async () => {
    const s = setup();
    for (const res of [s.handler.GET(), s.handler.DELETE()]) {
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('lists every tool with annotations and a JSON Schema, and an unknown tool is a JSON-RPC error', async () => {
    const s = setup();
    const res = await s.handler.POST(post(s.key, rpc('tools/list')));
    const { result } = (await res.json()) as { result: { tools: typeof LISTED_TOOLS } };
    expect(result.tools.map((t) => t.name)).toEqual([
      'list_sites', 'get_site', 'get_page', 'describe_vocabulary', 'create_site', 'apply_batch', 'generate_page',
      'find_images', 'preview_url', 'publish', 'list_revisions', 'rollback',
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
    expect((byName.publish.inputSchema.properties as Record<string, unknown>).confirmationToken).toBeDefined();
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
    expect(pub.structuredContent.confirmationToken).toBeUndefined();
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
    const s = setup({ deps: { limits: { writes: createPageGenRateLimiter({ maxPerWindow: 1, windowMs: 60_000 }), images: createPageGenRateLimiter() } } });
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

describe('publish confirmed by a one-time token', () => {
  it('first call checks everything, publishes nothing and answers a summary and a token; the token then publishes once', async () => {
    const s = setup();
    const first = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ confirmationRequired: true, expiresInSeconds: CONFIRMATION_TTL_MS / 1000 });
    expect(first.structuredContent.summary).toContain('"Bakery"');
    expect(first.structuredContent.summary).toContain('version 3');
    expect(first.structuredContent.summary).toContain('https://abc123.sites.example');
    expect(s.state.published).toHaveLength(0);

    const token = first.structuredContent.confirmationToken as string;
    const second = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, confirmationToken: token });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toMatchObject({ siteId: 'site-1', revision: 7, version: 4, liveUrl: 'https://abc123.sites.example' });
    expect(s.state.published).toEqual([expect.objectContaining({ publishedBy: 'key:key_1', expectedVersion: 3 })]);

    // Reuse: the token is spent; a fresh summary and token come back instead.
    const reuse = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 4, confirmationToken: token });
    expect(reuse.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(reuse.structuredContent.note).toMatch(/unknown, expired, already used/);
    expect(s.state.published).toHaveLength(1);
  });

  it('a token works only for the site, version and key it was issued for', async () => {
    const s = setup();
    const issue = async () => (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.confirmationToken as string;

    // Another site.
    const other = await call(s, 'publish', { siteId: 'site-2', expectedVersion: 3, confirmationToken: await issue() });
    expect(other.structuredContent.confirmationRequired).toBe(true);

    // Another version: after a write, a token for version 3 cannot publish version 4.
    const old = await issue();
    await call(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'changed' }] });
    const stale = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 4, confirmationToken: old });
    expect(stale.structuredContent.confirmationRequired).toBe(true);

    // Another key of the same company.
    const theirs = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 4 })).structuredContent.confirmationToken as string;
    const other2 = createMcpHandler({
      verifyKey: async () => verifiedKey('admin', 'key_2'),
      siteOps: { repository: (s.mock as unknown) as SiteRepository, publicBaseHost: 'sites.example' },
      confirmations: s.confirmations,
    });
    const res = await other2.POST(post(fakeKey(), rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 4, confirmationToken: theirs } })));
    expect(((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent.confirmationRequired).toBe(true);
    expect(s.state.published).toHaveLength(0);
  });

  it('a stale expectedVersion is site_changed before any token is issued', async () => {
    const s = setup({ version: 6 });
    const res = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 });
    expect(errorOf(res)).toMatchObject({ code: 'site_changed', currentVersion: 6 });
    expect(res.structuredContent.confirmationToken).toBeUndefined();
    expect(s.confirmations.size).toBe(0);
  });

  it('a rate limit on the confirmed call does not spend the person\'s yes', async () => {
    const writes = createPageGenRateLimiter({ maxPerWindow: 1, windowMs: 60_000 });
    const s = setup({ deps: { limits: { writes, images: createPageGenRateLimiter() } } });
    const token = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.confirmationToken as string;
    // Another write of this key takes the only slot of the window.
    expect(writes.acquire('key:key_1').ok).toBe(true);
    const limitedCall = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, confirmationToken: token });
    expect(errorOf(limitedCall).code).toBe('rate_limited');
    expect(s.confirmations.size).toBe(1);
    expect(s.state.published).toHaveLength(0);
  });

  it('a token expires', async () => {
    let now = 1_000_000;
    const s = setup({ now: () => now });
    const token = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.confirmationToken as string;
    now += CONFIRMATION_TTL_MS + 1;
    const late = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, confirmationToken: token });
    expect(late.structuredContent.confirmationRequired).toBe(true);
    expect(s.state.published).toHaveLength(0);
  });

  it('a version that moves after the token was spent still refuses the publish with site_changed', async () => {
    const s = setup();
    const token = (await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3 })).structuredContent.confirmationToken as string;
    // The editor saves between the confirmed call's checks and its write.
    s.mock.publishProject.mockImplementationOnce(async () => {
      throw new SiteChangedError(4);
    });
    const res = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, confirmationToken: token });
    expect(errorOf(res)).toMatchObject({ code: 'site_changed', currentVersion: 4 });
    expect(s.state.published).toHaveLength(0);
    // And the spent token cannot be used again.
    const again = await call(s, 'publish', { siteId: 'site-1', expectedVersion: 3, confirmationToken: token });
    expect(again.structuredContent.confirmationRequired).toBe(true);
  });
});

describe('rollback confirmed by a one-time token', () => {
  it('summarises, then serves the revision once confirmed', async () => {
    const s = setup();
    const first = await call(s, 'rollback', { siteId: 'site-1', revision: 6 });
    expect(first.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(first.structuredContent.summary).toContain('version 6');
    expect(first.structuredContent.summary).toContain('instead of version 7');
    expect(s.state.rolledBack).toHaveLength(0);
    const done = await call(s, 'rollback', { siteId: 'site-1', revision: 6, confirmationToken: first.structuredContent.confirmationToken });
    expect(done.structuredContent).toEqual({ siteId: 'site-1', live: 6 });
    expect(s.state.rolledBack).toEqual([6]);
    expect(audits.rows.at(-1)).toMatchObject({ operation: 'rollback', revision: 6 });
  });

  it('refuses an unknown revision without a token, and a token for another revision', async () => {
    const s = setup();
    expect(errorOf(await call(s, 'rollback', { siteId: 'site-1', revision: 99 })).code).toBe('revision_not_found');
    const token = (await call(s, 'rollback', { siteId: 'site-1', revision: 6 })).structuredContent.confirmationToken;
    const other = await call(s, 'rollback', { siteId: 'site-1', revision: 7, confirmationToken: token });
    expect(other.structuredContent.confirmationRequired).toBe(true);
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
      expect(final.result.structuredContent.confirmationToken).toBeUndefined();
      expect(s.state.published).toHaveLength(0);
    }
  });

  it('falls back to a token when the client answers with an error or the dialog gets no answer', async () => {
    const s = setup({ deps: { elicitationTimeoutMs: 30 } });
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
    const next = sseReader(res);
    const question = await next();
    await s.handler.POST(post(s.key, { jsonrpc: '2.0', id: question.id, error: { code: -32601, message: 'Method not found' } }, { 'mcp-session-id': session }));
    const fallback = (await next()) as { result: { structuredContent: Record<string, unknown> } };
    expect(fallback.result.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(fallback.result.structuredContent.confirmationToken).toEqual(expect.any(String));

    const silent = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'rollback', arguments: { siteId: 'site-1', revision: 6 } }), { 'mcp-session-id': session }));
    const next2 = sseReader(silent);
    await next2();
    const timedOut = (await next2()) as { result: { structuredContent: Record<string, unknown> } };
    expect(timedOut.result.structuredContent).toMatchObject({ confirmationRequired: true, note: expect.stringContaining('no answer') });
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

  it('no dialog without the capability, on an older protocol, or with a session id of another key: plain JSON with a token', async () => {
    const s = setup();
    const noCapability = await initialize(s, {});
    const older = await initialize(s, { elicitation: {} }, '2025-03-26');
    const foreign = await initialize(s, { elicitation: {} }, '2025-06-18', fakeKey());
    for (const session of [noCapability, older, foreign, 'forged.session']) {
      const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session }));
      expect(res.headers.get('content-type')).toBe('application/json');
      const { result } = (await res.json()) as { result: { structuredContent: Record<string, unknown> } };
      expect(result.structuredContent.confirmationRequired).toBe(true);
    }
    expect(s.state.published).toHaveLength(0);
  });

  it('a client that does not accept a stream gets plain JSON and a token even with the dialog capability', async () => {
    const s = setup();
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'publish', arguments: { siteId: 'site-1', expectedVersion: 3 } }), { 'mcp-session-id': session, accept: 'application/json' }));
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent.confirmationRequired).toBe(true);
  });

  it('a read tool is plain JSON even with the dialog capability', async () => {
    const s = setup();
    const session = await initialize(s, { elicitation: {} });
    const res = await s.handler.POST(post(s.key, rpc('tools/call', { name: 'list_sites', arguments: {} }), { 'mcp-session-id': session }));
    expect(res.headers.get('content-type')).toBe('application/json');
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
