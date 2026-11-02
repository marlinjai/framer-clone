// @vitest-environment node
//
// The machine door (src/lib/auth-machine.ts): every branch of verifyCompanyKey,
// the role mapping of authorizeKeyAction, the audit line, the redaction, and
// the bounded short cache. auth-brain and OpenFGA are mocked: verifyApiKey
// through the shared client, the company structure through openfgaRead.
//
// Fake keys are built at run time (knowledge-base standards/test-credentials.md),
// never written out.

import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthBrainError, AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';

const mockVerifyApiKey = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
    verifySession: vi.fn(),
    can: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

const mockReadCompanyStructure = vi.fn();
vi.mock('@/lib/openfgaRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/openfgaRead')>();
  return { ...actual, readCompanyStructure: (...args: unknown[]) => mockReadCompanyStructure(...args) };
});

import {
  KEY_CACHE_MAX,
  KEY_CACHE_TTL_MS,
  MACHINE_ACTIONS,
  authorizeKeyAction,
  carriesBearer,
  clearKeyCache,
  keyCacheSize,
  keyWorkspaceRole,
  machineAuthDenial,
  redactSecrets,
  verifyCompanyKey,
  type VerifiedKey,
} from '@/lib/auth-machine';
import { OpenFgaReadError } from '@/lib/openfgaRead';
import type { FramerAction } from '@/lib/permissions';

const fakeCredential = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const fakeKey = () => fakeCredential(['sk', 'live'].join('_'));

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const GROUP = 'group-a';
const WORKSPACE = 'ws-a';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://app.lumitra.co/api/mcp', { method: 'POST', headers });
}

function bearerRequest(key: string, extra: Record<string, string> = {}): Request {
  return request({ authorization: `Bearer ${key}`, ...extra });
}

interface VerifyOverrides {
  scopeType?: string;
  tenantId?: string;
  grants?: string[] | undefined;
  role?: string;
  tenantRoles?: Array<{ id: string; role: string }>;
  workspaceRoles?: Array<{ id: string; role: string }>;
}

function verifyResponse(o: VerifyOverrides = {}) {
  const tenantId = o.tenantId ?? TENANT;
  const scope: Record<string, unknown> = { type: o.scopeType ?? 'tenant', id: tenantId, slug: 'acme' };
  if (!('grants' in o)) scope.app_grants = ['sites'];
  else if (o.grants !== undefined) scope.app_grants = o.grants;
  const role = o.role ?? 'admin';
  return {
    principal: { type: 'service_account', id: 'sa-1', scope, role },
    key: { id: 'key-1', name: 'agent', expires_at: null },
    effective_roles: {
      tenant_groups: [],
      tenants: (o.tenantRoles ?? [{ id: tenantId, role }]).map((r) => ({ ...r, source: 'direct' })),
      workspaces: (o.workspaceRoles ?? []).map((r) => ({ ...r, source: 'inherited' })),
    },
  };
}

type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore: () => void };
let infoSpy: ConsoleSpy;
let errorSpy: ConsoleSpy;
let warnSpy: ConsoleSpy;

