// scripts/seed-demo.ts
//
// A thin CLI wrapper around the reusable `seedDemoSite` helper, for seeding the
// prod flash-demo database with the SAME coherent demo (catalog + CMS + a
// published Site/SitePage/SiteDomain) the render smoke proves end to end. It
// constructs a PrismaClient on the live `DATABASE_URL` and runs the helper, then
// prints the resolved ids + the host the published storefront answers on.
//
// CM-12: the seed writes the commerce catalog through the scoped
// `commerceTenantDb(DEMO_TENANT_GROUP_ID)` handle into `tg_<demo>`, so on a
// fresh database this script must stand up the commerce tier BEFORE seeding.
// It therefore requires THREE connection strings and provisions idempotently:
//
//   DATABASE_URL                 the Prisma database (CMS + sites rows)
//   COMMERCE_OWNER_DATABASE_URL  the OWNER role (`commerce_ddl`): runs
//                                `migrateCommercePublic` (ext schema + registry)
//                                and `provisionCommerceTenant` for tg_<demo>
//   COMMERCE_APP_DATABASE_URL    the LOW-PRIVILEGE role (`commerce_app`) the
//                                seed's scoped write handle connects as
//
// Both provisioning calls are advisory-locked + idempotent, so re-running
// against an already-provisioned database is a no-op. (The commerce roles
// themselves come from prisma/sql/commerce-roles.sql, applied by the operator.)
//
// HOW TO RUN. `seedDemoSite` pulls in server-only modules (the commerce/CMS
// repositories guard themselves with `import 'server-only'`, which THROWS under
// the default Node module-resolution condition). Run this script with the
// `react-server` condition so `server-only` resolves to its empty marker:
//
//   DATABASE_URL=postgresql://... COMMERCE_OWNER_DATABASE_URL=postgresql://... \
//   COMMERCE_APP_DATABASE_URL=postgresql://... \
//   pnpm exec tsx --conditions=react-server scripts/seed-demo.ts
//
// It expects a fresh, migrated database (run `prisma migrate deploy` first); it
// seeds, it does not reconcile or upsert.

import { PrismaClient } from '@prisma/client';
import { seedDemoSite } from '@/lib/renderer/server/seedDemoSite';
import { DEMO_TENANT_GROUP_ID } from '@/lib/renderer/server/demoTenant';
import { migrateCommercePublic } from '@/server/commerce/provisioning/public';
import { provisionCommerceTenant } from '@/server/commerce/provisioning/provision';

async function main(): Promise<void> {
  // Validate ALL required env up front so a misconfigured run fails with one
  // clear message instead of dying mid-seed on the first commerce write.
  const missing = [
    'DATABASE_URL',
    'COMMERCE_OWNER_DATABASE_URL',
    'COMMERCE_APP_DATABASE_URL',
  ].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `seed-demo: missing required environment variable(s): ${missing.join(', ')}. ` +
        'DATABASE_URL is the Prisma database; COMMERCE_OWNER_DATABASE_URL is the ' +
        'owner role for provisioning tg_<demo>; COMMERCE_APP_DATABASE_URL is the ' +
        'low-privilege role the seed writes commerce rows through.',
    );
  }

  // Stand up the commerce tier for the demo tenant-group (idempotent: both the
  // public migration and the per-tenant provision no-op when already applied).
  console.log('Provisioning commerce tier (ext + registry + tg_<demo>)...');
  await migrateCommercePublic();
  await provisionCommerceTenant({
    tenantGroupId: DEMO_TENANT_GROUP_ID,
    slug: 'demo',
  });

  const prisma = new PrismaClient();
  try {
    const seeded = await seedDemoSite(prisma);
    console.log('Seeded demo site:');
    console.log(JSON.stringify(seeded, null, 2));
    console.log(
      `\nPublished storefront resolves at host: ${seeded.publishedHost}\n` +
        `Draft site (must NOT resolve, published-only): ${seeded.draftHost}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('seed-demo failed:', err);
  process.exitCode = 1;
});
