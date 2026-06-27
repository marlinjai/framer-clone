// seedDemoSite: a reusable, coherent demo-data seeder for the published-site
// render chain. Given a PrismaClient (a test container client OR a live
// DATABASE_URL client), it seeds, against the EXISTING schema (no migration):
//
//   - a commerce catalog: 2 products, each with an option + 2 variants, each
//     variant priced (integer minor units) and backed by an inventory_item +
//     inventory_level with real stock (the read repo links variant.sku ->
//     inventory_item.sku for advisory availability);
//   - a CMS collection ("Events") with 3 rows whose titles are assertable
//     strings, seeded through the SAME PrismaAdapter that getCmsRepository()
//     reads, so listRows returns them;
//   - a PUBLISHED Site + a HOME SitePage whose snapshot is a valid PageModel
//     SnapshotOut. Its appComponentTree binds a CMS Collection block (to Events),
//     a ProductList (to the catalog), a ProductDetail, the 4 interactive commerce
//     islands, and one unbound data slot (to prove graceful degradation);
//   - a SiteDomain (subdomain `demo`) pointing at the published site;
//   - a second DRAFT Site + its own SiteDomain (subdomain `draftdemo`), to prove
//     the published-only filter.
//
// It returns the ids + assertable strings the smoke asserts on, AND is factored
// so the thin `scripts/seed-demo.ts` wrapper can run it against a live database
// for the prod demo. It is the ONE source of truth for the demo shape.
//
// This module deliberately uses the REAL write seams (the NEW Kysely catalog /
// pricing repos over a scoped `commerceTenantDb(tgId)` handle, the CMS
// PrismaAdapter) so the seeded rows are exactly what the read path expects: a
// mocked seed could not catch a real schema/mapping mismatch, which is the whole
// point of the smoke.
//
// CM-12 — every COMMERCE write routes through ONE scoped `commerceTenantDb(tgId)`
// Kysely handle (each bare table resolves to `tg_<id>.<table>`): the catalog /
// pricing writes via `catalogRepositoryKysely` / `pricingRepositoryKysely`, and
// the 3 ex-direct inventory creates (stock_location / inventory_item /
// inventory_level — the only commerce writes that used to bypass `withTenant`)
// are now schema-qualified inserts on the SAME handle. No commerce write bypasses
// it. The non-commerce CMS writes (site / sitePage / siteDomain, the CMS
// collection adapter) stay on Prisma — they are NOT part of this migration. This
// removed the last `withTenant` importer (CM-13 then deletes withTenant.ts).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';

import { CMS_WORKSPACE_ID } from '@/lib/cms/constants';
import { commerceTenantDb, type CommerceDB } from '@/server/commerce/db';
import { catalogRepositoryKysely } from '@/server/commerce/repository/catalog';
import { pricingRepositoryKysely } from '@/server/commerce/repository/pricing';

// The demo's isolation boundary. The CMS rows isolate by `workspace_id`; the
// commerce rows isolate by the `tg_<id>` schema DERIVED from this tenant-group id
// (so it MUST be a strict UUID — the tenant-db chokepoint validates it). Exported
// so the backfill (provisioning/backfill-demo.ts) + `pnpm db:backfill-demo` derive
// the SAME `tg_<demo>` schema this seed writes into. Env-overridable so a prod
// seed can target a specific provisioned tenant-group.
const DEMO_WORKSPACE_ID = CMS_WORKSPACE_ID;
export const DEMO_TENANT_GROUP_ID =
  process.env.DEMO_TENANT_GROUP_ID ?? '018f9c10-0000-7000-8000-0000000000de';

/** The hostname base the published storefront is served under (the smoke uses a
 *  three-label host `demo.<base>` so parseSubdomain yields `demo`). */
// Env-overridable so the prod hosted-demo seed can target the real host/subdomain
// (e.g. DEMO_BASE_HOST=lumitra.co DEMO_PUBLISHED_SUBDOMAIN=app). Defaults keep the
// integration test (which asserts on these constants) on demo.lumitra.site.
export const DEMO_BASE_HOST = process.env.DEMO_BASE_HOST ?? 'lumitra.site';
/** The subdomain label that resolves the PUBLISHED demo site. */
export const DEMO_PUBLISHED_SUBDOMAIN = process.env.DEMO_PUBLISHED_SUBDOMAIN ?? 'demo';
/** The subdomain label that resolves the DRAFT site (must NOT publish). */
export const DEMO_DRAFT_SUBDOMAIN = process.env.DEMO_DRAFT_SUBDOMAIN ?? 'draftdemo';

/** The 3 assertable Events row titles (proves CMS Collection hydration). */
export const DEMO_EVENT_TITLES = [
  'Summer Launch Party',
  'Founders Roundtable',
  'Winter Product Gala',
] as const;

