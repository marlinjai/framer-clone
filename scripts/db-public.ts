// scripts/db-public.ts
//
// Operator / deploy CLI for the commerce PUBLIC migration tier (CM-03). Runs
// `migrateCommercePublic()` against the OWNER database, standing up the shared
// `ext` schema (pgcrypto, gen_uuid_v7, touch_updated_at) and the runner's
// `public.tenant_groups` / `public.tenant_migration_progress` registry that
// every per-tenant `tg_<id>` schema is keyed on. This is the prerequisite for
// per-tenant provisioning (CM-11).
//
// HOW TO RUN. It reads COMMERCE_OWNER_DATABASE_URL from the environment (the
// OWNER role `commerce_ddl`, injected by the deploy's Infisical wrapper — never
// hardcoded). No DATABASE_URL or app role is involved.
//
//   COMMERCE_OWNER_DATABASE_URL=postgresql://... pnpm db:public
//
// It is idempotent: re-running on every deploy is safe and applies nothing new
// once the public tier exists. `public.ts` does not import `server-only`, so no
// special module-resolution condition is needed.

import { migrateCommercePublic } from '@/server/commerce/provisioning/public';

async function main(): Promise<void> {
  const applied = await migrateCommercePublic();
  if (applied.length === 0) {
    console.log('Commerce public tier already up to date — no migrations applied.');
  } else {
    console.log(`Applied commerce public migrations: ${applied.join(', ')}`);
  }
}

main().catch((err) => {
  console.error('db:public failed:', err);
  process.exitCode = 1;
});
