// @vitest-environment node
//
// Agent presence from the MCP endpoint (src/server/mcp/presence.ts, plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2): every tool call that
// names a site in the key's scope reports `agent:activity` on that site's bus,
// at its start and its end, with the right ids and outcome, and never the key
// id or the arguments' content. Driven through the real handler and the real
// site operations library over a fake repository, like mcp.test.ts.
//
// Fake keys are built at run time (knowledge-base standards/test-credentials.md).

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auditCreates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({
    siteOperationAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => auditCreates.push(data)) },
  }),
}));
vi.mock('@/server/sites/cachedResolver', () => ({
  revalidateSiteCache: () => {},
  revalidateCustomHostsForSiteId: async () => [],
}));

import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { SiteChangedError, SiteNotFoundError, type SiteRepository } from '@/server/sites';
import { __resetPageGenRateLimiterForTests } from '@/lib/ai/pageGen/rateLimit';
import type { VerifiedKey } from '@/lib/auth-machine';
import { resetLiveBusForTests, subscribeSite } from '@/server/sites/liveBus';
import { presenceSnapshot, resetLivePresenceForTests } from '@/server/sites/livePresence';
import { LIVE_EVENTS, type AgentActivity } from '@/lib/projects/liveEvents';
import { liveAgentId } from '@/server/siteOps/audit';
import { createMcpHandler } from '../handler';
import { resetLivePlansForTests } from '../livePlans';
import { ApprovalStore } from '../approvals';
import { focusOf, MISSES_PER_KEY, outcomeOf, REPORTS_PER_KEY, resetPresenceScopeCacheForTests, siteInScope, takeReport } from '../presence';

const fakeKey = () => `${['sk', 'live'].join('_')}_${randomBytes(16).toString('hex')}`;
const KEY_ID = `key_${randomBytes(6).toString('hex')}`;
const SCOPE = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };

function verifiedKey(extra: Partial<VerifiedKey> = {}): VerifiedKey {
  return Object.freeze({
    kind: 'key' as const,
    tenantId: 'tenant-a',
    companySlug: 'acme',
    keyId: KEY_ID,
    serviceAccountId: 'sa_1',
    scope: Object.freeze({ ...SCOPE }),
    workspaceRole: 'admin' as const,
    appGrants: Object.freeze(['sites']),
    ...extra,
  });
}

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
            { id: 'title', type: 'h1', componentType: 'host', parentId: 'root', props: { children: 'Secret launch copy' }, children: [] },
          ],
        },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

function fakeRepository() {
  const state = { version: 3, versionReads: 0 };
  const repository = {
    listSites: vi.fn(async () => []),
    getSiteVersion: vi.fn(async (_scope: unknown, siteId: string) => {
      state.versionReads += 1;
      if (siteId !== 'site-1') throw new SiteNotFoundError(siteId);
      return state.version;
    }),
    loadProjectWithVersion: vi.fn(async (_scope: unknown, siteId: string) => {
      if (siteId !== 'site-1') throw new SiteNotFoundError(siteId);
      return { project: storedProject(), version: state.version };
    }),
    saveProject: vi.fn(async (_scope: unknown, _project: unknown, options: Record<string, unknown>) => {
      if (options.expectedVersion !== state.version) throw new SiteChangedError(state.version);
      state.version += 1;
      // As the real repository: after the commit, before the write is announced.
      (options.beforeAnnounce as ((v: number) => void) | undefined)?.(state.version);
      return { version: state.version };
    }),
    getSiteAddress: vi.fn(async () => ({ host: null, everPublished: false })),
  };
  return { repository: repository as unknown as SiteRepository, state, mock: repository };
}

function setup(key: VerifiedKey = verifiedKey()) {
  const { repository, state, mock } = fakeRepository();
  const handler = createMcpHandler({
    verifyKey: vi.fn(async () => key),
    siteOps: { repository, publicBaseHost: 'sites.example', editorHost: 'app.example' },
    approvals: new ApprovalStore(),
  });
  return { handler, state, mock, bearer: fakeKey() };
}

let nextId = 1;
function post(bearer: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.lumitra.co/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function callTool(s: ReturnType<typeof setup>, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await s.handler.POST(post(s.bearer, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, headers));
  return ((await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } }).result;
}

