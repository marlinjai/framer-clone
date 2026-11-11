// @vitest-environment node
//
// The site branches tools of the Lumitra Sites MCP endpoint (docs/plans/2026-11-10-site-branches.md,
// slice S6): list_branches, create_branch, branch_status, update_branch, request_review, merge_branch and
// discard_branch, through the real handler, the real tools and the real branch operations
// (src/server/siteOps/branches.ts), over a fake branch repository and merge service. The integration
// test (mcp-branches.itest.ts) runs the same tools on a real Postgres.
//
// Covered: the switch (off: the tools are not listed, not callable and not in the instructions; on: all
// seven, after the fourteen every key has), arguments and bounds, permissions (a viewer key reads and
// writes nothing; a key discards only its own branch), a merge that is refused before anyone is asked
// (behind main, stale token, problems, nothing changed), a merge without an approval, with a declined
// one, with one for another state and with an approved one (once), a second merge of a merged branch,
// publish and rollback refused on a branch id before a link is opened, the refusals of the library as
// an agent reads them, and that no answer carries a person's id.
//
// Fake keys are built at run time (knowledge-base standards/test-credentials.md).

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => ({ byCookie: {} as Record<string, unknown> }));
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) => sessions.byCookie[cookie] ?? null),
    can: vi.fn(),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));
vi.mock('@/server/db', () => ({ getPrismaClient: () => ({ siteOperationAudit: { create: vi.fn(async () => ({})) } }) }));
vi.mock('@/server/sites/cachedResolver', () => ({ revalidateSiteCache: () => {}, revalidateCustomHostsForSiteId: async () => [] }));

import ProjectModel from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import {
  BranchClosedError,
  BranchConflictsError,
  BranchLimitError,
  BranchNameTakenError,
  BranchReviewStaleError,
  BranchUpdatedFirstError,
  SiteIsBranchError,
  SiteNotFoundError,
  type SiteRepository,
} from '@/server/sites';
import type { BranchSummary, SiteBranchContext } from '@/server/sites/branches/repository';
import type { BranchReview } from '@/server/sites/branches/merge';
import type { AuditEntry } from '@/server/siteOps/audit';
import { ANSWERS_PER_UPDATE, CONFLICTS_LISTED, type BranchOpsDeps } from '@/server/siteOps/branches';
import { BRANCH_NAME_MAX_LENGTH, MAX_OPEN_BRANCHES_PER_SITE } from '@/lib/sites/branches';
import type { VerifiedKey } from '@/lib/auth-machine';
import { ApprovalStore } from '../approvals';
import { approveConfirmation } from '../approveRoute';
import { createMcpHandler } from '../handler';
import { serverInstructions, SERVER_INSTRUCTIONS } from '../instructions';
import { LISTED_BRANCH_TOOLS, LISTED_TOOLS, TOOLS } from '../tools';

const fakeKey = () => `${['sk', 'live'].join('_')}_${randomBytes(16).toString('hex')}`;
const SCOPE = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };
const MAIN = 'site-1';
const BRANCH = 'branch-1';
const PERSON = 'person-7f3a';

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

