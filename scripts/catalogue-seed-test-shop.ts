// scripts/catalogue-seed-test-shop.ts
//
// Operator CLI: seed the catalogue of the owner's test jewellery shop "Schmuck Testshop" (rings with size and
// metal options, necklaces, earrings, a service, one archived product, two collections; all invented and
// marked as test data). Idempotent: a product or collection the company already has is left alone.
// src/server/catalog/testShop.ts holds what is seeded.
//
//   pnpm catalogue:seed-test-shop --tenant-group <tenant group uuid> --tenant <company uuid>
//
// Environment (inject with Infisical through the secrets proxy, never a .env file):
//   COMMERCE_APP_DATABASE_URL  the low-privilege app role
//
// Prints counts only.

import { createNodeDb } from '@marlinjai/tenant-db/node';
import { tenantDb } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../src/server/commerce/db-types';
import { catalogScope } from '../src/server/catalog/scope';
import { seedTestShop } from '../src/server/catalog/testShop';

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value) throw new Error(`usage: pnpm catalogue:seed-test-shop --tenant-group <uuid> --tenant <uuid> (missing ${name})`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantGroupId = flag(args, '--tenant-group');
  const tenantId = flag(args, '--tenant');
  const connectionString = process.env.COMMERCE_APP_DATABASE_URL;
  if (!connectionString) throw new Error('COMMERCE_APP_DATABASE_URL is not set (the app role, from Infisical)');
  const base = createNodeDb<CommerceDB>({ connectionString, max: 1 });
  try {
    const result = await seedTestShop(catalogScope(tenantDb(base, tenantGroupId), tenantGroupId, tenantId));
    console.log(
      `products created: ${result.productsCreated}, kept: ${result.productsKept}; collections created: ${result.collectionsCreated}`,
    );
  } finally {
    await base.destroy();
  }
}

main().catch((err) => {
  console.error('catalogue:seed-test-shop failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
