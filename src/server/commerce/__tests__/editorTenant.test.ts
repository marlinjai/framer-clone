// src/server/commerce/__tests__/editorTenant.test.ts
//
// Unit cover for the EDITOR edge of commerce tenancy (editorTenant.ts), with no
// database: the session verify, the auth-brain access check, the site lookup and
// the scoped-handle factory are faked. It pins the decision order:
//   no session -> 401; unknown project / workspace not in session / no viewSite
//   -> the SAME 403; site without a valid tenant group -> 404
//   commerce_not_provisioned; site tenant group differing from the session's
//   own tenant group for that workspace -> 403; otherwise the handle for THAT
//   project's tenant group.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

vi.mock('@/lib/auth-api', () => ({ getVerifiedSession: vi.fn() }));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn() }));
vi.mock('@/server/db', () => ({ getPrismaClient: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  commerceTenantDbChecked: vi.fn(async (tgId: string) => ({ __scopedHandleFor: tgId })),
  isCommerceTenantNotProvisioned: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'COMMERCE_TENANT_NOT_PROVISIONED',
}));

import { getVerifiedSession } from '@/lib/auth-api';
import { AuthUnavailableError, AuthzUnavailableError } from '@/lib/authBrainAvailability';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { commerceTenantDbChecked } from '../db';
import { resolveEditorCommerce } from '../editorTenant';

const sessionMock = vi.mocked(getVerifiedSession);
const accessMock = vi.mocked(checkWorkspaceAccess);
const tenantDbMock = vi.mocked(commerceTenantDbChecked);

const TG_A = '018f9c10-0000-7000-8000-0000000016aa';
const TG_B = '018f9c10-0000-7000-8000-0000000016bb';

function session(workspaceId: string, groupId: string): SessionVerifyResponse {
  return {
    user: { id: 'user_1' },
    workspaces: [{ id: workspaceId, tenant_id: 'tenant_1' }],
    tenants: [{ id: 'tenant_1', group_id: groupId }],
    active_workspace: { id: workspaceId },
  } as unknown as SessionVerifyResponse;
}

function prismaWith(site: { workspaceId: string; tenantGroupId: string } | null) {
  return {
    site: { findUnique: vi.fn(async () => site) },
  } as unknown as PrismaClient;
}

const req = new Request('http://app/api/projects/p1/commerce/products');

async function statusOf(result: Awaited<ReturnType<typeof resolveEditorCommerce>>) {
  if (result.ok) return { status: 200, code: 'ok' };
  return { status: result.response.status, code: (await result.response.json()).error.code };
}

afterEach(() => {
  delete process.env.EDITOR_HOST;
});

beforeEach(() => {
  sessionMock.mockReset();
  accessMock.mockReset();
  tenantDbMock.mockClear();
  sessionMock.mockResolvedValue(session('ws_a', TG_A));
  accessMock.mockResolvedValue(true);
});

describe('resolveEditorCommerce', () => {
  it('401s without a verified session (and a throwing verify)', async () => {
    sessionMock.mockResolvedValueOnce(null);
    expect(await statusOf(await resolveEditorCommerce(req, 'p1', prismaWith(null)))).toEqual({
      status: 401,
      code: 'unauthorized',
    });
    sessionMock.mockRejectedValueOnce(new Error('unexpected'));
    expect((await statusOf(await resolveEditorCommerce(req, 'p1', prismaWith(null)))).status).toBe(401);
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('503s auth_unavailable when auth-brain cannot answer (never "signed out")', async () => {
    sessionMock.mockRejectedValueOnce(new AuthUnavailableError(new Error('auth-brain down')));
    expect(await statusOf(await resolveEditorCommerce(req, 'p1', prismaWith(null)))).toEqual({
      status: 503,
      code: 'auth_unavailable',
    });
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('503s authz_unavailable (never 403) when the permission check cannot be answered', async () => {
    accessMock.mockRejectedValueOnce(new AuthzUnavailableError(new Error('openfga 401')));
    expect(
      await statusOf(
        await resolveEditorCommerce(req, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A })),
      ),
    ).toEqual({ status: 503, code: 'authz_unavailable' });
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('answers the SAME 403 for an unknown project, a foreign workspace and a denied permission', async () => {
    const unknown = await resolveEditorCommerce(req, 'p1', prismaWith(null));
    const foreign = await resolveEditorCommerce(
      req,
      'p1',
      prismaWith({ workspaceId: 'ws_other', tenantGroupId: TG_B }),
    );
    accessMock.mockResolvedValueOnce(false);
    const denied = await resolveEditorCommerce(
      req,
      'p1',
      prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A }),
    );
    for (const r of [unknown, foreign, denied]) {
      expect(await statusOf(r)).toEqual({ status: 403, code: 'forbidden' });
    }
    expect(accessMock).toHaveBeenCalledWith('user_1', 'ws_a', 'viewSite');
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED with 404 commerce_not_provisioned when the site has no valid tenant group', async () => {
    for (const tenantGroupId of ['', 'demo-tenant-group']) {
      const r = await resolveEditorCommerce(req, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId }));
      expect(await statusOf(r)).toEqual({ status: 404, code: 'commerce_not_provisioned' });
    }
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it("403s when the site's tenant group is not the session's own group for that workspace", async () => {
    const r = await resolveEditorCommerce(req, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_B }));
    expect(await statusOf(r)).toEqual({ status: 403, code: 'forbidden' });
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it("returns the scoped handle for THAT project's tenant group", async () => {
    const r = await resolveEditorCommerce(req, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.db).toEqual({ __scopedHandleFor: TG_A });
    expect(tenantDbMock).toHaveBeenCalledWith(TG_A);
  });

  it('404s on a published storefront host EVEN WITH a valid session, without reading the session', async () => {
    process.env.EDITOR_HOST = 'app.lumitra.co';
    const onStorefront = new Request('https://acme.sites.lumitra.co/api/projects/p1/commerce/products', {
      headers: { host: 'acme.sites.lumitra.co', cookie: 'lumitra_session=valid' },
    });
    const r = await resolveEditorCommerce(onStorefront, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A }));
    expect(await statusOf(r)).toEqual({ status: 404, code: 'not_found' });
    expect(sessionMock).not.toHaveBeenCalled();
    expect(tenantDbMock).not.toHaveBeenCalled();

    // The editor host (and localhost) still work.
    for (const host of ['app.lumitra.co', 'localhost:3000']) {
      const onEditor = new Request(`https://${host}/api/projects/p1/commerce/products`, {
        headers: { host },
      });
      const ok = await resolveEditorCommerce(onEditor, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A }));
      expect(ok.ok).toBe(true);
    }
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['malformed', 'not-a-uuid'],
  ])('403s (never a TypeError 500) when the session tenant group id is %s', async (_l, groupId) => {
    sessionMock.mockResolvedValue(session('ws_a', groupId as unknown as string));
    const r = await resolveEditorCommerce(req, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A }));
    expect(await statusOf(r)).toEqual({ status: 403, code: 'forbidden' });
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('answers 404 commerce_not_provisioned when the tenant schema does not exist', async () => {
    tenantDbMock.mockRejectedValueOnce(
      Object.assign(new Error('schema missing'), { code: 'COMMERCE_TENANT_NOT_PROVISIONED' }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await resolveEditorCommerce(req, 'p1', prismaWith({ workspaceId: 'ws_a', tenantGroupId: TG_A }));
    expect(await statusOf(r)).toEqual({ status: 404, code: 'commerce_not_provisioned' });
    errorSpy.mockRestore();
  });
});
