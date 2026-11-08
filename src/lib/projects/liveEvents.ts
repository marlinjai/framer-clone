// src/lib/projects/liveEvents.ts
//
// The events of a site's live stream (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 1): what GET /api/projects/<id>/events sends an open editor. Shared by
// the server (src/server/sites/liveBus.ts, the events route) and the browser
// (src/lib/projects/liveSync.ts), so both read one shape. Client-safe: types and
// small pure helpers only.
//
// Nothing here carries content, with one exception. An event says that a version
// exists and what it touched (ids, operation names, server-written summary lines);
// the content comes from the snapshot route (GET /api/projects/<id>/document), for
// every writer alike. The exception is the draft of an MCP generate_page that is
// still running (`gen:outline`, `gen:section`, the `state` event's `generation`):
// the model's preview of sections not saved yet, which the stream's guard (the
// document route's own: `editSite` on the project in the caller's workspace)
// lets only the site's editors see, which is never stored in the feed, the audit
// table or presence, and which is bounded (GEN_DRAFT_LIMITS).

import type { OutlineEntry } from '@/lib/ai/pageGen/outline';
import type { GeneratedNodeSnapshot } from '@/lib/ai/pageGen/validate';

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

/**
 * How an MCP tool call ended (`agent:activity` with phase `end`). `awaiting_approval`:
 * a publish or rollback is waiting for the person; `declined`: the person said no.
 * Neither wrote anything.
 */
export type AgentOutcome = 'ok' | 'rejected' | 'site_changed' | 'failed' | 'awaiting_approval' | 'declined';

/**
 * `agent:activity` (plan section 2): an MCP tool call on this site started or
 * ended. Ids and server-written lines only: `label` is the key's name as
 * auth-brain holds it (else the MCP client's declared name, else "Agent"),
 * capped and plain text. No summary line: those name page titles, which are content.
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

/** The shapes a skeleton section can take (plan section 3). */
export const PLAN_SECTION_KINDS = ['hero', 'features', 'gallery', 'pricing', 'testimonials', 'faq', 'cta', 'form', 'footer', 'generic'] as const;
export type PlanSectionKind = (typeof PLAN_SECTION_KINDS)[number];

/** The bounds of the skeleton plans (plan section 3). */
export const PLAN_LIMITS = {
  /** Live plans one site holds at once, of every agent together. */
  plansPerSite: 3,
  /** Of those, live plans one key holds on one site (so one agent never takes every slot). */
  plansPerKeyPerSite: 2,
  /** Sections one plan announces. */
  sectionsPerPlan: 20,
  /** A section's title, in visible characters. */
  titleMax: 60,
  /** A plan ends this long after its agent's last call on the site (any call by the same key refreshes it). */
  idleMs: 3 * 60_000,
  /** And this long after it was announced, whatever the agent does. */
  maxMs: 20 * 60_000,
} as const;

/** One announced section of a plan: what its skeleton shows, and once a batch created its ref, the node it became. */
export interface LivePlanSection {
  /** The ref the agent puts on the section's root node in apply_batch. */
  ref: string;
  /** Plain text the agent wrote, sanitised and capped at PLAN_LIMITS.titleMax; rendered as text only. */
  title: string;
  kind: PlanSectionKind;
  /** The site version whose batch created the ref: the skeleton goes once the editor holds that version. */
  fulfilledAt?: number;
  /** The id the ref became. */
  nodeId?: string;
}

/**
 * `plan:update` and the `state` event's plans: the sections an agent announced
 * before writing them (announce_sections), drawn as skeletons until each is
 * created. Ids, refs and sanitised titles only.
 */
export interface LivePlan {
  planId: string;
  /** The hash of the announcing key's id (as in AgentActivity). */
  agentId: string;
  /** The agent's label (as in AgentActivity). */
  label: string;
  /** The page the sections go on: named at the announce, or, for a new page, the page its createPage made. */
  pageId?: string;
  /** A page the agent is about to create: skeletons show in a ghost page frame until the page exists. */
  newPage?: { ref: string; title: string };
  /** The site version whose batch created the new page (with `pageId`). */
  pageAt?: number;
  /** A top-level section of the page the skeletons follow; absent: the end of the page. */
  after?: string;
  sections: LivePlanSection[];
  /** When the plan ends unless its agent calls again (ISO 8601). */
  expiresAt: string;
}