/** One demo product's seed spec: an option with N values, one variant per value. */
interface ProductSpec {
  title: string;
  handle: string;
  optionTitle: string;
  values: Array<{ value: string; sku: string; amountCents: number; stock: number }>;
}

const PRODUCT_SPECS: ProductSpec[] = [
  {
    title: 'Aurora Wool Jacket',
    handle: 'aurora-wool-jacket',
    optionTitle: 'Size',
    values: [
      { value: 'Small', sku: 'AURORA-S', amountCents: 18900, stock: 14 },
      { value: 'Medium', sku: 'AURORA-M', amountCents: 18900, stock: 9 },
    ],
  },
  {
    title: 'Lumen Desk Lamp',
    handle: 'lumen-desk-lamp',
    optionTitle: 'Finish',
    values: [
      { value: 'Graphite', sku: 'LUMEN-GR', amountCents: 8400, stock: 30 },
      { value: 'Ivory', sku: 'LUMEN-IV', amountCents: 8400, stock: 21 },
    ],
  },
];

/** The product titles the smoke asserts the ProductList hydrated. */
export const DEMO_PRODUCT_TITLES = PRODUCT_SPECS.map((p) => p.title);

/** What seedDemoSite returns: the ids + strings the smoke asserts on. */
export interface SeededDemo {
  baseHost: string;
  publishedHost: string;
  draftHost: string;
  publishedSubdomain: string;
  draftSubdomain: string;
  siteId: string;
  draftSiteId: string;
  homePageId: string;
  homeSlug: string;
  eventsCollectionId: string;
  eventsTitleColumnId: string;
  eventTitles: string[];
  productTitles: string[];
}

/**
 * Seed one product: its option, one variant per option value, each variant's
 * price_set + base price, and a matching inventory_item + inventory_level so the
 * advisory-availability read (variant.sku -> inventory_item.sku) resolves real
 * stock. Returns nothing; the ProductList lists the whole catalog by title.
 */
async function seedProduct(db: Kysely<CommerceDB>, spec: ProductSpec): Promise<void> {
  const product = await catalogRepositoryKysely.createProduct(db, {
    title: spec.title,
    handle: spec.handle,
  });
  const option = await catalogRepositoryKysely.addOption(db, {
    productId: product.id,
    title: spec.optionTitle,
  });

  for (const entry of spec.values) {
    const optionValue = await catalogRepositoryKysely.addOptionValue(db, {
      optionId: option.id,
      value: entry.value,
    });
    const variant = await catalogRepositoryKysely.addVariant(db, {
      productId: product.id,
      title: `${spec.title} / ${entry.value}`,
      sku: entry.sku,
    });
    // Assign the variant its single option value (the AFTER-trigger recompute
    // makes the combination unique per product at the database level).
    await catalogRepositoryKysely.setVariantOptions(db, variant.id, [
      { optionId: option.id, optionValueId: optionValue.id },
    ]);

    // Price: a base price in integer minor units (cents).
    const priceSet = await pricingRepositoryKysely.createPriceSet(db, {
      variantId: variant.id,
    });
    await pricingRepositoryKysely.addPrice(db, {
      priceSetId: priceSet.id,
      currency: 'EUR',
      amount: entry.amountCents,
    });

    // Inventory: the 3 ex-direct `prisma.stockLocation/inventoryItem/inventoryLevel
    // .create` calls (the ONLY commerce writes that used to bypass `withTenant`)
    // are now schema-qualified inserts on the SAME scoped handle. An item keyed by
    // the SAME sku the variant carries, plus a level with real stock at a location
    // (advisory availability reads the GENERATED stocked-reserved column). id /
    // updated_at are supplied app-side (no DB default; see catalog.ts header).
    const locationId = randomUUID();
    await db
      .insertInto('stock_location')
      .values({ id: locationId, name: `Demo Warehouse (${entry.sku})`, updated_at: new Date() })
      .execute();
    const inventoryItemId = randomUUID();
    await db
      .insertInto('inventory_item')
      .values({
        id: inventoryItemId,
        sku: entry.sku,
        title: `${spec.title} ${entry.value}`,
        updated_at: new Date(),
      })
      .execute();
    // available_quantity is GENERATED (stocked - reserved): OMITTED, never written.
    await db
      .insertInto('inventory_level')
      .values({
        id: randomUUID(),
        inventory_item_id: inventoryItemId,
        location_id: locationId,
        stocked_quantity: entry.stock,
        reserved_quantity: 0,
        updated_at: new Date(),
      })
      .execute();
  }
}

