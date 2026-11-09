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
import { LIVE_CHECK_TIMEOUT_MS, LIVE_PING_EVENT, LIVE_RECHECK_MS, LIVE_RECHECK_ON_WRITE_MS } from '@/lib/projects/liveEvents';
import { GET as DOCUMENT } from '../[projectId]/document/route';
import { SSE_HEARTBEAT_MS } from '@/lib/ai/sse';
import { LIVE_GUARD_MEMO_MS, resetLiveGuardMemoForTests } from '@/server/sites/liveGuard';
import { forgetSiteDocuments, resetLiveDocumentCacheForTests } from '@/server/sites/liveDocumentCache';
import { acquireStreamSlot } from '@/server/sites/liveBus';

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

const ctx = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

/** Reads named events off an SSE response as they arrive. */
function eventReader(res: Response, opts: { pings?: boolean } = {}) {
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
          if (block.startsWith(':')) continue; // a comment line
          if (block.startsWith(`event: ${LIVE_PING_EVENT}\n`) && !opts.pings) continue; // heartbeat, unless asked for
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
  resetLiveGuardMemoForTests();
  resetLiveDocumentCacheForTests();
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
    expect(await events.next()).toEqual({ event: 'gen:done', data: { runId: 'run-1', status: 'saved', version: 8, insertedIds: ['r1'], drawnAs: [[0, 1]] } });
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

  it('holds a write heard 30 s after the last check behind a re-check: access gone, the version never goes out', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    mockCan.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    expect(await events.next()).toEqual({ event: 'auth:expired', data: {} });
    expect(await events.ended()).toBe(true);
  });

  it('holds every kind of event behind a due re-check (plans, agent activity, versions), none of it reaching a stream whose access is gone', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    mockCan.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    reportAgentActivity('site_1', 'tg_lumitra', activity({ callId: 'held' }));
    publishSiteEvent('site_1', 'plan:update', { plan: { planId: 'p1' } });
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    expect(await events.next()).toEqual({ event: 'auth:expired', data: {} });
    expect(await events.ended()).toBe(true);
  });

  it('a due re-check that passes sends the held events of every kind in their order', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    const verified = mockVerifySession.mock.calls.length;
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    reportAgentActivity('site_1', 'tg_lumitra', activity({ callId: 'a1' }));
    publishSiteEvent('site_1', 'plan:update', { plan: { planId: 'p1' } });
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    const order = [await events.next(), await events.next(), await events.next()].map((e) => e.event);
    expect(order).toEqual(['agent:activity', 'plan:update', 'site:version']);
    // It really asked again (the guard's memo had run out).
    expect(mockVerifySession.mock.calls.length).toBeGreaterThan(verified);
    await events.cancel();
  });

  it("holds a running generation's draft until a stale check passed: a stream whose access is gone gets none of it", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const node = { id: 'n1', type: 'section', componentType: 'host', label: 'Hero', props: {}, children: [] } as never;
    const fresh = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await fresh.next();
    const run = openLiveGeneration('site_1', SCOPE, 'run-1', { kind: 'newPage' });
    // Checked moments ago: the section goes out at once.
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node });
    expect(await fresh.next()).toMatchObject({ event: 'gen:section', data: { index: 0 } });
    // Access gone, last check stale: the next section waits for the check and never arrives, nor what follows it.
    mockCan.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    run.section({ generationId: 'run-1', attempt: 1, index: 1, slot: 1, node });
    run.end('stopped');
    expect(await fresh.next()).toEqual({ event: 'auth:expired', data: {} });
    expect(await fresh.ended()).toBe(true);
  });

  it('a due re-check that never answers ends the stream after 10 s (fail closed): nothing it held goes out, and no auth:expired', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = { id: 'n1', type: 'section', componentType: 'host', label: 'Hero', props: {}, children: [] } as never;
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    mockVerifySession.mockImplementation(() => new Promise(() => {}));
    const run = openLiveGeneration('site_1', SCOPE, 'run-1', { kind: 'newPage' });
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node });
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    await vi.advanceTimersByTimeAsync(LIVE_CHECK_TIMEOUT_MS);
    // Ended without a single further event: the editor reconnects and meets the guard.
    await expect(events.next()).rejects.toThrow('stream ended');
    expect(warn).toHaveBeenCalled();
    // The slot is free again.
    mockVerifySession.mockReset();
    mockVerifySession.mockResolvedValue(makeSession());
    const again = await EVENTS(req('/api/projects/site_1/events', { cookie: 'lumitra_session=fresh' }), ctx('site_1'));
    expect(again.status).toBe(200);
  });

  it('a due re-check that meets an auth-brain outage ends the stream (fail closed) and drops what it held', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('down', 503));
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 8, versionBefore: 7 });
    await expect(events.next()).rejects.toThrow('stream ended');
    expect(warn).toHaveBeenCalled();
  });

  it('a due re-check that meets an OpenFGA outage ends the stream (fail closed)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockCan.mockRejectedValueOnce(new AuthBrainError('fga down', 503));
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    reportAgentActivity('site_1', 'tg_lumitra', activity({ callId: 'held' }));
    await expect(events.next()).rejects.toThrow('stream ended');
  });

  it('sends the heartbeat as a named `ping` event with an empty object, which the browser can see', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')), { pings: true });
    await events.next();
    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
    expect(await events.next()).toEqual({ event: 'ping', data: {} });
    await events.cancel();
  });

  it('ends the stream when more than 500 events pile up behind a check', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const node = { id: 'n1', type: 'section', componentType: 'host', label: 'Hero', props: {}, children: [] } as never;
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    mockVerifySession.mockImplementation(() => new Promise(() => {}));
    const run = openLiveGeneration('site_1', SCOPE, 'run-1', { kind: 'newPage' });
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node });
    for (let v = 8; v < 520; v += 1) publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: v, versionBefore: v - 1 });
    expect(await events.ended()).toBe(true);
  });

  it('a stale check that passes sends the held draft events in their order', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const node = { id: 'n1', type: 'section', componentType: 'host', label: 'Hero', props: {}, children: [] } as never;
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    const run = openLiveGeneration('site_1', SCOPE, 'run-1', { kind: 'newPage' });
    vi.setSystemTime(Date.now() + LIVE_RECHECK_ON_WRITE_MS + 1);
    run.outline({ generationId: 'run-1', attempt: 1, outline: [{ title: 'Hero', kind: 'hero' }] });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node });
    run.end('saved', { version: 8, insertedIds: ['r1'], nodes: [node] });
    publishSiteEvent('site_1', 'site:version', { origin: 'generate', version: 8, versionBefore: 7 });
    const order = [await events.next(), await events.next(), await events.next(), await events.next()].map((e) => e.event);
    expect(order).toEqual(['gen:outline', 'gen:section', 'gen:done', 'site:version']);
    await events.cancel();
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

  it('answers 429 over the per-company bound, while another company still gets a stream', async () => {
    // Fill the company's share without opening hundreds of streams.
    const held: Array<() => void> = [];
    for (let i = 0; i < LIVE_STREAM_LIMITS.perCompany; i++) held.push(acquireStreamSlot(`elsewhere_${Math.floor(i / 40)}`, `s${i}`, SCOPE.tenantGroupId)!);
    const refused = await EVENTS(req('/api/projects/site_1/events', { cookie: 'lumitra_session=late' }), ctx('site_1'));
    expect(refused.status).toBe(429);
    expect(acquireStreamSlot('site_x', 'other-company-session', 'tg_other')).not.toBeNull();
    held[0]();
    const res = await EVENTS(req('/api/projects/site_1/events', { cookie: 'lumitra_session=late' }), ctx('site_1'));
    expect(res.status).toBe(200);
    await eventReader(res).cancel();
    for (const release of held) release();
  });

  it('ends with auth:expired when the five-minute re-check finds the permission gone', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    mockCan.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    expect(await events.next()).toEqual({ event: 'auth:expired', data: {} });
    expect(await events.ended()).toBe(true);
    // Unsubscribed: a later write goes nowhere and throws nothing.
    expect(() => publishSiteEvent('site_1', 'site:version', { origin: 'mcp', version: 9, versionBefore: 8 })).not.toThrow();
  });

  it('a five-minute re-check that meets an outage ends the stream too (fail closed), without auth:expired', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    await events.next();
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('down', 503));
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    await expect(events.next()).rejects.toThrow('stream ended');
  });
});