/** Every event a site's bus carried while `fn` ran. */
function listen(siteId: string): Array<{ event: string; data: AgentActivity }> {
  const heard: Array<{ event: string; data: AgentActivity }> = [];
  subscribeSite(siteId, (event, data) => heard.push({ event, data: data as AgentActivity }));
  return heard;
}

const activities = (heard: Array<{ event: string; data: AgentActivity }>) =>
  heard.filter((h) => h.event === LIVE_EVENTS.agentActivity).map((h) => h.data);

beforeEach(() => {
  resetLivePlansForTests();
  resetLiveBusForTests();
  resetLivePresenceForTests();
  resetPresenceScopeCacheForTests();
  __resetPageGenRateLimiterForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent:activity from the MCP endpoint', () => {
  it('reports a read with a start and an end that share the call id, with the page it names', async () => {
    const s = setup(verifiedKey({ keyName: 'Claude' }));
    const heard = listen('site-1');
    await callTool(s, 'get_page', { siteId: 'site-1', pageId: 'home' });
    const [start, end] = activities(heard);
    expect(start).toMatchObject({ phase: 'start', tool: 'get_page', label: 'Claude', pageId: 'home' });
    expect(end).toMatchObject({ phase: 'end', tool: 'get_page', outcome: 'ok', label: 'Claude', pageId: 'home' });
    expect(start.callId).toBe(end.callId);
    expect(start.agentId).toBe(liveAgentId(KEY_ID));
    expect(start.agentId).not.toContain(KEY_ID);
    expect(Date.parse(end.at)).not.toBeNaN();
  });

  it('reports a batch with the nodes it names, then those plus the created ids, the count and the first summary line', async () => {
    const s = setup();
    const heard = listen('site-1');
    const result = await callTool(s, 'apply_batch', {
      siteId: 'site-1',
      expectedVersion: 3,
      ops: [
        { op: 'updateText', nodeId: 'title', text: 'Very secret new words' },
        { op: 'insertNodes', pageId: 'home', parentId: 'root', nodes: [{ type: 'p', ref: 'intro', props: { children: 'More secret words' } }] },
      ],
    });
    expect(result.isError).toBe(false);
    const created = Object.values(result.structuredContent.created as Record<string, string>);
    const [start, end] = activities(heard);
    expect(start).toMatchObject({ phase: 'start', tool: 'apply_batch', pageId: 'home', nodeIds: ['title', 'root'] });
    expect(end).toMatchObject({ phase: 'end', outcome: 'ok', changes: 2, label: 'Agent' });
    expect(end.nodeIds).toEqual(['title', 'root', ...created]);
    // No summary line: those name page titles, which are content.
    expect(end).not.toHaveProperty('summary');
    // Never the key id, never the content of the arguments.
    const wire = JSON.stringify(activities(heard));
    expect(wire).not.toContain(KEY_ID);
    expect(wire).not.toContain('secret');
  });

  it('names the announced section a batch writes (sectionRef), so the frame goes on its skeleton; never another key\'s', async () => {
    const s = setup();
    const heard = listen('site-1');
    await callTool(s, 'announce_sections', { siteId: 'site-1', pageId: 'home', sections: [{ ref: 'pricing', title: 'Pricing', kind: 'pricing' }] });
    const announce = activities(heard);
    expect(announce.map((a) => [a.tool, a.phase, a.outcome])).toEqual([['announce_sections', 'start', undefined], ['announce_sections', 'end', 'ok']]);
    // A batch of another key with the same ref fulfils and frames nothing of this plan.
    const other = setup(verifiedKey({ keyId: 'key_other' }));
    await callTool(other, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'insertNodes', pageId: 'home', nodes: [{ type: 'section', ref: 'pricing' }] }] });
    expect(activities(heard).slice(2).every((a) => a.sectionRef === undefined)).toBe(true);
    heard.length = 0;
    // (Each setup has its own fake repository, so this one is still at version 3.)
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'insertNodes', pageId: 'home', nodes: [{ type: 'section', ref: 'pricing' }] }] });
    const [start, end] = activities(heard);
    expect(start).toMatchObject({ phase: 'start', sectionRef: 'pricing' });
    expect(end).toMatchObject({ phase: 'end', outcome: 'ok', sectionRef: 'pricing' });
    expect(heard.some((h) => h.event === LIVE_EVENTS.planUpdate)).toBe(true);
  });

  it('a refused announcement shows as refused, never as a failure', () => {
    for (const code of ['too_many_plans', 'plan_not_found', 'page_not_found']) {
      expect(outcomeOf({ content: [], structuredContent: { error: { code, message: 'x' } }, isError: true })).toBe('rejected');
    }
  });

  it('reports a refused batch as rejected and a stale one as site_changed, with nothing written', async () => {
    const s = setup();
    const heard = listen('site-1');
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'removeNode', nodeId: 'nope' }] });
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 1, ops: [{ op: 'removeNode', nodeId: 'title' }] });
    const ends = activities(heard).filter((a) => a.phase === 'end');
    expect(ends.map((a) => a.outcome)).toEqual(['rejected', 'site_changed']);
    expect(s.state.version).toBe(3);
    // Neither left an audit row, so both are live feed lines for the next editor that opens.
    expect(presenceSnapshot('site-1').feed.map((l) => l.outcome)).toEqual(['site_changed', 'rejected']);
  });

  it('keeps a committed write out of the live feed (its audit row stands in) but reads in it', async () => {
    const s = setup();
    await callTool(s, 'get_site', { siteId: 'site-1' });
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] });
    expect(presenceSnapshot('site-1').feed.map((l) => l.tool)).toEqual(['get_site']);
  });

  it('never publishes a made-up id: text that is not an id is dropped, and a refused call repeats none of its arguments\' ids', async () => {
    const s = setup();
    const heard = listen('site-1');
    await callTool(s, 'apply_batch', {
      siteId: 'site-1',
      expectedVersion: 3,
      ops: [{ op: 'removeNode', nodeId: 'my password is hunter2 and the api key' }, { op: 'removeNode', nodeId: 'nope' }],
    });
    const [start, end] = activities(heard);
    expect(start.nodeIds).toEqual(['nope']);
    expect(end).toMatchObject({ outcome: 'rejected' });
    expect(end.nodeIds).toBeUndefined();
    expect(JSON.stringify(activities(heard))).not.toContain('hunter2');
    expect(presenceSnapshot('site-1').feed[0].nodeIds).toBeUndefined();
  });

  it('reports a page a batch created as the page, not as a node', async () => {
    const s = setup();
    const heard = listen('site-1');
    const result = await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'createPage', title: 'Pricing', ref: 'pricing' }] });
    expect(result.isError).toBe(false);
    const created = (result.structuredContent.created as Record<string, string>).pricing;
    const end = activities(heard).find((a) => a.phase === 'end')!;
    expect(end.pageId).toBe(created);
    expect(end.nodeIds ?? []).not.toContain(created);
  });

  it("reports a write's start only after its permission check passed: a refused write shows only its end and feed line", async () => {
    // A viewer may read, never edit or publish.
    const s = setup(verifiedKey({ workspaceRole: 'viewer' }));
    const heard = listen('site-1');
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] });
    await callTool(s, 'publish', { siteId: 'site-1', expectedVersion: 3 });
    const seen = activities(heard);
    expect(seen.map((a) => [a.tool, a.phase])).toEqual([['apply_batch', 'end'], ['publish', 'end']]);
    expect(seen.every((a) => a.outcome !== 'ok')).toBe(true);
    // Neither is drawn as running for a newly opened editor, both are feed lines.
    const snapshot = presenceSnapshot('site-1');
    expect(snapshot.agents.every((a) => a.phase === 'end')).toBe(true);
    expect(snapshot.feed.map((l) => l.tool)).toEqual(['publish', 'apply_batch']);
    // Its reads still report a start at once.
    heard.length = 0;
    await callTool(s, 'get_site', { siteId: 'site-1' });
    expect(activities(heard).map((a) => a.phase)).toEqual(['start', 'end']);
  });

  it('reports an allowed write with its start before the write commits and its end after', async () => {
    const s = setup();
    const heard = listen('site-1');
    let startBeforeSave = false;
    s.mock.saveProject.mockImplementationOnce(async (_scope: unknown, _project: unknown, options: Record<string, unknown>) => {
      startBeforeSave = activities(heard).some((a) => a.phase === 'start' && a.tool === 'apply_batch');
      s.state.version += 1;
      (options.beforeAnnounce as ((v: number) => void) | undefined)?.(s.state.version);
      return { version: s.state.version };
    });
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] });
    expect(startBeforeSave).toBe(true);
    expect(activities(heard).map((a) => a.phase)).toEqual(['start', 'end']);
  });

  it('reports invalid arguments as failed', async () => {
    const s = setup();
    const heard = listen('site-1');
    await callTool(s, 'get_page', { siteId: 'site-1' });
    expect(activities(heard).at(-1)).toMatchObject({ phase: 'end', outcome: 'failed' });
  });

  it('reports nothing for calls without a site', async () => {
    const s = setup();
    const heard = listen('site-1');
    await callTool(s, 'list_sites', {});
    await callTool(s, 'describe_vocabulary', {});
    expect(activities(heard)).toEqual([]);
  });

  it('reports nothing, not even an end, for a site outside the key\'s scope', async () => {
    const s = setup();
    const foreign = listen('site-of-another-company');
    const result = await callTool(s, 'get_site', { siteId: 'site-of-another-company' });
    expect(result.isError).toBe(true);
    expect(activities(foreign)).toEqual([]);
    expect(presenceSnapshot('site-of-another-company')).toEqual({ agents: [], feed: [] });
  });

  it('remembers a site outside the scope for a while, so made-up ids cost no read per call', async () => {
    const s = setup();
    await callTool(s, 'get_site', { siteId: 'made-up' });
    await callTool(s, 'get_site', { siteId: 'made-up' });
    expect(s.mock.getSiteVersion.mock.calls.filter((c) => c[1] === 'made-up')).toHaveLength(1);
  });

  it('stops looking up new made-up ids after MISSES_PER_KEY misses a minute, and never evicts confirmed sites with them', async () => {
    const s = setup();
    await callTool(s, 'get_site', { siteId: 'site-1' });
    for (let i = 0; i < MISSES_PER_KEY + 10; i += 1) await callTool(s, 'get_site', { siteId: `made-up-${i}` });
    const lookups = s.mock.getSiteVersion.mock.calls.filter((c) => String(c[1]).startsWith('made-up'));
    expect(lookups).toHaveLength(MISSES_PER_KEY);
    // The real site is still confirmed (no new read) and still reported.
    const heard = listen('site-1');
    const reads = s.state.versionReads;
    await callTool(s, 'get_site', { siteId: 'site-1' });
    expect(s.state.versionReads).toBe(reads);
    expect(activities(heard)).toHaveLength(2);
  });

  it('a key over its report budget causes no lookup at all', async () => {
    const s = setup();
    const agentId = liveAgentId(KEY_ID);
    while (takeReport(agentId)) { /* spend the minute */ }
    await callTool(s, 'get_site', { siteId: 'site-1' });
    expect(s.state.versionReads).toBe(0);
  });

  it('reports at most REPORTS_PER_KEY calls of a key per minute; the rest run unreported', async () => {
    for (let i = 0; i < REPORTS_PER_KEY; i += 1) expect(takeReport('agent-x', 1_000)).toBe(true);
    expect(takeReport('agent-x', 1_000)).toBe(false);
    expect(takeReport('agent-y', 1_000)).toBe(true);
    expect(takeReport('agent-x', 61_000)).toBe(true);
  });

  it('shows a rate-limited call as refused, never as a failure', () => {
    expect(outcomeOf({ content: [], isError: true, structuredContent: { error: { code: 'rate_limited' } } })).toBe('rejected');
  });

  it("puts the call's live id into the write's audit row, so the feed line keeps its id after a reload", async () => {
    const s = setup();
    const heard = listen('site-1');
    await callTool(s, 'apply_batch', { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'updateText', nodeId: 'title', text: 'x' }] });
    const [start] = activities(heard);
    expect(auditCreates.at(-1)).toMatchObject({ actorDetail: { serviceAccountId: 'sa_1', callId: start.callId } });
  });

  it('confirms a site once per scope and remembers it for a few minutes', async () => {
    const s = setup();
    await callTool(s, 'get_site', { siteId: 'site-1' });
    await callTool(s, 'get_site', { siteId: 'site-1' });
    expect(s.state.versionReads).toBe(1);
    // Another workspace is asked again.
    const repo = s.mock as unknown as SiteRepository;
    expect(await siteInScope(repo, { workspaceId: 'ws_b', tenantGroupId: 'tg_b' }, 'site-1')).toBe(true);
    expect(s.state.versionReads).toBe(2);
  });

  it('a repository that cannot answer reports nothing and still runs the call', async () => {
    const s = setup();
    s.mock.getSiteVersion.mockRejectedValueOnce(new Error('database down'));
    const heard = listen('site-1');
    const result = await callTool(s, 'get_site', { siteId: 'site-1' });
    expect(result.isError).toBe(false);
    expect(activities(heard)).toEqual([]);
  });

  it('names the agent by the MCP client when the key has no name, sanitised, from the signed session id', async () => {
    const s = setup();
    const init = await s.handler.POST(
      post(s.bearer, { jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude‮ Code\n', version: '1' } } }),
    );
    const session = init.headers.get('mcp-session-id')!;
    const heard = listen('site-1');
    await callTool(s, 'get_site', { siteId: 'site-1' }, { 'mcp-session-id': session });
    expect(activities(heard)[0].label).toBe('Claude Code');
  });

  it("prefers the key's own name over the client's", async () => {
    const s = setup(verifiedKey({ keyName: 'Marketing bot' }));
    const init = await s.handler.POST(
      post(s.bearer, { jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Code', version: '1' } } }),
    );
    const heard = listen('site-1');
    await callTool(s, 'get_site', { siteId: 'site-1' }, { 'mcp-session-id': init.headers.get('mcp-session-id')! });
    expect(activities(heard)[0].label).toBe('Marketing bot');
  });

  it('an agent still working is in the state a newly opened editor gets', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.mock.getSiteAddress.mockImplementationOnce(async () => {
      await gate;
      return { host: null, everPublished: false };
    });
    const pending = callTool(s, 'get_site', { siteId: 'site-1' });
    await vi.waitFor(() => expect(presenceSnapshot('site-1').agents).toHaveLength(1));
    expect(presenceSnapshot('site-1').agents[0]).toMatchObject({ phase: 'start', tool: 'get_site' });
    release();
    await pending;
    expect(presenceSnapshot('site-1').agents[0]).toMatchObject({ phase: 'end', outcome: 'ok' });
  });
});

describe('the pieces', () => {
  it('reads the page and node ids of every argument shape, never a ref and never content', () => {
    expect(focusOf({ siteId: 's', target: { kind: 'replace', pageId: 'p1', nodeId: 'n1' } })).toEqual({ pageId: 'p1', nodeIds: ['n1'] });
    expect(focusOf({ target: { kind: 'insert', pageId: 'p1', parentId: 'n2' } })).toEqual({ pageId: 'p1', nodeIds: ['n2'] });
    expect(
      focusOf({
        ops: [
          { op: 'moveNode', nodeId: 'a', to: { siblingId: 'b', position: 'after' } },
          { op: 'insertNodes', pageId: 'p2', parentId: 'ref:intro', nodes: [{ text: 'content' }] },
          { op: 'updateText', nodeId: 'a', text: 'content' },
        ],
      }),
    ).toEqual({ pageId: 'p2', nodeIds: ['a', 'b'] });
    expect(focusOf('not an object')).toEqual({ nodeIds: [] });
  });

  it('reads the outcome from the error code', () => {
    const err = (code: string) => ({ content: [], isError: true, structuredContent: { error: { code } } });
    expect(outcomeOf({ content: [], isError: false, structuredContent: {} })).toBe('ok');
    expect(outcomeOf(err('rejected'))).toBe('rejected');
    expect(outcomeOf(err('site_changed'))).toBe('site_changed');
    expect(outcomeOf(err('forbidden'))).toBe('failed');
    expect(outcomeOf(undefined)).toBe('failed');
  });

  it('does not report an unapproved, pending or declined publish as done', () => {
    const answer = (structuredContent: Record<string, unknown>) => ({ content: [], isError: false, structuredContent });
    expect(outcomeOf(answer({ approvalRequired: true, approvalId: 'a' }))).toBe('awaiting_approval');
    expect(outcomeOf(answer({ approvalPending: true, approvalId: 'a' }))).toBe('awaiting_approval');
    expect(outcomeOf(answer({ confirmed: false, declined: true }))).toBe('declined');
    expect(outcomeOf(answer({ version: 4, liveUrl: null }))).toBe('ok');
  });
});
