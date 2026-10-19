// src/server/sites/__tests__/scope.test.ts
//
// The pure active-workspace resolution order (resolveActiveWorkspaceId) and the
// scope it feeds (resolveActiveScope -> resolveScopeForWorkspace). The order:
// membership-checked `framer_ws` cookie, else session.active_workspace (when a
// member), else the only workspace, else null (the chooser).

import { describe, it, expect } from 'vitest';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import {
  listWorkspaceChoices,
  resolveActiveScope,
  resolveActiveWorkspaceId,
} from '../scope';

function session(over: Partial<Record<string, unknown>> = {}): SessionVerifyResponse {
  return {
    user: { id: 'u' },
    session: {},
    tenants: [
      { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme' },
      { id: 't-b', group_id: 'tg_b', name: 'Beta', slug: 'beta' },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 't-a', name: 'Acme', slug: 'acme' },
      { id: 'ws_b', tenant_id: 't-b', name: 'Shop', slug: 'beta-shop' },
    ],
    active_tenant: { id: 't-b' },
    active_workspace: null,
    ...over,
  } as unknown as SessionVerifyResponse;
}

describe('resolveActiveWorkspaceId', () => {
  it('1. the cookie wins when the session contains it', () => {
    expect(
      resolveActiveWorkspaceId(session({ active_workspace: { id: 'ws_a' } }), 'ws_b'),
    ).toBe('ws_b');
  });

  it('a forged cookie is ignored and falls through to active_workspace', () => {
    expect(
      resolveActiveWorkspaceId(session({ active_workspace: { id: 'ws_a' } }), 'ws_evil'),
    ).toBe('ws_a');
  });

  it('2. active_workspace when there is no cookie', () => {
    expect(resolveActiveWorkspaceId(session({ active_workspace: { id: 'ws_b' } }), null)).toBe(
      'ws_b',
    );
  });

  it('an active_workspace the session does not contain is not trusted', () => {
    expect(
      resolveActiveWorkspaceId(session({ active_workspace: { id: 'ws_gone' } }), null),
    ).toBeNull();
  });

  it('3. the only workspace when there is exactly one', () => {
    const s = session({
      workspaces: [{ id: 'ws_a', tenant_id: 't-a', name: 'Acme', slug: 'acme' }],
    });
    expect(resolveActiveWorkspaceId(s, undefined)).toBe('ws_a');
    expect(resolveActiveWorkspaceId(s, 'ws_stale')).toBe('ws_a');
  });

  it('4. null for several workspaces and no selection (active_tenant is not a tiebreak)', () => {
    expect(resolveActiveWorkspaceId(session(), null)).toBeNull();
    expect(resolveActiveWorkspaceId(session(), '')).toBeNull();
  });

  it('null for a session with no workspaces at all', () => {
    expect(resolveActiveWorkspaceId(session({ workspaces: [] }), 'ws_a')).toBeNull();
  });
});

describe('resolveActiveScope', () => {
  it('derives the tenant group of the selected workspace', () => {
    expect(resolveActiveScope(session(), 'ws_b')).toEqual({
      ok: true,
      scope: { workspaceId: 'ws_b', tenantGroupId: 'tg_b' },
    });
  });

  it('no_active_workspace when nothing is resolvable', () => {
    expect(resolveActiveScope(session(), null)).toEqual({
      ok: false,
      error: 'no_active_workspace',
    });
  });

  it('still denies when the selected workspace’s tenant is missing from the session', () => {
    expect(resolveActiveScope(session({ tenants: [] }), 'ws_a')).toEqual({
      ok: false,
      error: 'tenant_not_in_session',
    });
  });
});

describe('listWorkspaceChoices', () => {
  it('labels each workspace with its company, sorted by company', () => {
    expect(listWorkspaceChoices(session())).toEqual([
      { id: 'ws_a', name: 'Acme', slug: 'acme', companyName: 'Acme', companySlug: 'acme' },
      { id: 'ws_b', name: 'Shop', slug: 'beta-shop', companyName: 'Beta', companySlug: 'beta' },
    ]);
  });

  it('drops duplicate workspace rows', () => {
    const s = session();
    const doubled = session({ workspaces: [...s.workspaces, ...s.workspaces] });
    expect(listWorkspaceChoices(doubled).map((w) => w.id)).toEqual(['ws_a', 'ws_b']);
  });
});