/**
 * Seed the "Events" CMS collection through the SAME PrismaAdapter that
 * getCmsRepository() reads, so listRows returns the 3 rows. Returns the
 * collection id and the (primary) title column id so the page snapshot can bind
 * `{{row.<titleColumnId>}}` (Row.values is keyed by COLUMN ID, not name).
 */
async function seedEventsCollection(
  prisma: PrismaClient,
): Promise<{ collectionId: string; titleColumnId: string }> {
  const adapter = new PrismaAdapter({ prisma });

  const table = await adapter.createTable({
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Events',
    description: 'Demo events collection (render smoke)',
  });
  const titleColumn = await adapter.createColumn({
    tableId: table.id,
    name: 'Title',
    type: 'text',
    isPrimary: true,
  });

  for (const title of DEMO_EVENT_TITLES) {
    await adapter.createRow({
      tableId: table.id,
      cells: { [titleColumn.id]: title },
    });
  }

  return { collectionId: table.id, titleColumnId: titleColumn.id };
}

/**
 * Build the HOME page snapshot (a PageModel SnapshotOut shape). The renderer
 * adaptor (snapshotToComponentNode) reads only id/type/props/bindings/children
 * off `appComponentTree` and the page slug/metadata, so this plain object is a
 * faithful, minimal snapshot. The tree binds every data surface the smoke
 * exercises against REAL repos.
 */
function buildHomeSnapshot(args: {
  pageId: string;
  slug: string;
  eventsCollectionId: string;
  eventsTitleColumnId: string;
}): Record<string, unknown> {
  const { pageId, slug, eventsCollectionId, eventsTitleColumnId } = args;

  const appComponentTree = {
    id: 'root',
    type: 'div',
    children: [
      // CMS Collection bound to Events: read binding + a structured query object.
      // The per-row template binds its text to the title COLUMN ID.
      {
        id: 'events-collection',
        type: 'div',
        props: {
          'data-component-kind': 'collection',
          query: {
            sort: [{ column: eventsTitleColumnId, direction: 'asc' }],
            limit: 50,
          },
        },
        bindings: { collection: { mode: 'read', expression: eventsCollectionId } },
        children: [
          {
            id: 'event-row-template',
            type: 'p',
            props: { children: '', 'data-event-title': true },
            bindings: {
              children: { mode: 'read', expression: `{{row.${eventsTitleColumnId}}}` },
            },
          },
        ],
      },
      // ProductList bound to the catalog: one hydrated block per product, each
      // binding its text to {{product.title}}.
      {
        id: 'product-list',
        type: 'div',
        props: {
          'data-component-kind': 'product-list',
          query: { sort: [{ field: 'title', direction: 'asc' }], limit: 50 },
        },
        bindings: { products: { mode: 'read', expression: 'products' } },
        children: [
          {
            id: 'product-card-template',
            type: 'p',
            props: { children: '', 'data-product-title': true },
            bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
          },
        ],
      },
      // ProductDetail: bound, but the HOME page carries no `{{page.params.handle}}`,
      // so the hydrator resolves it to its empty-content note (a graceful path).
      {
        id: 'product-detail',
        type: 'div',
        props: { 'data-component-kind': 'product-detail' },
        bindings: { product: { mode: 'read', expression: 'product' } },
        children: [
          {
            id: 'product-detail-title',
            type: 'h2',
            props: { children: '' },
            bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
          },
        ],
      },
      // The 4 interactive commerce islands (left verbatim by the hydrator, mounted
      // as client islands by the renderer; renderToStaticMarkup emits their
      // initial server markup).
      { id: 'island-variant', type: 'div', props: { 'data-component-kind': 'variant-selector' } },
      {
        id: 'island-add-to-cart',
        type: 'div',
        props: { 'data-component-kind': 'add-to-cart', label: 'Add to cart' },
      },
      { id: 'island-cart', type: 'div', props: { 'data-component-kind': 'cart-view' } },
      {
        id: 'island-checkout',
        type: 'div',
        props: { 'data-component-kind': 'checkout-button', label: 'Checkout' },
      },
      // An UNBOUND data slot: proves the renderer degrades gracefully (a labelled
      // placeholder, never a throw).
      {
        id: 'unbound-collection',
        type: 'div',
        props: { 'data-component-kind': 'collection' },
      },
    ],
  };

  return {
    id: pageId,
    slug,
    metadata: {
      title: 'Demo Storefront',
      description: 'The render-smoke demo home page.',
      keywords: [],
      ogTitle: '',
      ogDescription: '',
      ogImage: '',
      canonicalUrl: '',
    },
    createdAt: 0,
    updatedAt: 0,
    appComponentTree,
    canvasNodes: {},
  };
}

