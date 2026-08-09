// renderPublishedPage.itest.ts
//
// The END-TO-END render smoke for the published-site SSR chain, against a REAL
// Postgres with REAL seeded CMS + commerce rows. Until now the whole chain
// (resolve -> snapshot adapt -> hydrate -> render) was covered ONLY by unit tests
// with MOCKED repos; it had never executed against a live database. This file
// closes that gap as a permanent regression guard.
//
// It exercises the REAL chain with NO mocks:
//   resolvePublishedSite (real Prisma read)
//     -> matchPageBySlug (home + the HOME_REWRITE_SENTINEL)
//     -> snapshotToComponentNode (snapshot adapt)
//     -> hydrateBindings (REAL getCmsRepository() + the scoped tg_<demo> commerce
//        read repo hitting the seeded DB)
//     -> renderComponentNode -> renderToStaticMarkup (HTML string)
//
// and asserts the high-signal proofs: the published-only resolver contract, the
// home/sentinel match equivalence, real CMS Collection + commerce ProductList
// hydration appearing in the HTML, all four interactive island kinds present in
// the server markup, and graceful degradation of unbound/empty data slots.
//
// The `.itest.ts` suffix keeps this OUT of the headless `pnpm test` unit gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs ONLY under
// `pnpm test:integration`. The shared globalSetup (vitest.integration.setup.ts)
// boots a Dockerized Postgres, runs `prisma migrate deploy`, and exposes
// DATABASE_URL before the workers fork. It requires a running Docker daemon.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import { getCmsRepository } from '@/server/cms';
import { getCommerceServerRepositoryDb } from '@/server/commerce/repository/read';
import { commerceTenantDb } from '@/server/commerce/db';
import {
  resolvePublishedSite,
  matchPageBySlug,
  HOME_REWRITE_SENTINEL,
  type PublishedSite,
} from '@/server/sites/publicResolver';
import { snapshotToComponentNode } from '../snapshotToComponentNode';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';
import { renderComponentNode } from '../renderComponentNode';
import CommercePageProviders from '../CommercePageProviders';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';
import { seedDemoSite, DEMO_TENANT_GROUP_ID, type SeededDemo } from '../seedDemoSite';

let prisma: PrismaClient;
let seeded: SeededDemo;

