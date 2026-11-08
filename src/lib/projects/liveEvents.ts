// src/lib/projects/liveEvents.ts
//
// The events of a site's live stream (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 1): what GET /api/projects/<id>/events sends an open editor. Shared by
// the server (src/server/sites/liveBus.ts, the events route) and the browser
// (src/lib/projects/liveSync.ts), so both read one shape. Client-safe: types and
// small pure helpers only.
//
// Nothing here carries content. An event says that a version exists and what it
// touched (ids, operation names, server-written summary lines); the content comes
// from the snapshot route (GET /api/projects/<id>/document), for every writer alike.

/** Who wrote a version. */
export type SiteWriteOrigin = 'editor' | 'mcp' | 'generate' | 'publish' | 'erasure';

/** The writer as the editor shows it: never a key id or an email address. */
export interface SiteWriteActor {
  kind: 'user' | 'key';
  /** Plain text, at most LIVE_LABEL_MAX characters. */
  label: string;
}

/** One operation of a site-operations batch, by name and id (src/server/siteOps/audit.ts AuditedOp). */
export interface SiteVersionOp {
  op: string;
  nodeId?: string;
  pageId?: string;
}

/** What a writer tells the bus about its write, besides the version numbers. */
export interface SiteWriteEvent {
  origin: SiteWriteOrigin;
  /** The random id of the editor tab that sent the write; absent for every other writer. */
  originTab?: string;
  actor?: SiteWriteActor;
  /** Site operations only: the operations of the batch. */
  ops?: SiteVersionOp[];
  /** Site operations only: every `ref` the batch gave, with the id it became. */
  created?: Record<string, string>;
  /** Site operations only: one line per operation, written by the server. */
  summary?: string[];
}

/** `site:version`: a committed write of the working copy. */
export interface SiteVersionEvent extends SiteWriteEvent {
  version: number;
  versionBefore: number;
  /**
   * True when this is the catch-up a reconnect gets (Last-Event-ID behind the
   * current version): one or more writes happened while the stream was away, so
   * origin and actor are unknown and the editor treats it as a foreign write.
   */
  catchUp?: boolean;
}

/** `state`: sent once on connect. Slices 2 and 4 fill the lists. */
export interface SiteStateEvent {
  version: number;
  /** Live skeleton plans of the site (slice 4). */
  plans: unknown[];
  /** Active agents and their last focus (slice 2). */
  agents: unknown[];
  /** The last feed lines (slice 2). */
  feed: unknown[];
}

/** Every event name the stream sends. */
export const LIVE_EVENTS = {
  state: 'state',
  siteVersion: 'site:version',
  authExpired: 'auth:expired',
} as const;

/** Labels and summary lines are capped like this before they leave the server. */
export const LIVE_LABEL_MAX = 80;

/** At most this many ops, created entries and summary lines travel with one event. */
export const LIVE_LIST_MAX = 200;

/** Cap a server-written line for the stream: one line, plain text, LIVE_LABEL_MAX characters. */
export function capLiveText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > LIVE_LABEL_MAX ? `${oneLine.slice(0, LIVE_LABEL_MAX - 1)}…` : oneLine;
}

/** A write event as it may travel: lists bounded, text capped. */
export function boundedWriteEvent(event: SiteWriteEvent): SiteWriteEvent {
  const out: SiteWriteEvent = { origin: event.origin };
  if (event.originTab) out.originTab = event.originTab;
  if (event.actor) out.actor = { kind: event.actor.kind, label: capLiveText(event.actor.label) || 'Someone' };
  if (event.ops) out.ops = event.ops.slice(0, LIVE_LIST_MAX);
  if (event.created) out.created = Object.fromEntries(Object.entries(event.created).slice(0, LIVE_LIST_MAX));
  if (event.summary) out.summary = event.summary.slice(0, LIVE_LIST_MAX).map(capLiveText);
  return out;
}

/** The pattern a tab id must match (the save and publish bodies check it). */
export const ORIGIN_TAB_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
