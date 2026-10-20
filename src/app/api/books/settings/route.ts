// src/app/api/books/settings/route.ts
//
// GET /api/books/settings -> { initialised, settings, counters }
//
// The company's Books configuration, read only (Books plan P1.8): the tax
// status (Section 19 small business or regular), the exemption note, the
// sender block the documents are issued under, the default payment terms and
// the number series with the number the next issue receives. All of it is set
// by an operator with `pnpm books:init-company` (the sender comes from the
// auth-brain company record plus a local file, never typed into the editor), so
// the editor shows it and says where it comes from. A company that was never
// initialised answers `initialised: false` (200), so the Books area can explain
// the missing step instead of failing every action.

import { booksRoute } from '@/server/books/http/route';
import { readCounters, readSettings } from '@/server/books/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute('read', async (ctx) => {
  const settings = await readSettings(ctx.scope.db, ctx.scope);
  const counters = await readCounters(ctx.scope.db, ctx.scope);
  return Response.json({
    initialised: settings !== null && counters.some((c) => c.docType === 'invoice'),
    settings: settings
      ? {
          taxStatus: settings.taxStatus,
          exemptionNote: settings.exemptionNote,
          senderBlock: settings.senderBlock,
          defaultPaymentTermsDays: settings.defaultPaymentTermsDays,
        }
      : null,
    counters,
  });
});
