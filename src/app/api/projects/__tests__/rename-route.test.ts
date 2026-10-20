// @vitest-environment node
//
// PATCH /api/projects/<projectId> (rename). The auth-brain client and the site
// repository's Prisma client are mocked; the guard chain, scope resolution,
// name validation and the REAL SiteRepository.renameSite are exercised, so the
// workspace scoping and the concurrency precondition are tested end to end
// down to the Prisma call.

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

// An in-memory sites table behind the real repository.
type Row = { id: string; workspaceId: string; tenantGroupId: string; name: string; projectUpdatedAt: Date };
let rows: Row[] = [];
const fakePrisma = {
  site: {
    updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: { name: string } }) => {
      const hits = rows.filter(
        (r) =>
          r.id === where.id &&
          r.workspaceId === where.workspaceId &&
          r.tenantGroupId === where.tenantGroupId &&
          (where.name === undefined || r.name === where.name),
      );
      for (const r of hits) r.name = data.name;
      return { count: hits.length };
    }),
    findFirst: vi.fn(async ({ where }: { where: Partial<Row> }) => {
      const r = rows.find(
        (x) => x.id === where.id && x.workspaceId === where.workspaceId && x.tenantGroupId === where.tenantGroupId,
      );
      return r ? { name: r.name, projectUpdatedAt: r.projectUpdatedAt } : null;
    }),
  },
};

vi.mock('@/server/sites', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites')>();
  return {
    ...actual,
    getSiteRepository: () => new actual.SiteRepository(fakePrisma as never),
  };
});

import { AuthBrainError } from '@marlinjai/auth-brain-sdk';
import { PATCH } from '../[projectId]/route';

const ORIGINAL_EDITOR_HOST = process.env.EDITOR_HOST;

function makeSession() {
  return {
    user: { id: 'user-1' },
    session: {},
    tenants: [
      { id: 'tenant-1', app_grants: ['sites'], group_id: 'tg_lumitra' },
      { id: 'tenant-2', app_grants: ['sites'], group_id: 'tg_other' },
    ],
    workspaces: [
      { id: 'ws_marlin', tenant_id: 'tenant-1' },
      { id: 'ws_other', tenant_id: 'tenant-2' },
    ],
    active_tenant: { id: 'tenant-1' },
    active_workspace: { id: 'ws_marlin' },
  };
}

function patch(
  projectId: string,
  body: unknown,
  opts: { host?: string; cookie?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: opts.host ?? 'app.lumitra.co',
  };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? 'lumitra_session=good';
  const req = new Request(`http://app.lumitra.co/api/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ projectId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EDITOR_HOST = 'app.lumitra.co';
  rows = [
    { id: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra', name: 'Framer Clone Demo', projectUpdatedAt: new Date(0) },
    { id: 'site_foreign', workspaceId: 'ws_other', tenantGroupId: 'tg_other', name: 'Other company site', projectUpdatedAt: new Date(0) },
  ];
  mockVerifySession.mockResolvedValue(makeSession());
  mockCan.mockResolvedValue(true);
});

afterEach(() => {
  if (ORIGINAL_EDITOR_HOST === undefined) delete process.env.EDITOR_HOST;
  else process.env.EDITOR_HOST = ORIGINAL_EDITOR_HOST;
});

describe('PATCH /api/projects/<id> guards', () => {
  it('404s on a published-site host before reading the session', async () => {
    const res = await patch('site_1', { name: 'X' }, { host: 'www.example.com' });
    expect(res.status).toBe(404);
    expect(mockVerifySession).not.toHaveBeenCalled();
    expect(rows[0].name).toBe('Framer Clone Demo');
  });

  it('401s without a session', async () => {
    mockVerifySession.mockResolvedValue(null);
    const res = await patch('site_1', { name: 'X' }, { cookie: null });
    expect(res.status).toBe(401);
  });

  it('403s when the user is not an admin of the workspace', async () => {
    mockCan.mockResolvedValue(false);
    const res = await patch('site_1', { name: 'X' });
    expect(res.status).toBe(403);
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', expect.anything());
    expect(rows[0].name).toBe('Framer Clone Demo');
  });

  it('403s sites_not_enabled when no company has Lumitra Sites', async () => {
    const s = makeSession();
    s.tenants = s.tenants.map((t) => ({ ...t, app_grants: [] }));
    mockVerifySession.mockResolvedValue(s);
    const res = await patch('site_1', { name: 'X' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('sites_not_enabled');
  });

  it('503s authz_unavailable (never 403) when the permission service is down', async () => {
    mockCan.mockRejectedValue(new AuthBrainError('OpenFGA check failed: 503', 503));
    const res = await patch('site_1', { name: 'X' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('authz_unavailable');
  });

  it("answers 404 for another company's project, and leaves it untouched", async () => {
    const res = await patch('site_foreign', { name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
    expect(rows[1].name).toBe('Other company site');
  });

  it('answers the same 404 for a project that does not exist', async () => {
    const res = await patch('site_missing', { name: 'X' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('site_not_found');
  });
});

describe('PATCH /api/projects/<id> validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['101 characters', 'a'.repeat(101)],
    ['a line break', 'two\nlines'],
    ['a NUL character', 'a\u0000b'],
    ['a right-to-left override', 'abc\u202Edef'],
    ['only a zero-width space', '\u200B'],
    ['not a string', 42],
  ])('400s for %s and writes nothing', async (_label, name) => {
    const res = await patch('site_1', { name });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(fakePrisma.site.updateMany).not.toHaveBeenCalled();
  });

  it('400s on a body that is not JSON', async () => {
    const res = await patch('site_1', '{nope');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_json');
  });
});

describe('PATCH /api/projects/<id> rename', () => {
  it('renames, trimmed, and answers the stored name', async () => {
    const res = await patch('site_1', { name: '  Bäckerei Müller  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ siteId: 'site_1', name: 'Bäckerei Müller' });
    expect(rows[0].name).toBe('Bäckerei Müller');
  });

  it('accepts exactly 100 characters', async () => {
    const res = await patch('site_1', { name: 'n'.repeat(100) });
    expect(res.status).toBe(200);
  });

  it('two concurrent renames from the same old name: one wins, the other gets 409 with the winner', async () => {
    const [a, b] = await Promise.all([
      patch('site_1', { name: 'Tab A', expectedName: 'Framer Clone Demo' }),
      patch('site_1', { name: 'Tab B', expectedName: 'Framer Clone Demo' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const body = await loser.json();
    expect(body.error.code).toBe('name_conflict');
    expect(body.error.currentName).toBe(rows[0].name);
    expect(['Tab A', 'Tab B']).toContain(rows[0].name);
  });

  it('a stored name longer than today\'s limit still works as expectedName', async () => {
    rows[0].name = 'L'.repeat(1500);
    const res = await patch('site_1', { name: 'Short again', expectedName: 'L'.repeat(1500) });
    expect(res.status).toBe(200);
    expect(rows[0].name).toBe('Short again');
  });

  it('without expectedName the last write wins', async () => {
    await patch('site_1', { name: 'First' });
    const res = await patch('site_1', { name: 'Second' });
    expect(res.status).toBe(200);
    expect(rows[0].name).toBe('Second');
  });
});
