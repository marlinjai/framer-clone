// @vitest-environment node
//
// src/app/api/cms/__tests__/routes.test.ts
//
// Unit tests for the four /api/cms READ route handlers and the two-plane read
// scope behind them (src/server/cms/readScope.ts). No database is touched:
//   - the auth-brain client (verifySession + can) is faked, so the REAL
//     getVerifiedSession / resolveActiveScope / checkWorkspaceAccess run,
//   - the published-site resolver is faked (host -> site),
//   - getCmsRepository is replaced by an in-memory, PER-WORKSPACE fake that only
//     sees its own workspace's collections, mirroring the real repository's
//     isolation (proved against the real code in repository.workspace.test.ts).
// What is pinned here is WHICH workspace each request reads:
//   - editor host: the active company's workspace, 401 without a session, 403
//     without the `sites` grant, a chosen company or `viewSite`, 503 when
//     auth-brain or OpenFGA cannot answer,
//   - published-site host: the Host's site workspace, never the session,
//   - any other host: 404,
//   - a foreign collection / row id: the same 404 as a missing one,
// plus the existing success shapes, the bad_query 400 and the error envelopes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CmsReadRepository } from '@/server/cms';

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

const mockPublishedSite = vi.fn();
vi.mock('@/server/sites/cachedResolver', () => ({
  getCachedPublishedSite: (...args: unknown[]) => mockPublishedSite(...args),
}));

vi.mock('@/server/cms/repository', () => ({
  getCmsRepository: vi.fn(),
  getCmsWriteRepository: vi.fn(),
}));

import { getCmsRepository } from '@/server/cms/repository';
import { GET as collectionsGET } from '../collections/route';
import { GET as collectionGET } from '../collections/[id]/route';
import { GET as rowsGET } from '../collections/[id]/rows/route';
import { GET as rowGET } from '../collections/[id]/rows/[rowId]/route';

const getCmsRepositoryMock = vi.mocked(getCmsRepository);

const EDITOR_HOST = 'app.lumitra.co';
const SITE_A_HOST = 'alpha.sites.lumitra.co';

const COLLECTION_A = {
  id: 'col_a',
  slug: 'posts',
  name: 'Posts A',
  columns: [{ id: 'title', name: 'Title', type: 'text' as const }],
};
const COLLECTION_B = {
  id: 'col_b',
  slug: 'drafts',
  name: 'Secret drafts B',
  columns: [{ id: 'title', name: 'Title', type: 'text' as const }],
};
const ROW_A = { id: 'row_a', values: { title: 'Hello from A' } };
const ROW_B = { id: 'row_b', values: { title: 'Unreleased B' } };

// workspace -> its collections and their rows.
const DATA: Record<string, { collection: typeof COLLECTION_A; rows: (typeof ROW_A)[] }[]> = {
  ws_a: [{ collection: COLLECTION_A, rows: [ROW_A] }],
  ws_b: [{ collection: COLLECTION_B, rows: [ROW_B] }],
};

// A per-workspace fake: a collection or row outside the bound workspace is
// "not found" (null / empty page), exactly like the real repository.
function fakeRepoFor(workspaceId: string): CmsReadRepository {
  const own = DATA[workspaceId] ?? [];
  const find = (id: string) => own.find((e) => e.collection.id === id);
  return {
    listCollections: vi.fn(async () => own.map((e) => e.collection)),
    getCollection: vi.fn(async (id: string) => find(id)?.collection ?? null),
    listRows: vi.fn(async (id: string) => {
      const entry = find(id);
      return entry ? { rows: entry.rows, total: entry.rows.length } : { rows: [], total: 0 };
    }),
    getRow: vi.fn(async (id: string, rowId: string) =>
      find(id)?.rows.find((r) => r.id === rowId) ?? null,
    ),
  };
}

