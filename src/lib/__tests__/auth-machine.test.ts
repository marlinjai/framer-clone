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
vi.mock('@/lib/auth-brain-machine', () => ({
  machineAuthBrainClient: {
    verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
  },
}));

const mockReadCompanyStructure = vi.fn();
vi.mock('@/lib/openfgaRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/openfgaRead')>();
  return { ...actual, readCompanyStructure: (...args: unknown[]) => mockReadCompanyStructure(...args) };
});

const mockFindFirst = vi.fn();
const mockExecuteRaw = vi.fn();
vi.mock('@/server/db', () => {
  const tx = {
    $executeRawUnsafe: (...args: unknown[]) => mockExecuteRaw(...args),
    site: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
  };
  return { getPrismaClient: () => ({ $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) }) };
});

import {
  KEY_CACHE_MAX,
  KEY_VERIFY_TIMEOUT_MS,
  KNOWN_GOOD_TTL_MS,
  SITE_ROW_STATEMENT_TIMEOUT_MS,
  addressBucket,
  REFUSALS_GLOBAL,
  REFUSALS_PER_CLIENT,
  REFUSAL_WINDOW_MS,
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
  mockFindFirst.mockReset();
  mockFindFirst.mockResolvedValue(null);
  mockExecuteRaw.mockReset();
  mockExecuteRaw.mockResolvedValue(0);
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
      companySlug: 'acme',
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
    companySlug: 'acme',
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
    expect(authorizeKeyAction(key('admin'), 'editSite', { workspaceId: WORKSPACE, tenantGroupId: GROUP })).toBe(true);
  });

  it('takes no site id: a site target alone does not compile, and is never a grant on its own', () => {
    // @ts-expect-error siteId is not part of the target: site isolation comes from the scoped repository.
    const bySiteOnly: Parameters<typeof authorizeKeyAction>[2] = { siteId: 's1' };
    // Whatever a caller smuggles in, only workspace and tenant group are checked, and they must match.
    expect(authorizeKeyAction(key('admin'), 'editSite', { ...bySiteOnly, workspaceId: 'ws-b' })).toBe(false);
  });

  it('audits every decision with key id, service account, company and workspace', () => {
    authorizeKeyAction(key('admin'), 'publishSite', { workspaceId: WORKSPACE });
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
        target: { workspaceId: WORKSPACE },
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

describe('verifyCompanyKey: hardening', () => {
  it('answers unavailable when the whole verification overruns the deadline at any step', async () => {
    vi.useFakeTimers();
    try {
      // OpenFGA hangs.
      mockVerifyApiKey.mockResolvedValue(verifyResponse());
      mockReadCompanyStructure.mockReturnValueOnce(new Promise(() => {}));
      let pending = verifyCompanyKey(bearerRequest(fakeKey()));
      await vi.advanceTimersByTimeAsync(KEY_VERIFY_TIMEOUT_MS);
      expect(await pending).toEqual({ kind: 'unavailable' });
      // The site-row query hangs.
      mockFindFirst.mockReturnValueOnce(new Promise(() => {}));
      pending = verifyCompanyKey(bearerRequest(fakeKey()));
      await vi.advanceTimersByTimeAsync(KEY_VERIFY_TIMEOUT_MS);
      expect(await pending).toEqual({ kind: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the site-row check under a Postgres statement timeout', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    await verifyCompanyKey(bearerRequest(fakeKey()));
    expect(mockExecuteRaw).toHaveBeenCalledWith(`SET LOCAL statement_timeout = ${SITE_ROW_STATEMENT_TIMEOUT_MS}`);
  });

  it('answers unavailable when auth-brain never answers within the deadline', async () => {
    vi.useFakeTimers();
    try {
      mockVerifyApiKey.mockReturnValue(new Promise(() => {}));
      const pending = verifyCompanyKey(bearerRequest(fakeKey()));
      await vi.advanceTimersByTimeAsync(KEY_VERIFY_TIMEOUT_MS);
      expect(await pending).toEqual({ kind: 'unavailable' });
      expect(keyCacheSize()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a company key whose verify answer names no company slug, so a first site never gets a wrongly named shop', async () => {
    for (const slug of [undefined, '', '   ', 42]) {
      const v = verifyResponse();
      const scope: Record<string, unknown> = { ...v.principal.scope };
      if (slug === undefined) delete scope.slug;
      else scope.slug = slug;
      mockVerifyApiKey.mockResolvedValueOnce({ ...v, principal: { ...v.principal, scope } });
      expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'refused' });
    }
    expect(keyCacheSize()).toBe(0);
  });

  it('refuses a principal that is not a service account', async () => {
    const v = verifyResponse();
    mockVerifyApiKey.mockResolvedValue({ ...v, principal: { ...v.principal, type: 'user' } });
    expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'refused' });
  });

  it('forbids a workspace whose site rows carry another tenant group or another company', async () => {
    for (const row of [{ id: 'site-1' }, { id: 'site-2' }]) {
      mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
      mockFindFirst.mockResolvedValueOnce(row);
      expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toMatchObject({ kind: 'forbidden', reason: 'workspace_mismatch' });
    }
    expect(keyCacheSize()).toBe(0);
    expect(auditLines().filter((l) => l.reason === 'workspace_mismatch')).toEqual([
      expect.objectContaining({ outcome: 'failed', keyId: 'key-1', tenantId: TENANT, workspaceId: WORKSPACE }),
      expect.objectContaining({ outcome: 'failed' }),
    ]);
  });

  it('accepts a workspace whose site rows agree, and checks the rows of that workspace', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    mockFindFirst.mockResolvedValue(null);
    expect((await verifyCompanyKey(bearerRequest(fakeKey()))).kind).toBe('key');
    expect(mockFindFirst.mock.calls[0][0]).toMatchObject({
      where: {
        workspaceId: WORKSPACE,
        OR: [
          { tenantGroupId: { not: GROUP } },
          { AND: [{ companyId: { not: null } }, { companyId: { not: TENANT } }] },
        ],
      },
    });
  });

  it('is unavailable when the database cannot answer the site-row check', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    mockFindFirst.mockRejectedValue(new Error('connection refused'));
    expect(await verifyCompanyKey(bearerRequest(fakeKey()))).toEqual({ kind: 'unavailable' });
  });

  it('caches no longer than the key itself is valid', async () => {
    let now = Date.parse('2026-11-02T12:00:00Z');
    const clock = () => now;
    const key = fakeKey();
    const v = verifyResponse();
    mockVerifyApiKey.mockResolvedValue({ ...v, key: { ...v.key, expires_at: new Date(now + 2_000).toISOString() } });
    await verifyCompanyKey(bearerRequest(key), clock);
    now += 2_000;
    mockVerifyApiKey.mockResolvedValue(null);
    expect(await verifyCompanyKey(bearerRequest(key), clock)).toEqual({ kind: 'refused' });
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(2);
  });

  it('hands out frozen results', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    const res = await verifyCompanyKey(bearerRequest(fakeKey()));
    if (res.kind !== 'key') throw new Error('expected a key');
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res.scope)).toBe(true);
    expect(() => {
      (res.scope as { workspaceId: string }).workspaceId = 'ws-b';
    }).toThrow();
  });

  it('shares one auth-brain round trip between concurrent verifications of the same key', async () => {
    let release: (v: unknown) => void = () => {};
    mockVerifyApiKey.mockReturnValue(new Promise((r) => (release = r)));
    const key = fakeKey();
    const all = Promise.all([1, 2, 3].map(() => verifyCompanyKey(bearerRequest(key))));
    await Promise.resolve();
    release(verifyResponse());
    const results = await all;
    expect(results.every((r) => r.kind === 'key')).toBe(true);
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(1);
    expect(auditLines().filter((l) => l.action === 'authenticate')).toHaveLength(1);
  });

  it('throttles a client that keeps presenting refused keys, without asking auth-brain, then lets it retry', async () => {
    let now = 5_000_000;
    const clock = () => now;
    const from = (ip: string) => bearerRequest(fakeKey(), { 'x-forwarded-for': `203.0.113.9, ${ip}` });
    mockVerifyApiKey.mockResolvedValue(null);
    for (let i = 0; i < REFUSALS_PER_CLIENT; i++) {
      expect(await verifyCompanyKey(from('198.51.100.1'), clock)).toEqual({ kind: 'refused' });
    }
    const calls = mockVerifyApiKey.mock.calls.length;
    const throttled = await verifyCompanyKey(from('198.51.100.1'), clock);
    expect(throttled).toMatchObject({ kind: 'throttled' });
    expect(mockVerifyApiKey.mock.calls.length).toBe(calls);
    // Another client is not affected.
    expect(await verifyCompanyKey(from('198.51.100.2'), clock)).toEqual({ kind: 'refused' });
    // Malformed keys count too, and the window ends.
    now += REFUSAL_WINDOW_MS;
    expect(await verifyCompanyKey(from('198.51.100.1'), clock)).toEqual({ kind: 'refused' });
  });

  it('counts malformed keys against the client', async () => {
    const bad = () => request({ authorization: 'Bearer short', 'x-real-ip': '198.51.100.7' });
    for (let i = 0; i < REFUSALS_PER_CLIENT; i++) expect(await verifyCompanyKey(bad())).toEqual({ kind: 'refused' });
    expect(await verifyCompanyKey(bad())).toMatchObject({ kind: 'throttled' });
  });

  it('throttles new keys globally under a flood from many addresses, while a cached good key still passes', async () => {
    const good = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    expect((await verifyCompanyKey(bearerRequest(good))).kind).toBe('key');
    mockVerifyApiKey.mockResolvedValue(null);
    for (let i = 0; i < REFUSALS_GLOBAL; i++) {
      await verifyCompanyKey(request({ authorization: 'Bearer short', 'x-real-ip': `10.0.${Math.floor(i / 250)}.${i % 250}` }));
    }
    expect(await verifyCompanyKey(bearerRequest(fakeKey(), { 'x-real-ip': '192.0.2.1' }))).toMatchObject({ kind: 'throttled' });
    expect((await verifyCompanyKey(bearerRequest(good, { 'x-real-ip': '192.0.2.1' }))).kind).toBe('key');
  });

  it('answers 429 with retry-after for a throttled client', () => {
    const res = machineAuthDenial({ kind: 'throttled', retryAfterSeconds: 42 });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
  });

  it('says a missing workspace may be temporary right after a company is created', async () => {
    const res = machineAuthDenial({ kind: 'forbidden', reason: 'no_sites_workspace', keyId: 'k', tenantId: 't' });
    expect((await res.json()).error.message).toMatch(/right after a company is created/);
  });
});

