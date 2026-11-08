// @vitest-environment node
//
// src/app/api/projects/__tests__/live-routes.test.ts
//
// The live sync routes of plan docs/plans/2026-11-08-live-agent-canvas.md:
// GET /api/projects/<id>/events (the site's stream) and GET /api/projects/<id>/document
// (the stored copy). auth-brain and the site repository are mocked; the guard
// chain, the scope resolution and the in-process bus are real.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return { ...actual, getSiteRepository: vi.fn() };
});
vi.mock('@/server/sites/repository', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites/repository')>();
  return { ...actual, getSiteRepository: vi.fn() };
});

const auditRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, fail: false, calls: [] as unknown[] }));
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({
    siteOperationAudit: {
      findMany: vi.fn(async (args: unknown) => {
        auditRows.calls.push(args);
        if (auditRows.fail) throw new Error('database down');
        return auditRows.rows;
      }),
    },
  }),
}));

import { getSiteRepository, SiteNotFoundError } from '@/server/sites';
import { reportAgentActivity, resetLivePresenceForTests } from '@/server/sites/livePresence';
import { liveAgentId } from '@/server/siteOps/audit';
import { getSiteRepository as getRepositoryDirect } from '@/server/sites/repository';
import { publishSiteEvent, resetLiveBusForTests, LIVE_STREAM_LIMITS } from '@/server/sites/liveBus';
import { GET as EVENTS } from '../[projectId]/events/route';
import { announcePlan, resetLivePlansForTests } from '@/server/mcp/livePlans';
import { openLiveGeneration, resetLiveGenerationForTests } from '@/server/sites/liveGeneration';
import { LIVE_RECHECK_MS, LIVE_RECHECK_ON_WRITE_MS } from '@/lib/projects/liveEvents';
import { GET as DOCUMENT } from '../[projectId]/document/route';

const ORIGINAL_EDITOR_HOST = process.env.EDITOR_HOST;
const SCOPE = { workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };

function makeSession() {
  return {
    user: { id: 'user-1', name: 'Marlin' },
    session: {},
    tenants: [{ id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_lumitra' }],
    workspaces: [{ id: 'ws_marlin', tenant_id: 'tenant-1' }],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: 'ws_marlin' },
  };
}

let version = 7;
const repo = {
  getSiteVersion: vi.fn(async (_scope: unknown, siteId: string) => {
    if (siteId !== 'site_1') throw new SiteNotFoundError(siteId);
    return version;
  }),
  loadProjectWithVersion: vi.fn(async () => ({
    project: (await import('@/models/ProjectModel')).default.create({ id: 'site_1', metadata: { title: 'Live', description: '' }, pages: {} }),
    version,
  })),
};

function req(path: string, opts: { host?: string; cookie?: string | null; headers?: Record<string, string>; signal?: AbortSignal } = {}): Request {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co', ...(opts.headers ?? {}) };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? 'lumitra_session=good';
  return new Request(`http://app.lumitra.co${path}`, { headers, signal: opts.signal });
}

const ctx = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

/** Reads named events off an SSE response as they arrive. */
function eventReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(): Promise<{ event: string; data: unknown; id?: string }> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(':')) continue; // heartbeat
          const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
          return { event: fields.event, data: JSON.parse(fields.data), ...(fields.id ? { id: fields.id } : {}) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async ended(): Promise<boolean> {
      for (;;) {
        const { done } = await reader.read();
        if (done) return true;
      }
    },
    cancel: () => reader.cancel(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveBusForTests();
  resetLivePresenceForTests();
  resetLivePlansForTests();
  resetLiveGenerationForTests();
  auditRows.rows = [];
  auditRows.fail = false;
  auditRows.calls = [];
  process.env.EDITOR_HOST = 'app.lumitra.co';
  version = 7;
  vi.mocked(getSiteRepository).mockReturnValue(repo as unknown as ReturnType<typeof getSiteRepository>);
  vi.mocked(getRepositoryDirect).mockReturnValue(repo as unknown as ReturnType<typeof getSiteRepository>);
  mockVerifySession.mockResolvedValue(makeSession());
  mockCan.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_EDITOR_HOST === undefined) delete process.env.EDITOR_HOST;
  else process.env.EDITOR_HOST = ORIGINAL_EDITOR_HOST;
});