function project(id: string) {
  return ProjectModel.create({
    id,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {}, children: [] },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

const NO_CHANGES = { site: [], settings: [], pages: { added: [], removed: [], changed: [] }, components: { added: [], removed: [], changed: [] }, nodes: { added: 0, removed: 0, changed: 0 }, pageOrder: false };

function conflict(n: number) {
  return { id: `node:home:text-${n}:props.children`, kind: 'value' as const, unit: { kind: 'node' as const, id: `text-${n}`, container: 'page:home' }, path: ['props', 'children'], base: 'a', main: 'b', branch: 'c', fingerprint: `fp-${n}`, options: ['main' as const, 'branch' as const] };
}

/** A world with one site and one open branch of it, made by `createdBy`. */
function world(options: { key?: VerifiedKey; enabled?: boolean; createdBy?: { kind: 'user' | 'key'; id: string } } = {}) {
  const key = options.key ?? verifiedKey();
  const creator = options.createdBy ?? { kind: 'key' as const, id: 'key_1' };
  const state = {
    mainVersion: 5,
    branchVersion: 2 as number | null,
    baseVersion: 5 as number | null,
    status: 'open' as BranchSummary['status'],
    token: 'tok-1',
    changes: 3,
    conflicts: [] as ReturnType<typeof conflict>[],
    problems: [] as BranchReview['problems'],
    merges: 0,
    updates: [] as Array<Record<string, unknown>>,
    created: [] as Array<{ name: unknown; actor: unknown }>,
    discards: 0,
    ready: 0,
    audits: [] as AuditEntry[],
    throwOn: {} as Partial<Record<'create' | 'list' | 'changes' | 'update' | 'merge', Error>>,
  };
  const summary = (): BranchSummary => ({
    branchId: BRANCH,
    mainSiteId: MAIN,
    name: 'New pricing page',
    status: state.status,
    createdByKind: creator.kind,
    createdBy: creator.id,
    createdAt: new Date('2026-11-11T10:00:00Z'),
    updatedAt: new Date('2026-11-11T11:00:00Z'),
    version: state.status === 'open' || state.status === 'ready' ? state.branchVersion : null,
    baseVersion: state.status === 'open' || state.status === 'ready' ? state.baseVersion : null,
    mainMoved: state.baseVersion !== null && state.baseVersion !== state.mainVersion,
    readyBy: null,
    readyAt: null,
    reviewNote: 'Please check the footer again',
    approved: false,
    mergedAt: state.status === 'merged' ? new Date('2026-11-11T12:00:00Z') : null,
    discardedAt: state.status === 'discarded' ? new Date('2026-11-11T12:00:00Z') : null,
    undoUntil: null,
    undoneIntoBranchId: null,
    undoneAt: null,
  });
  const closed = () => (state.status === 'merged' || state.status === 'discarded' ? new BranchClosedError(state.status, MAIN) : null);
  const review = (): BranchReview => ({
    branch: summary(),
    token: state.token,
    upToDate: state.baseVersion === state.mainVersion,
    branchChanges: { ...NO_CHANGES, nodes: { added: state.changes, removed: 0, changed: 0 } },
    mainChanges: state.baseVersion === state.mainVersion ? null : { ...NO_CHANGES, nodes: { added: 0, removed: 0, changed: 1 } },
    conflicts: state.conflicts,
    settled: [],
    review: { pages: [], components: [] } as unknown as BranchReview['review'],
    versions: { main: state.mainVersion, branch: state.branchVersion ?? 0 },
    problems: state.problems,
  });

  const repository = {
    loadProjectWithVersion: vi.fn(async (_scope: unknown, siteId: string) => {
      if (siteId === MAIN) return { project: project(MAIN), version: state.mainVersion };
      if (siteId === BRANCH) {
        const gone = closed();
        if (gone) throw gone;
        return { project: project(BRANCH), version: state.branchVersion as number };
      }
      throw new SiteNotFoundError(siteId);
    }),
    getSiteAddress: vi.fn(async () => ({ host: 'abc.sites.example', everPublished: true })),
    publishProject: vi.fn(async () => ({ revision: 1, version: state.mainVersion + 1 })),
    ensureSiteDomain: vi.fn(async () => ({ subdomain: 'abc' })),
    listRevisions: vi.fn(async () => ({ live: 1, status: 'published', revisions: [{ number: 1, kind: 'publish', publishedBy: 'u', createdAt: new Date(0), rewrittenAt: null }] })),
    rollbackToRevision: vi.fn(async () => {}),
  };

  const branchDeps: BranchOpsDeps = {
    enabled: () => options.enabled ?? true,
    audit: async (_caller, entry) => {
      state.audits.push(entry);
    },
    branches: {
      listBranches: async (_scope, mainSiteId) => {
        if (state.throwOn.list) throw state.throwOn.list;
        if (mainSiteId !== MAIN) throw new SiteNotFoundError(mainSiteId);
        const open = state.status === 'open' || state.status === 'ready';
        return { mainSiteId: MAIN, mainVersion: state.mainVersion, open: open ? [summary()] : [], closed: open ? [] : [summary()] };
      },
      createBranch: async (_scope, mainSiteId, input) => {
        if (state.throwOn.create) throw state.throwOn.create;
        if (mainSiteId !== MAIN) throw new SiteNotFoundError(mainSiteId);
        state.created.push({ name: input.name, actor: input.actor });
        return { branch: summary(), created: true };
      },
      getBranch: async (_scope, mainSiteId, branchId) => {
        if (mainSiteId !== MAIN || branchId !== BRANCH) throw new SiteNotFoundError(branchId);
        return summary();
      },
      siteBranchContext: async (_scope, siteId): Promise<SiteBranchContext> => {
        if (siteId === MAIN) return { kind: 'main', siteId: MAIN, openBranches: 1 };
        if (siteId !== BRANCH) throw new SiteNotFoundError(siteId);
        const gone = closed();
        if (gone) throw gone;
        return { kind: 'branch', siteId: BRANCH, mainSiteId: MAIN, branch: summary() };
      },
      setBranchReady: async () => {
        state.ready += 1;
        state.status = 'ready';
        return summary();
      },
      discardBranch: async () => {
        state.discards += 1;
        state.status = 'discarded';
        return { branch: summary(), discarded: true };
      },
    },
    merges: {
      changes: async (_scope, branchId) => {
        if (state.throwOn.changes) throw state.throwOn.changes;
        if (branchId !== BRANCH) throw new SiteNotFoundError(branchId);
        const gone = closed();
        if (gone) throw gone;
        return review();
      },
      update: async (_scope, branchId, input) => {
        if (state.throwOn.update) throw state.throwOn.update;
        if (branchId !== BRANCH) throw new SiteNotFoundError(branchId);
        const gone = closed();
        if (gone) throw gone;
        if (input.token !== state.token) throw new BranchReviewStaleError();
        state.updates.push({ resolutions: input.resolutions });
        const moved = state.baseVersion !== state.mainVersion;
        if (moved) {
          state.baseVersion = state.mainVersion;
          state.branchVersion = (state.branchVersion ?? 0) + 1;
          state.token = 'tok-2';
        }
        return { updated: moved, branch: summary(), token: state.token };
      },
      merge: async (_scope, branchId, input) => {
        if (state.throwOn.merge) throw state.throwOn.merge;
        if (branchId !== BRANCH) throw new SiteNotFoundError(branchId);
        if (state.status === 'merged') return { merged: false, branch: summary(), mainVersion: state.mainVersion };
        const gone = closed();
        if (gone) throw gone;
        if (input.token !== state.token) throw new BranchReviewStaleError();
        state.merges += 1;
        state.status = 'merged';
        state.mainVersion += 1;
        return { merged: true, branch: summary(), mainVersion: state.mainVersion };
      },
    },
  };

  const store = new ApprovalStore();
  const secret = fakeKey();
  const handler = createMcpHandler({
    verifyKey: async () => key,
    siteOps: { repository: repository as unknown as SiteRepository, editorHost: 'app.example', publicBaseHost: 'sites.example', branches: branchDeps },
    approvals: store,
  });
  let id = 1;
  const rpc = async (method: string, params?: Record<string, unknown>) => {
    const res = await handler.POST(
      new Request('https://app.lumitra.co/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) }),
      }),
    );
    return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  };
  /** A raw request, for the paths beside a plain call: a batch, a stream, a session id. */
  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    handler.POST(
      new Request('https://app.lumitra.co/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }),
    );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const body = await rpc('tools/call', { name, arguments: args });
    if (!body.result) throw new Error(`tools/call ${name} answered a JSON-RPC error: ${body.error?.message}`);
    return body.result as { isError: boolean; structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
  };
  const canMerge = vi.fn(async (userId: string) => userId === 'owner-a');
  const decide = (approvalId: unknown, decision: 'approve' | 'decline' = 'approve', cookie = 'sess_owner_a') =>
    approveConfirmation(
      new Request(`https://app.lumitra.co/api/projects/${MAIN}/confirmations/${String(approvalId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: `lumitra_session=${cookie}` },
        body: JSON.stringify({ decision }),
      }),
      MAIN,
      String(approvalId),
      { store, repository: repository as unknown as SiteRepository, canMerge, canPublish: async () => false },
    );
  return { state, repository, rpc, raw, call, decide, canMerge, store };
}

/** The messages of a streamed answer, one per call. */
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

async function dialogSession(w: ReturnType<typeof world>): Promise<string> {
  const res = await w.raw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } } });
  return res.headers.get('mcp-session-id')!;
}

const errorOf = (result: { structuredContent: Record<string, unknown> }) => result.structuredContent.error as Record<string, unknown>;
const BRANCH_TOOL_NAMES = ['list_branches', 'create_branch', 'branch_status', 'update_branch', 'request_review', 'merge_branch', 'discard_branch'];

let infoSpy: { mockRestore: () => void };
let errorSpy: { mockRestore: () => void };
beforeEach(() => {
  const fresh = { created_at: new Date(Date.now() - 60_000).toISOString() };
  sessions.byCookie = {
    sess_owner_a: { user: { id: 'owner-a' }, session: fresh, tenants: [], workspaces: [] },
    sess_viewer_a: { user: { id: 'viewer-a' }, session: fresh, tenants: [], workspaces: [] },
  };
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  infoSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('the switch', () => {
  it('off: the branch tools are not listed, not callable and not in the instructions', async () => {
    const w = world({ enabled: false });
    const listed = ((await w.rpc('tools/list')).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(listed).toEqual(LISTED_TOOLS.map((t) => t.name));
    for (const name of BRANCH_TOOL_NAMES) {
      expect(listed).not.toContain(name);
      const answered = await w.rpc('tools/call', { name, arguments: { siteId: MAIN, branchId: BRANCH, name: 'x', token: 't' } });
      expect(answered.result).toBeUndefined();
      expect(answered.error?.message).toBe(`unknown tool: ${name}`);
    }
    const init = (await w.rpc('initialize', { protocolVersion: '2026-06-18', capabilities: {} })).result as { instructions: string };
    expect(init.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(init.instructions).not.toMatch(/branch/i);
    expect(w.state.created).toEqual([]);
  });

  it('on: all seven are listed after the tools every key has, each with a schema, and the instructions explain them', async () => {
    const w = world();
    const tools = ((await w.rpc('tools/list')).result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([...LISTED_TOOLS.map((t) => t.name), ...BRANCH_TOOL_NAMES]);
    expect(LISTED_BRANCH_TOOLS.map((t) => t.name)).toEqual(BRANCH_TOOL_NAMES);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    const init = (await w.rpc('initialize', { protocolVersion: '2026-06-18', capabilities: {} })).result as { instructions: string };
    expect(init.instructions).toBe(serverInstructions(true));
    for (const name of BRANCH_TOOL_NAMES) expect(init.instructions).toContain(name);
    expect(init.instructions).toContain('Never merge unasked');
    expect(init.instructions).toContain(`at most ${MAX_OPEN_BRANCHES_PER_SITE} open branches`);
  });

  it('exactly publish, rollback and merge_branch ask the person, and merge_branch only exists with branches on', () => {
    expect(TOOLS.filter((t) => t.confirms).map((t) => t.name).sort()).toEqual(['merge_branch', 'publish', 'rollback']);
    expect(TOOLS.filter((t) => t.branches).map((t) => t.name)).toEqual(BRANCH_TOOL_NAMES);
  });
});

describe('reading and creating', () => {
  it('list_branches answers the open branches without any person or key id', async () => {
    const w = world({ createdBy: { kind: 'user', id: PERSON } });
    const result = await w.call('list_branches', { siteId: MAIN });
    expect(result.isError).toBe(false);
    const list = result.structuredContent as { siteId: string; version: number; openLimit: number; open: Array<Record<string, unknown>> };
    expect(list).toMatchObject({ siteId: MAIN, version: 5, openLimit: MAX_OPEN_BRANCHES_PER_SITE });
    expect(list.open).toHaveLength(1);
    expect(list.open[0]).toMatchObject({ branchId: BRANCH, siteId: MAIN, name: 'New pricing page', status: 'open', version: 2, createdByKind: 'user', createdByCaller: false });
    expect(JSON.stringify(result)).not.toContain(PERSON);
    expect(list.open[0]).not.toHaveProperty('createdBy');
  });

  it('create_branch makes the branch as the key, answers its id, version and preview link, and writes one audit row without the name', async () => {
    const w = world();
    const result = await w.call('create_branch', { siteId: MAIN, name: '  New pricing page ' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ branchId: BRANCH, version: 2, previewUrl: `https://app.example/projects/${BRANCH}/preview` });
    expect((result.structuredContent.branch as Record<string, unknown>).createdByCaller).toBe(true);
    expect(w.state.created).toEqual([{ name: 'New pricing page', actor: { kind: 'key', id: 'key_1' } }]);
    expect(w.state.audits).toEqual([{ siteId: MAIN, operation: 'branch_create', branchId: BRANCH, versionBefore: 5 }]);
    expect(JSON.stringify(w.state.audits)).not.toContain('pricing');
  });

  it('refuses a name that is empty or too long, and unknown arguments, before anything is made', async () => {
    const w = world();
    for (const args of [{ siteId: MAIN, name: '   ' }, { siteId: MAIN, name: 'x'.repeat(BRANCH_NAME_MAX_LENGTH + 1) }, { siteId: MAIN }, { siteId: MAIN, name: 'ok', branchId: 'mine' }]) {
      const result = await w.call('create_branch', args);
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('invalid_request');
    }
    expect(w.state.created).toEqual([]);
  });

  it('words the limit, a taken name, a branch given as the site and a foreign site for an agent', async () => {
    const w = world();
    w.state.throwOn.create = new BranchLimitError(MAX_OPEN_BRANCHES_PER_SITE);
    expect(errorOf(await w.call('create_branch', { siteId: MAIN, name: 'a' }))).toMatchObject({ code: 'branch_limit', limit: MAX_OPEN_BRANCHES_PER_SITE });
    w.state.throwOn.create = new BranchNameTakenError('a');
    expect(errorOf(await w.call('create_branch', { siteId: MAIN, name: 'a' })).code).toBe('branch_name_taken');
    w.state.throwOn.create = new SiteIsBranchError('x');
    expect(errorOf(await w.call('create_branch', { siteId: MAIN, name: 'a' })).code).toBe('site_is_branch');
    w.state.throwOn.create = undefined;
    const foreign = await w.call('create_branch', { siteId: 'site-of-another-company', name: 'a' });
    expect(errorOf(foreign)).toEqual({ code: 'site_not_found', message: 'no site or branch "site-of-another-company" for this caller' });
    expect(w.state.created).toEqual([]);
    expect(w.state.audits).toEqual([]);
  });

  it('branch_status answers the token, the counts, the links and whether a merge would go through', async () => {
    const w = world();
    const result = await w.call('branch_status', { branchId: BRANCH });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      token: 'tok-1',
      upToDate: true,
      changeCount: 3,
      mainChanges: null,
      conflicts: [],
      conflictsTotal: 0,
      mergeable: true,
      previewUrl: `https://app.example/projects/${BRANCH}/preview`,
      reviewUrl: `https://app.example/projects/${BRANCH}/review`,
    });
    // The element list of the review is the review page's; an agent reads the branch's pages instead.
    expect(result.structuredContent).not.toHaveProperty('review');
  });

  it(`branch_status lists at most ${CONFLICTS_LISTED} conflicts and says how many there are`, async () => {
    const w = world();
    w.state.mainVersion = 6;
    w.state.conflicts = Array.from({ length: CONFLICTS_LISTED + 7 }, (_, n) => conflict(n));
    const status = (await w.call('branch_status', { branchId: BRANCH })).structuredContent as { conflicts: unknown[]; conflictsTotal: number; mergeable: boolean; upToDate: boolean };
    expect(status.conflicts).toHaveLength(CONFLICTS_LISTED);
    expect(status.conflictsTotal).toBe(CONFLICTS_LISTED + 7);
    expect(status).toMatchObject({ upToDate: false, mergeable: false });
  });

  it('a closed branch answers branch_closed with what happened and its site, on every branch tool', async () => {
    const w = world();
    w.state.status = 'discarded';
    for (const [name, args] of [
      ['branch_status', { branchId: BRANCH }],
      ['update_branch', { branchId: BRANCH, token: 'tok-1' }],
      ['request_review', { branchId: BRANCH }],
      ['merge_branch', { branchId: BRANCH, token: 'tok-1' }],
    ] as const) {
      const result = await w.call(name, args);
      expect(errorOf(result), name).toMatchObject({ code: 'branch_closed', branchStatus: 'discarded', siteId: MAIN });
    }
    expect(w.state.merges).toBe(0);
  });
});

