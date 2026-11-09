import 'server-only';

// src/server/sites/liveDocumentCache.ts
//
// The serialized answer of GET /api/projects/<id>/document, kept per
// (workspace, site, version) (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 1). After a write every open editor of the site fetches the new copy
// at once; without this each fetch loads the rows, rebuilds the project model
// and serializes it again. With it the first fetch does that work and the
// others reuse its string. It never replaces the route's guard, which runs on
// every request before this is asked.
//
// Why the version is a sound key: every write of the working copy (a save, an
// MCP batch, a generation, a rollback, an erasure) moves the site's version in
// the same transaction. The one write that changes the snapshot without moving
// it is a rename (the name and projectUpdatedAt), and the repository forgets
// the site here when a rename commits (forgetSiteDocuments). A load that raced
// such a forget is not kept: every forget moves one process-wide epoch, and a
// body is only stored when the epoch is still the one read before its load
// (renames are rare, so a load that overlapped any of them just goes unkept).
//
// Bounded: LIVE_DOCUMENT_CACHE_LIMITS.entries bodies and
// LIVE_DOCUMENT_CACHE_LIMITS.bytes characters in all (the least recently used
// goes first), one version per site (a newer one replaces it), and a body larger
// than LIVE_DOCUMENT_CACHE_LIMITS.entryBytes is never kept. Process memory, like
// the bus: production runs one container (the plan's section 7). Kept on
// globalThis so a development hot reload does not split writers and readers.

import type { TenantScope } from './repository';

export const LIVE_DOCUMENT_CACHE_LIMITS = {
  entries: 64,
  /** Characters of all kept bodies together (about two bytes each in memory). */
  bytes: 32 * 1024 * 1024,
  /** A single body larger than this is served but never kept. */
  entryBytes: 8 * 1024 * 1024,
} as const;

interface CachedBody {
  siteId: string;
  version: number;
  body: string;
}

interface CacheState {
  /** `${workspaceId}:${siteId}` to its body, least recently used first. */
  bodies: Map<string, CachedBody>;
  /** Characters held. */
  size: number;
  /** Moved by every forget, so a load that raced one is not kept. */
  epoch: number;
}

const KEY = Symbol.for('lumitra.liveDocumentCache');

function state(): CacheState {
  const g = globalThis as unknown as Record<symbol, CacheState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { bodies: new Map(), size: 0, epoch: 0 };
    g[KEY] = s;
  }
  return s;
}

const keyOf = (scope: TenantScope, siteId: string) => `${scope.workspaceId}:${siteId}`;

function drop(s: CacheState, key: string): void {
  const entry = s.bodies.get(key);
  if (!entry) return;
  s.bodies.delete(key);
  s.size -= entry.body.length;
}

/** The kept body of this site at exactly this version, or undefined. */
export function cachedDocument(scope: TenantScope, siteId: string, version: number): string | undefined {
  const s = state();
  const key = keyOf(scope, siteId);
  const entry = s.bodies.get(key);
  if (!entry || entry.version !== version) return undefined;
  // Most recently used last.
  s.bodies.delete(key);
  s.bodies.set(key, entry);
  return entry.body;
}

/** The epoch, read before a load whose body may be kept. */
export function documentEpoch(): number {
  return state().epoch;
}

/** Keep a body read at `epoch` (documentEpoch before the load); one a forget overtook is dropped. */
export function rememberDocument(scope: TenantScope, siteId: string, version: number, body: string, epoch: number): void {
  const s = state();
  if (s.epoch !== epoch) return;
  if (body.length > LIVE_DOCUMENT_CACHE_LIMITS.entryBytes) return;
  const key = keyOf(scope, siteId);
  const held = s.bodies.get(key);
  // Never step back: a slower load of an older version does not replace a newer one.
  if (held && held.version > version) return;
  drop(s, key);
  s.bodies.set(key, { siteId, version, body });
  s.size += body.length;
  while (s.bodies.size > LIVE_DOCUMENT_CACHE_LIMITS.entries || s.size > LIVE_DOCUMENT_CACHE_LIMITS.bytes) {
    drop(s, s.bodies.keys().next().value as string);
  }
}

/** A write changed the site's snapshot without moving its version (a rename): forget it, in every workspace key. */
export function forgetSiteDocuments(siteId: string): void {
  const s = state();
  s.epoch += 1;
  for (const [key, entry] of s.bodies) if (entry.siteId === siteId) drop(s, key);
}

/** Tests only: forget everything. */
export function resetLiveDocumentCacheForTests(): void {
  const s = state();
  s.bodies.clear();
  s.epoch = 0;
  s.size = 0;
}
