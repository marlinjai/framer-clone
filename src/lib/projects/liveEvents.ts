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
   * True on the stream of the tab that sent this write. The tab's id itself
   * never travels on the stream (another editor could replay it): the route
   * compares it with the id the stream was opened with and sends this flag.
   */
  own?: boolean;
  /**
   * True when this is the catch-up a reconnect gets (Last-Event-ID behind the
   * current version): one or more writes happened while the stream was away, so
   * origin and actor are unknown and the editor treats it as a foreign write.
   */
  catchUp?: boolean;
}

/** How an MCP tool call ended (`agent:activity` with phase `end`). */
export type AgentOutcome = 'ok' | 'rejected' | 'site_changed' | 'failed';

/**
 * `agent:activity` (plan section 2): an MCP tool call on this site started or
 * ended. Ids and server-written lines only: `label` is the key's name as
 * auth-brain holds it (else the MCP client's declared name, else "Agent") and
 * `summary` is the first summary line of a write, both capped and plain text.
 * `agentId` is a hash of the key id, never the key id itself.
 */
export interface AgentActivity {
  /** Random per call: the start and the end of one call share it. */
  callId: string;
  /** Stable per key, a hash of its id. */
  agentId: string;
  label: string;
  /** The tool's name: 'get_page', 'apply_batch', 'generate_page', ... */
  tool: string;
  phase: 'start' | 'end';
  /** On `end`. */
  outcome?: AgentOutcome;
  /** The page the call reads or writes, when it names one. */
  pageId?: string;
  /** Start: the node ids its arguments name. End: those plus the ids it created. At most LIVE_LIST_MAX. */
  nodeIds?: string[];
  /** The skeleton ref the call fulfils (slice 4). */
  sectionRef?: string;
  /** On the end of a write: its first summary line. */
  summary?: string;
  /** On the end of a batch: how many operations it held. */
  changes?: number;
  /** ISO 8601. */
  at: string;
}

/**
 * One line of the activity feed. A write that committed comes from its audit
 * row (src/server/siteOps/audit.ts), so it is there again after a reload;
 * reads and refused calls leave no row and exist only live. The words are
 * composed by the editor (a page title is content and never travels).
 */
export interface LiveFeedLine {
  /** The audit row's id, or the call id of a live line. */
  id: string;
  agentId: string;
  label: string;
  actorKind: 'key' | 'user';
  tool: string;
  outcome: AgentOutcome;
  pageId?: string;
  /** The nodes the call named or created (a click selects the ones that still exist). */
  nodeIds?: string[];
  /** How many operations a batch held. */
  changes?: number;
  /** ISO 8601. */
  at: string;
}

/** `state`: sent once on connect. Slice 4 fills `plans`. */
export interface SiteStateEvent {
  version: number;
  /** Live skeleton plans of the site (slice 4). */
  plans: unknown[];
  /**
   * The agents active on the site and their last focus: the latest activity of
   * each, `start` while one of its calls is still running. Only agents seen
   * within AGENT_ACTIVE_MS: one that left is never reattached.
   */
  agents: AgentActivity[];
  /** The last LIVE_FEED_MAX feed lines, newest first. */
  feed: LiveFeedLine[];
}

/** Every event name the stream sends. */
export const LIVE_EVENTS = {
  state: 'state',
  siteVersion: 'site:version',
  agentActivity: 'agent:activity',
  authExpired: 'auth:expired',
} as const;

/** The feed keeps this many lines (the state event's backfill too). */
export const LIVE_FEED_MAX = 30;
/** The presence frame stays this long after an agent's last call ended, then fades. */
export const AGENT_FRAME_LINGER_MS = 4_000;
/**
 * An agent counts as active (the top bar's "... is editing this site", the
 * state event's agents) while a call runs and this long after its last one
 * ended: an agent thinks between calls, and the person should still know.
 */
export const AGENT_ACTIVE_MS = 60_000;

/** Labels and summary lines are capped like this before they leave the server. */
export const LIVE_LABEL_MAX = 80;

/** At most this many ops, created entries and summary lines travel with one event. */
export const LIVE_LIST_MAX = 200;

/** Cap a server-written line for the stream: one line, plain text, LIVE_LABEL_MAX characters. */
export function capLiveText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > LIVE_LABEL_MAX ? `${oneLine.slice(0, LIVE_LABEL_MAX - 1)}…` : oneLine;
}

/**
 * A label for the stream from text a client or an administrator chose (a key's
 * name, an MCP client's name): control and bidirectional override characters
 * removed, one line, capped. Undefined when nothing printable is left.
 */
export function sanitizeLiveLabel(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const printable = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ');
  const capped = capLiveText(printable);
  return capped ? capped : undefined;
}

/** A write event as it may travel: lists bounded, text capped. */
export function boundedWriteEvent(event: SiteWriteEvent): SiteWriteEvent {
  const out: SiteWriteEvent = { origin: event.origin };
  if (event.originTab) out.originTab = event.originTab;
  if (event.actor) out.actor = { kind: event.actor.kind, label: capLiveText(event.actor.label) || 'Someone' };
  if (event.ops) out.ops = event.ops.slice(0, LIVE_LIST_MAX);
  // The keys are refs an agent chose: capped like any other text that travels.
  if (event.created) out.created = Object.fromEntries(Object.entries(event.created).slice(0, LIVE_LIST_MAX).map(([ref, id]) => [capLiveText(ref), id]));
  if (event.summary) out.summary = event.summary.slice(0, LIVE_LIST_MAX).map(capLiveText);
  return out;
}

/** The pattern a tab id must match (the save and publish bodies check it). */
export const ORIGIN_TAB_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** How often an open stream checks that its session and permission still hold. */
export const LIVE_RECHECK_MS = 5 * 60_000;
/** A write heard longer than this after the last check triggers one more (access lost shows up within a write). */
export const LIVE_RECHECK_ON_WRITE_MS = 30_000;
