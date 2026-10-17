// @vitest-environment node
//
// src/app/api/projects/__tests__/create-route.test.ts
//
// Unit tests for POST /api/projects (the server create path). The auth-brain
// client (verifySession + can) and the site repository are mocked, so these
// assert the REAL guard + scope-resolution contract without a database:
//   - the scope is derived from the SERVER session (active workspace -> tenant
//     -> tenant_group), never from the client body,
//   - the site id is minted SERVER-SIDE (a fresh uuid), never client-supplied,
//   - the persisted snapshot is a minimal draft: exactly one `slug: ''` home
//     page and NO explicit status (so saveProject's create-path defaults it to
//     `draft`),
//   - 401 with no session, 403 when no active workspace / not an admin, 400 on a
//     malformed body,
//   - the company's commerce schema is provisioned BEFORE the site row is
//     written, and a missing owner URL or a failing provision is a 500 with a
//     named code, a server log line, and nothing persisted.
// resolveActiveScope and the typed error mapping are kept REAL (only
// getSiteRepository is mocked) so the actual scope/error wiring is exercised.

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

const mockProvision = vi.fn();
vi.mock('@/server/commerce/provisioning/provision', () => ({
  provisionCommerceTenant: (...args: unknown[]) => mockProvision(...args),
}));

import { getSiteRepository } from '@/server/sites';
import { POST } from '../route';

const getRepoMock = vi.mocked(getSiteRepository);

const SCOPE = { workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeSession() {
  return {
    user: { id: 'user-1' },
    session: {},
    tenants: [{ id: 'tenant-1', group_id: 'tg_lumitra' }],
    workspaces: [{ id: 'ws_marlin', tenant_id: 'tenant-1' }],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: 'ws_marlin' },
  };
}

// A session that authenticates but has no resolvable active workspace, so
// resolveActiveScope (kept real) fails -> 403.
function makeSessionNoWorkspace() {
  return {
    user: { id: 'user-1' },
    session: {},
    tenants: [],
    workspaces: [],
    active_tenant: null,
    active_workspace: null,
  };
}

function createReq(body?: unknown, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts?.cookie !== null) {
    headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  }
  return new Request('http://t/api/projects', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function installRepo(repo: { saveProject?: unknown }) {
  getRepoMock.mockReturnValue(repo as ReturnType<typeof getSiteRepository>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockReset();
  mockCan.mockReset();
});

describe('POST /api/projects guard', () => {
  it('401s when there is no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const save = vi.fn();
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'x' }, { cookie: null }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(save).not.toHaveBeenCalled();
  });

  it('403s when the session has no resolvable active workspace', async () => {
    mockVerifySession.mockResolvedValue(makeSessionNoWorkspace());
    const save = vi.fn();
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'x' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('no_active_workspace');
    expect(save).not.toHaveBeenCalled();
  });

  it('403s when the session is valid but the user is not a workspace admin', async () => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(false);
    const save = vi.fn();
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'x' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(save).not.toHaveBeenCalled();
    // editSite maps to the same workspace.admin requirement as publishSite.
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', {
      type: 'workspace',
      id: 'ws_marlin',
      workspaceId: 'ws_marlin',
    });
  });
});

describe('POST /api/projects (authorized)', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(makeSession());
    mockCan.mockResolvedValue(true);
    mockProvision.mockReset();
    mockProvision.mockResolvedValue({ schema: 'tg_x', applied: [] });
    vi.stubEnv('COMMERCE_OWNER_DATABASE_URL', 'postgresql://commerce_ddl@db:5432/app');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('provisions the company commerce schema BEFORE writing the site row', async () => {
    const order: string[] = [];
    mockProvision.mockImplementation(async () => {
      order.push('provision');
      return { schema: 'tg_x', applied: [] };
    });
    const save = vi.fn(async () => {
      order.push('save');
    });
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'Shop' }));

    expect(res.status).toBe(200);
    expect(mockProvision).toHaveBeenCalledWith({ tenantGroupId: 'tg_lumitra', slug: 'tg_lumitra' });
    expect(order).toEqual(['provision', 'save']);
  });

  it('500s with commerce_not_configured, logs, and writes nothing when the owner URL is unset', async () => {
    vi.stubEnv('COMMERCE_OWNER_DATABASE_URL', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn();
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'Shop' }));

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_not_configured');
    expect(save).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/COMMERCE_OWNER_DATABASE_URL is not set/));
    errorSpy.mockRestore();
  });

  it('500s with commerce_provision_failed, logs the cause, and writes nothing when provisioning throws', async () => {
    const cause = new Error('connect ECONNREFUSED');
    mockProvision.mockRejectedValue(cause);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn();
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'Shop' }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe('commerce_provision_failed');
    // The cause stays in the server log, not the response.
    expect(json.error.message).not.toMatch(/ECONNREFUSED/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/provisionCommerceTenant failed/), cause);
    expect(save).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('mints a server-side id and persists a minimal draft home page under the session scope', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 'My Site' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.siteId).toMatch(UUID_RE);

    // Scope comes from the SERVER session, not the body.
    expect(save).toHaveBeenCalledTimes(1);
    const [scopeArg, snapshotArg] = save.mock.calls[0];
    expect(scopeArg).toEqual(SCOPE);

    // The persisted snapshot's id is the freshly-minted uuid returned to the
    // caller — the client never supplied it.
    expect(snapshotArg.id).toBe(json.siteId);
    expect(snapshotArg.metadata.title).toBe('My Site');

    // Exactly ONE page, the home page (slug: '').
    const pages = Object.values(snapshotArg.pages) as Array<{ slug: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].slug).toBe('');

    // No explicit status: saveProject's create-path defaults the DB row to draft.
    expect(snapshotArg.status).toBeUndefined();
  });

  it('defaults the name to "Untitled Project" when the body is empty', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save });

    const res = await POST(createReq());

    expect(res.status).toBe(200);
    const snapshotArg = save.mock.calls[0][1];
    expect(snapshotArg.metadata.title).toBe('Untitled Project');
  });

  it('mints a DIFFERENT id on each create', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    installRepo({ saveProject: save });

    const a = await (await POST(createReq({ name: 'a' }))).json();
    const b = await (await POST(createReq({ name: 'b' }))).json();

    expect(a.siteId).not.toBe(b.siteId);
  });

  it('400s on a malformed body (name not a string)', async () => {
    const save = vi.fn();
    installRepo({ saveProject: save });

    const res = await POST(createReq({ name: 123 }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(save).not.toHaveBeenCalled();
  });
});