describe('the presence in the events stream', () => {
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
    reportAgentActivity('site_1', 'tg_lumitra', activity({ callId: 'read-1', phase: 'end', outcome: 'ok', at: new Date(now - 30_000).toISOString() }), {
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
    reportAgentActivity('site_1', 'tg_lumitra', activity({ phase: 'end', outcome: 'failed' }), {
      id: 'call-1', agentId: 'agent-a', label: 'Claude', actorKind: 'key', tool: 'get_page', outcome: 'failed', at: new Date().toISOString(),
    });
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    const state = (await events.next()).data as { feed: Array<{ id: string }> };
    expect(state.feed.map((l) => l.id)).toEqual(['call-1']);
    spy.mockRestore();
    await events.cancel();
  });

  it("sends the state's active agents (a running call wins) and forwards every agent:activity of this site only", async () => {
    reportAgentActivity('site_1', 'tg_lumitra', activity({ callId: 'c1' }));
    const events = eventReader(await EVENTS(req('/api/projects/site_1/events'), ctx('site_1')));
    const state = (await events.next()).data as { agents: Array<Record<string, unknown>> };
    expect(state.agents).toEqual([expect.objectContaining({ callId: 'c1', phase: 'start' })]);
    reportAgentActivity('site_2', 'tg_lumitra', activity({ callId: 'other-site' }));
    reportAgentActivity('site_1', 'tg_lumitra', activity({ callId: 'c1', phase: 'end', outcome: 'ok' }));
    expect(await events.next()).toEqual({ event: 'agent:activity', data: expect.objectContaining({ callId: 'c1', phase: 'end' }) });
    await events.cancel();
  });

  it('leaves out an agent that left more than a minute ago', async () => {
    reportAgentActivity('site_1', 'tg_lumitra', activity({ phase: 'end', outcome: 'ok' }), undefined, Date.now() - 120_000);
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

describe('the kept document body', () => {
  it('serves a version already served without loading it again, the same bytes and headers', async () => {
    const first = await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    const second = await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=other-tab' }), ctx('site_1'));
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).toBe('"7"');
    expect(second.headers.get('content-type')).toContain('application/json');
    expect(second.headers.get('cache-control')).toBe('private, no-cache');
    expect(await second.text()).toBe(await first.text());
    expect(repo.loadProjectWithVersion).toHaveBeenCalledTimes(1);
  });

  it('still runs the whole guard for a kept version: a session without editSite gets 403, a foreign workspace 404', async () => {
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    mockCan.mockResolvedValue(false);
    const refused = await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=no-edit' }), ctx('site_1'));
    expect(refused.status).toBe(403);
    mockCan.mockResolvedValue(true);
    repo.getSiteVersion.mockRejectedValueOnce(new SiteNotFoundError('site_1'));
    const gone = await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    expect(gone.status).toBe(404);
  });

  it('loads again for a new version, and after the site was forgotten (a rename)', async () => {
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    version = 8;
    expect((await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'))).headers.get('etag')).toBe('"8"');
    expect(repo.loadProjectWithVersion).toHaveBeenCalledTimes(2);
    forgetSiteDocuments('site_1');
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    expect(repo.loadProjectWithVersion).toHaveBeenCalledTimes(3);
  });
});

describe('the guard memo', () => {
  it('reuses a verified session and an allowed editSite for 30 s, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    expect(mockVerifySession).toHaveBeenCalledTimes(1);
    expect(mockCan).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + LIVE_GUARD_MEMO_MS + 1);
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    expect(mockVerifySession).toHaveBeenCalledTimes(2);
    expect(mockCan).toHaveBeenCalledTimes(2);
  });

  it('never remembers a no: a refused editSite is asked again on the next request', async () => {
    mockCan.mockResolvedValueOnce(false);
    expect((await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'))).status).toBe(403);
    expect((await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'))).status).toBe(200);
    expect(mockCan).toHaveBeenCalledTimes(2);
    mockVerifySession.mockResolvedValueOnce(null);
    expect((await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=signed-out' }), ctx('site_1'))).status).toBe(401);
    expect((await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=signed-out' }), ctx('site_1'))).status).toBe(200);
  });

  it('keys by the session cookie: another session asks again', async () => {
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=someone-else' }), ctx('site_1'));
    expect(mockVerifySession).toHaveBeenCalledTimes(2);
    expect(mockCan).toHaveBeenCalledTimes(2);
  });

  it("keys editSite by the workspace the session resolved: switching company asks again, and one company's yes never stands for another's", async () => {
    const twoCompanies = {
      ...makeSession(),
      tenants: [
        { id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_lumitra' },
        { id: 'tenant-2', app_grants: ['sites'], group_id: 'tg_other' },
      ],
      workspaces: [
        { id: 'ws_marlin', tenant_id: 'tenant-1' },
        { id: 'ws_other', tenant_id: 'tenant-2' },
      ],
    };
    mockVerifySession.mockResolvedValue(twoCompanies);
    await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=good; framer_company=tenant-1' }), ctx('site_1'));
    // The same session picks the other company: its permission there is asked for, and refused.
    mockCan.mockResolvedValue(false);
    const other = await DOCUMENT(req('/api/projects/site_1/document', { cookie: 'lumitra_session=good; framer_company=tenant-2' }), ctx('site_1'));
    expect(other.status).toBe(403);
    expect(mockCan).toHaveBeenCalledTimes(2);
    expect(mockCan.mock.calls[1]).toContainEqual(expect.objectContaining({ workspaceId: 'ws_other' }));
    // The session itself was verified once.
    expect(mockVerifySession).toHaveBeenCalledTimes(1);
  });

  it('never reuses a session past its own expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const soon = new Date(Date.now() + 1000).toISOString();
    mockVerifySession.mockResolvedValue({ ...makeSession(), session: { expires_at: soon } });
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    vi.setSystemTime(Date.now() + 2000);
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    expect(mockVerifySession).toHaveBeenCalledTimes(2);
  });

  it('is never used for a machine request (a Bearer header), which has no session here at all', async () => {
    await DOCUMENT(req('/api/projects/site_1/document'), ctx('site_1'));
    const machine = await DOCUMENT(req('/api/projects/site_1/document', { headers: { authorization: 'Bearer anything' } }), ctx('site_1'));
    expect(machine.status).toBe(401);
  });
});
