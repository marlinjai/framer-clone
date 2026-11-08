import 'server-only';

// src/server/mcp/session.ts
//
// What this endpoint remembers between two requests: nothing on the server. A
// client declares what it can do (above all `elicitation`, the confirmation
// dialog) only once, in `initialize`, and every later request is a new HTTP
// request. So `initialize` answers an `Mcp-Session-Id` that carries those facts
// itself, signed: the negotiated protocol version, whether the client declared
// elicitation, the client's declared name (how an open editor names the agent
// when its key has no name), and a fingerprint of the key it was issued to. The client sends
// it back on every request (Streamable HTTP requires that), and the endpoint
// reads the facts from it.
//
// It is never a credential: every request is still authenticated by its own key
// (verifyCompanyKey), and an id issued to another key, a forged one or one
// signed before a restart (the signing secret is random per process) simply
// reads as "no elicitation", so the confirmation falls back to the approval
// link. The endpoint never answers 404 for an unknown session, because it keeps
// none.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitizeLiveLabel } from '@/lib/projects/liveEvents';

const SECRET = randomBytes(32);

export interface SessionFacts {
  protocolVersion: string;
  elicitation: boolean;
  /**
   * The name the client declared at initialize (`clientInfo.name`), sanitised
   * and capped at SESSION_CLIENT_NAME_MAX: an open editor names the agent by it
   * when the key has no name. Text the client chose, shown as plain text only.
   */
  clientName?: string;
}

/** The longest client name a session id carries (the id itself stays well under 512 characters). */
export const SESSION_CLIENT_NAME_MAX = 40;

function clientNameOf(value: unknown): string | undefined {
  const clean = sanitizeLiveLabel(value);
  if (!clean) return undefined;
  const chars = Array.from(clean);
  return chars.length > SESSION_CLIENT_NAME_MAX ? `${chars.slice(0, SESSION_CLIENT_NAME_MAX - 1).join('')}…` : clean;
}

/** A short fingerprint of the presented key; never the key and never reversible to it. */
export function keyFingerprint(presentedKey: string): string {
  return createHash('sha256').update(presentedKey).digest('base64url').slice(0, 16);
}

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueSessionId(facts: SessionFacts, fingerprint: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: facts.protocolVersion,
      e: facts.elicitation ? 1 : 0,
      k: fingerprint,
      n: randomBytes(6).toString('base64url'),
      ...(clientNameOf(facts.clientName) ? { c: clientNameOf(facts.clientName) } : {}),
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The facts an id carries, or null for a missing, forged, foreign-key or pre-restart id. */
export function readSessionId(id: string | null, fingerprint: string): SessionFacts | null {
  if (!id || id.length > 512) return null;
  const [payload, mac, extra] = id.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.k !== fingerprint || typeof parsed.v !== 'string') return null;
    const clientName = clientNameOf(parsed.c);
    return { protocolVersion: parsed.v, elicitation: parsed.e === 1, ...(clientName ? { clientName } : {}) };
  } catch {
    return null;
  }
}
