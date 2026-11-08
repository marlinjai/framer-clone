// src/server/erasure/payload.ts
//
// The body auth-brain signs and sends (its `ErasureWebhookPayload`, packages/shared/src/types.ts, serialized
// by `serializeErasureBody`): `{ event_id, kind, user_id, tenant_id?, workspace_ids?, requested_at }`, snake
// case. The tenant is the company in this app's vocabulary. Unknown extra fields are allowed: auth-brain adds
// fields additively (workspace_ids arrived in 1.4.0), and the signature already covers whatever was sent.

import { z } from 'zod';

/**
 * The most workspace ids one delivery may name. The route reads at most 64 KB, and the shortest entry
 * (`"a",`) takes 4 bytes, so a body the route accepts never holds more; the bound only keeps the parser's
 * work independent of the body limit.
 */
export const MAX_ERASURE_WORKSPACE_IDS = 16_384;

// `z.guid()`, never `z.uuid()`: auth-brain derives its event ids from SHA-256, so most of them carry no RFC
// 9562 version or variant bits (15 of 16 in production on 2026-11-08), and Zod 4's `uuid()` refuses those.
// The ids are only compared and stored, so the 8-4-4-4-12 hex format is the whole contract.
const payloadSchema = z.object({
  event_id: z.guid(),
  kind: z.string().min(1).max(100),
  user_id: z.string().max(200).optional(),
  tenant_id: z.guid().optional(),
  workspace_ids: z.array(z.string().min(1).max(200)).max(MAX_ERASURE_WORKSPACE_IDS).optional(),
  requested_at: z.string().max(100).optional(),
});

export type ErasurePayload = z.infer<typeof payloadSchema>;

/** A company erasure, the one kind this app acts on. */
export interface CompanyErasure {
  eventId: string;
  /** The auth-brain company (tenant) id, lowercase. */
  companyId: string;
  /** The company's workspaces auth-brain names (may be empty). */
  workspaceIds: string[];
}

export type ParsedDelivery =
  | { kind: 'company'; erasure: CompanyErasure }
  | { kind: 'ignored'; eventId: string; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'incomplete'; eventId: string; reason: string };

/** Parse a verified body. Never throws. */
export function parseErasureDelivery(raw: string): ParsedDelivery {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'body is not JSON' };
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return { kind: 'invalid', reason: 'body does not match the erasure payload' };
  const body = parsed.data;
  const eventId = body.event_id.toLowerCase();
  if (body.kind === 'user.erased') {
    // framer-clone keeps no personal data per user: the only user ids it holds are audit references inside
    // a company (who erased a value, who ran an operation), which stay with the company and are erased with
    // it, and which point at nothing once auth-brain has removed the identity. See the plan, decision 4.
    return { kind: 'ignored', eventId, reason: 'user.erased: no per-user personal data is kept here' };
  }
  if (body.kind !== 'tenant.erased') return { kind: 'ignored', eventId, reason: `unknown kind ${body.kind}` };
  if (!body.tenant_id) return { kind: 'invalid', reason: 'tenant.erased without tenant_id' };
  if (!body.workspace_ids) return { kind: 'incomplete', eventId, reason: 'tenant.erased requires workspace_ids to include legacy sites; resend with the complete workspace list' };
  return {
    kind: 'company',
    erasure: {
      eventId,
      companyId: body.tenant_id.toLowerCase(),
      workspaceIds: [...new Set(body.workspace_ids ?? [])],
    },
  };
}
