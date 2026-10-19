// src/server/sites/__tests__/scope.test.ts
//
// The pure active-COMPANY resolution (resolveActiveCompany) and the scope it
// feeds (resolveActiveScope -> companyWorkspaceId -> resolveScopeForWorkspace).
// Only companies holding the auth-brain app grant `sites` (and with a
// workspace for the user) count. The order: the `framer_company` cookie, the
// retired `framer_ws` cookie mapped to its company, session.active_tenant, the
// only usable company; otherwise `sites_not_enabled` (no granted company) or
// `no_active_company` (the chooser).

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import {
  APP_GRANT_SKEW_MESSAGE,
  activeScopeDenial,
  companyWorkspaceId,
  grantedCompaniesWithoutWorkspace,
  listCompanyChoices,
  resolveActiveCompany,
  resolveActiveScope,
  resolveScopeForCompanyWorkspace,
  sitesGrantedCompanyIds,
} from '../scope';

const NONE = { companyCookie: null, legacyWorkspaceCookie: null };

// Acme and Beta have Sites; Corp (a company of the same user) does not.
function session(over: Partial<Record<string, unknown>> = {}): SessionVerifyResponse {
  return {
    user: { id: 'u' },
    session: {},
    tenants: [
      { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme', app_grants: ['sites'] },
      { id: 't-b', group_id: 'tg_b', name: 'Beta', slug: 'beta', app_grants: ['studio', 'sites'] },
      { id: 't-c', group_id: 'tg_c', name: 'Corp', slug: 'corp', app_grants: ['studio'] },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 't-a', name: 'Main', slug: 'main' },
      { id: 'ws_b', tenant_id: 't-b', name: 'Main', slug: 'main' },
      { id: 'ws_c', tenant_id: 't-c', name: 'Main', slug: 'main' },
    ],
    active_tenant: null,
    active_workspace: null,
    ...over,
  } as unknown as SessionVerifyResponse;
}

afterEach(() => vi.restoreAllMocks());

