// src/server/commerce/__tests__/tenant.test.ts
//
// Unit cover for the commerce tenancy chokepoint (CM-10):
// `resolveTenantGroupForSite` maps a resolved published site to the validated
// tenant-group id its `tg_<hex32>` schema is derived from, and FAILS CLOSED on a
// site with no usable tenant group id (no shared-schema fallback exists).

import { describe, expect, it } from 'vitest';
import { TenantSchemaError, tenantSchema } from '@marlinjai/tenant-db';

import { isTenantSchemaError, resolveTenantGroupForSite } from '../tenant';

const TG_A = '018f9c10-0000-7000-8000-0000000010aa';
const TG_B = '018f9c10-0000-7000-8000-0000000010bb';

describe('resolveTenantGroupForSite (CM-10 commerce tenancy chokepoint)', () => {
  it("returns the site's own tenant group id, so two tenants get two schemas", () => {
    const a = resolveTenantGroupForSite({ tenantGroupId: TG_A });
    const b = resolveTenantGroupForSite({ tenantGroupId: TG_B });

    expect(a).toBe(TG_A);
    expect(b).toBe(TG_B);
    // Each derives its OWN schema: there is no shared commerce schema any more.
    expect(tenantSchema(a)).toBe(`tg_${TG_A.replace(/-/g, '')}`);
    expect(tenantSchema(a)).not.toBe(tenantSchema(b));
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['the legacy demo sentinel', 'demo-tenant-group'],
    ['a non-UUID test id', 'test-tg'],
    ['an injection attempt', 'x"; DROP SCHEMA public; --'],
  ])('fails CLOSED (throws TenantSchemaError) for %s', (_label, tenantGroupId) => {
    let thrown: unknown;
    try {
      resolveTenantGroupForSite({ tenantGroupId });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TenantSchemaError);
    expect(isTenantSchemaError(thrown)).toBe(true);
  });

  it('isTenantSchemaError recognizes the stable code and rejects other errors', () => {
    expect(isTenantSchemaError({ code: 'TENANT_SCHEMA_INVALID' })).toBe(true);
    expect(isTenantSchemaError(new Error('connection refused'))).toBe(false);
    expect(isTenantSchemaError(null)).toBe(false);
  });
});