beforeEach(() => {
  clearKeyCache();
  mockVerifyApiKey.mockReset();
  mockReadCompanyStructure.mockReset();
  mockReadCompanyStructure.mockResolvedValue({ groupIds: [GROUP], workspaceIds: [WORKSPACE] });
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/** Everything this module logged, as one string, to prove the key never appears. */
function allLogged(): string {
  return [infoSpy, errorSpy, warnSpy].flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
}

function auditLines(): Array<Record<string, unknown>> {
  return infoSpy.mock.calls
    .filter((c) => c[0] === '[machine-audit]')
    .map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);
}

describe('carriesBearer', () => {
  it('is true for the Bearer scheme in any case, with or without a token', () => {
    expect(carriesBearer(request({ authorization: 'Bearer abc' }))).toBe(true);
    expect(carriesBearer(request({ authorization: 'bearer abc' }))).toBe(true);
    expect(carriesBearer(request({ authorization: 'Bearer' }))).toBe(true);
  });

  it('is false without an Authorization header or with another scheme', () => {
    expect(carriesBearer(request())).toBe(false);
    expect(carriesBearer(request({ authorization: 'Basic dXNlcjpwdw==' }))).toBe(false);
    expect(carriesBearer(request({ authorization: 'Bearerish abc' }))).toBe(false);
  });
});

describe('verifyCompanyKey: refusals before auth-brain', () => {
  it('refuses a request without an Authorization header', async () => {
    expect(await verifyCompanyKey(request())).toEqual({ kind: 'refused' });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it('refuses an empty bearer and never falls back to the cookie', async () => {
    const res = await verifyCompanyKey(request({ authorization: 'Bearer   ', cookie: 'lumitra_session=valid' }));
    expect(res).toEqual({ kind: 'refused' });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it('refuses a malformed bearer (whitespace inside, too short, another scheme)', async () => {
    for (const authorization of ['Bearer two words here', 'Bearer short', `Basic ${fakeKey()}`]) {
      expect(await verifyCompanyKey(request({ authorization }))).toEqual({ kind: 'refused' });
    }
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });
});

describe('verifyCompanyKey: auth-brain answers', () => {
  it('refuses an unknown, revoked or expired key (verifyApiKey answers null)', async () => {
    mockVerifyApiKey.mockResolvedValue(null);
    expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'refused' });
  });

  it('refuses when auth-brain rejects the request with a 4xx', async () => {
    mockVerifyApiKey.mockRejectedValue(new AuthBrainError('verifyApiKey failed: 400', 400));
    expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'refused' });
  });

  it('is unavailable when auth-brain is unreachable, answers 5xx or rate limits', async () => {
    for (const err of [
      new AuthBrainNetworkError(new Error('ECONNREFUSED')),
      new AuthBrainError('verifyApiKey failed: 503', 503),
      new AuthBrainError('verifyApiKey failed: 429', 429),
      new Error('boom'),
    ]) {
      mockVerifyApiKey.mockRejectedValueOnce(err);
      expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'unavailable' });
    }
    expect(keyCacheSize()).toBe(0);
  });

  it('refuses a workspace-scoped or tenant-group-scoped key (no widening or narrowing)', async () => {
    for (const scopeType of ['workspace', 'tenant_group']) {
      mockVerifyApiKey.mockResolvedValueOnce(verifyResponse({ scopeType }));
      expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'refused' });
    }
    expect(mockReadCompanyStructure).not.toHaveBeenCalled();
  });

  it('forbids a company key without the sites grant', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse({ grants: ['studio', 'books'] }));
    expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({
      kind: 'forbidden',
      reason: 'sites_not_enabled',
      keyId: 'key-1',
      tenantId: TENANT,
    });
    expect(mockReadCompanyStructure).not.toHaveBeenCalled();
    expect(auditLines()).toEqual([
      expect.objectContaining({ keyId: 'key-1', serviceAccountId: 'sa-1', tenantId: TENANT, outcome: 'denied', reason: 'sites_not_enabled' }),
    ]);
  });

  it('forbids a scope with no app_grants field and logs it as version skew', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse({ grants: undefined }));
    const res = await verifyCompanyKey(bearerRequest(fakeKey()));
    expect(res).toMatchObject({ kind: 'forbidden', reason: 'sites_not_enabled' });
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('version skew');
  });

  it('accepts a company key with the sites grant and maps it to its own workspace', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    const res = await verifyCompanyKey(bearerRequest(fakeKey()));
    expect(res).toEqual({
      kind: 'key',
      tenantId: TENANT,
      keyId: 'key-1',
      serviceAccountId: 'sa-1',
      scope: { workspaceId: WORKSPACE, tenantGroupId: GROUP },
      workspaceRole: 'admin',
    });
    expect(mockReadCompanyStructure).toHaveBeenCalledWith(TENANT);
    expect(auditLines()).toEqual([
      expect.objectContaining({ keyId: 'key-1', tenantId: TENANT, workspaceId: WORKSPACE, action: 'authenticate', outcome: 'allowed' }),
    ]);
  });

  it('takes the company from the verified key only, never from anything the request names', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    const res = await verifyCompanyKey(
      bearerRequest(fakeKey(), {
        cookie: `lumitra_session=x; framer_company=${OTHER_TENANT}`,
        'x-company-id': OTHER_TENANT,
        'x-workspace-id': 'ws-b',
      }),
    );
    expect(res).toMatchObject({ kind: 'key', tenantId: TENANT, scope: { workspaceId: WORKSPACE } });
    expect(mockReadCompanyStructure).toHaveBeenCalledTimes(1);
    expect(mockReadCompanyStructure).toHaveBeenCalledWith(TENANT);
  });

  it('forbids a company without a workspace, with several, or with a broken structure', async () => {
    const cases: Array<[{ groupIds: string[]; workspaceIds: string[] }, string]> = [
      [{ groupIds: [GROUP], workspaceIds: [] }, 'no_sites_workspace'],
      [{ groupIds: [GROUP], workspaceIds: ['ws-1', 'ws-2'] }, 'ambiguous_workspace'],
      [{ groupIds: [], workspaceIds: [WORKSPACE] }, 'company_structure_invalid'],
      [{ groupIds: ['g1', 'g2'], workspaceIds: [WORKSPACE] }, 'company_structure_invalid'],
    ];
    for (const [structure, reason] of cases) {
      mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
      mockReadCompanyStructure.mockResolvedValueOnce(structure);
      expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toMatchObject({ kind: 'forbidden', reason });
    }
    expect(keyCacheSize()).toBe(0);
  });

  it('is unavailable when OpenFGA cannot answer the structure read', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    mockReadCompanyStructure.mockRejectedValue(new OpenFgaReadError('OpenFGA read answered 503'));
    expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'unavailable' });
    expect(keyCacheSize()).toBe(0);
  });
});

