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
// Both run under one session advisory lock (COMMERCE_DEPLOY_LOCK_KEY), so two
// containers starting at once queue instead of racing on a fresh database. All
// waits are bounded (ownerSql.ts BOOT_TIMEOUTS: lock 30 s, statement 45 s), so a
// stuck lock fails the start with CommerceLockTimeoutError instead of hanging.
//
// Before touching anything it proves it is NOT connected as the low-privilege
// app role: the owner URL must be set, must not be a placeholder, must differ
// from the app URL, and `current_user` must be neither `commerce_app` nor a
// superuser (the non-superuser owner commerce_ddl is the only accepted one). Any failure
// throws, and the boot script turns a throw into a failed container start, so a
// bad migration or a miswired secret stops the deploy instead of serving a
// half-migrated shop.
//
// No `server-only` import anywhere in this module's graph: it is bundled into a
// single file by esbuild (scripts/commerce-migrate.ts) and run with plain node.

import { migrateCommercePublic } from './public';
import { COMMERCE_APP_ROLE, migrateAllCommerceTenants } from './provision';
import {
  acquireAdvisoryLock,
  BOOT_TIMEOUTS,
  openOwnerSql,
  releaseAdvisoryLock,
  type OwnerTimeouts,
} from './ownerSql';

/**
 * Session advisory lock key held around the whole start step (public tier plus
 * fleet). Two containers starting at once (a rolling deploy, a restart during a
 * deploy, two replicas) would otherwise race: the public migrations take no
 * lock of their own, so both could try to create the same `ext` objects and
 * bookkeeping rows on a fresh database. With the lock the second container
 * waits, then finds everything applied and does nothing. Distinct from
 * COMMERCE_PROVISION_LOCK_KEY: a company provisioning its first project does
 * not wait for a deploy, and the fleet migration never alters roles.
 */
export const COMMERCE_DEPLOY_LOCK_KEY = 74_610_011;

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
  timeouts?: OwnerTimeouts;
}): Promise<CommerceDeployResult> {
  const log = opts?.log ?? ((line: string) => console.log(line));
  const timeouts = opts?.timeouts ?? BOOT_TIMEOUTS;
  const ownerUrl = assertOwnerUrlShape({
    ownerUrl: opts?.ownerUrl ?? process.env.COMMERCE_OWNER_DATABASE_URL,
    appUrl: opts?.appUrl ?? process.env.COMMERCE_APP_DATABASE_URL,
  });

  // One session for the identity check and the lock. The migrations open their
  // own sessions; the lock on this one covers them because every other start
  // step waits on the same key.
  const lockSession = openOwnerSql(ownerUrl, timeouts);
  try {
    // Who are we really? A URL can name any role; ask the server.
    const [{ role, superuser }] = await lockSession<{ role: string; superuser: boolean }[]>`
      SELECT current_user AS role,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
    `;
    if (role === COMMERCE_APP_ROLE) {
      throw new Error(
        `COMMERCE_OWNER_DATABASE_URL authenticates as ${COMMERCE_APP_ROLE}, the ` +
          'low-privilege app role. Point it at the owner role commerce_ddl.',
      );
    }
    if (superuser) {
      // The non-superuser owner is proven (roles.itest.ts), so there is no
      // reason to run the commerce tier, or keep a URL in the server process,
      // with superuser rights over the whole Postgres instance.
      throw new Error(
        `COMMERCE_OWNER_DATABASE_URL authenticates as ${role}, a superuser. Use the ` +
          'non-superuser owner role commerce_ddl (prisma/sql/commerce-roles.sql).',
      );
    }

    await acquireAdvisoryLock(lockSession, COMMERCE_DEPLOY_LOCK_KEY, 'commerce migration lock', timeouts, () =>
      log('commerce: another start step holds the commerce migration lock, waiting'),
    );
    try {
      return await migrateUnderLock(ownerUrl, role, log, timeouts);
    } finally {
      await releaseAdvisoryLock(lockSession, COMMERCE_DEPLOY_LOCK_KEY);
    }
  } finally {
    await lockSession.end();
  }
}

/** The public tier and the fleet, run while the deploy lock is held. */
async function migrateUnderLock(
  ownerUrl: string,
  role: string,
  log: (line: string) => void,
  timeouts: OwnerTimeouts,
): Promise<CommerceDeployResult> {
  log(`commerce: migrating as ${role}`);

  const publicApplied = await migrateCommercePublic(ownerUrl, timeouts);
  log(
    publicApplied.length === 0
      ? 'commerce: public tier up to date'
      : `commerce: public migrations applied: ${publicApplied.join(', ')}`,
  );

  const fleet = await migrateAllCommerceTenants({
    connectionString: ownerUrl,
    timeouts,
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
