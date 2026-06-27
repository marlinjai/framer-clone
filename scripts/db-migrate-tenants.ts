// scripts/db-migrate-tenants.ts
//
// Operator / deploy CLI for the commerce FLEET migration (CM-11). Runs
// `migrateAllCommerceTenants()` against the OWNER database, rolling the CM-04
// commerce migration set across EVERY provisioned `tg_<id>` schema in
// `public.tenant_groups`. This is how new commerce DDL ships after launch:
// land a new migration in src/server/commerce/migrations/tenant, then run this
// once per deploy to apply it to the whole fleet.
//
// It is batched + resumable (each schema's migration is its own committed tx),
// so a re-run after a partial failure resumes, and a run where everything is
// already up to date applies nothing new (idempotent).
//
// HOW TO RUN. It reads COMMERCE_OWNER_DATABASE_URL from the environment (the
// OWNER role `commerce_ddl`, injected by the deploy's Infisical wrapper — never
// hardcoded). No DATABASE_URL or app role is involved.
//
//   COMMERCE_OWNER_DATABASE_URL=postgresql://... pnpm db:migrate-tenants
//
// `provision.ts` does not import `server-only`, so no special module-resolution
// condition is needed here.

import { migrateAllCommerceTenants } from '@/server/commerce/provisioning/provision';

async function main(): Promise<void> {
  const result = await migrateAllCommerceTenants({
    // Log per-schema progress as the fleet sweep advances.
    onSchemaDone: ({ schema, applied, index, total }) => {
      const what = applied.length === 0 ? 'up to date' : `applied ${applied.join(', ')}`;
      console.log(`[${index + 1}/${total}] ${schema}: ${what}`);
    },
  });

  const withChanges = result.schemas.filter((s) => s.applied.length > 0).length;
  console.log(
    `Commerce fleet migration done: processed ${result.processed}/${result.total} ` +
      `schema(s), ${withChanges} with new migrations.`,
  );
}

main().catch((err) => {
  console.error('db:migrate-tenants failed:', err);
  process.exitCode = 1;
});