describe('update_branch', () => {
  it('brings main in and answers the new version and token; a second call writes nothing', async () => {
    const w = world();
    w.state.mainVersion = 6;
    const first = await w.call('update_branch', { branchId: BRANCH, token: 'tok-1' });
    expect(first.structuredContent).toMatchObject({ updated: true, version: 3, token: 'tok-2' });
    const second = await w.call('update_branch', { branchId: BRANCH, token: 'tok-2' });
    expect(second.structuredContent).toMatchObject({ updated: false, version: 3, token: 'tok-2' });
  });

  it('passes the answers by conflict id, and refuses more than the bound or a pick that is no side', async () => {
    const w = world();
    w.state.mainVersion = 6;
    await w.call('update_branch', { branchId: BRANCH, token: 'tok-1', answers: [{ conflictId: 'c1', fingerprint: 'f1', pick: 'branch' }] });
    expect(w.state.updates).toEqual([{ resolutions: { c1: { fingerprint: 'f1', pick: 'branch' } } }]);
    const tooMany = Array.from({ length: ANSWERS_PER_UPDATE + 1 }, (_, n) => ({ conflictId: `c${n}`, fingerprint: 'f', pick: 'main' }));
    expect(errorOf(await w.call('update_branch', { branchId: BRANCH, token: 'tok-2', answers: tooMany })).code).toBe('invalid_request');
    expect(errorOf(await w.call('update_branch', { branchId: BRANCH, token: 'tok-2', answers: [{ conflictId: 'c', fingerprint: 'f', pick: 'both' }] })).code).toBe('invalid_request');
    expect(errorOf(await w.call('update_branch', { branchId: BRANCH, token: 'x'.repeat(65) })).code).toBe('invalid_request');
    expect(w.state.updates).toHaveLength(1);
  });

  it('a stale token and open conflicts are refusals that name what to do, with the conflicts capped', async () => {
    const w = world();
    expect(errorOf(await w.call('update_branch', { branchId: BRANCH, token: 'old' })).code).toBe('branch_review_stale');
    w.state.throwOn.update = new BranchConflictsError(Array.from({ length: CONFLICTS_LISTED + 1 }, (_, n) => conflict(n)), 'tok-9', true);
    const refused = errorOf(await w.call('update_branch', { branchId: BRANCH, token: 'tok-1' }));
    expect(refused).toMatchObject({ code: 'branch_conflicts', conflictsTotal: CONFLICTS_LISTED + 1, token: 'tok-9', answersKept: true });
    expect(refused.conflicts as unknown[]).toHaveLength(CONFLICTS_LISTED);
  });
});