function sessionFor(workspaceId: string) {
  return {
    user: { id: `user-${workspaceId}` },
    session: {},
    tenants: [{ id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_1' }],
    workspaces: [{ id: workspaceId, tenant_id: 'tenant-1' }],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: workspaceId },
  };
}

function req(
  host: string,
  path: string,
  opts: { cookie?: string | null } = {},
): Request {
  const headers: Record<string, string> = { host };
  // Default to a present session cookie; "no session" tests pass null.
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? 'lumitra_session=good';
  return new Request(`http://${host}${path}`, { headers });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}
function rowParams(id: string, rowId: string) {
  return { params: Promise.resolve({ id, rowId }) };
}

async function codeOf(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

beforeEach(() => {
  vi.stubEnv('EDITOR_HOST', EDITOR_HOST);
  mockVerifySession.mockReset();
  mockCan.mockReset();
  mockPublishedSite.mockReset();
  getCmsRepositoryMock.mockReset();
  getCmsRepositoryMock.mockImplementation((ws?: string) => fakeRepoFor(ws ?? 'framer-clone'));
  // Default: no published site for any host.
  mockPublishedSite.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// =============================================================================
// published-site plane
// =============================================================================

describe('published-site host (tenancy from the Host, never the session)', () => {
  beforeEach(() => {
    mockPublishedSite.mockImplementation(async (host: string) =>
      host === SITE_A_HOST ? { siteId: 'site_a', workspaceId: 'ws_a' } : null,
    );
  });

  it('lists only the collections of the Host site\'s workspace', async () => {
    const res = await collectionsGET(req(SITE_A_HOST, '/api/cms/collections'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([COLLECTION_A]);
    expect(getCmsRepositoryMock).toHaveBeenCalledWith('ws_a');
  });

  it('reads its own collection, rows and row', async () => {
    const col = await collectionGET(req(SITE_A_HOST, '/api/cms/collections/col_a'), idParams('col_a'));
    expect(col.status).toBe(200);
    expect(await col.json()).toEqual(COLLECTION_A);

    const rows = await rowsGET(req(SITE_A_HOST, '/api/cms/collections/col_a/rows'), idParams('col_a'));
    expect(rows.status).toBe(200);
    expect(await rows.json()).toEqual({ rows: [ROW_A], total: 1 });

    const row = await rowGET(
      req(SITE_A_HOST, '/api/cms/collections/col_a/rows/row_a'),
      rowParams('col_a', 'row_a'),
    );
    expect(row.status).toBe(200);
    expect(await row.json()).toEqual(ROW_A);
  });

  it('answers 404 for another workspace\'s collection, rows and row (no existence leak)', async () => {
    const col = await collectionGET(req(SITE_A_HOST, '/api/cms/collections/col_b'), idParams('col_b'));
    expect(col.status).toBe(404);
    expect(await codeOf(col)).toBe('not_found');

    const rows = await rowsGET(req(SITE_A_HOST, '/api/cms/collections/col_b/rows'), idParams('col_b'));
    expect(rows.status).toBe(404);
    expect(await codeOf(rows)).toBe('not_found');

    const row = await rowGET(
      req(SITE_A_HOST, '/api/cms/collections/col_b/rows/row_b'),
      rowParams('col_b', 'row_b'),
    );
    expect(row.status).toBe(404);
    expect(await codeOf(row)).toBe('not_found');

    // The foreign workspace was never even bound.
    expect(getCmsRepositoryMock).not.toHaveBeenCalledWith('ws_b');
  });

  it('never reads the session, even when a valid editor session for another workspace is sent', async () => {
    // The apex `.lumitra.co` cookie reaches *.sites.lumitra.co; it must not
    // widen the read to the visitor's own workspace.
    mockVerifySession.mockResolvedValue(sessionFor('ws_b'));
    mockCan.mockResolvedValue(true);

    const list = await collectionsGET(req(SITE_A_HOST, '/api/cms/collections'));
    expect(await list.json()).toEqual([COLLECTION_A]);

    const foreign = await collectionGET(
      req(SITE_A_HOST, '/api/cms/collections/col_b'),
      idParams('col_b'),
    );
    expect(foreign.status).toBe(404);

    expect(mockVerifySession).not.toHaveBeenCalled();
    expect(mockCan).not.toHaveBeenCalled();
    expect(getCmsRepositoryMock).not.toHaveBeenCalledWith('ws_b');
  });
});

describe('unknown host (neither the editor nor a published site)', () => {
  it('answers 404 on every read route and binds no repository', async () => {
    const host = 'nobody.sites.lumitra.co';
    const responses = [
      await collectionsGET(req(host, '/api/cms/collections')),
      await collectionGET(req(host, '/api/cms/collections/col_a'), idParams('col_a')),
      await rowsGET(req(host, '/api/cms/collections/col_a/rows'), idParams('col_a')),
      await rowGET(req(host, '/api/cms/collections/col_a/rows/row_a'), rowParams('col_a', 'row_a')),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await codeOf(res)).toBe('not_found');
    }
    expect(getCmsRepositoryMock).not.toHaveBeenCalled();
    expect(mockVerifySession).not.toHaveBeenCalled();
  });
});

// =============================================================================
// editor plane
// =============================================================================

describe('editor host without a valid session', () => {
  it('answers 401 on every read route when no session cookie is sent', async () => {
    const responses = [
      await collectionsGET(req(EDITOR_HOST, '/api/cms/collections', { cookie: null })),
      await collectionGET(
        req(EDITOR_HOST, '/api/cms/collections/col_a', { cookie: null }),
        idParams('col_a'),
      ),
      await rowsGET(
        req(EDITOR_HOST, '/api/cms/collections/col_a/rows', { cookie: null }),
        idParams('col_a'),
      ),
      await rowGET(
        req(EDITOR_HOST, '/api/cms/collections/col_a/rows/row_a', { cookie: null }),
        rowParams('col_a', 'row_a'),
      ),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe('unauthorized');
    }
    expect(getCmsRepositoryMock).not.toHaveBeenCalled();
  });

  it('answers 401 when the session cookie does not verify', async () => {
    mockVerifySession.mockResolvedValue(null);
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(401);
    expect(getCmsRepositoryMock).not.toHaveBeenCalled();
  });

  it('answers 503 auth_unavailable when auth-brain cannot answer (never a 401)', async () => {
    mockVerifySession.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('auth_unavailable');
  });
});

describe('editor host with a session', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(sessionFor('ws_a'));
    mockCan.mockResolvedValue(true);
  });

  it('lists only the active workspace\'s collections, checking viewSite on it', async () => {
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([COLLECTION_A]);
    expect(getCmsRepositoryMock).toHaveBeenCalledWith('ws_a');
    expect(mockCan).toHaveBeenCalledWith(
      'user-ws_a',
      expect.any(String),
      expect.objectContaining({ type: 'workspace', id: 'ws_a' }),
    );
  });

  it('reads the active workspace\'s collection, rows and row', async () => {
    const col = await collectionGET(req(EDITOR_HOST, '/api/cms/collections/col_a'), idParams('col_a'));
    expect(col.status).toBe(200);
    expect(await col.json()).toEqual(COLLECTION_A);
    const rows = await rowsGET(req(EDITOR_HOST, '/api/cms/collections/col_a/rows'), idParams('col_a'));
    expect(await rows.json()).toEqual({ rows: [ROW_A], total: 1 });
    const row = await rowGET(
      req(EDITOR_HOST, '/api/cms/collections/col_a/rows/row_a'),
      rowParams('col_a', 'row_a'),
    );
    expect(await row.json()).toEqual(ROW_A);
  });

  it('answers 404 for a collection or row of a workspace the session is not acting in', async () => {
    const col = await collectionGET(req(EDITOR_HOST, '/api/cms/collections/col_b'), idParams('col_b'));
    expect(col.status).toBe(404);
    const rows = await rowsGET(req(EDITOR_HOST, '/api/cms/collections/col_b/rows'), idParams('col_b'));
    expect(rows.status).toBe(404);
    const row = await rowGET(
      req(EDITOR_HOST, '/api/cms/collections/col_b/rows/row_b'),
      rowParams('col_b', 'row_b'),
    );
    expect(row.status).toBe(404);
    expect(getCmsRepositoryMock).not.toHaveBeenCalledWith('ws_b');
  });

  it('ignores forged company / workspace selectors for a company outside the session', async () => {
    const res = await collectionsGET(
      req(EDITOR_HOST, '/api/cms/collections', {
        cookie: 'lumitra_session=good; framer_company=tenant-b; framer_ws=ws_b',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([COLLECTION_A]);
    expect(getCmsRepositoryMock).not.toHaveBeenCalledWith('ws_b');
  });

  it('answers 403 forbidden when the session lacks viewSite on the active workspace', async () => {
    mockCan.mockResolvedValue(false);
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('forbidden');
    expect(getCmsRepositoryMock).not.toHaveBeenCalled();
  });

  it('answers 403 no_active_company when several granted companies exist and none is picked', async () => {
    mockVerifySession.mockResolvedValue({
      ...sessionFor('ws_a'),
      tenants: [
        { id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_1' },
        { id: 'tenant-2', app_grants: ['sites'], group_id: 'tg_2' },
      ],
      workspaces: [
        { id: 'ws_a', tenant_id: 'tenant-1' },
        { id: 'ws_c', tenant_id: 'tenant-2' },
      ],
      active_tenant: null,
      active_workspace: null,
    });
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('no_active_company');
    expect(getCmsRepositoryMock).not.toHaveBeenCalled();
  });

  it('answers 403 sites_not_enabled when no company of the session holds the sites grant', async () => {
    mockVerifySession.mockResolvedValue({
      ...sessionFor('ws_a'),
      tenants: [{ id: 'tenant-1', app_grants: [], group_id: 'tg_1' }],
    });
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('sites_not_enabled');
    expect(getCmsRepositoryMock).not.toHaveBeenCalled();
  });

  it('answers 503 authz_unavailable when OpenFGA cannot answer (never a 403)', async () => {
    const { AuthzUnavailableError } = await import('@/lib/authBrainAvailability');
    mockCan.mockRejectedValue(new AuthzUnavailableError(new Error('openfga down')));
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('authz_unavailable');
  });
});

// =============================================================================
// route mechanics (editor host, authorized)
// =============================================================================

describe('route mechanics', () => {
  beforeEach(() => {
    mockVerifySession.mockResolvedValue(sessionFor('ws_a'));
    mockCan.mockResolvedValue(true);
  });

  function installRepo(repo: Partial<CmsReadRepository>): void {
    getCmsRepositoryMock.mockReturnValue(repo as CmsReadRepository);
  }

  it('surfaces a listCollections throw as a 5xx envelope (never an empty 200)', async () => {
    installRepo({ listCollections: vi.fn().mockRejectedValue(new Error('db down')) });
    const res = await collectionsGET(req(EDITOR_HOST, '/api/cms/collections'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'cms_read_failed', message: 'db down' } });
  });

  it('surfaces a getCollection throw as a 5xx envelope', async () => {
    installRepo({ getCollection: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await collectionGET(req(EDITOR_HOST, '/api/cms/collections/col_a'), idParams('col_a'));
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe('cms_read_failed');
  });

  it('decodes the JSON query search param and forwards it to listRows', async () => {
    const listRows = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    installRepo({ getCollection: vi.fn().mockResolvedValue(COLLECTION_A), listRows });
    const query = {
      filter: [{ column: 'title', op: 'contains', value: 'x' }],
      sort: [{ column: 'title', direction: 'asc' }],
      limit: 5,
    };
    const res = await rowsGET(
      req(
        EDITOR_HOST,
        `/api/cms/collections/col_a/rows?query=${encodeURIComponent(JSON.stringify(query))}`,
      ),
      idParams('col_a'),
    );
    expect(res.status).toBe(200);
    expect(listRows).toHaveBeenCalledWith('col_a', query);
  });

  it('returns a 400 envelope on an unparseable query param, before any read', async () => {
    const listRows = vi.fn();
    installRepo({ getCollection: vi.fn().mockResolvedValue(COLLECTION_A), listRows });
    const res = await rowsGET(
      req(EDITOR_HOST, '/api/cms/collections/col_a/rows?query=%7Bnot-json'),
      idParams('col_a'),
    );
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('bad_query');
    expect(listRows).not.toHaveBeenCalled();
  });

  it('surfaces a listRows throw as a 5xx envelope', async () => {
    installRepo({
      getCollection: vi.fn().mockResolvedValue(COLLECTION_A),
      listRows: vi.fn().mockRejectedValue(new Error('bad cursor')),
    });
    const res = await rowsGET(req(EDITOR_HOST, '/api/cms/collections/col_a/rows'), idParams('col_a'));
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe('cms_read_failed');
  });

  it('surfaces a getRow throw as a 5xx envelope', async () => {
    installRepo({ getRow: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await rowGET(
      req(EDITOR_HOST, '/api/cms/collections/col_a/rows/row_a'),
      rowParams('col_a', 'row_a'),
    );
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe('cms_read_failed');
  });
});
