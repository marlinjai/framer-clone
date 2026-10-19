// @vitest-environment node
//
// src/app/api/__tests__/active-company-routes.test.ts
//
// Every editor-plane API route resolves its company the SAME way as the
// /projects dashboard and the project loader: the `framer_company` selector
// cookie, else the retired `framer_ws` cookie mapped to its company, else the
// session's active_tenant, else its only company, always only among companies
// holding the auth-brain app grant `sites`, and then acts in that company's
// workspace. A session with no granted company answers JSON 403
// `sites_not_enabled`; granted companies but none resolvable answer JSON 403
// `no_active_company` (never a redirect to the login, which looped forever on
// 2026-10-19). Only the auth-brain client and the data layers are mocked;
// resolveActiveScope and the routes' guard wiring run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const mockListSites = vi.fn();
vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return {
    ...actual,
    getSiteRepository: () => ({
      listSites: mockListSites,
      saveProject: vi.fn(),
      publishProject: vi.fn(),
      unpublishProject: vi.fn(),
      loadProject: vi.fn(),
    }),
  };
});
vi.mock('@/server/cms/adapterClient', () => ({ getCmsAdapter: () => ({}) }));
vi.mock('@/server/db', () => ({ getPrismaClient: () => ({}) }));
vi.mock('@/lib/ai/anthropicClient', () => ({
  AI_MODELS: { HAIKU: 'h', SONNET: 's', OPUS: 'o' },
  getAnthropicClient: () => ({}),
  MissingAnthropicKeyError: class extends Error {},
  resolveModelId: () => 'o',
}));

import { AuthBrainError, AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';
import { POST as createProject } from '../projects/route';
import { POST as saveProject } from '../projects/save/route';
import { POST as publishProject } from '../projects/publish/route';
import { POST as unpublishProject } from '../projects/unpublish/route';
import { GET as listProjects } from '../projects/list/route';
import { POST as createCollection } from '../cms/collections/route';
import { PATCH as patchCollection, DELETE as deleteCollection } from '../cms/collections/[id]/route';
import { POST as cmsAgent } from '../ai/cms-agent/route';
import { POST as cmsAgentUndo } from '../ai/cms-agent/undo/route';

// Two companies with Sites (a, b) and one without (c), no active company.
function multiSession() {
  return {
    user: { id: 'user-m' },
    session: {},
    tenants: [
      { id: 'tenant-a', app_grants: ['sites'], group_id: 'tg_a', name: 'Acme', slug: 'acme' },
      { id: 'tenant-b', app_grants: ['sites'], group_id: 'tg_b', name: 'Beta', slug: 'beta' },
      { id: 'tenant-c', app_grants: ['studio'], group_id: 'tg_c', name: 'Corp', slug: 'corp' },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 'tenant-a', name: 'Main', slug: 'main' },
      { id: 'ws_b', tenant_id: 'tenant-b', name: 'Main', slug: 'main' },
      { id: 'ws_c', tenant_id: 'tenant-c', name: 'Main', slug: 'main' },
    ],
    active_tenant: null,
    active_workspace: null,
  };
}

/** The same user, but no company of theirs holds the `sites` grant. */
function ungrantedSession() {
  const s = multiSession();
  return {
    ...s,
    tenants: s.tenants.map((t) => ({ ...t, app_grants: ['studio'] })),
    active_tenant: { id: 'tenant-a' },
  };
}

