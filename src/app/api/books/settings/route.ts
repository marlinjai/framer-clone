// src/app/api/books/settings/route.ts
//
// GET /api/books/settings -> { initialised, settings, counters }
//
// The company's Books configuration, read only (Books plan P1.8): the tax
// status (Section 19 small business or regular), the exemption note, the
// sender the documents are issued under, the default payment terms and
// the number series with the number the next issue receives. An operator sets
// it with `pnpm books:init-company`. The sender is either stored in the Books or
// read from the company's linked business contact (books/sender.ts), which is
// edited in the receipts app; the editor shows it and says where it comes from. A company that was never
// initialised answers `initialised: false` (200), so the Books area can explain
// the missing step instead of failing every action.

import { isBooksError } from '@/server/books/errors';
import { booksRoute } from '@/server/books/http/route';
import { resolveSender } from '@/server/books/sender';
import type { BooksScope } from '@/server/books/scope';
import { readCounters, readSettings, type CompanySettings } from '@/server/books/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The sender as the Books would print it now. A linked contact that cannot be read or used does not fail the page:
 * the answer says why (`problem`, field names only), so the person knows what to correct.
 */
async function senderView(scope: BooksScope, settings: CompanySettings) {
  const source = settings.senderContactId === null ? ('settings' as const) : ('contact' as const);
  try {
    return { source, senderBlock: (await resolveSender(scope, settings)).block, problem: null };
  } catch (err) {
    if (!isBooksError(err, 'SENDER_UNAVAILABLE') && !isBooksError(err, 'SENDER_NOT_FOUND') && !isBooksError(err, 'SENDER_INVALID')) {
      throw err;
    }
    console.error(`[books] company ${scope.tenantId}: the sender cannot be used, ${err.code}`, err.cause ?? err.message);
    const fields = (err.details?.fields as string[] | undefined) ?? [];
    return { source, senderBlock: null, problem: { code: err.code.toLowerCase(), fields } };
  }
}

export const GET = booksRoute('read', async (ctx) => {
  const settings = await readSettings(ctx.scope.db, ctx.scope);
  const sender = settings ? await senderView(ctx.scope, settings) : null;
  const counters = await readCounters(ctx.scope.db, ctx.scope);
  return Response.json({
    initialised: settings !== null && counters.some((c) => c.docType === 'invoice'),
    settings: settings
      ? {
          taxStatus: settings.taxStatus,
          exemptionNote: settings.exemptionNote,
          senderBlock: sender!.senderBlock,
          senderSource: sender!.source,
          senderProblem: sender!.problem,
          defaultPaymentTermsDays: settings.defaultPaymentTermsDays,
        }
      : null,
    counters,
  });
});