describe('request_review and discard_branch', () => {
  it('request_review marks the branch ready once, answers both links, and a site id is not a branch', async () => {
    const w = world();
    const result = await w.call('request_review', { branchId: BRANCH });
    expect(result.structuredContent).toMatchObject({
      previewUrl: `https://app.example/projects/${BRANCH}/preview`,
      reviewUrl: `https://app.example/projects/${BRANCH}/review`,
    });
    expect((result.structuredContent.branch as Record<string, unknown>).status).toBe('ready');
    await w.call('request_review', { branchId: BRANCH });
    expect(w.state.audits.map((a) => a.operation)).toEqual(['branch_review']);
    expect(errorOf(await w.call('request_review', { branchId: MAIN })).code).toBe('not_a_branch');
  });

  it('a key discards a branch it created', async () => {
    const w = world();
    const result = await w.call('discard_branch', { branchId: BRANCH });
    expect(result.structuredContent).toMatchObject({ discarded: true });
    expect(w.state.discards).toBe(1);
    expect(w.state.audits).toEqual([{ siteId: MAIN, operation: 'branch_discard', branchId: BRANCH }]);
  });

  it("a key may not discard a person's branch or another key's, and a site id is not a branch", async () => {
    for (const createdBy of [{ kind: 'user' as const, id: PERSON }, { kind: 'key' as const, id: 'key_2' }, { kind: 'user' as const, id: 'key_1' }]) {
      const w = world({ createdBy });
      const refused = await w.call('discard_branch', { branchId: BRANCH });
      expect(errorOf(refused).code).toBe('forbidden');
      expect(w.state.discards).toBe(0);
      expect(w.state.audits).toEqual([]);
    }
    const w = world();
    expect(errorOf(await w.call('discard_branch', { branchId: MAIN })).code).toBe('not_a_branch');
    expect(w.state.discards).toBe(0);
  });
});

