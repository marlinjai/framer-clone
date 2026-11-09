// src/app/api/internal/commerce/expired-payments/__tests__/route.itest.ts
//
// The scheduled sweep against real Postgres, through the real route, across two tenant groups: an abandoned hold
// ends with nobody buying, in every company, and a hold inside its window is left alone. Other suites share this
// database, so the assertions read this suite's own rows, never the fleet-wide totals.
//
// The fleet the sweep walks (every tenant group with a site) is narrowed to this suite's own groups: the
// integration files run in parallel, and a sweep over the whole database closed, or failed on, other suites'
// orders in the middle of their own tests (a 500 here, a changed order there). The route, the sweep and every
// tenant schema stay real; only the list of groups is this suite's.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The tenant groups this suite created; the sweep's fleet query answers only these. */
const suiteGroups = vi.hoisted(() => new Set<string>());
vi.mock('@/server/db', async (importActual) => {
  const actual = await importActual<typeof import('@/server/db')>();
  return {
    ...actual,
    getPrismaClient: () => {
      const prisma = actual.getPrismaClient();
      return new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== 'site') return Reflect.get(target, prop, receiver);
          const site = target.site;
          return new Proxy(site, {
            get(siteTarget, siteProp, siteReceiver) {
              if (siteProp !== 'findMany') return Reflect.get(siteTarget, siteProp, siteReceiver);
              return async (args: Parameters<typeof site.findMany>[0]) => {
                const rows = (await site.findMany(args)) as Array<{ tenantGroupId?: string }>;
                return rows.filter((row) => row.tenantGroupId === undefined || suiteGroups.has(row.tenantGroupId));
              };
            },
          });
        },
      });
    },
  };
});

import { createOrder } from '@/server/commerce/order/createOrder';
import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';
import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { commerceTenantDb } from '@/server/commerce/db';
import { POST } from '../route';

const TOKEN = 'y'.repeat(40);

let fx: StorefrontFixtures;
let shops: ProvisionedTenant[];
let noCommerceGroup: string;

beforeAll(async () => {
  fx = openStorefrontFixtures();
  shops = [await provisionCommerceTenant(fx, 'sweep-a'), await provisionCommerceTenant(fx, 'sweep-b')];
  for (const shop of shops) await createPublishedSite(fx, shop.tgId, 'sweep');
  // A site whose group has no commerce schema, and one with a legacy id: neither stops the pass.
  noCommerceGroup = randomUUID();
  await createPublishedSite(fx, noCommerceGroup, 'sweep-none');
  await createPublishedSite(fx, 'legacy-tenant-group', 'sweep-legacy');
  for (const group of [...shops.map((shop) => shop.tgId), noCommerceGroup, 'legacy-tenant-group']) suiteGroups.add(group);
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

beforeEach(() => {
  vi.stubEnv('CUSTOM_DOMAIN_SYNC_TOKEN', TOKEN);
  vi.stubEnv('EDITOR_HOST', 'app.lumitra.co');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function sweep(): Promise<Response> {
  return POST(
    new Request('http://app.lumitra.co/api/internal/commerce/expired-payments', {
      method: 'POST',
      headers: { host: 'app.lumitra.co', authorization: `Bearer ${TOKEN}` },
    }),
  );
}

/** A last unit held by a pending order in `shop`, opened `ageMs` ago. */
async function holdLastUnit(shop: ProvisionedTenant, ageMs: number) {
  const seeded = await seedBuyableProduct(shop.db, {
    title: `P-${randomUUID().slice(0, 6)}`,
    handle: `p-${randomUUID()}`,
    amountCents: 1000,
    stocked: 1,
  });
  const result = await createOrder(commerceTenantDb(shop.tgId), shop.tgId, {
    tenantId: DEMO_COMPANY_ID,
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    now: new Date(Date.now() - ageMs),
    lines: [{ inventoryItemId: seeded.inventoryItemId, variantId: seeded.variantId, quantity: 1, locationId: seeded.locationId }],
    payment: { provider: 'demo' },
  });
  if (!result.ok) throw new Error('the order was short');
  return { shop, orderId: result.orderId, item: seeded.inventoryItemId };
}

async function state(hold: Awaited<ReturnType<typeof holdLastUnit>>) {
  const payment = await hold.shop.db
    .selectFrom('order_payment')
    .select('status')
    .where('order_id', '=', hold.orderId)
    .executeTakeFirstOrThrow();
  const level = await hold.shop.db
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', hold.item)
    .executeTakeFirstOrThrow();
  return { status: payment.status, reserved: level.reserved_quantity };
}

const WINDOW_RAN_OUT = 31 * 60 * 1000;

describe('POST /api/internal/commerce/expired-payments on real tenant schemas', () => {
  it('closes the abandoned holds of every tenant group and leaves a live hold alone', async () => {
    const abandonedA = await holdLastUnit(shops[0], WINDOW_RAN_OUT);
    const abandonedB = await holdLastUnit(shops[1], WINDOW_RAN_OUT);
    const live = await holdLastUnit(shops[1], 60_000);

    const res = await sweep();
    expect(res.status).toBe(200);
    // The fleet is this suite's four groups: two shops swept, the group without commerce and the legacy id skipped.
    expect(await res.json()).toEqual({ tenantGroups: 2, skipped: 2, closed: 2, failed: 0 });

    expect(await state(abandonedA)).toEqual({ status: 'expired', reserved: 0 });
    expect(await state(abandonedB)).toEqual({ status: 'expired', reserved: 0 });
    expect(await state(live)).toEqual({ status: 'pending', reserved: 1 });
  });

  it('the next tick changes nothing, and two ticks at once release once', async () => {
    const stockedTwice = await holdLastUnit(shops[0], WINDOW_RAN_OUT);
    const [first, second] = await Promise.all([sweep(), sweep()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await sweep()).status).toBe(200);

    expect(await state(stockedTwice)).toEqual({ status: 'expired', reserved: 0 });
    const releases = await stockedTwice.shop.db
      .selectFrom('stock_movement')
      .select('id')
      .where('movement_type', '=', 'release')
      .where('ref_id', '=', stockedTwice.orderId)
      .execute();
    expect(releases).toHaveLength(1);
  });
});
