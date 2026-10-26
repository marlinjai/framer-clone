import 'server-only';

// src/server/commerce/mail/receiptLink.ts
//
// The buyer's link to a receipt invoice: `<base>/api/receipts/<token>`, where the token is
// `v1.<payload>.<signature>`, the payload the tenant group, the company and the document (base64url JSON) and
// the signature an HMAC-SHA256 over `v1.<payload>` with RECEIPT_LINK_KEY. It does not expire, because an
// invoice must stay retrievable; rotating the key revokes every link. Verification compares in constant time
// and answers null for anything that is not a token this platform signed.

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReceiptRef {
  tenantGroupId: string;
  tenantId: string;
  documentId: string;
}

function sign(key: Buffer, signed: string): string {
  return createHmac('sha256', key).update(signed).digest('base64url');
}

export function receiptToken(key: Buffer, ref: ReceiptRef): string {
  const payload = Buffer.from(JSON.stringify({ g: ref.tenantGroupId, t: ref.tenantId, d: ref.documentId })).toString('base64url');
  const signed = `${VERSION}.${payload}`;
  return `${signed}.${sign(key, signed)}`;
}

export function readReceiptToken(key: Buffer, token: string): ReceiptRef | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const expected = Buffer.from(sign(key, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { g, t, d } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof g !== 'string' || typeof t !== 'string' || typeof d !== 'string') return null;
    if (!UUID.test(t) || d.length === 0 || d.length > 64 || !/^[0-9a-f-]+$/i.test(g)) return null;
    return { tenantGroupId: g, tenantId: t, documentId: d };
  } catch {
    return null;
  }
}
