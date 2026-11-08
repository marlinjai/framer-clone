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
// most 4 per session, 50 per site and 1,000 per process.
//
// Kept on globalThis so a development hot reload does not split publishers and
// subscribers across two copies of this module.

import { EventEmitter } from 'node:events';

export type LiveListener = (event: string, data: unknown) => void;

export const LIVE_STREAM_LIMITS = { perSession: 4, perSite: 50, perProcess: 1000 } as const;

interface BusState {
  emitter: EventEmitter;
  perSite: Map<string, number>;
  perSession: Map<string, number>;
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
    s = { emitter, perSite: new Map(), perSession: new Map(), total: 0 };
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

/**
 * Take a stream slot for a session on a site. Answers the release (idempotent),
 * or null when a bound is reached (the route answers 429).
 */
export function acquireStreamSlot(siteId: string, sessionKey: string): (() => void) | null {
  const s = state();
  const site = s.perSite.get(siteId) ?? 0;
  const session = s.perSession.get(sessionKey) ?? 0;
  if (s.total >= LIVE_STREAM_LIMITS.perProcess || site >= LIVE_STREAM_LIMITS.perSite || session >= LIVE_STREAM_LIMITS.perSession) {
    return null;
  }
  s.total += 1;
  s.perSite.set(siteId, site + 1);
  s.perSession.set(sessionKey, session + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.total -= 1;
    const siteLeft = (s.perSite.get(siteId) ?? 1) - 1;
    if (siteLeft > 0) s.perSite.set(siteId, siteLeft);
    else s.perSite.delete(siteId);
    const sessionLeft = (s.perSession.get(sessionKey) ?? 1) - 1;
    if (sessionLeft > 0) s.perSession.set(sessionKey, sessionLeft);
    else s.perSession.delete(sessionKey);
  };
}

/** Tests only: forget every listener and slot. */
export function resetLiveBusForTests(): void {
  const s = state();
  s.emitter.removeAllListeners();
  s.perSite.clear();
  s.perSession.clear();
  s.total = 0;
}
