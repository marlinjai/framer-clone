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
// containers starting at once queue instead of racing on a fresh database. The
// wait for that lock is bounded at 30 s (BOOT_LOCK_TIMEOUTS), so a stuck start
// fails with CommerceLockTimeoutError instead of hanging. The migrations
// themselves run with a 5 s lock wait for their DDL and no statement limit
// unless COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS sets one (ownerSql.ts).
//
// Before touching anything it proves it is connected as the intended owner:
// the owner URL must be set, must not be a placeholder and must differ from the
// app URL, and on the server BOTH session_user (the login) and current_user
// (the effective role, which a URL's `options=-c role=...` can change) must be
// `commerce_ddl`, which must not be a superuser, must not bypass row security
// and must not belong to a predefined role that reads or writes everything or
// reaches the server's files or programs (assertOwnerIdentity). Any failure
// throws, and the boot script turns a throw into a failed container start, so a
// bad migration or a miswired secret stops the deploy instead of serving a
// half-migrated shop.
//
// No `server-only` import anywhere in this module's graph: it is bundled into a
// single file by esbuild (scripts/commerce-migrate.ts) and run with plain node.

import { migrateCommercePublic } from './public';
import postgres from 'postgres';

import { migrateAllCommerceTenants } from './provision';
import {
  acquireAdvisoryLock,
  BOOT_LOCK_TIMEOUTS,
  migrationTimeouts,
  openOwnerSql,
  releaseAdvisoryLock,
  type OwnerTimeouts,
} from './ownerSql';

/** The only role the start step accepts behind COMMERCE_OWNER_DATABASE_URL. */
export const COMMERCE_OWNER_ROLE = 'commerce_ddl';

/**
 * Predefined roles that would let the owner read or write every table, or
 * reach the server's files and programs. Membership in any of them is refused.
 */
export const FORBIDDEN_OWNER_MEMBERSHIPS = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
] as const;

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
 * Prove the owner session is exactly the intended, bounded owner role. Checks
 * the login (session_user) and the effective role (current_user): a URL whose
 * `options` switch the role could otherwise hide a superuser login behind
 * `commerce_ddl`.
 *
 * @throws Error naming what is wrong.
 */
export async function assertOwnerIdentity(sql: postgres.Sql): Promise<string> {
  const [who] = await sql<
    {
      session_user: string;
      current_user: string;
      super: boolean;
      bypassrls: boolean;
      memberships: string[];
    }[]
  >`
    SELECT session_user::text AS session_user,
           current_user::text AS current_user,
           bool_or(r.rolsuper) AS super,
           bool_or(r.rolbypassrls) AS bypassrls,
           COALESCE(
             (SELECT array_agg(DISTINCT f.name ORDER BY f.name)
              FROM unnest(${FORBIDDEN_OWNER_MEMBERSHIPS as unknown as string[]}::text[]) AS f(name)
              WHERE pg_has_role(session_user, f.name, 'MEMBER')
                 OR pg_has_role(current_user, f.name, 'MEMBER')),
             '{}'
           ) AS memberships
    FROM pg_roles r
    WHERE r.rolname IN (session_user, current_user)
  `;
  const named = `session_user ${who.session_user}, current_user ${who.current_user}`;
  if (who.super) {
    throw new Error(
      `COMMERCE_OWNER_DATABASE_URL reaches a superuser (${named}). Use the non-superuser ` +
        `owner role ${COMMERCE_OWNER_ROLE} (prisma/sql/commerce-roles.sql).`,
    );
  }
  if (who.session_user !== COMMERCE_OWNER_ROLE || who.current_user !== COMMERCE_OWNER_ROLE) {
    throw new Error(
      `COMMERCE_OWNER_DATABASE_URL must log in as ${COMMERCE_OWNER_ROLE} and stay that role ` +
        `(found ${named}). The app role commerce_app, the database's own user and role ` +
        'switches in the URL are all refused.',
    );
  }
  if (who.bypassrls) {
    throw new Error(`${COMMERCE_OWNER_ROLE} has BYPASSRLS; re-run prisma/sql/commerce-roles.sql to remove it.`);
  }
  if (who.memberships.length > 0) {
    throw new Error(
      `${COMMERCE_OWNER_ROLE} is a member of ${who.memberships.join(', ')}; revoke that membership ` +
        'before deploying (the owner must not read or write every table or reach server files).',
    );
  }
  return who.current_user;
}

/**
 * Run the commerce public migrations and the tenant fleet migration as the
 * owner role. Throws on any failure (the caller exits non-zero).
 *
 * @param opts.ownerUrl Defaults to COMMERCE_OWNER_DATABASE_URL.
 * @param opts.appUrl   Defaults to COMMERCE_APP_DATABASE_URL (only compared).
 * @param opts.log      Progress lines; defaults to console.log.
 * @param opts.timeouts Overrides for the bounded waits (tests).
 */
export async function runCommerceDeployMigrations(opts?: {
  ownerUrl?: string;
  appUrl?: string;
  log?: (line: string) => void;
  /** Bounded waits: `lock` for the start-step lock session, `migration` for the migrations. */
  timeouts?: { lock?: OwnerTimeouts; migration?: OwnerTimeouts };
}): Promise<CommerceDeployResult> {
  const log = opts?.log ?? ((line: string) => console.log(line));
  const lockTimeouts = opts?.timeouts?.lock ?? BOOT_LOCK_TIMEOUTS;
  // Read (and validate) the migration budget before touching the database, so a
  // malformed COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS fails the start at once.
  const migrationBudget = opts?.timeouts?.migration ?? migrationTimeouts();
  const ownerUrl = assertOwnerUrlShape({
    ownerUrl: opts?.ownerUrl ?? process.env.COMMERCE_OWNER_DATABASE_URL,
    appUrl: opts?.appUrl ?? process.env.COMMERCE_APP_DATABASE_URL,
  });

  // One session for the identity check and the lock. The migrations open their
  // own sessions; the lock on this one covers them because every other start
  // step waits on the same key.
  const lockSession = await openOwnerSql(ownerUrl, lockTimeouts);
  try {
    const role = await assertOwnerIdentity(lockSession);

    await acquireAdvisoryLock(lockSession, COMMERCE_DEPLOY_LOCK_KEY, 'commerce migration lock', lockTimeouts, () =>
      log('commerce: another start step holds the commerce migration lock, waiting'),
    );
    try {
      return await migrateUnderLock(ownerUrl, role, log, migrationBudget);
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