describe('verifyCompanyKey: the key never leaks', () => {
  it('never logs the key, even when an error message carries it', async () => {
    const key = fakeKey();
    mockVerifyApiKey.mockRejectedValue(new Error(`upstream echoed ${key} back`));
    expect(await verifyCompanyKey(bearerRequest(key))).toEqual({ kind: 'unavailable' });
    expect(allLogged()).not.toContain(key);
    expect(allLogged()).toContain('[REDACTED]');
  });

  it('never puts the key in any log line or denial body on the success and refusal paths', async () => {
    const key = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse({ grants: [] }));
    const forbidden = await verifyCompanyKey(bearerRequest(key));
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    const other = fakeKey();
    await verifyCompanyKey(bearerRequest(other));
    expect(allLogged()).not.toContain(key);
    expect(allLogged()).not.toContain(other);
    if (forbidden.kind !== 'forbidden') throw new Error('expected forbidden');
    expect(await machineAuthDenial(forbidden).text()).not.toContain(key);
  });

  it('redactSecrets masks the presented key and anything key-shaped', () => {
    const key = fakeKey();
    const out = redactSecrets(`a ${key} b ${fakeKey()} c`, key);
    expect(out).not.toMatch(/sk_live_[0-9a-f]{8}/);
    expect(out).toContain('[REDACTED]');
  });
});