describe('resolveActiveCompany: the order', () => {
  it('1. the framer_company cookie wins over everything else', () => {
    const s = session({ active_tenant: { id: 't-a' } });
    expect(
      resolveActiveCompany(s, { companyCookie: 't-b', legacyWorkspaceCookie: 'ws_a' }),
    ).toEqual({ ok: true, companyId: 't-b', source: 'cookie' });
  });

  it('2. the legacy framer_ws cookie is mapped to its company', () => {
    expect(
      resolveActiveCompany(session({ active_tenant: { id: 't-a' } }), {
        companyCookie: null,
        legacyWorkspaceCookie: 'ws_b',
      }),
    ).toEqual({ ok: true, companyId: 't-b', source: 'legacy_cookie' });
  });

  it('3. active_tenant when there is no usable cookie', () => {
    expect(resolveActiveCompany(session({ active_tenant: { id: 't-b' } }), NONE)).toEqual({
      ok: true,
      companyId: 't-b',
      source: 'active_tenant',
    });
  });

  it('4. the only usable company', () => {
    const s = session({
      tenants: [
        { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme', app_grants: ['sites'] },
        { id: 't-c', group_id: 'tg_c', name: 'Corp', slug: 'corp', app_grants: [] },
      ],
    });
    expect(resolveActiveCompany(s, NONE)).toEqual({
      ok: true,
      companyId: 't-a',
      source: 'only_company',
    });
  });

  it('no_active_company for several usable companies and no selection', () => {
    expect(resolveActiveCompany(session(), NONE)).toEqual({
      ok: false,
      error: 'no_active_company',
    });
  });

  it('sites_not_enabled when no company of the session holds the grant', () => {
    const s = session({
      tenants: [{ id: 't-c', group_id: 'tg_c', name: 'Corp', slug: 'corp', app_grants: ['studio'] }],
      active_tenant: { id: 't-c' },
    });
    expect(resolveActiveCompany(s, { companyCookie: 't-c', legacyWorkspaceCookie: 'ws_c' })).toEqual({
      ok: false,
      error: 'sites_not_enabled',
    });
  });

  it('sites_not_enabled for a session with no companies at all', () => {
    expect(resolveActiveCompany(session({ tenants: [], workspaces: [] }), NONE)).toEqual({
      ok: false,
      error: 'sites_not_enabled',
    });
  });
});

describe('resolveActiveCompany: grant filtering and forged selectors', () => {
  it('ignores a forged company cookie (not in the session)', () => {
    expect(
      resolveActiveCompany(session({ active_tenant: { id: 't-a' } }), {
        companyCookie: 't-evil',
        legacyWorkspaceCookie: null,
      }),
    ).toEqual({ ok: true, companyId: 't-a', source: 'active_tenant' });
  });

  it('ignores a company cookie naming a company WITHOUT the grant', () => {
    expect(
      resolveActiveCompany(session({ active_tenant: { id: 't-a' } }), {
        companyCookie: 't-c',
        legacyWorkspaceCookie: null,
      }),
    ).toEqual({ ok: true, companyId: 't-a', source: 'active_tenant' });
  });

  it('ignores a legacy cookie whose workspace belongs to a company without the grant', () => {
    expect(
      resolveActiveCompany(session(), { companyCookie: null, legacyWorkspaceCookie: 'ws_c' }),
    ).toEqual({ ok: false, error: 'no_active_company' });
  });

  it('ignores a legacy cookie naming a workspace outside the session', () => {
    expect(
      resolveActiveCompany(session({ active_tenant: { id: 't-b' } }), {
        companyCookie: null,
        legacyWorkspaceCookie: 'ws_evil',
      }),
    ).toEqual({ ok: true, companyId: 't-b', source: 'active_tenant' });
  });

  it('does not trust an active_tenant without the grant', () => {
    expect(resolveActiveCompany(session({ active_tenant: { id: 't-c' } }), NONE)).toEqual({
      ok: false,
      error: 'no_active_company',
    });
  });

  it('a revoked grant makes a stale company cookie fall back on the next request', () => {
    const revoked = session({
      tenants: [
        { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme', app_grants: ['sites'] },
        { id: 't-b', group_id: 'tg_b', name: 'Beta', slug: 'beta', app_grants: [] },
      ],
    });
    expect(resolveActiveCompany(revoked, { companyCookie: 't-b', legacyWorkspaceCookie: null })).toEqual({
      ok: true,
      companyId: 't-a',
      source: 'only_company',
    });
  });

  it('inherited companies do not count, even with the grant', () => {
    const s = session({
      tenants: [],
      inherited_tenants: [
        { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme', app_grants: ['sites'] },
      ],
    });
    expect(resolveActiveCompany(s, { companyCookie: 't-a', legacyWorkspaceCookie: null })).toEqual({
      ok: false,
      error: 'sites_not_enabled',
    });
  });

  it('a granted company without a workspace for the user is never resolved', () => {
    const s = session({
      workspaces: [{ id: 'ws_c', tenant_id: 't-c', name: 'Main', slug: 'main' }],
    });
    expect(resolveActiveCompany(s, { companyCookie: 't-a', legacyWorkspaceCookie: null })).toEqual({
      ok: false,
      error: 'no_active_company',
    });
    expect(grantedCompaniesWithoutWorkspace(s)).toEqual(['Acme', 'Beta']);
  });
});

describe('sitesGrantedCompanyIds: version skew', () => {
  it('fails an entry without app_grants closed and logs the skew line once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = session({
      tenants: [
        { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme' },
        { id: 't-b', group_id: 'tg_b', name: 'Beta', slug: 'beta' },
      ],
    });
    expect(sitesGrantedCompanyIds(s)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(APP_GRANT_SKEW_MESSAGE);
  });

  it('an empty grant list is a plain "not granted" (no log)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      sitesGrantedCompanyIds(
        session({ tenants: [{ id: 't-a', group_id: 'tg_a', name: 'A', slug: 'a', app_grants: [] }] }),
      ),
    ).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('companyWorkspaceId: one workspace per company, deterministically', () => {
  it('the only workspace of the company', () => {
    expect(companyWorkspaceId(session(), 't-b')).toBe('ws_b');
  });

  it('the workspace with slug main when the company has several', () => {
    const s = session({
      workspaces: [
        { id: 'ws_old', tenant_id: 't-a', slug: 'archive', created_at: '2020-01-01T00:00:00Z' },
        { id: 'ws_main', tenant_id: 't-a', slug: 'main', created_at: '2026-01-01T00:00:00Z' },
      ],
    });
    expect(companyWorkspaceId(s, 't-a')).toBe('ws_main');
  });

  it('the oldest workspace (ties by id) when none is main', () => {
    const s = session({
      workspaces: [
        { id: 'ws_z', tenant_id: 't-a', slug: 'z', created_at: '2024-01-01T00:00:00Z' },
        { id: 'ws_y', tenant_id: 't-a', slug: 'y', created_at: '2024-01-01T00:00:00Z' },
        { id: 'ws_new', tenant_id: 't-a', slug: 'n', created_at: '2025-01-01T00:00:00Z' },
      ],
    });
    expect(companyWorkspaceId(s, 't-a')).toBe('ws_y');
  });

  it('null when the session lists no workspace of the company', () => {
    expect(companyWorkspaceId(session(), 't-unknown')).toBeNull();
  });
});

describe('resolveActiveScope', () => {
  it("derives the scope of the active company's workspace", () => {
    expect(
      resolveActiveScope(session(), { companyCookie: 't-b', legacyWorkspaceCookie: null }),
    ).toEqual({ ok: true, scope: { workspaceId: 'ws_b', tenantGroupId: 'tg_b' }, companyId: 't-b' });
  });

  it('switching the company changes the scope', () => {
    const a = resolveActiveScope(session(), { companyCookie: 't-a', legacyWorkspaceCookie: null });
    const b = resolveActiveScope(session(), { companyCookie: 't-b', legacyWorkspaceCookie: null });
    expect(a.ok && a.scope.workspaceId).toBe('ws_a');
    expect(b.ok && b.scope.workspaceId).toBe('ws_b');
  });

  it('passes the resolution error through', () => {
    expect(resolveActiveScope(session(), NONE)).toEqual({ ok: false, error: 'no_active_company' });
  });
});

describe('resolveScopeForCompanyWorkspace', () => {
  it("accepts a granted company's workspace", () => {
    expect(resolveScopeForCompanyWorkspace(session(), 'ws_a')).toEqual({
      ok: true,
      scope: { workspaceId: 'ws_a', tenantGroupId: 'tg_a' },
      companyId: 't-a',
    });
  });

  it("refuses the workspace of a company without the grant as sites_not_enabled", () => {
    expect(resolveScopeForCompanyWorkspace(session(), 'ws_c')).toEqual({
      ok: false,
      error: 'sites_not_enabled',
    });
  });

  it('refuses a workspace outside the session', () => {
    expect(resolveScopeForCompanyWorkspace(session(), 'ws_evil')).toEqual({
      ok: false,
      error: 'workspace_not_in_session',
    });
  });
});

describe('listCompanyChoices', () => {
  it('lists only granted companies with a workspace, by name, without the workspace name', () => {
    expect(listCompanyChoices(session())).toEqual([
      { id: 't-a', name: 'Acme', slug: 'acme', workspaceId: 'ws_a' },
      { id: 't-b', name: 'Beta', slug: 'beta', workspaceId: 'ws_b' },
    ]);
  });

  it('drops duplicate tenant rows', () => {
    const s = session();
    const doubled = session({ tenants: [...s.tenants, ...s.tenants] });
    expect(listCompanyChoices(doubled).map((c) => c.id)).toEqual(['t-a', 't-b']);
  });
});

describe('activeScopeDenial', () => {
  it('keeps sites_not_enabled and maps everything else to no_active_company', () => {
    expect(activeScopeDenial('sites_not_enabled').code).toBe('sites_not_enabled');
    expect(activeScopeDenial('no_active_company').code).toBe('no_active_company');
    expect(activeScopeDenial('workspace_not_in_session').code).toBe('no_active_company');
    expect(activeScopeDenial('tenant_not_in_session').code).toBe('no_active_company');
  });
});
