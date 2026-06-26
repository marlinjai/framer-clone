// @vitest-environment node
//
// src/app/api/cms/__tests__/write-routes.test.ts
//
// Unit tests for the auth-brain-guarded /api/cms COLLECTION write routes. The
// auth-brain client (verifySession + can) and the write repository are mocked;
// resolveActiveScope, cmsWriteErrorResponse, and the typed error classes are kept
// REAL, so these exercise the actual guard + scope-derivation + typed-envelope
// contract WITHOUT a database:
//   - the workspace a write lands in is derived from the SERVER session (active
//     workspace -> tenant -> tenant_group), never a client-supplied value: a
//     workspace-A session writes through getCmsWriteRepository('ws_a'),
//   - no session -> 401, a session that is not a workspace admin -> 403,
//   - a duplicate collection is a 409 `collection_exists` envelope (the
//     specific-error path, not a generic 500).
//
// Column/row writes are no longer HTTP routes (the editor grid persists them via
// the data-table server-actions adapter), so only collection routes remain here.

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

vi.mock('@/server/cms', async (importActual) => {
  const actual = await importActual<typeof import('@/server/cms')>();
  return {
    ...actual,
    getCmsWriteRepository: vi.fn(),
    getCmsRepository: vi.fn(),
  };
});

import {
  getCmsWriteRepository,
  getCmsRepository,
  CollectionExistsError,
  type CmsWriteRepository,
  type CmsReadRepository,
} from '@/server/cms';
import { POST as collectionsPOST } from '../collections/route';
import { PATCH as collectionPATCH, DELETE as collectionDELETE } from '../collections/[id]/route';

const writeMock = vi.mocked(getCmsWriteRepository);
const readMock = vi.mocked(getCmsRepository);

// A session whose active workspace is ws_a (tenant_group tg_a).
function sessionA() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', group_id: 'tg_a' }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
    active_workspace: { id: 'ws_a' },
  };
}

function installWrite(repo: Partial<CmsWriteRepository>): void {
  writeMock.mockReturnValue(repo as CmsWriteRepository);
}
function installRead(repo: Partial<CmsReadRepository>): void {
  readMock.mockReturnValue(repo as CmsReadRepository);
}

function postReq(url: string, body: unknown, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Default to a present session cookie; tests that need "no session" pass null.
  if (opts?.cookie !== null) headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
function patchReq(url: string, body: unknown, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts?.cookie !== null) headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  return new Request(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
}
function deleteReq(url: string, opts?: { cookie?: string | null }): Request {
  const headers: Record<string, string> = {};
  if (opts?.cookie !== null) headers['cookie'] = opts?.cookie ?? 'lumitra_session=good';
  return new Request(url, { method: 'DELETE', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockReset();
  mockCan.mockReset();
});

describe('POST /api/cms/collections guard', () => {
  it('returns 401 when there is no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const create = vi.fn();
    installWrite({ createCollection: create });
    const res = await collectionsPOST(
      postReq('http://t/api/cms/collections', { name: 'Events' }, { cookie: null }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(create).not.toHaveBeenCalled();
  });

  it('returns 403 when the session is valid but the user is not a workspace admin', async () => {
    mockVerifySession.mockResolvedValue(sessionA());
    mockCan.mockResolvedValue(false);
    const create = vi.fn();
    installWrite({ createCollection: create });
    const res = await collectionsPOST(postReq('http://t/api/cms/collections', { name: 'Events' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(create).not.toHaveBeenCalled();
    // The admin check uses the real editSite -> workspace.admin requirement.
    expect(mockCan).toHaveBeenCalledWith('user-a', 'workspace.admin', {
      type: 'workspace',
      id: 'ws_a',
      workspaceId: 'ws_a',
    });
  });
});

describe('POST /api/cms/collections (authorized)', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(sessionA());
    mockCan.mockResolvedValue(true);
  });

  it('creates a collection scoped to the SESSION workspace and returns 201', async () => {
    const created = { id: 'col_events', slug: 'events', name: 'Events', columns: [] };
    installWrite({ createCollection: vi.fn().mockResolvedValue(created) });
    const res = await collectionsPOST(postReq('http://t/api/cms/collections', { name: 'Events' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    // The write repo is bound to the workspace DERIVED from the session, never a
    // client-supplied value: a workspace-A session cannot write into another ws.
    expect(writeMock).toHaveBeenCalledWith('ws_a');
  });

  it('surfaces a duplicate name as a typed 409 collection_exists envelope', async () => {
    installWrite({
      createCollection: vi.fn().mockRejectedValue(new CollectionExistsError('Events')),
    });
    const res = await collectionsPOST(postReq('http://t/api/cms/collections', { name: 'Events' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('collection_exists');
  });

  it('returns 400 on an invalid body (missing name)', async () => {
    const create = vi.fn();
    installWrite({ createCollection: create });
    const res = await collectionsPOST(postReq('http://t/api/cms/collections', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('PATCH/DELETE /api/cms/collections/:id', () => {
  const params = { params: Promise.resolve({ id: 'col_events' }) };

  it('PATCH returns 401 with no session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const update = vi.fn();
    installWrite({ updateCollection: update });
    const res = await collectionPATCH(
      patchReq('http://t/api/cms/collections/col_events', { name: 'Renamed' }, { cookie: null }),
      params,
    );
    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it('PATCH renames through the SESSION-scoped repo', async () => {
    mockVerifySession.mockResolvedValue(sessionA());
    mockCan.mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue(undefined);
    installWrite({ updateCollection: update });
    installRead({
      getCollection: vi.fn().mockResolvedValue({ id: 'col_events', name: 'Renamed' }),
    });
    const res = await collectionPATCH(
      patchReq('http://t/api/cms/collections/col_events', { name: 'Renamed' }),
      params,
    );
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledWith('ws_a');
    expect(readMock).toHaveBeenCalledWith('ws_a');
    expect(update).toHaveBeenCalledWith('col_events', { name: 'Renamed', icon: undefined });
  });

  it('DELETE returns 403 when not a workspace admin', async () => {
    mockVerifySession.mockResolvedValue(sessionA());
    mockCan.mockResolvedValue(false);
    const del = vi.fn();
    installWrite({ deleteCollection: del });
    const res = await collectionDELETE(
      deleteReq('http://t/api/cms/collections/col_events'),
      params,
    );
    expect(res.status).toBe(403);
    expect(del).not.toHaveBeenCalled();
  });

  it('DELETE removes through the SESSION-scoped repo', async () => {
    mockVerifySession.mockResolvedValue(sessionA());
    mockCan.mockResolvedValue(true);
    const del = vi.fn().mockResolvedValue(undefined);
    installWrite({ deleteCollection: del });
    const res = await collectionDELETE(
      deleteReq('http://t/api/cms/collections/col_events'),
      params,
    );
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledWith('ws_a');
    expect(del).toHaveBeenCalledWith('col_events');
  });
});