/** Why a plan ended. */
export type PlanEndReason = 'fulfilled' | 'cleared' | 'expired' | 'session_ended' | 'anchor_removed' | 'evicted';

/** `plan:update`: a plan announced, partly fulfilled, replaced or ended. */
export interface PlanUpdateEvent {
  /** The plan as it is now (its last state when it ended). */
  plan: LivePlan;
  /** The plan this one replaces, in the same step (no gap between the two). */
  replaces?: string;
  /** Set when the plan ended. */
  ended?: PlanEndReason;
}

/** The feed line an ended plan leaves when its agent stopped (expired, or its session ended): the same id on the server and in the editor. */
export function stoppedPlanLineId(planId: string): string {
  return `plan-stopped:${planId}`;
}

/** The tool name of that feed line (no real tool: the editor words it). */
export const PLAN_STOPPED_TOOL = 'sections_stopped';

/** Clean a section or page title an agent wrote: no control or bidirectional characters, one line, PLAN_LIMITS.titleMax characters. */
export function sanitizePlanTitle(text: unknown): string | undefined {
  const label = sanitizeLiveLabel(text);
  return label ? capChars(label, PLAN_LIMITS.titleMax) : undefined;
}

/**
 * Where a running MCP generate_page puts its result, by id (plan section 3, "The
 * MCP generate_page streams its draft"). A new page's title is the one the agent
 * asked for, sanitised like a skeleton title; the editor draws the draft in place
 * of, or inside, the named node, or as draft frames of a new page.
 */
export type GenDraftTarget =
  | { kind: 'newPage'; title?: string }
  | { kind: 'replace'; pageId: string; nodeId: string }
  | { kind: 'insert'; pageId: string; parentId: string };

/** `gen:outline`: the run's outline, whole, each time it changes (the latest replaces the earlier one). */
export interface GenOutlineEvent {
  /** Random per run. */
  runId: string;
  target: GenDraftTarget;
  outline: OutlineEntry[];
}

/** One preview section of a running generation: its gapless index, its slot in the outline, and the section as the model wrote it. */
export interface GenDraftSection {
  index: number;
  slot: number;
  node: GeneratedNodeSnapshot;
}

/** `gen:section`: one preview section of the run, complete and valid on its own. */
export interface GenSectionEvent extends GenDraftSection {
  runId: string;
  target: GenDraftTarget;
}

/**
 * How a run ended. `saved`: the result was written at `version`; the editor
 * drops the draft in the same step it adopts that version. Anything else wrote
 * nothing and the draft goes at once: `stopped` (cancelled, or the MCP client
 * went away), `failed` (the model or the server failed), `rejected` (the result
 * could not be placed), `site_changed` (the site moved on meanwhile), `expired`
 * (the run was given up on, GEN_DRAFT_LIMITS.runMaxMs), `superseded` (a newer
 * generation on the same site took its place).
 */
export type GenDoneStatus = 'saved' | 'stopped' | 'failed' | 'rejected' | 'site_changed' | 'expired' | 'superseded';

/** `gen:done`: the run ended. Sent before the `site:version` of its save. */
export interface GenDoneEvent {
  runId: string;
  status: GenDoneStatus;
  /** `saved`: the version the result was written at. */
  version?: number;
  /** `saved`: the ids of the result's top-level nodes, in page order (at most LIVE_LIST_MAX). */
  insertedIds?: string[];
  /**
   * `saved`: for each of `insertedIds`, the indexes of the preview sections it
   * is identical to (what the model wrote, ids aside), empty when none. A section
   * the editor drew and that the result kept as it was stays still when the
   * result is adopted (each drawn preview for one result section at most);
   * everything else reveals. At most GEN_DRAFT_LIMITS.sectionsPerRun indexes each.
   */
  drawnAs?: number[][];
}

/** The running generation of a site, as the `state` event carries it, so a reload mid-run draws the same draft. */
export interface LiveGeneration {
  runId: string;
  target: GenDraftTarget;
  outline: OutlineEntry[];
  /** The preview sections sent so far, in index order. */
  sections: GenDraftSection[];
}

