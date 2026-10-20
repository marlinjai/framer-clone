// @vitest-environment node
//
// The custom-domain editor routes: the guard chain (editor host, session,
// company grant, tenant group, permission, both outage codes) and the mapping
// of service outcomes to responses. auth-brain, Prisma's site lookup and the
// domain service are mocked; the guard, the scope resolution and the response
// plumbing are real. The service itself runs against a real Postgres in
// src/server/domains/__tests__/service.itest.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifySession = vi.fn();
const can = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => verifySession(...args),
    can: (...args: unknown[]) => can(...args),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

const siteFindUnique = vi.fn();
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({ site: { findUnique: siteFindUnique } }),
}));

const service = {
  listDomains: vi.fn(),
  addDomain: vi.fn(),
  verifyDomain: vi.fn(),
  removeDomain: vi.fn(),
};
vi.mock('@/server/domains/service', async (importActual) => {
  const actual = await importActual<typeof import('@/server/domains/service')>();
  return { ...actual, getDomainService: () => service };
});

import { DomainError } from '@/server/domains/service';
import { GET, POST } from '../route';
import { DELETE } from '../[domainId]/route';
import { POST as VERIFY } from '../[domainId]/verify/route';

const TG = '018f9c10-0000-7000-8000-0000000000a1';
const SITE = { id: 'site_1', workspaceId: 'ws_a', tenantGroupId: TG };

function session(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', app_grants: ['sites'], group_id: TG }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
    ...overrides,
  };
}

const DOMAIN_VIEW = {
  id: 'dom_1',
  hostname: 'www.example.com',
  displayHostname: 'www.example.com',
  status: 'pending',
  serving: false,
  lastErrorCode: null,
  lastError: null,
  lastCheckedAt: null,
  verifiedAt: null,
  activatedAt: null,
  records: [],
};