describe('permissions', () => {
  it('a viewer key reads branches and writes nothing', async () => {
    const w = world({ key: verifiedKey('viewer') });
    expect((await w.call('list_branches', { siteId: MAIN })).isError).toBe(false);
    expect((await w.call('branch_status', { branchId: BRANCH })).isError).toBe(false);
    for (const [name, args] of [
      ['create_branch', { siteId: MAIN, name: 'a' }],
      ['update_branch', { branchId: BRANCH, token: 'tok-1' }],
      ['request_review', { branchId: BRANCH }],
      ['merge_branch', { branchId: BRANCH, token: 'tok-1' }],
      ['discard_branch', { branchId: BRANCH }],
    ] as const) {
      expect(errorOf(await w.call(name, args)).code, name).toBe('forbidden');
    }
    expect(w.state).toMatchObject({ created: [], updates: [], ready: 0, merges: 0, discards: 0, audits: [] });
  });

  it('a key without a workspace role reads nothing', async () => {
    const w = world({ key: verifiedKey(null) });
    expect(errorOf(await w.call('list_branches', { siteId: MAIN })).code).toBe('forbidden');
    expect(errorOf(await w.call('branch_status', { branchId: BRANCH })).code).toBe('forbidden');
  });
});

describe('merge_branch needs the person', () => {
  it('without an approval nothing is merged: the first call answers a link pinned to the site', async () => {
    const w = world();
    const first = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1' });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ approvalRequired: true });
    expect(String(first.structuredContent.approvalUrl)).toBe(`https://app.example/projects/${MAIN}/confirm/${String(first.structuredContent.approvalId)}`);
    expect(String(first.structuredContent.summary)).toContain('Merge branch "New pricing page" (3 changes, branch version 2) into "Bakery"');
    expect(String(first.structuredContent.summary)).toContain('Nothing is published');
    // Calling again without the person having decided: still nothing.
    const pending = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId });
    expect(pending.structuredContent).toMatchObject({ approvalPending: true });
    expect(w.state.merges).toBe(0);
  });

  it('an approved merge merges once, publishes nothing, and a second call answers the first result', async () => {
    const w = world();
    const first = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1' });
    expect((await w.decide(first.structuredContent.approvalId)).status).toBe(200);
    expect(w.canMerge).toHaveBeenCalledWith('owner-a', 'ws_a');
    const merged = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId });
    expect(merged.isError).toBe(false);
    expect(merged.structuredContent).toMatchObject({ merged: true, siteId: MAIN, version: 6 });
    expect(String(merged.structuredContent.message)).toContain('Nothing was published');
    expect(w.repository.publishProject).not.toHaveBeenCalled();
    // A retry (the answer was lost): the same result, no second merge, nobody asked again.
    const again = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId });
    expect(again.structuredContent).toMatchObject({ merged: false, siteId: MAIN, version: 6 });
    expect(again.structuredContent).not.toHaveProperty('approvalRequired');
    expect(w.state.merges).toBe(1);
  });

  it('a declined merge writes nothing and is spent', async () => {
    const w = world();
    const first = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1' });
    expect((await w.decide(first.structuredContent.approvalId, 'decline')).status).toBe(200);
    const declined = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId });
    expect(declined.structuredContent).toMatchObject({ confirmed: false, declined: true });
    const reused = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId });
    expect(reused.structuredContent).toMatchObject({ approvalRequired: true });
    expect(w.state.merges).toBe(0);
  });

  it('an approval for a state that moved since is useless: the branch was edited, or main was', async () => {
    for (const move of ['branch', 'main'] as const) {
      const w = world();
      const first = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1' });
      expect((await w.decide(first.structuredContent.approvalId)).status).toBe(200);
      // An edit after the approval: a new version and so a new token.
      if (move === 'branch') w.state.branchVersion = 3;
      else w.state.mainVersion = 6;
      w.state.token = 'tok-2';
      // The old token is refused before the approval is looked at.
      expect(errorOf(await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId })).code).toBe('branch_review_stale');
      if (move === 'branch') {
        // The new token with the old approval: the approval was for another state, a new link is opened.
        const stale = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-2', approvalId: first.structuredContent.approvalId });
        expect(stale.structuredContent).toMatchObject({ approvalRequired: true });
        expect(stale.structuredContent.approvalId).not.toBe(first.structuredContent.approvalId);
      }
      expect(w.state.merges, move).toBe(0);
    }
  });

  it('the person cannot approve what changed since the agent asked, nor without the right to merge', async () => {
    const w = world();
    const first = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1' });
    const viewer = await w.decide(first.structuredContent.approvalId, 'approve', 'sess_viewer_a');
    expect(viewer.status).toBe(403);
    w.state.branchVersion = 3;
    const changed = await w.decide(first.structuredContent.approvalId);
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe('site_changed');
    w.state.branchVersion = 2;
    w.state.status = 'discarded';
    expect((await w.decide(first.structuredContent.approvalId)).status).toBe(409);
    expect(w.state.merges).toBe(0);
  });

  it('is refused before anyone is asked: behind main, problems, nothing changed, a stale token', async () => {
    const cases: Array<[string, (s: ReturnType<typeof world>['state']) => void, string]> = [
      ['branch_behind_main', (s) => { s.mainVersion = 6; }, 'tok-1'],
      ['branch_merge_invalid', (s) => { s.problems = [{ code: 'slug', message: 'two pages share an address' }]; }, 'tok-1'],
      ['branch_unchanged', (s) => { s.changes = 0; }, 'tok-1'],
      ['branch_review_stale', () => {}, 'tok-0'],
    ];
    for (const [code, arrange, token] of cases) {
      const w = world();
      arrange(w.state);
      const refused = await w.call('merge_branch', { branchId: BRANCH, token });
      expect(refused.isError, code).toBe(true);
      expect(errorOf(refused).code).toBe(code);
      expect(refused.structuredContent).not.toHaveProperty('approvalUrl');
      expect(w.state.merges).toBe(0);
    }
  });

  it('a merge that finds main moved after the approval updates the branch first and says so', async () => {
    const w = world();
    const first = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1' });
    expect((await w.decide(first.structuredContent.approvalId)).status).toBe(200);
    w.state.throwOn.merge = new BranchUpdatedFirstError('tok-5');
    const refused = await w.call('merge_branch', { branchId: BRANCH, token: 'tok-1', approvalId: first.structuredContent.approvalId });
    expect(errorOf(refused)).toMatchObject({ code: 'branch_updated_from_main', token: 'tok-5' });
    expect(w.state.merges).toBe(0);
  });
});

