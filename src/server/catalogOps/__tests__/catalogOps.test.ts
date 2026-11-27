// src/server/catalogOps/__tests__/catalogOps.test.ts
//
// The checks the catalogue operations make before any catalogue row is read (plan
// docs/plans/2026-11-27-agent-catalogue-tools.md, "How the company and the site are verified"), with fakes for
// the site lookup and the shop schema: a refused or failed check never opens the shop schema. The reads
// themselves are proven against a real database in src/server/mcp/__tests__/mcp-catalog.itest.ts.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db', () => ({ getPrismaClient: () => ({}) }));

import type { SiteOpsCaller } from '@/lib/siteOps/types';
import { SiteNotFoundError } from '@/server/sites';

import { getSiteProduct, listSiteProducts, resolveSiteCatalog, type CatalogOpsDeps } from '..';

const COMPANY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const GROUP = '018f9c10-0000-7000-8000-0000000c4a71';

function caller(can: SiteOpsCaller['can'], companyId = COMPANY): SiteOpsCaller {
  return {
    scope: { workspaceId: 'ws-1', tenantGroupId: GROUP },
    companyId,
    companySlug: 'acme',
    actor: { kind: 'key', id: 'key-1' },
    can,
  } as SiteOpsCaller;
}

function deps(context: (siteId: string) => unknown, opened: string[] = []): CatalogOpsDeps {
  return {
    branches: {
      branches: {
        siteBranchContext: vi.fn(async (_scope: unknown, siteId: string) => context(siteId)),
      } as never,
    },
    tenantDb: vi.fn(async (tgId: string) => {
      opened.push(tgId);
      return {} as never;
    }),
  };
}

const mainSite = (siteId: string) => ({ kind: 'main', siteId, openBranches: 0 });

describe('resolveSiteCatalog', () => {
  it('a caller without viewSite is refused before the site or the shop schema is touched', async () => {
    const opened: string[] = [];
    const lookup = vi.fn(mainSite);
    const d = deps(lookup, opened);
    const result = await listSiteProducts(caller(() => false), { siteId: 'site-1' }, d);
    expect(result).toEqual({ ok: false, error: { code: 'forbidden', message: 'this caller may not viewSite' } });
    expect(lookup).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('a permission service that cannot answer is unavailable, never a yes', async () => {
    const opened: string[] = [];
    const result = await getSiteProduct(
      caller(() => Promise.reject(new Error('openfga down'))),
      { siteId: 'site-1', productId: 'p-1' },
      deps(mainSite, opened),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable', retryAfterSec: 5 } });
    expect(opened).toEqual([]);
  });

  it("a site outside the caller's workspace is site_not_found and opens no shop schema", async () => {
    const opened: string[] = [];
    const result = await listSiteProducts(
      caller(() => true),
      { siteId: 'elsewhere' },
      deps(() => {
        throw new SiteNotFoundError('elsewhere');
      }, opened),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'site_not_found' } });
    expect(opened).toEqual([]);
  });

  it("a branch id resolves to its main site, in the caller's own tenant group and company", async () => {
    const opened: string[] = [];
    const result = await resolveSiteCatalog(
      caller(() => true),
      'branch-1',
      'viewSite',
      deps(() => ({ kind: 'branch', siteId: 'branch-1', mainSiteId: 'site-1', branch: {} }), opened),
    );
    expect(result.ok && result.value.siteId).toBe('site-1');
    expect(result.ok && result.value.scope.tenantId).toBe(COMPANY);
    expect(result.ok && result.value.scope.tgId).toBe(GROUP);
    expect(opened).toEqual([GROUP]);
  });

  it('a tenant group without a shop schema is catalog_not_provisioned', async () => {
    const d = deps(mainSite);
    d.tenantDb = vi.fn(async () => {
      throw Object.assign(new Error('commerce schema tg_x does not exist'), { code: 'COMMERCE_TENANT_NOT_PROVISIONED' });
    });
    const result = await listSiteProducts(caller(() => true), { siteId: 'site-1' }, d);
    expect(result).toMatchObject({ ok: false, error: { code: 'catalog_not_provisioned' } });
  });

  it('an unexpected failure answers a generic message and never its own text', async () => {
    const d = deps(mainSite);
    d.tenantDb = vi.fn(async () => {
      throw new Error('connection to 10.0.0.5 refused');
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await listSiteProducts(caller(() => true), { siteId: 'site-1' }, d);
    quiet.mockRestore();
    expect(result).toMatchObject({ ok: false, error: { code: 'failed' } });
    if (!result.ok) expect(result.error.message).not.toContain('10.0.0.5');
  });

  it('a company id that is not a lowercase uuid owns no catalogue', async () => {
    const result = await resolveSiteCatalog(caller(() => true, 'Not-A-Uuid'), 'site-1', 'viewSite', deps(mainSite));
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});
