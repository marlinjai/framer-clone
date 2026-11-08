import 'server-only';

// src/server/sites/companyCommerce.ts
//
// The commerce onboard hook every path that creates a site runs first: the
// project create route (POST /api/projects) and the site operations library's
// createSite (src/server/siteOps). A typed outcome instead of a Response, so a
// route and a library caller each answer it in their own form.

import {
  commerceSlugFor,
  CommerceTenantSuspendedError,
  ensureCommerceTenant,
} from '@/server/commerce/provisioning/provision';
import { AppRoleSearchPathError } from '@marlinjai/tenant-db';
import { CommerceLockTimeoutError } from '@/server/commerce/provisioning/ownerSql';

export type CompanyCommerceOutcome =
  | { ok: true }
  | {
      ok: false;
      code: 'commerce_not_configured' | 'commerce_suspended' | 'commerce_misconfigured' | 'commerce_busy' | 'commerce_provision_failed';
      message: string;
      status: 403 | 500 | 503;
      retryAfterSec?: number;
    };

/**
 * CM-11, the commerce-tenant ONBOARD HOOK.
 *
 * framer-clone does NOT mint tenant-groups: the workspace -> tenant -> tenant_group
 * hierarchy is owned by auth-brain and arrives on the verified session (scope.ts).
 * So provisioning is hooked at the first framer-clone path that (a) has a
 * server-verified `tenantGroupId` AND (b) owns commerce DDL: the project/site
 * create path. The first time a tenant-group creates a project here, its
 * `tg_<id>` commerce schema is stood up (migrations + `commerce_app` grants +
 * a read-only check of the `ext`-locked backstop) on the OWNER connection, out-of-band from the
 * request's app-role pool. Every later project of an already provisioned company
 * costs one registry read and nothing else (`ensureCommerceTenant`: no lock, no
 * DDL, no role check); only a miss runs the full provision, under the global
 * provisioning lock with bounded waits (as long as the queue of companies
 * provisioning moves, at most about 40 s, but 10 s behind one stuck provision;
 * 30 s per statement).
 *
 * The registry slug is `commerceSlugFor(tenant group, display slug)`: the
 * display slug plus the tenant-group id, so two companies whose auth-brain slugs
 * collide never block each other on the UNIQUE `tenant_groups.slug`.
 *
 * It runs BEFORE the site row is written, and a failure fails the create with
 * a named code (a route answers it with this status), with the cause in the server log:
 *  - 500 `commerce_not_configured` when COMMERCE_OWNER_DATABASE_URL is unset. A
 *    production container cannot even start without it (deploy/boot.sh), so
 *    this only catches a miswired environment, loudly, instead of creating
 *    projects whose shop would fail later.
 *  - 403 `commerce_suspended` when an operator suspended the company's commerce
 *    (`tenant_groups.status = 'suspended'`). Provisioning would set it active
 *    again, so it is never attempted; 403 rather than 500 because nothing is
 *    broken and a retry cannot succeed: the refusal is a decision about this
 *    company, lifted only by an operator.
 *  - 500 `commerce_misconfigured` when the app role commerce_app's default
 *    search_path is not exactly `ext` (tenant-db AppRoleSearchPathError).
 *    Provisioning only verifies that value, never sets it (the owner role may
 *    not alter roles), so a retry cannot succeed until an administrator runs
 *    the repair command the error names, which goes to the server log only; the
 *    container start step refuses to start on the same condition, so this
 *    catches a value changed after the start.
 *  - 500 `commerce_provision_failed` when provisioning throws anything else (database down, a
 *    tenant group id that is not a UUID, a migration error).
 *  - 503 `commerce_busy` with Retry-After when the provisioning lock was not
 *    granted (CommerceLockTimeoutError: one provision held it too long, or the
 *    queue of companies provisioning outlasted the wait): nothing is broken and
 *    the same request succeeds a moment later.
 * Provisioning first means a failure leaves NOTHING behind: no site row whose
 * company has no commerce schema, no "created but broken" project, and a retry
 * of the same request is clean. The connection details stay out of the
 * response; the log carries them.
 *
 * FLAG (deferral): there is no job/outbox seam in framer-clone to defer the DDL
 * to, so the first provision runs inline in this request. If a background-job
 * seam lands later, move this off the request path.
 */
export async function ensureCompanyCommerce(
  tenantGroupId: string,
  displaySlug: string | undefined,
): Promise<CompanyCommerceOutcome> {
  if (!process.env.COMMERCE_OWNER_DATABASE_URL) {
    console.error(
      `[commerce] cannot provision tenant_group ${tenantGroupId}: COMMERCE_OWNER_DATABASE_URL is not set`,
    );
    return {
      ok: false,
      code: 'commerce_not_configured',
      message: 'the shop database is not configured on this server; no project was created',
      status: 500,
    };
  }
  try {
    await ensureCommerceTenant({ tenantGroupId, slug: commerceSlugFor(tenantGroupId, displaySlug) });
    return { ok: true };
  } catch (err) {
    if (err instanceof CommerceTenantSuspendedError) {
      console.error(`[commerce] project create refused: commerce for tenant_group ${tenantGroupId} is suspended`);
      return {
        ok: false,
        code: 'commerce_suspended',
        message: "this company's shop is suspended; no project was created. Contact support to lift the suspension.",
        status: 403,
      };
    }
    if (err instanceof AppRoleSearchPathError) {
      console.error(
        `[commerce] cannot provision tenant_group ${tenantGroupId}: the app role is misconfigured (${err.problem}). ${err.message}`,
      );
      return {
        ok: false,
        code: 'commerce_misconfigured',
        message: 'the shop database on this server needs an administrator to fix it; no project was created',
        status: 500,
      };
    }
    if (err instanceof CommerceLockTimeoutError) {
      console.error(`[commerce] provisioning for tenant_group ${tenantGroupId} waited too long: ${err.message}`);
      return {
        ok: false,
        code: 'commerce_busy',
        message: 'several companies are setting up their shop right now; no project was created, try again in a moment',
        status: 503,
        retryAfterSec: 10,
      };
    }
    console.error(
      `[commerce] ensureCommerceTenant failed for tenant_group ${tenantGroupId}:`,
      err,
    );
    return {
      ok: false,
      code: 'commerce_provision_failed',
      message: 'setting up the shop for this company failed; no project was created, try again',
      status: 500,
    };
  }
}
