// @vitest-environment node
//
// src/app/api/books/__tests__/guard.test.ts
//
// The guard chain every /api/books route runs (src/server/books/http/route.ts),
// exercised through real route handlers with only the auth-brain client, the
// tenant database handle and the repository mocked:
//   - no session 401; auth-brain down 503 auth_unavailable;
//   - no company with `sites` 403 sites_not_enabled; several and none chosen
//     403 no_active_company;
//   - the active company without the `books` grant 403 books_not_enabled,
//     even when another company of the session holds it;
//   - OpenFGA deny 403 forbidden, OpenFGA down 503 authz_unavailable;
//   - a published-site host 404 before the session is read;
//   - the tenant group not provisioned 404 books_not_provisioned;
//   - the scope handed to the repository is the ACTIVE company and ITS tenant
//     group, never anything the client sent;
//   - a BooksError maps to its status (404 for another company's id).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifySession = vi.fn();
const mockCan = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...a: unknown[]) => mockVerifySession(...a),
    can: (...a: unknown[]) => mockCan(...a),
  },
}));

const mockDbChecked = vi.fn();
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: (...a: unknown[]) => mockDbChecked(...a),
  isCommerceTenantNotProvisioned: (err: unknown) =>
    (err as { code?: string })?.code === 'COMMERCE_TENANT_NOT_PROVISIONED',
}));

const mockListDocuments = vi.fn();
const mockGetDocument = vi.fn();
vi.mock('@/server/books/repository/read', async (importActual) => ({
  ...(await importActual<typeof import('@/server/books/repository/read')>()),
  listDocuments: (...a: unknown[]) => mockListDocuments(...a),
  getDocument: (...a: unknown[]) => mockGetDocument(...a),
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({
    recipients: { getContact: vi.fn() },
    contactBook: { search: vi.fn(), getMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
  }),
}));

import { AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';
import { BooksError } from '@/server/books/errors';
import { GET as listDocumentsRoute } from '../documents/route';
import { GET as getDocumentRoute } from '../documents/[id]/route';

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';
const TG_A = '0190a000-0000-7000-8000-0000000000fa';
const TG_B = '0190a000-0000-7000-8000-0000000000fb';

function session(grantsA: string[], grantsB: string[] = ['sites'], active: string | null = A) {
  return {
    user: { id: 'user-1' },
    session: {},
    tenants: [
      { id: A, app_grants: grantsA, group_id: TG_A, name: 'Alpha', slug: 'alpha' },
      { id: B, app_grants: grantsB, group_id: TG_B, name: 'Beta', slug: 'beta' },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: A, name: 'Main', slug: 'main' },
      { id: 'ws_b', tenant_id: B, name: 'Main', slug: 'main' },
    ],
    active_tenant: active ? { id: active } : null,
    active_workspace: null,
  };
}

function req(path: string, opts: { host?: string; cookie?: string } = {}): Request {
  return new Request(`http://${opts.host ?? 'localhost:3000'}${path}`, {
    headers: { host: opts.host ?? 'localhost:3000', cookie: opts.cookie ?? 'lumitra_session=s' },
  });
}

const list = () => listDocumentsRoute(req('/api/books/documents'), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EDITOR_HOST;
  mockCan.mockResolvedValue(true);
  mockDbChecked.mockImplementation(async (tg: string) => ({ __tg: tg }));
  mockListDocuments.mockResolvedValue({ items: [], nextCursor: null });
});

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('Books guard', () => {
  it('401 without a session cookie, and when the session is invalid', async () => {
    const res = await listDocumentsRoute(req('/api/books/documents', { cookie: '' }), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
    mockVerifySession.mockResolvedValue(null);
    expect((await list()).status).toBe(401);
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('503 auth_unavailable when auth-brain cannot answer', async () => {
    mockVerifySession.mockRejectedValue(new AuthBrainNetworkError('down'));
    const res = await list();
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('auth_unavailable');
  });

  it('403 sites_not_enabled when no company holds sites', async () => {
    mockVerifySession.mockResolvedValue(session(['books'], ['books']));
    const res = await list();
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('sites_not_enabled');
  });

  it('403 no_active_company with several companies and none chosen', async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books'], ['sites', 'books'], null));
    const res = await list();
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('no_active_company');
  });

  it('403 books_not_enabled when the ACTIVE company lacks books, even if another has it', async () => {
    mockVerifySession.mockResolvedValue(session(['sites'], ['sites', 'books'], A));
    const res = await list();
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('books_not_enabled');
    expect(mockCan).not.toHaveBeenCalled();
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('a tenant entry without app_grants fails closed', async () => {
    const s = session(['sites', 'books']);
    mockVerifySession.mockResolvedValue({ ...s, tenants: [{ ...s.tenants[0], app_grants: undefined }, s.tenants[1]] });
    const res = await list();
    expect(res.status).toBe(403);
  });

  it('403 forbidden on an OpenFGA deny; 503 authz_unavailable when OpenFGA is down', async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books']));
    mockCan.mockResolvedValue(false);
    const denied = await list();
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('forbidden');
    mockCan.mockRejectedValue(new Error('openfga down'));
    const down = await list();
    expect(down.status).toBe(503);
    expect(await code(down)).toBe('authz_unavailable');
  });

  it('checks viewBooks (workspace.admin) on the active company workspace', async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books']));
    await list();
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', expect.objectContaining({ id: 'ws_a' }));
  });

  it('404 on a published-site host before the session is read', async () => {
    process.env.EDITOR_HOST = 'app.example.test';
    const res = await listDocumentsRoute(req('/api/books/documents', { host: 'shop.example.test' }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(404);
    expect(mockVerifySession).not.toHaveBeenCalled();
  });

  it('404 books_not_provisioned when the tenant group has no schema', async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books']));
    mockDbChecked.mockRejectedValue(Object.assign(new Error('no schema'), { code: 'COMMERCE_TENANT_NOT_PROVISIONED' }));
    const res = await list();
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('books_not_provisioned');
  });

  it('scopes the repository to the active company and its own tenant group', async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books'], ['sites', 'books'], A));
    const res = await listDocumentsRoute(
      req('/api/books/documents', { cookie: `lumitra_session=s; framer_company=${B}` }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    expect(mockDbChecked).toHaveBeenCalledWith(TG_B);
    const scope = mockListDocuments.mock.calls[0][0] as { tenantId: string; tgId: string };
    expect(scope.tenantId).toBe(B);
    expect(scope.tgId).toBe(TG_B);
  });

  it("another company's document is a 404, never a 403", async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books']));
    mockGetDocument.mockRejectedValue(new BooksError('NOT_FOUND', 'NOT_FOUND: document'));
    const res = await getDocumentRoute(req('/api/books/documents/x'), { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('not_found');
  });

  it('an unexpected error is a logged 500, not a swallowed success', async () => {
    mockVerifySession.mockResolvedValue(session(['sites', 'books']));
    mockListDocuments.mockRejectedValue(new Error('database exploded'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await list();
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
