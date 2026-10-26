import 'server-only';

// src/server/commerce/mail/receiptRoute.ts
//
// GET /api/receipts/<token>: the buyer's receipt invoice as a PDF, from the link in the order confirmation
// (docs/plans/2026-10-27-shop-receipt-email.md, decision 3). No session: the signed token is the permission, and
// it names exactly one document of one company. Only the stored document of record of an issued invoice made
// from a shop order is served, never a draft, an offer, a credit note or a hand-made invoice, so a link can
// reveal nothing else of the Books. Anything else answers the same 404, so a guess learns nothing.

import type { Kysely } from 'kysely';

import { jsonError } from '@/lib/api/respond';
import { documentPdf } from '@/server/books/render/store';
import { getDocument } from '@/server/books/repository/read';
import { booksScope } from '@/server/books/scope';
import { isPdfBytes } from '@/server/books/pdfBytes';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '../db';
import type { CommerceDB } from '../db-types';
import { readReceiptToken } from './receiptLink';

const NOT_FOUND = () => jsonError('not_found', 'This receipt link is not valid.', 404);

export async function serveReceipt(
  token: string,
  key: Buffer | null,
  dbFor: (tenantGroupId: string) => Promise<Kysely<CommerceDB>> = commerceTenantDbChecked,
): Promise<Response> {
  if (!key) return NOT_FOUND();
  const ref = readReceiptToken(key, token);
  if (!ref) return NOT_FOUND();
  let scope;
  try {
    scope = booksScope(await dbFor(ref.tenantGroupId), ref.tenantGroupId, ref.tenantId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return NOT_FOUND();
    throw err;
  }
  const view = await getDocument(scope, ref.documentId).catch(() => null);
  if (!view || view.document.docType !== 'invoice' || view.document.status === 'draft' || !view.document.sourceOrderId) {
    return NOT_FOUND();
  }
  const pdf = await documentPdf(scope, ref.documentId);
  if (!pdf.ofRecord || !isPdfBytes(pdf.bytes)) return NOT_FOUND();
  return new Response(Buffer.from(pdf.bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${pdf.fileName}"`,
      'content-length': String(pdf.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}