function req(
  path: string,
  init: { method?: string; host?: string; cookie?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { host: init.host ?? 'app.lumitra.co' };
  if (init.cookie !== null) headers.cookie = init.cookie ?? 'lumitra_session=good';
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://app.lumitra.co${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}

const listCtx = { params: Promise.resolve({ projectId: 'site_1' }) };
const domainCtx = { params: Promise.resolve({ projectId: 'site_1', domainId: 'dom_1' }) };

const ENV_KEYS = [
  'EDITOR_HOST',
  'CUSTOM_DOMAIN_TARGET_HOST',
  'CUSTOM_DOMAIN_TARGET_IPV4',
  'CUSTOM_DOMAIN_TARGET_IPV6',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.EDITOR_HOST = 'app.lumitra.co';
  process.env.CUSTOM_DOMAIN_TARGET_HOST = 'domains.lumitra.co';
  process.env.CUSTOM_DOMAIN_TARGET_IPV4 = '203.0.113.10';
  delete process.env.CUSTOM_DOMAIN_TARGET_IPV6;
  verifySession.mockResolvedValue(session());
  can.mockResolvedValue(true);
  siteFindUnique.mockResolvedValue(SITE);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('the guard (every domain route)', () => {
  it('404s on a published-site host before reading the session (D2)', async () => {
    const res = await GET(req('/api/projects/site_1/domains', { host: 'www.example.com' }), listCtx);
    expect(res.status).toBe(404);
    expect(verifySession).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    verifySession.mockResolvedValue(null);
    const res = await GET(req('/api/projects/site_1/domains', { cookie: null }), listCtx);
    expect(res.status).toBe(401);
  });

  it('503 auth_unavailable when auth-brain cannot answer', async () => {
    verifySession.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('auth_unavailable');
  });

  it('403s for an unknown project, the same as a foreign one', async () => {
    siteFindUnique.mockResolvedValue(null);
    const unknown = await GET(req('/api/projects/site_1/domains'), listCtx);
    siteFindUnique.mockResolvedValue({ ...SITE, workspaceId: 'ws_other' });
    const foreign = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(unknown.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(await unknown.json()).toEqual(await foreign.json());
  });

  it('403s when the company lacks the sites grant', async () => {
    verifySession.mockResolvedValue(
      session({ tenants: [{ id: 'tenant-a', app_grants: ['studio'], group_id: TG }] }),
    );
    const res = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(res.status).toBe(403);
  });

  it('403s when the site row carries a different tenant group than the session', async () => {
    siteFindUnique.mockResolvedValue({ ...SITE, tenantGroupId: 'tg_foreign' });
    const res = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(res.status).toBe(403);
  });

  it('403s on a real deny and 503 authz_unavailable when OpenFGA cannot answer', async () => {
    can.mockResolvedValue(false);
    expect((await GET(req('/api/projects/site_1/domains'), listCtx)).status).toBe(403);
    can.mockRejectedValue(new Error('openfga down'));
    const res = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('authz_unavailable');
  });

  it('reads need viewer, every change needs workspace admin', async () => {
    service.listDomains.mockResolvedValue([]);
    await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(can.mock.calls.at(-1)?.[1]).toBe('workspace.viewer');

    service.addDomain.mockResolvedValue({ domain: DOMAIN_VIEW, created: true });
    await POST(req('/api/projects/site_1/domains', { method: 'POST', body: { hostname: 'www.example.com' } }), listCtx);
    expect(can.mock.calls.at(-1)?.[1]).toBe('workspace.admin');

    service.verifyDomain.mockResolvedValue(DOMAIN_VIEW);
    await VERIFY(req('/api/projects/site_1/domains/dom_1/verify', { method: 'POST' }), domainCtx);
    expect(can.mock.calls.at(-1)?.[1]).toBe('workspace.admin');

    service.removeDomain.mockResolvedValue(undefined);
    await DELETE(req('/api/projects/site_1/domains/dom_1', { method: 'DELETE' }), domainCtx);
    expect(can.mock.calls.at(-1)?.[1]).toBe('workspace.admin');
  });

  it('a viewer cannot add, verify or disconnect', async () => {
    can.mockImplementation(async (_u: string, relation: string) => relation === 'workspace.viewer');
    const add = await POST(req('/api/projects/site_1/domains', { method: 'POST', body: { hostname: 'a.example.com' } }), listCtx);
    const verify = await VERIFY(req('/api/projects/site_1/domains/dom_1/verify', { method: 'POST' }), domainCtx);
    const del = await DELETE(req('/api/projects/site_1/domains/dom_1', { method: 'DELETE' }), domainCtx);
    expect([add.status, verify.status, del.status]).toEqual([403, 403, 403]);
    expect(service.addDomain).not.toHaveBeenCalled();
    expect(service.verifyDomain).not.toHaveBeenCalled();
    expect(service.removeDomain).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/<id>/domains', () => {
  it('lists the project domains with the platform target', async () => {
    service.listDomains.mockResolvedValue([DOMAIN_VIEW]);
    const res = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      configured: true,
      target: { host: 'domains.lumitra.co', ipv4: ['203.0.113.10'], ipv6: [] },
      domains: [DOMAIN_VIEW],
    });
    expect(service.listDomains.mock.calls[0][0]).toBe('site_1');
  });

  it('still lists (without records) when custom domains are not configured', async () => {
    delete process.env.CUSTOM_DOMAIN_TARGET_HOST;
    service.listDomains.mockResolvedValue([]);
    const res = await GET(req('/api/projects/site_1/domains'), listCtx);
    expect(await res.json()).toEqual({ configured: false, target: null, domains: [] });
    expect(service.listDomains).toHaveBeenCalledWith('site_1', null);
  });
});

describe('POST /api/projects/<id>/domains', () => {
  const add = (body: unknown) =>
    POST(req('/api/projects/site_1/domains', { method: 'POST', body }), listCtx);

  it('201 with the new domain; 200 when it already existed', async () => {
    service.addDomain.mockResolvedValue({ domain: DOMAIN_VIEW, created: true });
    const created = await add({ hostname: 'www.example.com' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ domain: DOMAIN_VIEW });
    expect(service.addDomain.mock.calls[0][0]).toEqual(SITE);

    service.addDomain.mockResolvedValue({ domain: DOMAIN_VIEW, created: false });
    expect((await add({ hostname: 'www.example.com' })).status).toBe(200);
  });

  it('503 custom_domains_not_configured when the platform target is unset', async () => {
    delete process.env.CUSTOM_DOMAIN_TARGET_IPV4;
    const res = await add({ hostname: 'www.example.com' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('custom_domains_not_configured');
    expect(service.addDomain).not.toHaveBeenCalled();
  });

  it('400 on a malformed body', async () => {
    expect((await add({})).status).toBe(400);
    expect((await add('{nope')).status).toBe(400);
  });

  it('surfaces a service refusal with its own code and status', async () => {
    service.addDomain.mockRejectedValue(
      new DomainError('reserved_hostname', 'This domain belongs to the platform.', 400),
    );
    const res = await add({ hostname: 'app.lumitra.co' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({
      code: 'reserved_hostname',
      message: 'This domain belongs to the platform.',
    });
  });

  it('turns an unexpected failure into a 500 that names no internals', async () => {
    service.addDomain.mockRejectedValue(new Error('connection to 10.0.0.5 refused'));
    const res = await add({ hostname: 'www.example.com' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('domain_request_failed');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});

describe('verify and disconnect', () => {
  it('verify answers the updated domain', async () => {
    service.verifyDomain.mockResolvedValue({ ...DOMAIN_VIEW, status: 'active', serving: true });
    const res = await VERIFY(req('/api/projects/site_1/domains/dom_1/verify', { method: 'POST' }), domainCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).domain.status).toBe('active');
    expect(service.verifyDomain.mock.calls[0].slice(0, 2)).toEqual(['site_1', 'dom_1']);
  });

  it('verify 503s when not configured, and 404s for a domain of another site', async () => {
    delete process.env.CUSTOM_DOMAIN_TARGET_HOST;
    expect(
      (await VERIFY(req('/api/projects/site_1/domains/dom_1/verify', { method: 'POST' }), domainCtx)).status,
    ).toBe(503);
    process.env.CUSTOM_DOMAIN_TARGET_HOST = 'domains.lumitra.co';
    service.verifyDomain.mockRejectedValue(new DomainError('domain_not_found', 'not here', 404));
    expect(
      (await VERIFY(req('/api/projects/site_1/domains/dom_1/verify', { method: 'POST' }), domainCtx)).status,
    ).toBe(404);
  });

  it('disconnect answers removed, and 404s for an unknown domain', async () => {
    service.removeDomain.mockResolvedValue(undefined);
    const ok = await DELETE(req('/api/projects/site_1/domains/dom_1', { method: 'DELETE' }), domainCtx);
    expect(await ok.json()).toEqual({ id: 'dom_1', removed: true });
    expect(service.removeDomain).toHaveBeenCalledWith('site_1', 'dom_1');

    service.removeDomain.mockRejectedValue(new DomainError('domain_not_found', 'not here', 404));
    const missing = await DELETE(req('/api/projects/site_1/domains/dom_1', { method: 'DELETE' }), domainCtx);
    expect(missing.status).toBe(404);
  });
});
