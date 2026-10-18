// scripts/commerce-migrate.ts
//
// Container start step: the commerce public migrations and the tenant fleet
// migration, as the OWNER role (COMMERCE_OWNER_DATABASE_URL, commerce_ddl).
// deploy/boot.sh runs it after `prisma migrate deploy` and before the server.
//
// The runtime image is a Next standalone build without tsx or the source tree,
// so this file is bundled with everything it imports into one plain-node file
// by `pnpm build:boot` (esbuild) in the Dockerfile's builder stage, and the
// image runs `node commerce-migrate.cjs`. Locally it also runs as
// `pnpm exec tsx scripts/commerce-migrate.ts`.
//
// Exit code 0 when everything is up to date or was applied, 1 on any failure
// (missing or placeholder owner URL, the app role behind the owner URL, an
// unreachable database, a failing migration). Never prints a connection string.

import { runCommerceDeployMigrations } from '@/server/commerce/provisioning/deploy';

runCommerceDeployMigrations()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`commerce-migrate failed: ${message}`);
    process.exitCode = 1;
  });
