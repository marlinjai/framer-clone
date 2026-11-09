import 'server-only';

// src/server/sites/liveBus.ts
//
// The in-process bus of a site's live events (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 1). The site repository
// publishes `site:version` here after a write of the working copy commits; the
// events route (GET /api/projects/<id>/events) subscribes one listener per open
// editor stream and forwards what it hears.
//
// Production runs one container (deploy/README.md), so a process-local emitter
// reaches every stream. With more than one, this module is what changes (the
// plan's section 7: Postgres LISTEN/NOTIFY), and its callers stay as they are.
//
// The bus also counts the open streams, for the bounds the route enforces: at
// most 4 per session, 50 per site, 200 per company (its tenant group, so one
// company's editors can never take the whole process's share from the others)
// and 1,000 per process.
//
// Kept on globalThis so a development hot reload does not split publishers and
// subscribers across two copies of this module.

import { EventEmitter } from 'node:events';

export type LiveListener = (event: string, data: unknown) => void;

export const LIVE_STREAM_LIMITS = { perSession: 4, perSite: 50, perCompany: 200, perProcess: 1000 } as const;

interface BusState {
  emitter: EventEmitter;
  perSite: Map<string, number>;
  perSession: Map<string, number>;
  perCompany: Map<string, number>;
  total: number;
}

const KEY = Symbol.for('lumitra.liveBus');

function state(): BusState {
  const g = globalThis as unknown as Record<symbol, BusState | undefined>;
  let s = g[KEY];
  if (!s) {
    const emitter = new EventEmitter();
    // One listener per open stream; the per-process bound keeps this finite.
    emitter.setMaxListeners(0);
    s = { emitter, perSite: new Map(), perSession: new Map(), perCompany: new Map(), total: 0 };
    g[KEY] = s;
  }
  return s;
}

/** Send an event to every stream open on the site. Never throws: a broken listener is logged. */
export function publishSiteEvent(siteId: string, event: string, data: unknown): void {
  const { emitter } = state();
  for (const listener of emitter.listeners(siteId) as LiveListener[]) {
    try {
      listener(event, data);
    } catch (err) {
      console.error(`[live] a listener of site ${siteId} failed on ${event}`, err);
    }
  }
}

/** Listen to a site's events; answers the unsubscribe. */
export function subscribeSite(siteId: string, listener: LiveListener): () => void {
  const { emitter } = state();
  emitter.on(siteId, listener);
  return () => {
    emitter.off(siteId, listener);
  };
}

function decrement(map: Map<string, number>, key: string): void {
  const left = (map.get(key) ?? 1) - 1;
  if (left > 0) map.set(key, left);
  else map.delete(key);
}

/**
 * Take a stream slot for a session of a company (its tenant group id, from the
 * scope the route's guard verified) on a site. Answers the release
 * (idempotent), or null when a bound is reached (the route answers 429).
 */
export function acquireStreamSlot(siteId: string, sessionKey: string, companyKey: string): (() => void) | null {
  const s = state();
  const site = s.perSite.get(siteId) ?? 0;
  const session = s.perSession.get(sessionKey) ?? 0;
  const company = s.perCompany.get(companyKey) ?? 0;
  if (
    s.total >= LIVE_STREAM_LIMITS.perProcess ||
    site >= LIVE_STREAM_LIMITS.perSite ||
    session >= LIVE_STREAM_LIMITS.perSession ||
    company >= LIVE_STREAM_LIMITS.perCompany
  ) {
    return null;
  }
  s.total += 1;
  s.perSite.set(siteId, site + 1);
  s.perSession.set(sessionKey, session + 1);
  s.perCompany.set(companyKey, company + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.total -= 1;
    decrement(s.perSite, siteId);
    decrement(s.perSession, sessionKey);
    decrement(s.perCompany, companyKey);
  };
}

/** Tests only: forget every listener and slot. */
export function resetLiveBusForTests(): void {
  const s = state();
  s.emitter.removeAllListeners();
  s.perSite.clear();
  s.perSession.clear();
  s.perCompany.clear();
  s.total = 0;
}
