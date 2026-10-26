// src/server/commerce/__tests__/renderCommerceGate.test.ts
//
// The render route's commerce gate against the REAL db.ts wiring, with
// COMMERCE_APP_DATABASE_URL UNSET (no mocks, no database):
//   - a page WITHOUT bound commerce sources renders (no handle is ever derived,
//     so the missing variable cannot 500 a CMS-only page),
//   - a page WITH bound commerce sources fails LOUDLY with the named
//     configuration error (never silently empty shop slots).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { commerceRepoForSite } from '../storefrontTenant';

const SITE = { siteId: 'site_a', tenantGroupId: '018f9c10-0000-7000-8000-0000000014aa', companyId: null };

const COMMERCE_PAGE = {
  type: 'div',
  props: {},
  children: [
    {
      type: 'div',
      props: { 'data-component-kind': 'product-detail' },
      bindings: { product: { kind: 'commerce' } },
    },
  ],
} as unknown as ComponentNode;

const CMS_ONLY_PAGE = {
  type: 'div',
  props: {},
  children: [
    { type: 'h1', props: { children: 'About us' } },
    // An interactive island is never baked, so it needs no repository either.
    { type: 'div', props: { 'data-component-kind': 'cart-view' } },
  ],
} as unknown as ComponentNode;

let saved: string | undefined;
beforeAll(() => {
  saved = process.env.COMMERCE_APP_DATABASE_URL;
  delete process.env.COMMERCE_APP_DATABASE_URL;
});
afterAll(() => {
  if (saved !== undefined) process.env.COMMERCE_APP_DATABASE_URL = saved;
});

describe('render commerce gate with COMMERCE_APP_DATABASE_URL unset', () => {
  it('a page without commerce bindings gets no repo and does NOT throw', async () => {
    await expect(commerceRepoForSite(SITE, CMS_ONLY_PAGE)).resolves.toBeUndefined();
  });

  it('a page with commerce bindings fails loudly with the named configuration error', async () => {
    await expect(commerceRepoForSite(SITE, COMMERCE_PAGE)).rejects.toThrow(
      /COMMERCE_APP_DATABASE_URL is not set/,
    );
  });
});