describe('verifyCompanyKey: header edge cases', () => {
  it('refuses two Authorization headers (they join into one value with a comma)', async () => {
    const headers = new Headers();
    headers.append('authorization', `Bearer ${fakeKey()}`);
    headers.append('authorization', `Bearer ${fakeKey()}`);
    const res = await verifyCompanyKey(new Request('https://app.lumitra.co/api/mcp', { method: 'POST', headers }));
    expect(res).toEqual({ kind: 'refused' });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it('accepts the scheme in capitals and a tab after it', async () => {
    mockVerifyApiKey.mockResolvedValue(verifyResponse());
    expect((await verifyCompanyKey(request({ authorization: `BEARER ${fakeKey()}` }))).kind).toBe('key');
    expect((await verifyCompanyKey(request({ authorization: `Bearer\t${fakeKey()}` }))).kind).toBe('key');
  });

  it('refuses a token longer than 512 characters without asking auth-brain', async () => {
    const long = fakeKey() + 'a'.repeat(520);
    expect(await verifyCompanyKey(bearerRequest(long))).toEqual({ kind: 'refused' });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });
});

describe('verifyCompanyKey: the global limit cannot lock out working agents', () => {
  const flood = async () => {
    mockVerifyApiKey.mockResolvedValue(null);
    for (let i = 0; i < REFUSALS_GLOBAL; i++) {
      await verifyCompanyKey(request({ authorization: 'Bearer short', 'x-real-ip': `10.1.${Math.floor(i / 250)}.${i % 250}` }), clock);
    }
  };
  let now = 9_000_000;
  const clock = () => now;

  it('keeps a key that verified within the last hour working after its cache entry expired, and re-verifies it', async () => {
    const good = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    expect((await verifyCompanyKey(bearerRequest(good), clock)).kind).toBe('key');
    now += KEY_CACHE_TTL_MS + 1;
    await flood();
    expect(await verifyCompanyKey(bearerRequest(fakeKey(), { 'x-real-ip': '192.0.2.9' }), clock)).toMatchObject({ kind: 'throttled' });

    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    const calls = mockVerifyApiKey.mock.calls.length;
    expect((await verifyCompanyKey(bearerRequest(good, { 'x-real-ip': '192.0.2.9' }), clock)).kind).toBe('key');
    expect(mockVerifyApiKey.mock.calls.length).toBe(calls + 1);
  });

  it('forgets a known-good key once auth-brain refuses it, and after an hour', async () => {
    const good = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    await verifyCompanyKey(bearerRequest(good), clock);
    now += KEY_CACHE_TTL_MS + 1;
    mockVerifyApiKey.mockResolvedValueOnce(null);
    expect(await verifyCompanyKey(bearerRequest(good), clock)).toEqual({ kind: 'refused' });
    await flood();
    expect(await verifyCompanyKey(bearerRequest(good, { 'x-real-ip': '192.0.2.10' }), clock)).toMatchObject({ kind: 'throttled' });

    clearKeyCache();
    const other = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    await verifyCompanyKey(bearerRequest(other), clock);
    now += KNOWN_GOOD_TTL_MS;
    await flood();
    expect(await verifyCompanyKey(bearerRequest(other, { 'x-real-ip': '192.0.2.11' }), clock)).toMatchObject({ kind: 'throttled' });
  });
});

describe('verifyCompanyKey: a forbidden key is no longer known good', () => {
  let now = 20_000_000;
  const clock = () => now;

  it('loses its global-limit bypass once auth-brain withdraws the sites grant', async () => {
    const key = fakeKey();
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse());
    expect((await verifyCompanyKey(bearerRequest(key), clock)).kind).toBe('key');
    now += KEY_CACHE_TTL_MS + 1;
    mockVerifyApiKey.mockResolvedValueOnce(verifyResponse({ grants: [] }));
    expect(await verifyCompanyKey(bearerRequest(key), clock)).toMatchObject({ kind: 'forbidden' });

    mockVerifyApiKey.mockResolvedValue(null);
    for (let i = 0; i < REFUSALS_GLOBAL; i++) {
      await verifyCompanyKey(request({ authorization: 'Bearer short', 'x-real-ip': `10.2.${Math.floor(i / 250)}.${i % 250}` }), clock);
    }
    expect(await verifyCompanyKey(bearerRequest(key, { 'x-real-ip': '192.0.2.20' }), clock)).toMatchObject({ kind: 'throttled' });
  });
});

describe('client address buckets', () => {
  it('keeps IPv4 whole and buckets IPv6 by /64', () => {
    expect(addressBucket('198.51.100.7')).toBe('198.51.100.7');
    expect(addressBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(addressBucket('::ffff:c000:280')).toBe('192.0.2.128');
    expect(addressBucket('0:0:0:0:0:ffff:c633:6407')).toBe('198.51.100.7');
    expect(addressBucket('not-an-address')).toBe('not-an-address');
  });

  it('counts two addresses of one IPv6 /64 in one bucket', async () => {
    mockVerifyApiKey.mockResolvedValue(null);
    const from = (ip: string) => bearerRequest(fakeKey(), { 'x-real-ip': ip });
    for (let i = 0; i < REFUSALS_PER_CLIENT; i++) {
      await verifyCompanyKey(from(i % 2 ? '2001:db8:1:2::a' : '2001:db8:1:2:ffff::b'));
    }
    expect(await verifyCompanyKey(from('2001:db8:1:2::c'))).toMatchObject({ kind: 'throttled' });
    expect(await verifyCompanyKey(from('2001:db8:1:3::a'))).toEqual({ kind: 'refused' });
  });

  it('counts by the rightmost x-forwarded-for entry, the one the proxy appended', async () => {
    mockVerifyApiKey.mockResolvedValue(null);
    // The client forges the left entries; the proxy appended 198.51.100.50.
    for (let i = 0; i < REFUSALS_PER_CLIENT; i++) {
      await verifyCompanyKey(bearerRequest(fakeKey(), { 'x-forwarded-for': `10.9.9.${i}, 198.51.100.50` }));
    }
    expect(
      await verifyCompanyKey(bearerRequest(fakeKey(), { 'x-forwarded-for': '10.9.9.200, 198.51.100.50' })),
    ).toMatchObject({ kind: 'throttled' });
    // The same forged left entry with another proxy-appended address is another client.
    expect(await verifyCompanyKey(bearerRequest(fakeKey(), { 'x-forwarded-for': '10.9.9.1, 198.51.100.51' }))).toEqual({
      kind: 'refused',
    });
  });
});