describe('verifyCompanyKey: the cache', () => {
  it('serves a repeated key from the cache within the TTL and verifies again after it', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const key = fakeKey();
    mockVerifyApiKey.mockResolvedValue(verifyResponse());

    expect((await verifyCompanyKey(bearerRequest(key), clock)).kind).toBe('key');
    now += KEY_CACHE_TTL_MS - 1;
    expect((await verifyCompanyKey(bearerRequest(key), clock)).kind).toBe('key');
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(1);

    // Revoked in auth-brain: visible as soon as the TTL has passed.
    mockVerifyApiKey.mockResolvedValue(null);
    now += 1;
    expect(await verifyCompanyKey(bearerRequest(key), clock)).toEqual({ kind: 'refused' });
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(2);
    expect(keyCacheSize()).toBe(0);
  });

  it('never caches a refusal or an outage', async () => {
    const key = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(null);
    await verifyCompanyKey(bearerRequest(key));
    mockVerifyApiKey.mockRejectedValueOnce(new AuthBrainNetworkError(new Error('down')));
    await verifyCompanyKey(bearerRequest(key));
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    expect((await verifyCompanyKey(bearerRequest(key))).kind).toBe('key');
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(3);
  });

  it('is bounded: the oldest entry is evicted beyond KEY_CACHE_MAX', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    const first = fakeKey();
    await verifyCompanyKey(bearerRequest(first));
    for (let i = 0; i < KEY_CACHE_MAX; i++) await verifyCompanyKey(bearerRequest(fakeKey()));
    expect(keyCacheSize()).toBe(KEY_CACHE_MAX);
    const calls = mockVerifyApiKey.mock.calls.length;
    await verifyCompanyKey(bearerRequest(first));
    expect(mockVerifyApiKey.mock.calls.length).toBe(calls + 1);
  });
});

describe('keyWorkspaceRole: the role mapping', () => {
  const base = (o: VerifyOverrides) => verifyResponse(o) as unknown as Parameters<typeof keyWorkspaceRole>[0];

  it('a company owner or admin is an effective workspace admin (the model cascade)', () => {
    expect(keyWorkspaceRole(base({ role: 'owner' }), TENANT, WORKSPACE)).toBe('admin');
    expect(keyWorkspaceRole(base({ role: 'admin' }), TENANT, WORKSPACE)).toBe('admin');
  });

  it('a company member, billing_admin or viewer reaches no workspace', () => {
    for (const role of ['member', 'billing_admin', 'viewer']) {
      expect(keyWorkspaceRole(base({ role }), TENANT, WORKSPACE)).toBeNull();
    }
  });

  it('an unknown role string grants nothing', () => {
    expect(keyWorkspaceRole(base({ role: 'superuser' }), TENANT, WORKSPACE)).toBeNull();
    expect(
      keyWorkspaceRole(base({ role: 'member', workspaceRoles: [{ id: WORKSPACE, role: 'root' }] }), TENANT, WORKSPACE),
    ).toBeNull();
  });

  it('reads an effective workspace entry for this workspace only', () => {
    const v = base({ role: 'member', workspaceRoles: [{ id: WORKSPACE, role: 'viewer' }, { id: 'ws-b', role: 'admin' }] });
    expect(keyWorkspaceRole(v, TENANT, WORKSPACE)).toBe('viewer');
  });

  it('takes the higher of the workspace entry and the company cascade', () => {
    const v = base({ role: 'admin', workspaceRoles: [{ id: WORKSPACE, role: 'viewer' }] });
    expect(keyWorkspaceRole(v, TENANT, WORKSPACE)).toBe('admin');
  });

  it('reads the company role from effective_roles for its own company, and principal.role only as a fallback', () => {
    // Effective says member on this company: the direct principal role is not consulted.
    expect(keyWorkspaceRole(base({ role: 'admin', tenantRoles: [{ id: TENANT, role: 'member' }] }), TENANT, WORKSPACE)).toBeNull();
    // An admin role on ANOTHER company does not cascade here.
    expect(
      keyWorkspaceRole(base({ role: 'member', tenantRoles: [{ id: OTHER_TENANT, role: 'admin' }] }), TENANT, WORKSPACE),
    ).toBeNull();
    // No effective entry (auth-brain degraded): the direct role cascades as the model says.
    expect(keyWorkspaceRole(base({ role: 'owner', tenantRoles: [] }), TENANT, WORKSPACE)).toBe('admin');
  });
});