describe.each([
  ['events', EVENTS, '/api/projects/site_1/events'],
  ['document', DOCUMENT, '/api/projects/site_1/document'],
] as const)('the %s route guard', (_name, GET, path) => {
  it('404s on a published-site host before reading the session', async () => {
    const res = await GET(req(path, { host: 'www.example.com' }), ctx('site_1'));
    expect(res.status).toBe(404);
    expect(mockVerifySession).not.toHaveBeenCalled();
  });

  it('401s without a session cookie', async () => {
    const res = await GET(req(path, { cookie: null }), ctx('site_1'));
    expect(res.status).toBe(401);
  });

  it('503s when auth-brain cannot answer, never a sign-out', async () => {
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockVerifySession.mockRejectedValue(new AuthBrainError('down', 503));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req(path), ctx('site_1'));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('auth_unavailable');
    errorSpy.mockRestore();
  });

  it('403s for a session without a company with Lumitra Sites', async () => {
    mockVerifySession.mockResolvedValue({ ...makeSession(), tenants: [{ id: 'tenant-1', app_grants: [], group_id: 'tg_lumitra' }] });
    const res = await GET(req(path), ctx('site_1'));
    expect(res.status).toBe(403);
  });

  it('403s without editSite on the workspace', async () => {
    mockCan.mockResolvedValue(false);
    const res = await GET(req(path), ctx('site_1'));
    expect(res.status).toBe(403);
    expect(repo.getSiteVersion).not.toHaveBeenCalled();
  });

  it('503s when OpenFGA cannot answer', async () => {
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockCan.mockRejectedValue(new AuthBrainError('OpenFGA check failed: 503', 503));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req(path), ctx('site_1'));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('authz_unavailable');
    errorSpy.mockRestore();
  });

  it('answers a project of another workspace like a missing one (404), never its existence', async () => {
    const res = await GET(req(path.replace('site_1', 'site_foreign')), ctx('site_foreign'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
    expect(repo.getSiteVersion).toHaveBeenCalledWith(SCOPE, 'site_foreign');
  });
});

