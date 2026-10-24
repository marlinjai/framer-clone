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
//     -> hydrateBindings (REAL getCmsRepository() + the render route's REAL
//        commerceRepoForSite(site), the scoped tg_<demo> read repo hitting the
//        seeded DB)
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
import { commerceRepoForSite } from '@/server/commerce/storefrontTenant';
import { commerceTenantDbChecked } from '@/server/commerce/db';
import { getCommerceServerRepository } from '@/server/commerce/repository/read';
import { POST as ordersPOST } from '@/app/api/commerce/orders/route';
import {
  resolvePublishedSite,
  matchPageBySlug,
  HOME_REWRITE_SENTINEL,
  type PublishedSite,
} from '@/server/sites/publicResolver';
import { snapshotToComponentNode } from '../snapshotToComponentNode';
import { hydrateBindings, treeNeedsCommerceRepo } from '@/lib/renderer/publish/hydrateBindings';
import { renderComponentNode } from '../renderComponentNode';
import CommercePageProviders from '../CommercePageProviders';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';
import { seedDemoSite, type SeededDemo } from '../seedDemoSite';
import { DEMO_TENANT_GROUP_ID } from '../demoTenant';

let prisma: PrismaClient;
let seeded: SeededDemo;

beforeAll(async () => {
  // getPrismaClient() reads process.env.DATABASE_URL (set by the shared
  // globalSetup) at construction, so this is the SAME container DB that
  // getCmsRepository() defaults to. One client, one pool: the seed writes and
  // the CMS render-path reads share it. Commerce reads go through
  // COMMERCE_APP_DATABASE_URL (the commerce_app role), also set by globalSetup.
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

  // CM-10: the commerce repo comes from the render route's OWN helper,
  // commerceRepoForSite(site), which maps the resolved site to its tenant group
  // and reads through the scoped `commerceTenantDb(tgId)` handle (the seed wrote
  // the catalog into `tg_<demo>` through the same handle). A site with no valid
  // tenant group yields undefined (fail closed, see the last describe block).
  const hydrated = await hydrateBindings(adapted.root!, matched!.params, {
    cmsRepo: getCmsRepository(),
    commerceRepo: await commerceRepoForSite(site, adapted.root!),
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
      // ...and the server markup of each is its sized, aria-busy pending
      // placeholder (CommerceIsland): the island itself renders after mount,
      // so nothing claims "your cart is empty" before the cart was read.
      for (const kind of ['variant-selector', 'add-to-cart', 'cart-view', 'checkout-button']) {
        expect(html).toContain(`data-island-pending="${kind}"`);
      }
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain('data-cart-empty');
    });

    it('degrades gracefully for unbound / empty data slots (no throw)', () => {
      // The unbound Collection node renders its labelled placeholder...
      expect(html).toContain('Collection (no binding)');
      // ...and the ProductDetail with no {{page.params.handle}} renders its
      // configuration note rather than throwing.
      expect(html).toContain('Product detail: no product selected');
    });
  });

  describe('FAIL CLOSED: a published site with no valid tenant group (CM-10)', () => {
    let html: string;

    beforeAll(async () => {
      const site = await resolvePublishedSite(
        seeded.publishedHost,
        prisma,
        seeded.baseHost,
      );
      expect(site).not.toBeNull();
      // The same site, but carrying a legacy non-UUID tenant group sentinel (a
      // row that was never restamped). The render helper must refuse it: no
      // shared-schema fallback, so the page renders WITHOUT any commerce data.
      const unprovisioned: PublishedSite = { ...site!, tenantGroupId: 'demo-tenant-group' };
      const home = snapshotToComponentNode(matchPageBySlug(site!.pages, [])!.page.snapshot);
      // The home page DOES have bound commerce sources, so only the invalid
      // tenant group is what makes the helper refuse.
      expect(treeNeedsCommerceRepo(home.root!)).toBe(true);
      expect(await commerceRepoForSite(unprovisioned, home.root!)).toBeUndefined();
      // Same for a VALID tenant group UUID whose tg_<id> schema was never
      // created: no commerce data (logged), never silently empty slots.
      expect(
        await commerceRepoForSite(
          { ...site!, tenantGroupId: '018f9c10-0000-7000-8000-00000000dead' },
          home.root!,
        ),
      ).toBeUndefined();
      html = await renderHomeToHtml(unprovisioned);
    }, 60_000);

    it('still renders the CMS content', () => {
      for (const title of seeded.eventTitles) {
        expect(html).toContain(title);
      }
    });

    it('renders NO commerce data from any schema (the bound ProductList is a placeholder)', () => {
      for (const title of seeded.productTitles) {
        expect(html, `HTML must not contain product "${title}"`).not.toContain(title);
      }
      expect(html).toContain('(no binding)');
    });
  });

  describe('demo checkout end to end through the storefront orders route', () => {
    it('places one order on the demo host: 201, the order lands in tg_<demo>, stock is reserved', async () => {
      const db = await commerceTenantDbChecked(DEMO_TENANT_GROUP_ID);
      const repo = getCommerceServerRepository(db);
      const page = await repo.listProducts();
      const variantId = page.products[0]!.variantIds[0]!;
      const before = await repo.getAvailability(variantId);

      // The real anonymous storefront write: only the demo host, no session.
      const res = await ordersPOST(
        new Request(`http://${seeded.publishedHost}/api/commerce/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: seeded.publishedHost },
          body: JSON.stringify({ lines: [{ variantId, quantity: 1 }] }),
        }),
      );
      const body = (await res.json()) as { orderId: string; totalCents: number; currency: string };
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(body.currency).toBe('EUR');
      expect(body.totalCents).toBeGreaterThan(0);

      const order = await db
        .selectFrom('order')
        .select(['id', 'total'])
        .where('id', '=', body.orderId)
        .executeTakeFirstOrThrow();
      expect(order.total).toBe(body.totalCents);

      // One unit is now reserved against the demo warehouse level.
      const after = await repo.getAvailability(variantId);
      expect(after.availableQuantity).toBe(before.availableQuantity - 1);
    });
  });
});