describe('authorizeKeyAction', () => {
  const key = (workspaceRole: VerifiedKey['workspaceRole']): VerifiedKey => ({
    kind: 'key',
    tenantId: TENANT,
    keyId: 'key-1',
    serviceAccountId: 'sa-1',
    scope: { workspaceId: WORKSPACE, tenantGroupId: GROUP },
    workspaceRole,
  });

  it('lets a workspace admin key view, edit and publish', () => {
    for (const action of ['viewSite', 'editSite', 'publishSite'] as const) {
      expect(authorizeKeyAction(key('admin'), action)).toBe(true);
    }
  });

  it('lets a viewer or member key only view', () => {
    for (const role of ['viewer', 'member'] as const) {
      expect(authorizeKeyAction(key(role), 'viewSite')).toBe(true);
      expect(authorizeKeyAction(key(role), 'editSite')).toBe(false);
      expect(authorizeKeyAction(key(role), 'publishSite')).toBe(false);
    }
  });

  it('denies everything to a key without a workspace role', () => {
    for (const action of ['viewSite', 'editSite', 'publishSite'] as const) {
      expect(authorizeKeyAction(key(null), action)).toBe(false);
    }
  });

  it('never lets a key manage domains, erase personal data or touch the Books, even as admin', () => {
    for (const action of ['manageDomain', 'eraseSiteData', 'viewBooks', 'editBooks'] as const) {
      expect(authorizeKeyAction(key('admin'), action)).toBe(false);
    }
    expect([...MACHINE_ACTIONS].sort()).toEqual(['editSite', 'publishSite', 'viewSite']);
  });

  it('denies a target in another workspace or tenant group (a foreign company)', () => {
    expect(authorizeKeyAction(key('admin'), 'editSite', { workspaceId: 'ws-b' })).toBe(false);
    expect(authorizeKeyAction(key('admin'), 'editSite', { workspaceId: WORKSPACE, tenantGroupId: 'group-b' })).toBe(false);
    expect(authorizeKeyAction(key('admin'), 'editSite', { workspaceId: WORKSPACE, tenantGroupId: GROUP, siteId: 's1' })).toBe(true);
  });

  it('audits every decision with key id, service account, company and workspace', () => {
    authorizeKeyAction(key('admin'), 'publishSite', { siteId: 's1' });
    authorizeKeyAction(key('viewer'), 'editSite');
    expect(auditLines()).toEqual([
      expect.objectContaining({
        keyId: 'key-1',
        serviceAccountId: 'sa-1',
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        tenantGroupId: GROUP,
        action: 'publishSite',
        outcome: 'allowed',
        target: { siteId: 's1' },
      }),
      expect.objectContaining({ action: 'editSite', outcome: 'denied', reason: 'insufficient_role' }),
    ]);
  });

  it('denies an action name that is not in the vocabulary', () => {
    expect(authorizeKeyAction(key('admin'), 'deleteEverything' as FramerAction)).toBe(false);
  });
});

describe('machineAuthDenial', () => {
  it('answers 401 with a Bearer challenge, 403 with the reason, 503 with retry-after', async () => {
    const r401 = machineAuthDenial({ kind: 'refused' });
    expect(r401.status).toBe(401);
    expect(r401.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const r403 = machineAuthDenial({ kind: 'forbidden', reason: 'sites_not_enabled', keyId: 'k', tenantId: 't' });
    expect(r403.status).toBe(403);
    expect((await r403.json()).error.code).toBe('sites_not_enabled');

    const r503 = machineAuthDenial({ kind: 'unavailable' });
    expect(r503.status).toBe(503);
    expect(r503.headers.get('retry-after')).toBe('5');
  });
});