beforeAll(async () => {
  // getPrismaClient() reads process.env.DATABASE_URL (set by the shared
  // globalSetup) at construction, so this is the SAME container DB that
  // getCmsRepository() / getCommerceServerRepository() default to. One client,
  // one pool: the seed writes and the render-path reads share it.
  prisma = getPrismaClient();
  seeded = await seedDemoSite(prisma);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Run the REAL render chain for the seeded HOME page against the live repos and
 * return the static-rendered HTML string. NO mocks anywhere on this path.
 */
async function renderHomeToHtml(site: PublishedSite): Promise<string> {
  const matched = matchPageBySlug(site.pages, []);
  expect(matched, 'home page must match empty segments').not.toBeNull();

  const adapted = snapshotToComponentNode(matched!.page.snapshot);
  expect(adapted.root, 'adapted snapshot must yield a renderable root').not.toBeNull();

  // CM-12: the seed writes the commerce catalog through the scoped
  // `commerceTenantDb(DEMO_TENANT_GROUP_ID)` handle into `tg_<demo>` (the shared
  // globalSetup provisions the schema + exports COMMERCE_APP_DATABASE_URL), so
  // the smoke reads through the SAME real app-role handle (the exact wiring
  // CM-10 puts behind resolveCommerceSchemaForSite in the route). The legacy
  // Prisma repo (getCommerceServerRepository) would read the now-empty
  // `commerce` schema: on a fresh database that path is intentionally dead, and
  // existing deployments bridge it via the CM-12 backfill until CM-10 flips.
  const hydrated = await hydrateBindings(adapted.root!, matched!.params, {
    cmsRepo: getCmsRepository(),
    commerceRepo: getCommerceServerRepositoryDb(commerceTenantDb(DEMO_TENANT_GROUP_ID)),
  });

  const scope = pushPageFrame(createScope(), matched!.params);
  const tree = renderComponentNode(hydrated, scope);

  // The four islands are `'use client'` components; renderToStaticMarkup emits
  // their INITIAL server markup. They read CommerceDataSourceContext + the cart,
  // both mounted by CommercePageProviders, so wrap the tree exactly as the real
  // route does before serializing.
  return renderToStaticMarkup(
    React.createElement(CommercePageProviders, null, tree),
  );
}

describe('published-site render smoke (real Postgres, real seeded data)', () => {
  describe('resolvePublishedSite', () => {
    it('resolves the seeded PUBLISHED site for demo.<base>', async () => {
      const site = await resolvePublishedSite(
        seeded.publishedHost,
        prisma,
        seeded.baseHost,
      );
      expect(site).not.toBeNull();
      expect(site!.siteId).toBe(seeded.siteId);
      expect(site!.name).toBe('Demo Storefront');
      expect(site!.pages.length).toBeGreaterThan(0);
    });

    it('returns null for an UNKNOWN subdomain', async () => {
      const site = await resolvePublishedSite(
        `does-not-exist.${seeded.baseHost}`,
        prisma,
        seeded.baseHost,
      );
      expect(site).toBeNull();
    });

    it('returns null for the seeded DRAFT site subdomain (published-only filter)', async () => {
      const site = await resolvePublishedSite(
        seeded.draftHost,
        prisma,
        seeded.baseHost,
      );
      expect(site).toBeNull();
    });
  });

  describe('matchPageBySlug', () => {
    it('resolves the same HOME page from empty segments and the HOME_REWRITE_SENTINEL', async () => {
      const site = await resolvePublishedSite(
        seeded.publishedHost,
        prisma,
        seeded.baseHost,
      );
      expect(site).not.toBeNull();

      const byEmpty = matchPageBySlug(site!.pages, []);
      const bySentinel = matchPageBySlug(site!.pages, [HOME_REWRITE_SENTINEL]);

      expect(byEmpty).not.toBeNull();
      expect(bySentinel).not.toBeNull();
      expect(byEmpty!.page.pageId).toBe(seeded.homePageId);
      expect(bySentinel!.page.pageId).toBe(byEmpty!.page.pageId);
    });
  });

  describe('the hydrated, server-rendered HTML', () => {
    let html: string;

    beforeAll(async () => {
      const site = await resolvePublishedSite(
        seeded.publishedHost,
        prisma,
        seeded.baseHost,
      );
      expect(site).not.toBeNull();
      html = await renderHomeToHtml(site!);
    }, 60_000);

    it('contains every seeded Events row title (real CMS Collection hydration)', () => {
      for (const title of seeded.eventTitles) {
        expect(html, `HTML should contain Events row "${title}"`).toContain(title);
      }
    });

    it('contains every seeded product title (real commerce ProductList hydration)', () => {
      for (const title of seeded.productTitles) {
        expect(html, `HTML should contain product "${title}"`).toContain(title);
      }
    });

    it('emits all four interactive commerce island kinds in the server markup', () => {
      // Every island spreads `data-component-kind` onto its host element...
      expect(html).toContain('data-component-kind="variant-selector"');
      expect(html).toContain('data-component-kind="add-to-cart"');
      expect(html).toContain('data-component-kind="cart-view"');
      expect(html).toContain('data-component-kind="checkout-button"');
      // ...and each island also emits its own stable server-side marker.
      expect(html).toContain('data-add-to-cart');
      expect(html).toContain('data-checkout');
      expect(html).toContain('data-cart-empty');
    });

    it('degrades gracefully for unbound / empty data slots (no throw)', () => {
      // The unbound Collection node renders its labelled placeholder...
      expect(html).toContain('Collection (no binding)');
      // ...and the ProductDetail with no {{page.params.handle}} renders its
      // configuration note rather than throwing.
      expect(html).toContain('Product detail: no product selected');
    });
  });
});