describe('GET /api/projects/<id>/events', () => {
  it("sends the site's live skeleton plans in `state`, never one whose time ran out or one of another workspace, then every plan:update", async () => {
    const plan = (over: Record<string, unknown>) =>
      announcePlan({ siteId: 'site_1', scope: SCOPE, agentId: 'agent-a', label: 'Claude', pageId: 'home', sections: [{ ref: 'hero', title: 'Hero', kind: 'hero' }], ...over } as Parameters<typeof announcePlan>[0], Date.now());
    const live = plan({});
    plan({ scope: { workspaceId: 'ws_other', tenantGroupId: 'tg_other' } });
    // Announced 20 minutes ago: past its hard cap, so it is swept before `state` is built.
    announcePlan({ siteId: 'site_1', scope: SCOPE, agentId: 'agent-b', label: 'Old', pageId: 'home', sections: [{ ref: 'old', title: 'Old', kind: 'generic' }] }, Date.now() - 20 * 60_000);
    const res = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
    const events = eventReader(res);
    const state = await events.next();
    expect(state.event).toBe('state');
    const plans = (state.data as { plans: Array<{ planId: string }> }).plans;
    expect(live.ok && plans.map((p) => p.planId)).toEqual([live.ok ? live.plan.planId : '']);
    // The sweep that left the old plan out of `state` also told the stream it ended (an editor that never drew it ignores that).
    expect(await events.next()).toMatchObject({ event: 'plan:update', data: { ended: 'expired', plan: { agentId: 'agent-b' } } });
    publishSiteEvent('site_1', 'plan:update', { plan: { planId: 'p2' }, ended: 'cleared' });
    expect(await events.next()).toEqual({ event: 'plan:update', data: { plan: { planId: 'p2' }, ended: 'cleared' } });
    await events.cancel();
  });

  it("sends the site's running generation in `state` (never another workspace's), then its draft events in order", async () => {
    const node = { id: 'n1', type: 'section', componentType: 'host', label: 'Hero', props: {}, children: [] } as never;
    const run = openLiveGeneration('site_1', SCOPE, 'run-1', { kind: 'insert', pageId: 'home', parentId: 'root' });
    run.outline({ generationId: 'run-1', attempt: 1, outline: [{ title: 'Hero', kind: 'hero' }] });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node });
    // Another company's run on another site, and a stream of this site under another scope, never mix.
    openLiveGeneration('site_2', { workspaceId: 'ws_other', tenantGroupId: 'tg_other' }, 'run-x', { kind: 'newPage' });
    const res = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
    const events = eventReader(res);
    const state = (await events.next()).data as { generation?: Record<string, unknown> };
    expect(state.generation).toEqual({
      runId: 'run-1',
      target: { kind: 'insert', pageId: 'home', parentId: 'root' },
      outline: [{ title: 'Hero', kind: 'hero' }],
      sections: [{ index: 0, slot: 0, node }],
    });
    run.section({ generationId: 'run-1', attempt: 1, index: 1, slot: 1, node });
    expect(await events.next()).toMatchObject({ event: 'gen:section', data: { runId: 'run-1', index: 1 } });
    run.end('saved', { version: 8, insertedIds: ['r1'], nodes: [node] });
    publishSiteEvent('site_1', 'site:version', { origin: 'generate', version: 8, versionBefore: 7 });
    expect(await events.next()).toEqual({ event: 'gen:done', data: { runId: 'run-1', status: 'saved', version: 8, insertedIds: ['r1'], drawnAs: [0] } });
    expect((await events.next()).event).toBe('site:version');
    await events.cancel();

    // A run opened under another workspace's scope on this site is not in this stream's state.
    resetLiveGenerationForTests();
    openLiveGeneration('site_1', { workspaceId: 'ws_other', tenantGroupId: 'tg_other' }, 'run-y', { kind: 'newPage' });
    const again = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    expect((await again.next()).data).not.toHaveProperty('generation');
    await again.cancel();
  });

  it('sends the state on connect, then every committed write with its version as the event id', async () => {
    const res = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const events = eventReader(res);
    expect(await events.next()).toEqual({ event: 'state', data: { version: 7, plans: [], agents: [], feed: [] }, id: '7' });

    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7, created: { hero: 'n1' } });
    expect(await events.next()).toEqual({
      event: 'site:version',
      data: { origin: 'mcp', version: 8, versionBefore: 7, created: { hero: 'n1' } },
      id: '8',
    });
    // Another site's writes never reach this stream.
    publishSiteEvent('site_2', 'site:version', { origin: 'mcp', version: 3, versionBefore: 2 });
    publishSiteEvent('site_1', 'site:version', { origin: 'editor', version: 9, versionBefore: 8 });
    expect((await events.next()).id).toBe('9');
    await events.cancel();
  });

  it("flags the opening tab's own writes and never sends a tab id to anyone", async () => {
    const mine = eventReader(await EVENTS(req('/api/projects/site_1/events?tab=tab_mine_0001'), ctx('site_1')));
    const other = eventReader(await EVENTS(req('/api/projects/site_1/events?tab=tab_other_001', { cookie: 'lumitra_session=two' }), ctx('site_1')));
    await mine.next();
    await other.next();
    publishSiteEvent('site_1', 'site:version', { origin: 'editor', originTab: 'tab_mine_0001', version: 8, versionBefore: 7 });
    expect((await mine.next()).data).toEqual({ origin: 'editor', own: true, version: 8, versionBefore: 7 });
    expect((await other.next()).data).toEqual({ origin: 'editor', version: 8, versionBefore: 7 });
    await mine.cancel();
    await other.cancel();
  });

  it('re-checks access on a write heard 30 s after the last check', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    mockCan.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    expect((await events.next()).id).toBe('8');
    expect(await events.next()).toEqual({ event: 'auth:expired', data: {} });
    expect(await events.ended()).toBe(true);
  });

  it('catches a reconnect up: Last-Event-ID behind the current version gets one site:version', async () => {
    version = 12;
    const res = await EVENTS(req('/api/projects/site_1/events', { headers: { 'last-event-id': '9' } }), ctx('site_1'));
    const events = eventReader(res);
    expect((await events.next()).event).toBe('state');
    expect(await events.next()).toEqual({
      event: 'site:version',
      data: { origin: 'editor', version: 12, versionBefore: 9, catchUp: true },
      id: '12',
    });
    await events.cancel();
  });

  it('sends no catch-up when the browser already heard the current version', async () => {
    const res = await EVENTS(req('/api/projects/site_1/events', { headers: { 'last-event-id': '7' } }), ctx('site_1'));
    const events = eventReader(res);
    expect((await events.next()).event).toBe('state');
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    expect((await events.next()).id).toBe('8');
    await events.cancel();
  });

  it('answers 429 over the per-session bound, and frees the slot when a stream ends', async () => {
    const open: Array<ReturnType<typeof eventReader>> = [];
    for (let i = 0; i < LIVE_STREAM_LIMITS.perSession; i++) {
      const res = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
      expect(res.status).toBe(200);
      const events = eventReader(res);
      await events.next();
      open.push(events);
    }
    const refused = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    // Another session still gets one.
    const other = await EVENTS(req('/api/projects/site_1/events', { cookie: 'lumitra_session=other' }), ctx('site_1'));
    expect(other.status).toBe(200);
    await eventReader(other).cancel();

    await open[0].cancel();
    const again = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
    expect(again.status).toBe(200);
    await eventReader(again).cancel();
    for (const events of open.slice(1)) await events.cancel();
  });

  it('answers 429 over the per-site bound', async () => {
    const open: Array<ReturnType<typeof eventReader>> = [];
    for (let i = 0; i < LIVE_STREAM_LIMITS.perSite; i++) {
      const res = await EVENTS(req('/api/projects/site_1/events', { cookie: `lumitra_session=s${i}` }), ctx('site_1'));
      expect(res.status).toBe(200);
      open.push(eventReader(res));
    }
    const refused = await EVENTS(req('/api/projects/site_1/events', { cookie: 'lumitra_session=late' }), ctx('site_1'));
    expect(refused.status).toBe(429);
    for (const events of open) await events.cancel();
  });

  it('ends with auth:expired when the re-check finds the permission gone; an outage keeps it open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const res = await EVENTS(req('/api/projects/site_1/events'), ctx('site_1'));
    const events = eventReader(res);
    await events.next();

    // auth-brain down at the re-check: not a sign-out.
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('down', 503));
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    expect((await events.next()).id).toBe('8');

    mockCan.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    expect(await events.next()).toEqual({ event: 'auth:expired', data: {} });
    expect(await events.ended()).toBe(true);
    // Unsubscribed: a later write goes nowhere and throws nothing.
    expect(() => publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 9, versionBefore: 8 })).not.toThrow();
    errorSpy.mockRestore();
  });
});

