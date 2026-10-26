// src/server/commerce/__tests__/storefrontTenant.test.ts
//
// Unit cover for the storefront edge of commerce tenancy (CM-10), with NO
// database: the host -> published-site resolver and the scoped-handle factory
// are mocked, so these assert the decision logic only.
//
//   resolveStorefrontCommerce(host)  (the four /api/commerce routes)
//     - unknown / unpublished host           -> 403 forbidden, no handle derived
//     - published site, no valid tenant group -> 404 commerce_not_provisioned,
//                                               no handle derived (fail closed)
//     - published site, valid tenant group    -> the handle for THAT group
//   commerceRepoForSite(site, root)  (the SSR render route)
//     - page without bound commerce sources -> undefined, nothing touched
//     - no valid tenant group -> undefined (render without commerce data), the
//       repo factory is never called
//     - valid tenant group    -> the factory is called with that group only
//     - any OTHER failure (missing connection string) propagates loudly

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/sites/publicResolver', () => ({
  resolvePublishedSite: vi.fn(),
}));

vi.mock('../db', () => ({
  commerceTenantDbChecked: vi.fn(async (tgId: string) => ({ __scopedHandleFor: tgId })),
  isCommerceTenantNotProvisioned: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'COMMERCE_TENANT_NOT_PROVISIONED',
}));

import { resolvePublishedSite } from '@/server/sites/publicResolver';
import type {
  CommerceServerRepository,
  ComponentNode,
} from '@/lib/renderer/publish/hydrateBindings';
import { commerceTenantDbChecked } from '../db';
import {
  COMMERCE_NOT_PROVISIONED,
  commerceRepoForSite,
  resolveStorefrontCommerce,
} from '../storefrontTenant';

const resolveSiteMock = vi.mocked(resolvePublishedSite);
const tenantDbMock = vi.mocked(commerceTenantDbChecked);

const TG_A = '018f9c10-0000-7000-8000-0000000011aa';

function publishedSite(tenantGroupId: unknown) {
  return {
    siteId: 'site_a',
    workspaceId: 'ws_a',
    tenantGroupId,
    companyId: '018f9c10-0000-7000-8000-0000000000a1',
    name: 'Store A',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    pages: [],
  } as unknown as Awaited<ReturnType<typeof resolvePublishedSite>>;
}

beforeEach(() => {
  resolveSiteMock.mockReset();
  tenantDbMock.mockClear();
});

