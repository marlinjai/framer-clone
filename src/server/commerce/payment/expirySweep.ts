import 'server-only';

// src/server/commerce/payment/expirySweep.ts
//
// The scheduled pass over every company's expired payments. A new order and a payment sweep their own company
// first, so this is what ends a hold in a shop nobody is buying from: without it the storefront would keep showing
// the stock as taken. Called by a host timer through POST /api/internal/commerce/expired-payments.
//
// On its way out: each order now has its own job (expiryJob.ts). This pass stays beside it until that job has been live
// for a deploy, then slice B3R of docs/plans/2026-11-02-shop-backbone.md removes it with its host timer.

import { getPrismaClient } from '@/server/db';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '../db';
import { isTenantSchemaError } from '../tenant';
import { paymentDeps } from './deps';
import { ExpirySweepError, sweepExpiredPayments } from './payments';

export interface ExpirySweepSummary {
  /** Tenant groups swept. */
  tenantGroups: number;
  /** Tenant groups without commerce (never provisioned, or a legacy id): nothing to sweep. */
  skipped: number;
  /** Payments closed, their stock released. */
  closed: number;
  /** Payments, or whole tenant groups or companies, that could not be swept (logged; the next pass tries again). */
  failed: number;
}

/** One pass over every tenant group that has a site. One group or company that fails never stops the others. */
export async function sweepAllExpiredPayments(): Promise<ExpirySweepSummary> {
  const summary: ExpirySweepSummary = { tenantGroups: 0, skipped: 0, closed: 0, failed: 0 };
  const groups = await getPrismaClient().site.findMany({ distinct: ['tenantGroupId'], select: { tenantGroupId: true } });
  for (const { tenantGroupId } of groups) {
    try {
      const db = await commerceTenantDbChecked(tenantGroupId);
      const companies = await db
        .selectFrom('order_payment')
        .select('tenant_id')
        .distinct()
        .where('status', '=', 'pending')
        .where('expires_at', '<', new Date())
        .execute();
      summary.tenantGroups += 1;
      for (const { tenant_id: companyId } of companies) {
        try {
          const closed = await sweepExpiredPayments(paymentDeps(db, tenantGroupId, companyId), companyId);
          summary.closed += closed.length;
        } catch (err) {
          if (err instanceof ExpirySweepError) {
            summary.closed += err.closed.length;
            summary.failed += err.failed.length;
          } else {
            console.error(`[payments] the expiry sweep of company ${companyId} failed:`, err);
            summary.failed += 1;
          }
        }
      }
    } catch (err) {
      if (isCommerceTenantNotProvisioned(err) || isTenantSchemaError(err)) {
        summary.skipped += 1;
      } else {
        console.error(`[payments] the expiry sweep of tenant group ${tenantGroupId} failed:`, err);
        summary.failed += 1;
      }
    }
  }
  return summary;
}