describe('a branch is never published', () => {
  it('publish and rollback on a branch id are refused before a link is opened, naming its site', async () => {
    const w = world();
    const publish = await w.call('publish', { siteId: BRANCH, expectedVersion: 2 });
    expect(errorOf(publish)).toMatchObject({ code: 'branch_cannot_publish', mainSiteId: MAIN });
    const rollback = await w.call('rollback', { siteId: BRANCH, revision: 1 });
    expect(errorOf(rollback)).toMatchObject({ code: 'branch_cannot_publish', mainSiteId: MAIN });
    for (const result of [publish, rollback]) expect(result.structuredContent).not.toHaveProperty('approvalUrl');
    expect(w.repository.publishProject).not.toHaveBeenCalled();
    expect(w.repository.rollbackToRevision).not.toHaveBeenCalled();
  });

  it('the same refusal with the switch off: a branch made while it was on stays a branch', async () => {
    const w = world({ enabled: false });
    expect(errorOf(await w.call('publish', { siteId: BRANCH, expectedVersion: 2 })).code).toBe('branch_cannot_publish');
    expect(w.repository.publishProject).not.toHaveBeenCalled();
  });

  it('publish on the site itself still asks the person', async () => {
    const w = world();
    const first = await w.call('publish', { siteId: MAIN, expectedVersion: 5 });
    expect(first.structuredContent).toMatchObject({ approvalRequired: true });
  });
});

