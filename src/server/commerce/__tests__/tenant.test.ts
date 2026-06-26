// src/server/commerce/__tests__/tenant.test.ts
//
// Unit cover for the render-path commerce tenancy SEAM (MT-13). Until MT-18
// builds the per-tenant schema registry, `resolveCommerceSchemaForSite` maps
// EVERY resolved site to the single shared `COMMERCE_SCHEMA`. This test pins
// that documented limitation (so a future per-tenant change is a deliberate
// edit, not an accident) and proves the seam takes the resolved Site row.

import { describe, expect, it } from 'vitest';

import { resolveCommerceSchemaForSite } from '../tenant';
import { COMMERCE_SCHEMA } from '../withTenant';

describe('resolveCommerceSchemaForSite (MT-13 commerce seam)', () => {
  it('maps every site to the single shared COMMERCE_SCHEMA until MT-18', () => {
    const siteA = { workspaceId: 'ws-alpha', tenantGroupId: 'tg-alpha' };
    const siteB = { workspaceId: 'ws-beta', tenantGroupId: 'tg-beta' };

    // Two DIFFERENT tenants both resolve to the one shared schema today: this is
    // the documented BLOCK on multi-tenant commerce until MT-18 lands.
    expect(resolveCommerceSchemaForSite(siteA)).toBe(COMMERCE_SCHEMA);
    expect(resolveCommerceSchemaForSite(siteB)).toBe(COMMERCE_SCHEMA);
    expect(resolveCommerceSchemaForSite(siteA)).toBe(
      resolveCommerceSchemaForSite(siteB),
    );
  });

  it('returns an allowlist-safe identifier (never an injectable string)', () => {
    const schema = resolveCommerceSchemaForSite({
      workspaceId: 'ws',
      tenantGroupId: 'tg',
    });
    expect(schema).toMatch(/^[A-Za-z_][A-Za-z0-9_$]*$/);
  });
});
