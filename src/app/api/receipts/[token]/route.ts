// src/app/api/receipts/[token]/route.ts
//
// GET /api/receipts/<token>: a buyer's receipt invoice (PDF) from the link in the shop's order confirmation.
// The editor host only; the signed token is the permission. Behaviour in src/server/commerce/mail/receiptRoute.ts.

import { jsonError } from '@/lib/api/respond';
import { isEditorHost } from '@/lib/editorHost';
import { receiptLinkKey } from '@/server/commerce/mail/config';
import { serveReceipt } from '@/server/commerce/mail/receiptRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!isEditorHost(req.headers.get('host'))) return jsonError('not_found', 'not found', 404);
  const { token } = await params;
  return serveReceipt(token, receiptLinkKey());
}