describe('resolveStorefrontCommerce (route edge)', () => {
  it('403s a host that does not resolve to a published site, deriving no handle', async () => {
    resolveSiteMock.mockResolvedValue(null);
    const result = await resolveStorefrontCommerce('nope.example.com');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).error.code).toBe('forbidden');
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a legacy non-UUID sentinel', 'demo-tenant-group'],
  ])(
    'FAILS CLOSED with 404 commerce_not_provisioned for a published site whose tenant group is %s',
    async (_label, tenantGroupId) => {
      resolveSiteMock.mockResolvedValue(publishedSite(tenantGroupId));
      const result = await resolveStorefrontCommerce('store.example.com');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(404);
      expect((await result.response.json()).error.code).toBe(COMMERCE_NOT_PROVISIONED);
      // No handle at all: nothing can be read from ANY schema, shared or not.
      expect(tenantDbMock).not.toHaveBeenCalled();
    },
  );

  it("derives the scoped handle for the site's own tenant group from the host", async () => {
    resolveSiteMock.mockResolvedValue(publishedSite(TG_A));
    const result = await resolveStorefrontCommerce('store.example.com');

    expect(resolveSiteMock).toHaveBeenCalledWith('store.example.com');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tenantGroupId).toBe(TG_A);
    expect(tenantDbMock).toHaveBeenCalledTimes(1);
    expect(tenantDbMock).toHaveBeenCalledWith(TG_A);
    expect(result.db).toEqual({ __scopedHandleFor: TG_A });
  });

  it('answers 404 commerce_not_provisioned for a valid tenant group whose schema does not exist', async () => {
    resolveSiteMock.mockResolvedValue(publishedSite(TG_A));
    tenantDbMock.mockRejectedValueOnce(
      Object.assign(new Error('commerce schema tg_x does not exist'), {
        code: 'COMMERCE_TENANT_NOT_PROVISIONED',
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await resolveStorefrontCommerce('store.example.com');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(404);
    expect((await result.response.json()).error.code).toBe(COMMERCE_NOT_PROVISIONED);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('lets a non-tenant failure (e.g. the resolver throwing) propagate to the route', async () => {
    resolveSiteMock.mockRejectedValue(new Error('db down'));
    await expect(resolveStorefrontCommerce('store.example.com')).rejects.toThrow('db down');
  });
});

/** A page tree with a BOUND ProductList (needs the commerce repo). */
const COMMERCE_PAGE = {
  type: 'div',
  props: {},
  children: [
    {
      type: 'div',
      props: { 'data-component-kind': 'product-list' },
      bindings: { products: { kind: 'commerce' } },
    },
  ],
} as unknown as ComponentNode;

/** A CMS-only page tree (an unbound ProductList renders a placeholder). */
const CMS_ONLY_PAGE = {
  type: 'div',
  props: {},
  children: [
    { type: 'h1', props: { children: 'Hello' } },
    { type: 'div', props: { 'data-component-kind': 'product-list' } },
  ],
} as unknown as ComponentNode;

describe('commerceRepoForSite (SSR render edge)', () => {
  const fakeRepo = { listProducts: vi.fn() } as unknown as CommerceServerRepository;

  it('never builds a repo (never touches the commerce connection) for a page without bound commerce sources', async () => {
    const build = vi.fn(async () => fakeRepo);
    expect(await commerceRepoForSite({ siteId: 's1', tenantGroupId: TG_A, companyId: null }, CMS_ONLY_PAGE, build)).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });

  it('returns undefined (render WITHOUT commerce data) when the site has no valid tenant group', async () => {
    const build = vi.fn(async () => fakeRepo);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const tenantGroupId of ['', null, 'demo-tenant-group']) {
      expect(
        await commerceRepoForSite(
          { siteId: 's', tenantGroupId: tenantGroupId as unknown as string, companyId: null },
          COMMERCE_PAGE,
          build,
        ),
      ).toBeUndefined();
    }

    // The repo factory (and so the scoped handle) is never built: no schema read.
    expect(build).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("builds the repo for the site's own tenant group only", async () => {
    const build = vi.fn(async () => fakeRepo);
    expect(await commerceRepoForSite({ siteId: 's1', tenantGroupId: TG_A, companyId: null }, COMMERCE_PAGE, build)).toBe(fakeRepo);
    expect(build).toHaveBeenCalledWith(TG_A);
  });

  it('renders without commerce data (and logs) when the tenant schema does not exist', async () => {
    const build = vi.fn(async () => {
      throw Object.assign(new Error('commerce schema tg_x does not exist'), {
        code: 'COMMERCE_TENANT_NOT_PROVISIONED',
      });
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await commerceRepoForSite({ siteId: 's1', tenantGroupId: TG_A, companyId: null }, COMMERCE_PAGE, build)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rendering without commerce data'));
    errorSpy.mockRestore();
  });

  it('propagates a non-tenant failure (misconfigured deploy) instead of hiding the shop', async () => {
    const build = vi.fn(async () => {
      throw new Error('COMMERCE_APP_DATABASE_URL is not set');
    });
    await expect(
      commerceRepoForSite({ siteId: 's1', tenantGroupId: TG_A, companyId: null }, COMMERCE_PAGE, build),
    ).rejects.toThrow('COMMERCE_APP_DATABASE_URL is not set');
  });
});
