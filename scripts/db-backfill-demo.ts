// scripts/db-backfill-demo.ts
//
// Operator / deploy CLI for the one-shot demo BACK-COMPAT backfill (CM-12, plan
// §9). Runs `backfillDemoTenant()` against the OWNER database: provisions the demo
// tenant-group's `tg_<demo>` schema and copies the current `commerce.<table>` rows
// into it (FK-safe, excluding the GENERATED / trigger columns, which regenerate),
// so the demo storefront renders + checks out identically once CM-10 flips the
// render path / routes onto `tg_<demo>`.
//
// It is ADDITIVE and idempotent: the old `commerce` schema is untouched (CM-13
// drops it, only after the demo verifies green on `tg_<demo>`), and a re-run
// provisions nothing new and copies nothing already present.
//
// HOW TO RUN. It reads COMMERCE_OWNER_DATABASE_URL from the environment (the OWNER
// role `commerce_ddl`, injected by the deploy's Infisical wrapper, never
// hardcoded). The demo tenant-group id comes from DEMO_TENANT_GROUP_ID (the same
// constant seedDemoSite stamps on the demo Site rows; env-overridable). NO app
// role / DATABASE_URL is involved.
//
//   COMMERCE_OWNER_DATABASE_URL=postgresql://... pnpm db:backfill-demo
//
// Every import here is `server-only`-free, so plain `tsx` (no
// `--conditions=react-server`) works: `backfill-demo.ts` pulls no server-only
// module, and DEMO_TENANT_GROUP_ID comes from the dependency-free
// `demoTenant.ts` (NOT from `seedDemoSite.ts`, whose module graph executes
// `import 'server-only'` via the commerce repos and would CRASH at import time
// under the default Node condition).

import { DEMO_TENANT_GROUP_ID } from '@/lib/renderer/server/demoTenant';
import { backfillDemoTenant } from '@/server/commerce/provisioning/backfill-demo';

async function main(): Promise<void> {
  const tenantGroupId = DEMO_TENANT_GROUP_ID;
  console.log(`Backfilling demo tenant-group ${tenantGroupId} into its tg_<demo> schema...`);
  await backfillDemoTenant({ tenantGroupId });
  console.log('Demo backfill complete (provision + copy were idempotent).');
}

main().catch((err) => {
  console.error('db:backfill-demo failed:', err);
  process.exitCode = 1;
});
