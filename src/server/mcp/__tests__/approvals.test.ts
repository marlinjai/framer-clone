// @vitest-environment node
//
// The approval link of the Lumitra Sites MCP endpoint: the editor route a
// signed-in person decides through (src/server/mcp/approveRoute.ts) and the check
// it shares with the approval page (src/server/mcp/approvalCheck.ts), together
// with the MCP handler that opened the request, over one shared store.
//
// Covered: approve then the agent's call publishes; decline; expiry; a user
// without publishSite; a user of another company; reuse; a version that moves
// before or after the approval; no session, a bearer instead of a session, a
// write from another origin, a malformed body, a link for another site; and that
// reading a request (what the page does) never decides it.

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
import { SiteChangedError, SiteNotFoundError, type SiteRepository } from '@/server/sites';
import type { VerifiedKey } from '@/lib/auth-machine';
import { APPROVAL_TTL_MS, ApprovalStore } from '../approvals';
import { checkApprover } from '../approvalCheck';
import { approveConfirmation } from '../approveRoute';
import { createMcpHandler } from '../handler';
import { NO_BRANCHES } from './noBranches';
import * as routeModule from '@/app/api/projects/[projectId]/confirmations/[approvalId]/route';

const fakeKey = () => `${['sk', 'live'].join('_')}_${randomBytes(16).toString('hex')}`;
const SCOPE = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };
const KEY: VerifiedKey = Object.freeze({
  kind: 'key' as const,
  tenantId: 'tenant-a',
  companySlug: 'acme',
  keyId: 'key_1',
  serviceAccountId: 'sa_1',
  scope: Object.freeze({ ...SCOPE }),
  workspaceRole: 'admin' as const,
  appGrants: Object.freeze(['sites']),
});

// Who may publish where: the owner of company A on its workspace; a member of
// company A without the publish right; the owner of company B on another workspace.
const PUBLISH_RIGHTS: Record<string, string[]> = { 'owner-a': ['ws_a'], 'member-a': [], 'owner-b': ['ws_b'] };
const canPublish = vi.fn(async (userId: string, workspaceId: string) => (PUBLISH_RIGHTS[userId] ?? []).includes(workspaceId));

