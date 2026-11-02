// src/lib/__tests__/auth-machine.itest.ts
//
// The machine door against a REAL Postgres and the REAL create route. Only the
// two outside services are mocked: auth-brain (verifyApiKey and verifySession,
// through the shared client) and OpenFGA (its read endpoint, through fetch).
// The chain under test:
//
//   Bearer key -> verifyCompanyKey -> OpenFGA structure read -> resolveScopeForKey
//     -> the site repository, scoped to the key's company only
//
// and, on a real authoring route, that a request carrying a bearer is never
// authenticated by the session cookie that came along.
//
// Runs only under `pnpm test:integration` (Dockerized Postgres).

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const fakeCredential = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const fakeKey = () => fakeCredential(['sk', 'live'].join('_'));

const KEY_A = fakeKey();
const KEY_B = fakeKey();
const GROUP_A = '018f9c10-0000-7000-8000-0000000000c1';
const GROUP_B = '018f9c10-0000-7000-8000-0000000000d1';

function verified(tenant: string, keyId: string) {
  return {
    principal: {
      type: 'service_account',
      id: `sa-${tenant}`,
      scope: { type: 'tenant', id: tenant, slug: tenant, app_grants: ['sites'] },
      role: 'admin',
    },
    key: { id: keyId, name: 'agent', expires_at: null },
    effective_roles: { tenant_groups: [], tenants: [{ id: tenant, role: 'admin', source: 'direct' }], workspaces: [] },
  };
}

const SESSION_A = {
  user: { id: 'user-a' },
  session: {},
  tenants: [{ id: 'mk-tenant-a', app_grants: ['sites'], group_id: GROUP_A }],
  workspaces: [{ id: 'mk_ws_a', tenant_id: 'mk-tenant-a' }],
  active_tenant: { id: 'mk-tenant-a' },
  active_workspace: { id: 'mk_ws_a' },
};

const SESSION_B = {
  user: { id: 'user-b' },
  session: {},
  tenants: [{ id: 'mk-tenant-b', app_grants: ['sites'], group_id: GROUP_B }],
  workspaces: [{ id: 'mk_ws_b', tenant_id: 'mk-tenant-b' }],
  active_tenant: { id: 'mk-tenant-b' },
  active_workspace: { id: 'mk_ws_b' },
};

const mockVerifySession = vi.fn(async (cookie: string) =>
  cookie === 'sess_a' ? SESSION_A : cookie === 'sess_b' ? SESSION_B : null,
);
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (cookie: string) => mockVerifySession(cookie),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));
vi.mock('@/lib/auth-brain-machine', () => ({
  machineAuthBrainClient: {
    verifyApiKey: vi.fn(async (key: string) => {
      if (key === KEY_A) return verified('mk-tenant-a', 'key-a');
      if (key === KEY_B) return verified('mk-tenant-b', 'key-b');
      return null;
    }),
  },
}));

import { getPrismaClient } from '@/server/db';
import { getSiteRepository, SiteNotFoundError } from '@/server/sites';
import { clearKeyCache, verifyCompanyKey, type CompanyKey } from '@/lib/auth-machine';
import { POST as createProject } from '@/app/api/projects/route';

// OpenFGA's structural edges for the two companies.
const STRUCTURE: Record<string, { group: string; workspace: string }> = {
  'mk-tenant-a': { group: GROUP_A, workspace: 'mk_ws_a' },
  'mk-tenant-b': { group: GROUP_B, workspace: 'mk_ws_b' },
};