describe('failures', () => {
  it('an unexpected error never reaches the agent: a fixed message, the detail in the server log', async () => {
    const w = world();
    w.state.throwOn.changes = new Error('connection to 10.0.0.5:5432 refused for role sites_owner');
    const result = await w.call('branch_status', { branchId: BRANCH });
    expect(errorOf(result)).toEqual({ code: 'failed', message: 'the branch operation failed unexpectedly; call branch_status again before retrying' });
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('review findings', () => {
  it('with the switch off a branch tool is unknown in a batch and on the dialog path too, and nothing is asked or written', async () => {
    const w = world({ enabled: false });
    const batch = await w.raw([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merge_branch', arguments: { branchId: BRANCH, token: 'tok-1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_branch', arguments: { siteId: MAIN, name: 'x' } } },
    ]);
    const answers = (await batch.json()) as Array<{ result?: unknown; error?: { message: string } }>;
    expect(answers.map((a) => a.error?.message)).toEqual(['unknown tool: merge_branch', 'unknown tool: create_branch']);
    const session = await dialogSession(w);
    const streamed = await w.raw({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'merge_branch', arguments: { branchId: BRANCH, token: 'tok-1' } } }, { 'mcp-session-id': session });
    expect(streamed.headers.get('content-type')).not.toBe('text/event-stream');
    expect(((await streamed.json()) as { error: { message: string } }).error.message).toBe('unknown tool: merge_branch');
    expect(w.state).toMatchObject({ merges: 0, created: [] });
  });

  it('merge_branch through the client dialog: merges on accept, on the same stream', async () => {
    const w = world();
    const session = await dialogSession(w);
    const res = await w.raw({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'merge_branch', arguments: { branchId: BRANCH, token: 'tok-1' } } }, { 'mcp-session-id': session });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const next = sseReader(res);
    const question = await next();
    expect(question).toMatchObject({ method: 'elicitation/create', params: { message: expect.stringContaining('Merge branch "New pricing page"') } });
    expect(w.state.merges).toBe(0);
    await w.raw({ jsonrpc: '2.0', id: question.id, result: { action: 'accept', content: { confirm: true } } }, { 'mcp-session-id': session });
    const final = (await next()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(final.result.structuredContent).toMatchObject({ merged: true, siteId: MAIN });
    expect(w.state.merges).toBe(1);
  });

  it('merge_branch through the client dialog: a decline merges nothing', async () => {
    for (const result of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }]) {
      const w = world();
      const session = await dialogSession(w);
      const res = await w.raw({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'merge_branch', arguments: { branchId: BRANCH, token: 'tok-1' } } }, { 'mcp-session-id': session });
      const next = sseReader(res);
      const question = await next();
      await w.raw({ jsonrpc: '2.0', id: question.id, result }, { 'mcp-session-id': session });
      const final = (await next()) as { result: { structuredContent: Record<string, unknown> } };
      expect(final.result.structuredContent).not.toHaveProperty('merged');
      expect(w.state.merges).toBe(0);
    }
  });

  it("an approval for one branch cannot be spent on a sibling branch of the same site, even with the same token and versions", () => {
    const store = new ApprovalStore();
    const subject = { action: 'merge' as const, tenantId: 'tenant-a', keyId: 'key_1', scope: SCOPE, siteId: MAIN, version: 5, branchId: 'branch-a', branchVersion: 1, token: 'same-token' };
    const approval = store.open(subject, 'Merge branch "A"?');
    expect(store.decide(approval.id, 'owner-a', 'approve').kind).toBe('decided');
    expect(store.redeem(approval.id, { ...subject, branchId: 'branch-b' }).kind).toBe('invalid');
    expect(store.redeem(approval.id, { ...subject, branchVersion: 2 }).kind).toBe('invalid');
    expect(store.redeem(approval.id, { ...subject, token: 'other-token' }).kind).toBe('invalid');
    expect(store.redeem(approval.id, { ...subject, action: 'publish' as const }).kind).toBe('invalid');
    expect(store.redeem(approval.id, subject).kind).toBe('approved');
  });

  it('a site id given where a branch id belongs is told so, on every tool that takes a branch', async () => {
    const w = world();
    for (const [name, args] of [
      ['branch_status', { branchId: MAIN }],
      ['update_branch', { branchId: MAIN, token: 'tok-1' }],
      ['merge_branch', { branchId: MAIN, token: 'tok-1' }],
      ['request_review', { branchId: MAIN }],
      ['discard_branch', { branchId: MAIN }],
    ] as const) {
      expect(errorOf(await w.call(name, args)).code, name).toBe('not_a_branch');
    }
    expect(errorOf(await w.call('branch_status', { branchId: 'nothing-of-ours' })).code).toBe('site_not_found');
  });

  it('a repeated discard answers the first outcome to the key that made the branch, and only to it', async () => {
    const w = world();
    expect((await w.call('discard_branch', { branchId: BRANCH })).structuredContent).toMatchObject({ discarded: true });
    const again = await w.call('discard_branch', { branchId: BRANCH });
    expect(again.isError).toBe(false);
    expect(again.structuredContent).toMatchObject({ discarded: false });
    expect(w.state.discards).toBe(1);
    const other = world({ createdBy: { kind: 'user', id: PERSON } });
    other.state.status = 'discarded';
    expect(errorOf(await other.call('discard_branch', { branchId: BRANCH })).code).toBe('branch_closed');
  });

  it('publish and rollback on a closed branch id open no link', async () => {
    const w = world();
    w.state.status = 'merged';
    for (const result of [await w.call('publish', { siteId: BRANCH, expectedVersion: 2 }), await w.call('rollback', { siteId: BRANCH, revision: 1 })]) {
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('site_not_found');
      expect(String(errorOf(result).message)).toContain(MAIN);
      expect(result.structuredContent).not.toHaveProperty('approvalUrl');
    }
    expect(w.repository.publishProject).not.toHaveBeenCalled();
  });

  it('a taken name points at list_branches, for a create whose first answer was lost', async () => {
    const w = world();
    w.state.throwOn.create = new BranchNameTakenError('a');
    expect(String(errorOf(await w.call('create_branch', { siteId: MAIN, name: 'a' })).message)).toContain('list_branches');
  });
});
