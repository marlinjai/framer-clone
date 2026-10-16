import 'server-only';

// src/server/commerce/schemaProbe.ts
//
// One catalog read: does a tenant schema physically exist? Used by db.ts to tell
// "this tenant group is provisioned" from "the site carries a valid tenant group
// UUID but its tg_<id> schema was never created" (an onboarding gap). Kept in
// its own module so the unit tests of db.ts can fake it without a database.
// pg_catalog is readable by every role, including the low-privilege commerce_app.

import { sql, type Kysely } from 'kysely';

export async function tenantSchemaExists<DB>(
  base: Kysely<DB>,
  schemaName: string,
): Promise<boolean> {
  const result = await sql<{ present: number }>`
    SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname = ${schemaName}
  `.execute(base);
  return result.rows.length > 0;
}