const realFetch = globalThis.fetch;
const savedEnv = {
  url: process.env.OPENFGA_API_URL,
  store: process.env.OPENFGA_STORE_ID,
  owner: process.env.COMMERCE_OWNER_DATABASE_URL,
};
let prisma: PrismaClient;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  prisma = getPrismaClient();
  process.env.OPENFGA_API_URL = 'http://openfga.itest';
  process.env.OPENFGA_STORE_ID = 'store-itest';
  // The create route provisions the company's commerce schema on the OWNER
  // connection; the container superuser plays the owner here (as in
  // create-route.itest.ts).
  process.env.COMMERCE_OWNER_DATABASE_URL = process.env.DATABASE_URL;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('http://openfga.itest/')) return realFetch(input, init);
    const key = JSON.parse(String(init?.body)).tuple_key as { user?: string; relation?: string; object?: string };
    const tenant = (key.relation === 'group' ? key.object : key.user)?.replace(/^tenant:/, '') ?? '';
    const s = STRUCTURE[tenant];
    const tuples = !s
      ? []
      : key.relation === 'group'
        ? [{ key: { user: `tenant_group:${s.group}`, relation: 'group', object: `tenant:${tenant}` } }]
        : [{ key: { user: `tenant:${tenant}`, relation: 'tenant', object: `workspace:${s.workspace}` } }];
    return Response.json({ tuples, continuation_token: '' });
  }) as typeof fetch;
  clearKeyCache();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  restore('OPENFGA_API_URL', savedEnv.url);
  restore('OPENFGA_STORE_ID', savedEnv.store);
  restore('COMMERCE_OWNER_DATABASE_URL', savedEnv.owner);
  await prisma.site.deleteMany({ where: { workspaceId: { in: ['mk_ws_a', 'mk_ws_b'] } } });
  await prisma.$disconnect();
});

function bearer(key: string, extra: Record<string, string> = {}): Request {
  return new Request('http://t/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, ...extra } });
}

function createAs(cookie: string, name: string): Request {
  return new Request('http://t/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `lumitra_session=${cookie}` },
    body: JSON.stringify({ name }),
  });
}

function asKey(result: CompanyKey) {
  if (result.kind !== 'key') throw new Error(`expected a verified key, got ${result.kind}`);
  return result;
}

describe('the machine door (integration)', () => {
  it('scopes each company key to exactly the sites its company made in the editor, never another company', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // Each company's person creates a site through the real create route (the session scope).
      const resA = await createProject(createAs('sess_a', 'Company A site'));
      const resB = await createProject(createAs('sess_b', 'Company B site'));
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const { siteId: idA } = (await resA.json()) as { siteId: string };
      const { siteId: idB } = (await resB.json()) as { siteId: string };

      // Each company's key resolves to the same scope its session had; a header naming the
      // other company's workspace changes nothing.
      const keyA = asKey(await verifyCompanyKey(bearer(KEY_A)));
      const keyB = asKey(await verifyCompanyKey(bearer(KEY_B, { 'x-workspace-id': 'mk_ws_a' })));
      expect(keyA.scope).toEqual({ workspaceId: 'mk_ws_a', tenantGroupId: GROUP_A });
      expect(keyB.scope).toEqual({ workspaceId: 'mk_ws_b', tenantGroupId: GROUP_B });

      const repo = getSiteRepository();
      expect((await repo.loadProject(keyA.scope, idA)).id).toBe(idA);
      expect((await repo.loadProject(keyB.scope, idB)).id).toBe(idB);

      expect((await repo.listSites(keyA.scope)).map((s) => s.siteId)).toContain(idA);
      expect((await repo.listSites(keyA.scope)).map((s) => s.siteId)).not.toContain(idB);
      await expect(repo.loadProject(keyA.scope, idB)).rejects.toBeInstanceOf(SiteNotFoundError);
      await expect(repo.loadProject(keyB.scope, idA)).rejects.toBeInstanceOf(SiteNotFoundError);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('refuses an unknown key without touching the database', async () => {
    expect(await verifyCompanyKey(bearer(fakeKey()))).toEqual({ kind: 'refused' });
  });

  it('a real authoring route never authenticates a bearer request by its cookie', async () => {
    const withCookieOnly = new Request('http://t/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'lumitra_session=sess_a' },
      body: JSON.stringify({ name: 'control' }),
    });
    const withBoth = new Request('http://t/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'lumitra_session=sess_a', authorization: `Bearer ${KEY_A}` },
      body: JSON.stringify({ name: 'never written' }),
    });
    const before = await prisma.site.count({ where: { workspaceId: 'mk_ws_a' } });
    mockVerifySession.mockClear();
    const refused = await createProject(withBoth);
    expect(refused.status).toBe(401);
    expect(await prisma.site.count({ where: { workspaceId: 'mk_ws_a' } })).toBe(before);
    expect(mockVerifySession).not.toHaveBeenCalledWith('sess_a');

    // Control: the same cookie without a bearer is a valid session on that route.
    expect((await createProject(withCookieOnly)).status).toBe(200);
  });
});
