// src/app/api/internal/commerce/jobs/run/route.ts
//
// POST /api/internal/commerce/jobs/run
//
// The watchdog of the shop's job engine (docs/plans/2026-11-02-shop-backbone.md,
// section 1.7): one pass, then its report. The poller in every server process does
// the work; a systemd timer calls this every 5 minutes (deploy/commerce/), so a dead
// poller still gets its work done and the journal shows it, and an Uptime Kuma
// monitor on the same route reaches Marlin.
//
// It answers 500 with the report (so the host unit's curl --fail-with-body fails)
// only when a pass failed or the oldest due job is over 10 minutes late. Dead jobs
// are a count and stay 200: a dead row persists, so turning red on one would keep
// the monitor red and hide the next real failure across all tenants. After a deploy
// rollback, the jobs of a kind the older build does not know count as late on
// purpose until the newer build is back.
//
// Paid orders without an invoice that no live job will issue are counted in
// `receiptsUnissued`, and `receipts` reads "unissued" while there are any, "ok"
// otherwise. That field is for its own Uptime Kuma keyword monitor matching
// `"receipts":"ok"`, so money taken without a receipt turns that monitor red
// while the status code stays 200 for this one.
//
// Form-submission purges of deleted projects (src/server/forms/purge.ts) never die and never give up, so a permanent fault
// would retry silently: they are counted in `purgesStuck` (five failures or more) and `purges` reads "stuck" while there
// are any, "ok" otherwise, for a fourth Uptime Kuma keyword monitor matching `"purges":"ok"` (deploy/README.md). Until that
// monitor exists nothing notifies a person of a stuck purge.
//
// Running at the same moment as a poller is harmless: the claim hands each job to
// one of them.
//
// Access: src/server/domains/internalAuth.ts (editor host, bearer token), the same
// gate and the same token as the other host timers.

import { jsonError } from '@/lib/api/respond';
import { runCommerceWatchdogPass } from '@/server/commerce/jobs/runtime';
import { checkInternalRequest } from '@/server/domains/internalAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LATE_AFTER_SECONDS = 10 * 60;

export async function POST(req: Request): Promise<Response> {
  const denied = checkInternalRequest(req);
  if (denied) return denied;

  try {
    const report = await runCommerceWatchdogPass();
    if (report.failed > 0) {
      return jsonError('commerce_jobs_unhealthy', 'a tenant group could not be worked on', 500, { report });
    }
    if (report.oldestDueSeconds > LATE_AFTER_SECONDS) {
      return jsonError('commerce_jobs_unhealthy', 'a due job is over 10 minutes late', 500, { report });
    }
    return Response.json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[commerce-job] the watchdog pass failed:', err);
    return jsonError('commerce_jobs_unhealthy', 'the pass failed', 500);
  }
}
