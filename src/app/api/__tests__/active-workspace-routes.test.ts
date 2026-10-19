// @vitest-environment node
//
// src/app/api/__tests__/active-workspace-routes.test.ts
//
// Every editor-plane API route resolves its workspace the SAME way as the
// /projects dashboard and the project loader: the membership-checked
// `framer_ws` selector cookie, else the session's active_workspace, else its
// only workspace. Without a resolvable workspace the route answers a JSON 403
// `no_active_workspace` (never a redirect to the login, which looped forever
// on 2026-10-19). Only the auth-brain client and the data layers are mocked;
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

// Two companies, active_workspace null: the production shape of 2026-10-19.
function multiSession() {
  return {
    user: { id: 'user-m' },
    session: {},
    tenants: [
      { id: 'tenant-a', group_id: 'tg_a', name: 'Acme', slug: 'acme' },
      { id: 'tenant-b', group_id: 'tg_b', name: 'Beta', slug: 'beta' },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 'tenant-a', name: 'Acme', slug: 'acme' },
      { id: 'ws_b', tenant_id: 'tenant-b', name: 'Beta', slug: 'beta' },
    ],
    active_tenant: { id: 'tenant-b' },
    active_workspace: null,
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

describe.each(ROUTES)('%s: active workspace resolution', (_name, call) => {
  it('answers JSON 403 no_active_workspace (never a redirect) when no workspace is resolvable', async () => {
    const res = await call('lumitra_session=sess');

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect((await res.json()).error.code).toBe('no_active_workspace');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('ignores a forged framer_ws (workspace outside the session)', async () => {
    const res = await call('lumitra_session=sess; framer_ws=ws_foreign');

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_workspace');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('authorizes against the workspace framer_ws selects when the session contains it', async () => {
    const res = await call('lumitra_session=sess; framer_ws=ws_b');

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(mockCan).toHaveBeenCalledWith('user-m', expect.any(String), {
      type: 'workspace',
      id: 'ws_b',
      workspaceId: 'ws_b',
    });
  });
});

describe('GET /api/projects/list: active workspace resolution', () => {
  it('lists the framer_ws workspace when the session contains it', async () => {
    const res = await listProjects(req('/api/projects/list', 'GET', 'lumitra_session=sess; framer_ws=ws_b'));

    expect(res.status).toBe(200);
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_b', tenantGroupId: 'tg_b' });
  });

  it('answers JSON 403 no_active_workspace without a selection', async () => {
    const res = await listProjects(req('/api/projects/list', 'GET', 'lumitra_session=sess'));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_workspace');
    expect(mockListSites).not.toHaveBeenCalled();
  });

  it('an explicit ?workspace= still wins and is membership-checked', async () => {
    const ok = await listProjects(
      req('/api/projects/list?workspace=ws_a', 'GET', 'lumitra_session=sess; framer_ws=ws_b'),
    );
    expect(ok.status).toBe(200);
    expect(mockListSites).toHaveBeenCalledWith({ workspaceId: 'ws_a', tenantGroupId: 'tg_a' });

    const denied = await listProjects(
      req('/api/projects/list?workspace=ws_foreign', 'GET', 'lumitra_session=sess'),
    );
    expect(denied.status).toBe(403);
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

    const res = await call('lumitra_session=sess; framer_ws=ws_a');

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