/** Options for {@link seedDemoSite}. */
export interface SeedDemoOptions {
  /**
   * The scoped commerce handle EVERY commerce write routes through. Defaults to
   * `commerceTenantDb(tenantGroupId)` (built from COMMERCE_APP_DATABASE_URL).
   * Tests inject a handle scoped to a provisioned `tg_<id>` schema on the test
   * container (so the seed never needs the app-role env).
   */
  commerceDb?: Kysely<CommerceDB>;
  /**
   * The demo tenant-group id stamped on the Site / SitePage / SiteDomain rows AND
   * used to derive the default commerce handle's `tg_<id>` schema. Defaults to
   * {@link DEMO_TENANT_GROUP_ID}. MUST be a strict UUID (the tenant-db chokepoint
   * validates it when deriving the schema).
   */
  tenantGroupId?: string;
}

/**
 * Seed the full coherent demo and return the ids + assertable strings. The
 * COMMERCE catalog is written through the scoped `commerceTenantDb(tgId)` handle
 * (into `tg_<demo>`); the CMS + Site rows are written through `prisma`.
 * Idempotency is NOT a goal: it expects a fresh (migrated/provisioned, empty)
 * database, exactly as the integration harness and a first prod-demo seed give.
 */
export async function seedDemoSite(
  prisma: PrismaClient,
  opts: SeedDemoOptions = {},
): Promise<SeededDemo> {
  const tenantGroupId = opts.tenantGroupId ?? DEMO_TENANT_GROUP_ID;
  // The ONE scoped commerce handle. EVERY commerce write below routes through it
  // (each bare table resolves to `tg_<id>.<table>`); nothing bypasses it.
  const db = opts.commerceDb ?? commerceTenantDb(tenantGroupId);

  // 1) Commerce catalog (products + variants + prices + inventory) -> tg_<demo>.
  for (const spec of PRODUCT_SPECS) {
    await seedProduct(db, spec);
  }

  // 2) CMS Events collection (through the adapter the read path uses).
  const { collectionId, titleColumnId } = await seedEventsCollection(prisma);

  // 3) Published Site + HOME page + subdomain.
  const homePageId = 'demo-home-page';
  const homeSlug = '';
  const now = new Date();
  const site = await prisma.site.create({
    data: {
      name: 'Demo Storefront',
      description: 'Render smoke demo site',
      status: 'published',
      workspaceId: DEMO_WORKSPACE_ID,
      tenantGroupId,
      lumitraEnabled: false,
      projectCreatedAt: now,
      projectUpdatedAt: now,
    },
  });
  await prisma.sitePage.create({
    data: {
      siteId: site.id,
      workspaceId: DEMO_WORKSPACE_ID,
      tenantGroupId,
      pageId: homePageId,
      slug: homeSlug,
      // Stored as JSON; read back as PageSnapshotOut by the resolver.
      snapshot: buildHomeSnapshot({
        pageId: homePageId,
        slug: homeSlug,
        eventsCollectionId: collectionId,
        eventsTitleColumnId: titleColumnId,
      }) as object,
    },
  });
  await prisma.siteDomain.create({
    data: {
      siteId: site.id,
      workspaceId: DEMO_WORKSPACE_ID,
      tenantGroupId,
      subdomain: DEMO_PUBLISHED_SUBDOMAIN,
      verificationStatus: 'active',
      isPrimary: true,
    },
  });

  // 4) A DRAFT Site + its own subdomain (must resolve to null: published-only).
  const draftSite = await prisma.site.create({
    data: {
      name: 'Draft Storefront',
      description: 'Unpublished site',
      status: 'draft',
      workspaceId: DEMO_WORKSPACE_ID,
      tenantGroupId,
      lumitraEnabled: false,
      projectCreatedAt: now,
      projectUpdatedAt: now,
    },
  });
  await prisma.siteDomain.create({
    data: {
      siteId: draftSite.id,
      workspaceId: DEMO_WORKSPACE_ID,
      tenantGroupId,
      subdomain: DEMO_DRAFT_SUBDOMAIN,
      verificationStatus: 'pending',
      isPrimary: true,
    },
  });

  return {
    baseHost: DEMO_BASE_HOST,
    publishedHost: `${DEMO_PUBLISHED_SUBDOMAIN}.${DEMO_BASE_HOST}`,
    draftHost: `${DEMO_DRAFT_SUBDOMAIN}.${DEMO_BASE_HOST}`,
    publishedSubdomain: DEMO_PUBLISHED_SUBDOMAIN,
    draftSubdomain: DEMO_DRAFT_SUBDOMAIN,
    siteId: site.id,
    draftSiteId: draftSite.id,
    homePageId,
    homeSlug,
    eventsCollectionId: collectionId,
    eventsTitleColumnId: titleColumnId,
    eventTitles: [...DEMO_EVENT_TITLES],
    productTitles: [...DEMO_PRODUCT_TITLES],
  };
}
