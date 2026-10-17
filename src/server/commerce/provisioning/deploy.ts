// src/server/commerce/provisioning/deploy.ts
//
// The commerce half of the container start sequence (deploy/boot.sh): after the
// Prisma migrations, bring the commerce tier up to date, as the OWNER role.
//
//   1. migrateCommercePublic: the shared `ext` schema and the
//      `public.tenant_groups` registry (idempotent, applies nothing once present).
//   2. migrateAllCommerceTenants: every provisioned `tg_<id>` schema gets the
//      tenant migrations it is missing, and the append-only REVOKEs are
//      re-asserted (idempotent and resumable).
//
// Before touching anything it proves it is NOT connected as the low-privilege
// app role: the owner URL must be set, must not be a placeholder, must differ
// from the app URL, and `current_user` must not be `commerce_app`. Any failure
// throws, and the boot script turns a throw into a failed container start, so a
// bad migration or a miswired secret stops the deploy instead of serving a
// half-migrated shop.
//
// No `server-only` import anywhere in this module's graph: it is bundled into a
// single file by esbuild (scripts/commerce-migrate.ts) and run with plain node.

import postgres from 'postgres';

import { migrateCommercePublic } from './public';
import { COMMERCE_APP_ROLE, migrateAllCommerceTenants } from './provision';

/** What the start sequence did, for the boot log. */
export interface CommerceDeployResult {
  /** The role the owner URL authenticated as. */
  role: string;
  /** Public migrations newly applied (empty once the tier exists). */
  publicApplied: string[];
  /** Tenant schemas seen in the registry. */
  tenantSchemas: number;
  /** Per schema, the tenant migrations newly applied. */
  tenantApplied: { schema: string; applied: string[] }[];
}

/** A value that is visibly a stand-in, never a real connection string. */
function isPlaceholder(value: string): boolean {
  return /PLACEHOLDER|REPLACE_ME/i.test(value);
}

/**
 * Check the owner connection is wired to the owner role and not the app role.
 * Exported for the unit test; {@link runCommerceDeployMigrations} calls it.
 *
 * @throws Error naming the problem when the wiring is wrong.
 */
export function assertOwnerUrlShape(env: {
  ownerUrl: string | undefined;
  appUrl: string | undefined;
}): string {
  const { ownerUrl, appUrl } = env;
  if (!ownerUrl) {
    throw new Error(
      'COMMERCE_OWNER_DATABASE_URL is not set. The container runs the commerce ' +
        'public and tenant migrations at start as the owner role commerce_ddl; ' +
        'set the owner URL in Infisical (prod, path /) before deploying.',
    );
  }
  if (isPlaceholder(ownerUrl)) {
    throw new Error(
      'COMMERCE_OWNER_DATABASE_URL is still a placeholder. Write the real ' +
        'commerce_ddl connection string (infra RUNBOOK, step 7) before deploying.',
    );
  }
  if (appUrl && appUrl === ownerUrl) {
    throw new Error(
      'COMMERCE_OWNER_DATABASE_URL equals COMMERCE_APP_DATABASE_URL. Migrations ' +
        'must run as the owner role commerce_ddl, never as the app role commerce_app.',
    );
  }
  return ownerUrl;
}

/**
 * Run the commerce public migrations and the tenant fleet migration as the
 * owner role. Throws on any failure (the caller exits non-zero).
 *
 * @param opts.ownerUrl Defaults to COMMERCE_OWNER_DATABASE_URL.
 * @param opts.appUrl   Defaults to COMMERCE_APP_DATABASE_URL (only compared).
 * @param opts.log      Progress lines; defaults to console.log.
 */
export async function runCommerceDeployMigrations(opts?: {
  ownerUrl?: string;
  appUrl?: string;
  log?: (line: string) => void;
}): Promise<CommerceDeployResult> {
  const log = opts?.log ?? ((line: string) => console.log(line));
  const ownerUrl = assertOwnerUrlShape({
    ownerUrl: opts?.ownerUrl ?? process.env.COMMERCE_OWNER_DATABASE_URL,
    appUrl: opts?.appUrl ?? process.env.COMMERCE_APP_DATABASE_URL,
  });

  // Who are we really? A URL can name any role; ask the server.
  const probe = postgres(ownerUrl, { max: 1, prepare: false });
  let role: string;
  try {
    const rows = await probe<{ role: string }[]>`SELECT current_user AS role`;
    role = rows[0].role;
  } finally {
    await probe.end();
  }
  if (role === COMMERCE_APP_ROLE) {
    throw new Error(
      `COMMERCE_OWNER_DATABASE_URL authenticates as ${COMMERCE_APP_ROLE}, the ` +
        'low-privilege app role. Point it at the owner role commerce_ddl.',
    );
  }
  log(`commerce: migrating as ${role}`);

  const publicApplied = await migrateCommercePublic(ownerUrl);
  log(
    publicApplied.length === 0
      ? 'commerce: public tier up to date'
      : `commerce: public migrations applied: ${publicApplied.join(', ')}`,
  );

  const fleet = await migrateAllCommerceTenants({
    connectionString: ownerUrl,
    onSchemaDone: ({ schema, applied, index, total }) => {
      const what = applied.length === 0 ? 'up to date' : `applied ${applied.join(', ')}`;
      log(`commerce: [${index + 1}/${total}] ${schema}: ${what}`);
    },
  });
  log(`commerce: tenant fleet done, ${fleet.processed}/${fleet.total} schema(s)`);

  return {
    role,
    publicApplied,
    tenantSchemas: fleet.total,
    tenantApplied: fleet.schemas.map(({ schema, applied }) => ({ schema, applied })),
  };
}
