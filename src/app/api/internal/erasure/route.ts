// src/app/api/internal/erasure/route.ts
//
// POST /api/internal/erasure
//
// auth-brain's GDPR erasure webhook (plan docs/plans/2026-11-05-company-erasure-consumer.md). auth-brain
// erases a company by POSTing a signed `tenant.erased` event to every app that registers an erasure
// endpoint, and marks the erasure complete only when every app answers 2xx. This route deletes every row and
// file of the company here: its sites and everything hanging off them, its CMS collections, and its rows in
// every commerce and Books tenant schema (src/server/erasure).
//
// A machine caller, never a browser: no session, authenticated by an HMAC-SHA256 signature over the raw body
// with SITES_ERASURE_WEBHOOK_SECRET. Editor host only (app.lumitra.co; 404 elsewhere, and the host route
// table keeps it off published hosts).
//
//   - secret not configured          -> 503, nothing deleted (auth-brain retries once it is set)
//   - missing or wrong signature     -> 401, nothing deleted
//   - malformed body                 -> 400
//   - `user.erased` or another kind  -> 200, a no-op (no per-user personal data is kept here)
//   - an event already processed     -> 200, nothing deleted again
//   - a company never served here    -> 200, a no-op
//   - any failure while deleting     -> 500, the event stays unprocessed and auth-brain retries
//
// No answer or log line carries anything but ids and counts.

import { jsonError, readBodyBytes } from '@/lib/api/respond';
import { isEditorHost } from '@/lib/editorHost';
import { eraseCompany } from '@/server/erasure/eraseCompany';
import { parseErasureDelivery } from '@/server/erasure/payload';
import {
  ERASURE_EVENT_ID_HEADER,
  ERASURE_SECRET_ENV,
  ERASURE_SIGNATURE_HEADER,
  verifyErasureSignature,
} from '@/server/erasure/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A delivery is a few hundred bytes; this bound only stops abuse. */
const MAX_BODY_BYTES = 64 * 1024;

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: Request): Promise<Response> {
  if (!isEditorHost(req.headers.get('host'))) return jsonError('not_found', 'not found', 404);

  const secret = process.env[ERASURE_SECRET_ENV]?.trim() ?? '';
  if (!secret) {
    console.error(`[erasure] ${ERASURE_SECRET_ENV} is not set; erasure deliveries are refused until it is`);
    return jsonError('erasure_not_configured', 'erasure is not configured', 503);
  }

  // The signature covers the exact bytes received: verify those, never a decoded and re-encoded copy.
  const body = await readBodyBytes(req, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  if (!verifyErasureSignature(body.bytes, req.headers.get(ERASURE_SIGNATURE_HEADER), secret)) {
    return jsonError('invalid_signature', 'invalid signature', 401);
  }

  const delivery = parseErasureDelivery(new TextDecoder().decode(body.bytes));
  if (delivery.kind === 'invalid') return jsonError('bad_payload', delivery.reason, 400);

  const headerEventId = req.headers.get(ERASURE_EVENT_ID_HEADER)?.trim().toLowerCase();
  const eventId = delivery.kind === 'company' ? delivery.erasure.eventId : delivery.eventId;
  if (headerEventId && headerEventId !== eventId) {
    return jsonError('bad_payload', 'the event id header does not match the body', 400);
  }

  if (delivery.kind === 'incomplete') return jsonError('incomplete_scope', delivery.reason, 503);

  if (delivery.kind === 'ignored') {
    console.info(`[erasure] ${eventId}: acknowledged without action (${delivery.reason})`);
    return Response.json({ ok: true, eventId, ignored: delivery.reason }, { headers: NO_STORE });
  }

  const { erasure } = delivery;
  try {
    const outcome = await eraseCompany(erasure);
    if (outcome.status === 'already_processed') {
      console.info(`[erasure] ${eventId}: already processed for company ${erasure.companyId}`);
      return Response.json({ ok: true, eventId, alreadyProcessed: true }, { headers: NO_STORE });
    }
    const commerceRows = Object.values(outcome.commerce.deleted).reduce((a, b) => a + b, 0);
    console.info(
      `[erasure] ${eventId}: company ${erasure.companyId} erased (${outcome.publicRows.sites} site(s), ` +
        `${outcome.publicRows.cmsTables} CMS collection(s), ${commerceRows} commerce row(s) in ${outcome.commerce.erasedIn} of ${outcome.commerce.schemas} tenant schema(s)` +
        `${outcome.servedHere ? '' : '; never served here'})`,
    );
    return Response.json(
      {
        ok: true,
        eventId,
        servedHere: outcome.servedHere,
        deleted: { ...outcome.publicRows, commerce: outcome.commerce.deleted },
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    // A database error's detail can quote the row it was writing: log its name and SQLSTATE only.
    const name = err instanceof Error ? err.name : 'unknown error';
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[erasure] ${eventId}: erasing company ${erasure.companyId} failed (${name}${typeof code === 'string' ? ` ${code}` : ''})`);
    return jsonError('erasure_failed', 'the erasure failed and will be retried', 500);
  }
}
