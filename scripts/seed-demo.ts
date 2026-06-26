// scripts/seed-demo.ts
//
// A thin CLI wrapper around the reusable `seedDemoSite` helper, for seeding the
// prod flash-demo database with the SAME coherent demo (catalog + CMS + a
// published Site/SitePage/SiteDomain) the render smoke proves end to end. It
// constructs a PrismaClient on the live `DATABASE_URL` and runs the helper, then
// prints the resolved ids + the host the published storefront answers on.
//
// HOW TO RUN. `seedDemoSite` pulls in server-only modules (the commerce/CMS
// repositories guard themselves with `import 'server-only'`, which THROWS under
// the default Node module-resolution condition). Run this script with the
// `react-server` condition so `server-only` resolves to its empty marker:
//
//   DATABASE_URL=postgresql://... pnpm exec tsx --conditions=react-server scripts/seed-demo.ts
//
// It expects a fresh, migrated database (run `prisma migrate deploy` first); it
// seeds, it does not reconcile or upsert.

import { PrismaClient } from '@prisma/client';
import { seedDemoSite } from '@/lib/renderer/server/seedDemoSite';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('seed-demo: DATABASE_URL must be set to the target database.');
  }

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