function req(url: string, method: string, cookie: string, body?: unknown): Request {
  return new Request(`http://app.test${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'tbl_1' }) };
const PROJECT = { id: 'site_1', metadata: { title: 'T', description: '' }, pages: {} };

// Each guarded write route, invoked with a given cookie header.
const ROUTES: Array<[string, (cookie: string) => Promise<Response>]> = [
  ['POST /api/projects', (c) => createProject(req('/api/projects', 'POST', c, {}))],
  ['POST /api/projects/save', (c) => saveProject(req('/api/projects/save', 'POST', c, { project: PROJECT }))],
  ['POST /api/projects/publish', (c) => publishProject(req('/api/projects/publish', 'POST', c, { project: PROJECT }))],
  ['POST /api/projects/unpublish', (c) => unpublishProject(req('/api/projects/unpublish', 'POST', c, { siteId: 'site_1' }))],
  ['POST /api/cms/collections', (c) => createCollection(req('/api/cms/collections', 'POST', c, { name: 'X' }))],
  ['PATCH /api/cms/collections/:id', (c) => patchCollection(req('/api/cms/collections/tbl_1', 'PATCH', c, { name: 'Y' }), params)],
  ['DELETE /api/cms/collections/:id', (c) => deleteCollection(req('/api/cms/collections/tbl_1', 'DELETE', c), params)],
  [
    'POST /api/ai/cms-agent',
    (c) =>
      cmsAgent(
        req('/api/ai/cms-agent', 'POST', c, {
          collectionId: 'tbl_1',
          workspaceId: 'ws_a',
          prompt: 'hi',
        }),
      ),
  ],
  ['POST /api/ai/cms-agent/undo', (c) => cmsAgentUndo(req('/api/ai/cms-agent/undo', 'POST', c, { runId: 'run_1' }))],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockResolvedValue(multiSession());
  // Deny at the permission step: these tests stop at the scope + authz
  // boundary, which is exactly what is under test.
  mockCan.mockResolvedValue(false);
  mockListSites.mockResolvedValue([]);
});

describe.each(ROUTES)('%s: active company resolution', (_name, call) => {
  it('answers JSON 403 no_active_company (never a redirect) when no company is resolvable', async () => {
    const res = await call('lumitra_session=sess');

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect((await res.json()).error.code).toBe('no_active_company');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('answers JSON 403 sites_not_enabled when no company of the session holds the grant', async () => {
    mockVerifySession.mockResolvedValue(ungrantedSession());

    const res = await call('lumitra_session=sess; framer_company=tenant-a');

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect((await res.json()).error.code).toBe('sites_not_enabled');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('ignores a forged framer_company (company outside the session)', async () => {
    const res = await call('lumitra_session=sess; framer_company=tenant-foreign');

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_company');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('ignores a framer_company naming a company WITHOUT the grant', async () => {
    const res = await call('lumitra_session=sess; framer_company=tenant-c');

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_company');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it("authorizes against the selected company's workspace", async () => {
    const res = await call('lumitra_session=sess; framer_company=tenant-b');

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(mockCan).toHaveBeenCalledWith('user-m', expect.any(String), {
      type: 'workspace',
      id: 'ws_b',
      workspaceId: 'ws_b',
    });
  });

  it('honours the retired framer_ws cookie of a granted company until it is migrated', async () => {
    const res = await call('lumitra_session=sess; framer_ws=ws_a');

    expect((await res.json()).error.code).toBe('forbidden');
    expect(mockCan).toHaveBeenCalledWith('user-m', expect.any(String), {
      type: 'workspace',
      id: 'ws_a',
      workspaceId: 'ws_a',
    });
  });
});

describe('GET /api/projects/list: active company resolution', () => {
  it("lists the selected company's workspace", async () => {
    const res = await listProjects(
      req('/api/projects/list', 'GET', 'lumitra_session=sess; framer_company=tenant-b'),
    );

    expect(res.status).toBe(200);
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_b', tenantGroupId: 'tg_b' });
  });

  it('switching the company changes the project list', async () => {
    mockListSites.mockImplementation(async (scope: { workspaceId: string }) => [
      { siteId: `site-of-${scope.workspaceId}` },
    ]);
    const a = await listProjects(
      req('/api/projects/list', 'GET', 'lumitra_session=sess; framer_company=tenant-a'),
    );
    const b = await listProjects(
      req('/api/projects/list', 'GET', 'lumitra_session=sess; framer_company=tenant-b'),
    );

    expect((await a.json()).sites).toEqual([{ siteId: 'site-of-ws_a' }]);
    expect((await b.json()).sites).toEqual([{ siteId: 'site-of-ws_b' }]);
  });

  it('answers JSON 403 no_active_company without a selection', async () => {
    const res = await listProjects(req('/api/projects/list', 'GET', 'lumitra_session=sess'));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_company');
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('answers JSON 403 sites_not_enabled when no company holds the grant', async () => {
    mockVerifySession.mockResolvedValue(ungrantedSession());

    const res = await listProjects(req('/api/projects/list', 'GET', 'lumitra_session=sess'));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('sites_not_enabled');
  });

  it('an explicit ?workspace= must be the workspace of a granted company', async () => {
    const ok = await listProjects(
      req('/api/projects/list?workspace=ws_a', 'GET', 'lumitra_session=sess; framer_company=tenant-b'),
    );
    expect(ok.status).toBe(200);
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_a', tenantGroupId: 'tg_a' });

    const ungranted = await listProjects(
      req('/api/projects/list?workspace=ws_c', 'GET', 'lumitra_session=sess'),
    );
    expect(ungranted.status).toBe(403);
    expect((await ungranted.json()).error.code).toBe('sites_not_enabled');

    const foreign = await listProjects(
      req('/api/projects/list?workspace=ws_foreign', 'GET', 'lumitra_session=sess'),
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe('no_active_company');
  });
});

// An auth-brain outage during session verify is NOT "signed out": every route
// answers JSON 503 `auth_unavailable`, never a 401 (the client would send the
// user to the login) and never an unhandled 500.
describe.each([
  ...ROUTES,
  ['GET /api/projects/list', (c: string) => listProjects(req('/api/projects/list', 'GET', c))] as const,
])('%s: auth-brain outage', (_name, call) => {
  it('answers JSON 503 auth_unavailable', async () => {
    mockVerifySession.mockRejectedValue(new AuthBrainNetworkError(new Error('ECONNREFUSED')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call('lumitra_session=sess; framer_company=tenant-a');

    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect((await res.json()).error.code).toBe('auth_unavailable');
    expect(mockCan).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a 4xx cookie rejection (not 401) is still a 401', async () => {
    mockVerifySession.mockRejectedValue(new AuthBrainError('verifySession failed: 400', 400));

    const res = await call('lumitra_session=garbage');

    expect(res.status).toBe(401);
  });
});