describe('the presence in the events stream', () => {
  const activity = (over: Record<string, unknown> = {}) => ({
    callId: 'call-1',
    agentId: 'agent-a',
    label: 'Claude',
    tool: 'get_page',
    phase: 'start' as const,
    pageId: 'home',
    at: new Date().toISOString(),
    ...over,
  });

  it("backfills the state's feed from the site's audit rows, scoped to the caller's workspace, merged with live lines", async () => {
    const now = Date.now();
    auditRows.rows = [
      {
        id: 'row-2',
        actorKind: 'key',
        actorId: 'key_secret_id',
        actorDetail: { serviceAccountId: 'sa_1', label: 'Claude' },
        operation: 'batch',
        ops: [{ op: 'updateText', nodeId: 'n1' }, { op: 'insertNodes', pageId: 'home' }],
        createdAt: new Date(now - 1_000),
      },
      { id: 'row-1', actorKind: 'user', actorId: 'user-9', actorDetail: null, operation: 'publish', ops: null, createdAt: new Date(now - 60_000) },
    ];
    reportAgentActivity('site_1', activity({ callId: 'read-1', phase: 'end', outcome: 'ok', at: new Date(now - 30_000).toISOString() }), {
      id: 'read-1', agentId: 'agent-a', label: 'Claude', actorKind: 'key', tool: 'get_page', outcome: 'ok', pageId: 'home', at: new Date(now - 30_000).toISOString(),
    });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    const state = (await events.next()).data as { agents: unknown[]; feed: Array<Record<string, unknown>> };
    expect(auditRows.calls[0]).toMatchObject({ where: { siteId: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' }, take: 30 });
    expect(state.feed.map((l) => l.id)).toEqual(['row-2', 'read-1', 'row-1']);
    expect(state.feed[0]).toMatchObject({ tool: 'apply_batch', label: 'Claude', changes: 2, nodeIds: ['n1'], pageId: 'home', agentId: liveAgentId('key_secret_id') });
    expect(state.feed[2]).toMatchObject({ tool: 'publish', label: 'Someone', actorKind: 'user' });
    expect(JSON.stringify(state)).not.toContain('key_secret_id');
    expect(JSON.stringify(state)).not.toContain('sa_1');
    expect(state.agents).toHaveLength(1);
    await events.cancel();
  });

  it("gives a write's backfilled line the id it had live (the call id kept in its row), never a forged one", async () => {
    const callId = '5f0c1e9a-2b7d-4c3e-9f10-6a1b2c3d4e5f';
    auditRows.rows = [
      { id: 'row-9', actorKind: 'key', actorId: 'k', actorDetail: { callId }, operation: 'batch', ops: [], createdAt: new Date() },
      { id: 'row-8', actorKind: 'key', actorId: 'k', actorDetail: { callId: '<script>' }, operation: 'batch', ops: [], createdAt: new Date(Date.now() - 1) },
    ];
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    const state = (await events.next()).data as { feed: Array<{ id: string }> };
    expect(state.feed.map((l) => l.id)).toEqual([callId, 'row-8']);
    await events.cancel();
  });

  it('keeps the stream when the audit rows cannot be read: the live lines alone', async () => {
    auditRows.fail = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportAgentActivity('site_1', activity({ phase: 'end', outcome: 'failed' }), {
      id: 'call-1', agentId: 'agent-a', label: 'Claude', actorKind: 'key', tool: 'get_page', outcome: 'failed', at: new Date().toISOString(),
    });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    const state = (await events.next()).data as { feed: Array<{ id: string }> };
    expect(state.feed.map((l) => l.id)).toEqual(['call-1']);
    spy.mockRestore();
    await events.cancel();
  });

  it("sends the state's active agents (a running call wins) and forwards every agent:activity of this site only", async () => {
    reportAgentActivity('site_1', activity({ callId: 'c1' }));
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    const state = (await events.next()).data as { agents: Array<Record<string, unknown>> };
    expect(state.agents).toEqual([expect.objectContaining({ callId: 'c1', phase: 'start' })]);
    reportAgentActivity('site_2', activity({ callId: 'other-site' }));
    reportAgentActivity('site_1', activity({ callId: 'c1', phase: 'end', outcome: 'ok' }));
    expect(await events.next()).toEqual({ event: 'agent:activity', data: expect.objectContaining({ callId: 'c1', phase: 'end' }) });
    await events.cancel();
  });

  it('leaves out an agent that left more than a minute ago', async () => {
    reportAgentActivity('site_1', activity({ phase: 'end', outcome: 'ok' }), undefined, Date.now() - 120_000);
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    expect(((await events.next()).data as { agents: unknown[] }).agents).toEqual([]);
    await events.cancel();
  });
});

describe('GET /api/projects/<id>/document', () => {
  it('answers the stored copy with its version as the ETag', async () => {
    const res = await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"7"');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const body = await res.json();
    expect(body.version).toBe(7);
    expect(body.snapshot.id).toBe('site_1');
    expect(repo.loadProjectWithVersion).toHaveBeenCalledWith(SCOPE, 'site_1');
  });

  it('answers 304 without loading the project when If-None-Match names the current version', async () => {
    const res = await DOCUMENT(req('/api/projects/site_1/document', { headers: { 'if-none-match': '"7"' } }), ctx('site_1'));
    expect(res.status).toBe(304);
    expect(repo.loadProjectWithVersion).not.toHaveBeenCalled();
  });

  it('answers the copy when If-None-Match names an older version', async () => {
    const res = await DOCUMENT(req('/api/projects/site_1/document', { headers: { 'if-none-match': '"6"' } }), ctx('site_1'));
    expect(res.status).toBe(200);
  });
});