function project() {
  return ProjectModel.create({
    id: 'site-1',
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

function world(now: () => number = Date.now) {
  const state = { version: 3, published: 0, gone: false };
  const repository = {
    loadProjectWithVersion: vi.fn(async (_scope: unknown, siteId: string) => {
      if (siteId !== 'site-1' || state.gone) throw new SiteNotFoundError(siteId);
      return { project: project(), version: state.version };
    }),
    getSiteAddress: vi.fn(async () => ({ host: 'abc.sites.example', everPublished: true })),
    publishProject: vi.fn(async (_s: unknown, _p: unknown, o: { expectedVersion: number }) => {
      if (o.expectedVersion !== state.version) throw new SiteChangedError(state.version);
      state.published += 1;
      state.version += 1;
      return { revision: 1, version: state.version };
    }),
    ensureSiteDomain: vi.fn(async () => ({ subdomain: 'abc' })),
  } as unknown as SiteRepository;
  const store = new ApprovalStore(now);
  const key = fakeKey();
  const handler = createMcpHandler({ verifyKey: async () => KEY, siteOps: { repository, editorHost: 'app.example', branches: NO_BRANCHES }, approvals: store });
  let id = 1;
  const publishCall = async (args: Record<string, unknown>) => {
    const res = await handler.POST(
      new Request('https://app.lumitra.co/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'publish', arguments: args } }),
      }),
    );
    return ((await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } }).result;
  };
  const decide = (approvalId: unknown, cookie: string | null, body: unknown = { decision: 'approve' }, headers: Record<string, string> = {}) =>
    approveConfirmation(
      new Request(`https://app.lumitra.co/api/projects/site-1/confirmations/${String(approvalId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie: `lumitra_session=${cookie}` } : {}), ...headers },
        body: JSON.stringify(body),
      }),
      'site-1',
      String(approvalId),
      { store, repository, canPublish },
    );
  return { state, store, repository, publishCall, decide };
}

let infoSpy: { mockRestore: () => void };
beforeEach(() => {
  const fresh = { created_at: new Date(Date.now() - 60_000).toISOString() };
  sessions.byCookie = {
    sess_owner_a: { user: { id: 'owner-a' }, session: fresh, tenants: [], workspaces: [] },
    sess_member_a: { user: { id: 'member-a' }, session: fresh, tenants: [], workspaces: [] },
    sess_owner_b: { user: { id: 'owner-b' }, session: fresh, tenants: [], workspaces: [] },
    // The owner again, in a browser left signed in for 20 minutes.
    sess_owner_a_old: { user: { id: 'owner-a' }, session: { created_at: new Date(Date.now() - 20 * 60_000).toISOString() }, tenants: [], workspaces: [] },
    // An auth-brain answer without a sign-in time.
    sess_owner_a_untimed: { user: { id: 'owner-a' }, session: {}, tenants: [], workspaces: [] },
  };
  canPublish.mockClear();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => infoSpy.mockRestore());

describe('the approval link', () => {
  it('approve: the signed-in owner approves on the page, then the agent\'s next call publishes once', async () => {
    const w = world();
    const asked = await w.publishCall({ siteId: 'site-1', expectedVersion: 3 });
    const id = asked.structuredContent.approvalId;
    expect(w.state.published).toBe(0);

    const res = await w.decide(id, 'sess_owner_a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: Record<string, unknown> };
    expect(body.approval).toMatchObject({ decision: 'approve', siteId: 'site-1', version: 3 });
    expect(JSON.stringify(body)).not.toContain('key_1');
    expect(canPublish).toHaveBeenCalledWith('owner-a', 'ws_a');

    const done = await w.publishCall({ siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(done.isError).toBe(false);
    expect(w.state.published).toBe(1);

    // Reuse: spent by the publish; the page and the route no longer know it.
    expect((await w.decide(id, 'sess_owner_a')).status).toBe(404);
    expect((await w.publishCall({ siteId: 'site-1', expectedVersion: 4, approvalId: id })).structuredContent.approvalRequired).toBe(true);
  });

  it('decline: nothing is published, and the first decision stands', async () => {
    const w = world();
    const id = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    expect((await w.decide(id, 'sess_owner_a', { decision: 'decline' })).status).toBe(200);
    const again = await w.decide(id, 'sess_owner_a', { decision: 'approve' });
    expect(again.status).toBe(409);
    const res = await w.publishCall({ siteId: 'site-1', expectedVersion: 3, approvalId: id });
    expect(res.structuredContent).toMatchObject({ declined: true });
    expect(w.state.published).toBe(0);
  });

  it('expiry: a link past its five minutes can neither be approved nor used', async () => {
    let now = 5_000_000;
    const w = world(() => now);
    const id = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    expect(APPROVAL_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
    now += APPROVAL_TTL_MS + 1;
    expect((await w.decide(id, 'sess_owner_a')).status).toBe(404);

    // Approved in time, used too late.
    const id2 = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    expect((await w.decide(id2, 'sess_owner_a')).status).toBe(200);
    now += APPROVAL_TTL_MS + 1;
    expect((await w.publishCall({ siteId: 'site-1', expectedVersion: 3, approvalId: id2 })).structuredContent.approvalRequired).toBe(true);
    expect(w.state.published).toBe(0);
  });

  it('a user of the same company without publishSite, and the owner of another company, are refused', async () => {
    const w = world();
    const id = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    expect((await w.decide(id, 'sess_member_a')).status).toBe(403);
    expect((await w.decide(id, 'sess_owner_b')).status).toBe(403);
    expect(canPublish).toHaveBeenCalledWith('owner-b', 'ws_a');
    expect((await w.publishCall({ siteId: 'site-1', expectedVersion: 3, approvalId: id })).structuredContent.approvalPending).toBe(true);
    expect(w.state.published).toBe(0);
  });

  it('a version that moves before the approval cannot be approved; one that moves after it refuses the publish', async () => {
    const w = world();
    const before = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    w.state.version = 4;
    expect((await w.decide(before, 'sess_owner_a')).status).toBe(409);
    // Declining a changed request is still possible.
    expect((await w.decide(before, 'sess_owner_a', { decision: 'decline' })).status).toBe(200);

    const after = (await w.publishCall({ siteId: 'site-1', expectedVersion: 4 })).structuredContent.approvalId;
    expect((await w.decide(after, 'sess_owner_a')).status).toBe(200);
    w.state.version = 5;
    const res = await w.publishCall({ siteId: 'site-1', expectedVersion: 4, approvalId: after });
    expect((res.structuredContent.error as { code: string; currentVersion: number })).toMatchObject({ code: 'site_changed', currentVersion: 5 });
    expect(w.state.published).toBe(0);

    // A site removed meanwhile is "changed" too.
    const gone = (await w.publishCall({ siteId: 'site-1', expectedVersion: 5 })).structuredContent.approvalId;
    w.state.gone = true;
    expect((await w.decide(gone, 'sess_owner_a')).status).toBe(409);
  });

  it('refuses no session, a bearer instead of a session, another origin, a bad body and a link of another site', async () => {
    const w = world();
    const id = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    expect((await w.decide(id, null)).status).toBe(401);
    expect((await w.decide(id, 'sess_owner_a', undefined, { authorization: `Bearer ${fakeKey()}` })).status).toBe(401);
    expect((await w.decide(id, 'sess_owner_a', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await w.decide(id, 'sess_owner_a', undefined, { 'sec-fetch-site': '', origin: 'https://evil.sites.example', host: 'app.lumitra.co' })).status).toBe(403);
    expect((await w.decide(id, 'sess_owner_a', { decision: 'yes please' })).status).toBe(400);
    const otherSite = await approveConfirmation(
      new Request('https://app.lumitra.co/api/projects/site-2/confirmations/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: 'lumitra_session=sess_owner_a' },
        body: JSON.stringify({ decision: 'approve' }),
      }),
      'site-2',
      String(id),
      { store: w.store, repository: w.repository, canPublish },
    );
    expect(otherSite.status).toBe(404);
    expect(w.store.get(String(id))?.decision).toBeNull();
  });

  it('a sign-in older than 15 minutes, or without a time, must sign in again before approving', async () => {
    const w = world();
    const id = (await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId;
    for (const cookie of ['sess_owner_a_old', 'sess_owner_a_untimed']) {
      const res = await w.decide(id, cookie, { decision: 'approve' }, { host: 'app.lumitra.co' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; reauthUrl: string } };
      expect(body.error.code).toBe('reauth_required');
      const logout = new URL(body.error.reauthUrl);
      expect(logout.pathname).toBe('/api/auth/logout');
      const login = new URL(logout.searchParams.get('return_to')!);
      expect(login.pathname).toBe('/login');
      expect(login.searchParams.get('return_to')).toBe(`https://app.lumitra.co/projects/site-1/confirm/${String(id)}`);
    }
    expect(w.store.get(String(id))?.decision).toBeNull();
    expect((await w.decide(id, 'sess_owner_a')).status).toBe(200);
  });

  it('reading a request, as the page does, never decides it, and the route answers only POST', async () => {
    const w = world();
    const id = String((await w.publishCall({ siteId: 'site-1', expectedVersion: 3 })).structuredContent.approvalId);
    for (let i = 0; i < 3; i++) expect((await checkApprover('owner-a', 'site-1', id, { store: w.store, repository: w.repository, canPublish })).status).toBe('ok');
    expect(w.store.get(id)?.decision).toBeNull();
    expect((await w.publishCall({ siteId: 'site-1', expectedVersion: 3, approvalId: id })).structuredContent.approvalPending).toBe(true);
    expect(Object.keys(routeModule).filter((k) => ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
    expect(typeof routeModule.POST).toBe('function');
  });
});