/** The bounds of a running generation's draft on the stream. */
export const GEN_DRAFT_LIMITS = {
  /** A preview section larger than this (characters of its JSON) is not sent: its skeleton stays until the result. */
  sectionChars: 96_000,
  /** Characters of all preview sections of one run together; past this, later sections are not sent. */
  runChars: 384_000,
  /** Preview sections of one run. */
  sectionsPerRun: 20,
  /** Running generations kept for the `state` event, in the whole process (one per site): at most 50 x runChars in memory. */
  runsPerProcess: 50,
  /** Of those, the runs of one company (its own least recently touched goes first, never another company's). */
  runsPerCompany: 10,
  /** A run that has not ended after this long is given up on (`expired`). */
  runMaxMs: 15 * 60_000,
  /** How long the editor waits for the saved version before it drops the draft anyway (a copy held for the person). */
  settleMs: 15_000,
} as const;

/** `state`: sent once on connect. */
export interface SiteStateEvent {
  version: number;
  /** The live skeleton plans of the site. One that ended while the tab was away is not here, and never comes back. */
  plans: LivePlan[];
  /**
   * The agents active on the site and their last focus: the latest activity of
   * each, `start` while one of its calls is still running. Only agents seen
   * within AGENT_ACTIVE_MS: one that left is never reattached.
   */
  agents: AgentActivity[];
  /** The last LIVE_FEED_MAX feed lines, newest first. */
  feed: LiveFeedLine[];
  /** The MCP generate_page running on the site, if any: its draft so far. */
  generation?: LiveGeneration;
}

/** Every event name the stream sends. */
export const LIVE_EVENTS = {
  state: 'state',
  siteVersion: 'site:version',
  agentActivity: 'agent:activity',
  planUpdate: 'plan:update',
  genOutline: 'gen:outline',
  genSection: 'gen:section',
  genDone: 'gen:done',
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

/**
 * A call still running after this long is treated as ended (a generation takes
 * minutes, never this long): the server drops it from its snapshot, the editor
 * from its picture, so a lost `end` leaves no frame behind.
 */
export const OPEN_CALL_MAX_MS = 15 * 60_000;

/** Labels and summary lines are capped like this before they leave the server. */
export const LIVE_LABEL_MAX = 80;

/** At most this many ops, created entries and summary lines travel with one event. */
export const LIVE_LIST_MAX = 200;

/** Cap a server-written line for the stream: one line, plain text, LIVE_LABEL_MAX characters. */
export function capLiveText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return capChars(oneLine, LIVE_LABEL_MAX);
}

/** The most code points one visible character may keep (a flag is 2, a family emoji about 7). */
const CLUSTER_MAX_CODE_POINTS = 8;

type GraphemeSegmenter = { segment(t: string): Iterable<{ segment: string }> };
let segmenter: GraphemeSegmenter | null | undefined;

/** Visible characters as a reader sees them, by code points where the runtime cannot tell. */
function visibleChars(text: string): string[] {
  if (segmenter === undefined) {
    const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => GraphemeSegmenter }).Segmenter;
    segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/**
 * Text split into at most `max` visible characters (a flag or a skin-toned
 * emoji is one, though several code points), each kept to
 * CLUSTER_MAX_CODE_POINTS code points, so the size stays bounded however many
 * combining marks one character carries. Never more than `max * 8` code points
 * are looked at.
 */
export function boundedChars(text: string, max: number): string[] {
  const head = Array.from(text).slice(0, max * CLUSTER_MAX_CODE_POINTS + 1).join('');
  return visibleChars(head)
    .slice(0, max + 1)
    .map((c) => Array.from(c).slice(0, CLUSTER_MAX_CODE_POINTS).join(''));
}

/** Cut text to `max` visible characters with an ellipsis, between whole characters. */
export function capChars(text: string, max: number): string {
  const chars = boundedChars(text, max);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/**
 * A label for the stream from text a client or an administrator chose (a key's
 * name, an MCP client's name): control and bidirectional override characters
 * removed, one line, capped. Undefined when nothing printable is left.
 */
export function sanitizeLiveLabel(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  // Controls, format characters (zero-width, bidirectional marks and overrides, soft hyphen, tag
  // characters), line or paragraph separators, private-use and unassigned code points: nothing
  // that hides, reorders or fakes text.
  const printable = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, ' ');
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
