// src/lib/projects/liveSync.ts
//
// The open editor follows the site live (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 1). One LiveSync per open project listens to the site's stream
// (GET /api/projects/<id>/events, src/lib/projects/liveEvents.ts) and, on a
// `site:version` from any other writer (an agent's batch, a generated page, a
// publish, another tab or person), fetches the stored copy
// (GET /api/projects/<id>/document) and adopts it. It never replays operations:
// the event says a version exists, the content comes from the snapshot route.
//
// What happens with a newer version:
//   - this tab's own write is ignored (the stream is opened with this tab's id,
//     src/lib/projects/tabId.ts, and flags those writes `own`): the write's
//     answer already moved the version this tab knows;
//   - a version not above the one this tab knows is ignored (versions only go up);
//   - several events in a row become one fetch of the newest;
//   - the working copy saved and no write of this tab out: the copy is adopted
//     as one undo step labelled by the writer (adoptServerCopy), and the known
//     version moves with it, so the next save of this tab is not refused;
//   - unsaved work, or a write out: nothing is merged. The fetched copy is held,
//     autosave pauses and SiteChangedDialog opens at once (this tab's save is
//     certain to be refused). "Load the newer version" adopts the held copy
//     (dropping this tab's unsaved edits, as the dialog says), as one undo step,
//     without reloading the page. A copy held while this tab's own write was out
//     is looked at again once that write settled: when it succeeded (no 409
//     comes), the copy is adopted then;
//   - a version that erased personal data is adopted without an undo step and
//     clears the history, as a load does (undo must not bring erased values back);
//   - an agent's write the stream announced (revealsOnAdoption) plays the
//     per-component reveal (plan section 4, src/lib/live/reveal.ts): its new
//     nodes fade in one after another. A load, a catch-up, a poll, another
//     person's save and "Load the newer version" appear at once.
//
// The stream also says who works on the site (plan section 2): the `state`
// event's agents and feed and every `agent:activity` go to the editor's
// presence store (src/lib/live/presenceStore.ts); the layer drops a frame whose
// nodes the open copy does not have when it draws.
//
// While an agent's generate_page runs, the stream carries its draft (plan section
// 3): `gen:outline`, `gen:section` and `gen:done` (and the `state` event's running
// generation) go to src/lib/live/generationDraft.ts, which draws them with the
// editor's own Generate draft. `gen:done` of a saved result comes before the
// `site:version` of its save, and the draft goes inside the adoption's action of
// that version (or a newer one), so the draft and the saved result never show
// together. The result's sections the draft already drew exactly as saved do not
// reveal again; the rest does. A new page the person watched being drafted is
// shown once it is adopted when its draft frames were in view and the person is
// not in the middle of something; otherwise a notice offers it (showGeneratedPage).
//
// When the stream is down (a network loss, the 429 of too many streams, a proxy
// that buffers), the snapshot route is polled with If-None-Match every 5 s while
// the tab is visible and every 60 s while hidden, until the stream is back. A
// stream that ended (closed by the server, a network drop, a request that got
// no answer) is reopened by this tab after 2 to 4 s (doubling with each failure
// in a row, up to a minute), never by the browser's own fixed retry, so editors
// whose streams the server ended together do not all come back together. Only a
// stream the server refused (an HTTP 429, 503, 403 and the like, found by asking
// the route once: probeStream, since an EventSource never shows the status) is
// tried again after 1, 2, 4 then 8 minutes, each a little later at random. The server sends a
// `ping` every LIVE_HEARTBEAT_MS; once one arrived, a stream silent for
// LIVE_WATCHDOG_MS (a proxy that holds it open without passing anything) is
// reopened. A server that sends no ping arms no watchdog. A fetch of the stored
// copy that fails while the stream is live is tried again after 2, 5 and then
// every 15 s until one arrives (nothing else would ask again). On
// `auth:expired` (or a 401 while polling) everything stops and autosave shows the
// signed-out state; the next time the tab is shown, one check decides whether to
// start again. A tab shown again while live asks once for the newest copy (a
// hidden tab's stream may have been throttled).
//
// While the person types, edits text on the canvas, drags or resizes
// (src/lib/live/editingInProgress.ts), a newer copy is held without the dialog:
// adopting it would replace what is under the cursor. (Autosave goes on as
// before: a save it sends on the old version meanwhile is refused and opens the
// dialog, as it always did.) It is looked at again once the editing settled: adopted when the copy is still
// saved, else the dialog opens as for any unsaved work. (Putting a settled edit
// on top of the agent's copy instead is its own follow-up, ROADMAP.md.)

import { runInAction } from 'mobx';
import { isEditing, isInteracting, onEditingSettled } from '@/lib/live/editingInProgress';
import { getSnapshot, isAlive } from 'mobx-state-tree';
import type { RootStoreType } from '@/stores/RootStore';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import {
  adoptServerCopy,
  hasWriteInFlight,
  isSaved,
  onWritesSettled,
  knownServerVersion,
  type AdoptedVersion,
  type ProjectContent,
} from '@/stores/openProject';
import { existingAutosave, reloadDiscarding } from './autosave';
import { SSE_HEARTBEAT_MS } from '@/lib/ai/sse';
import { editorTabId } from './tabId';
import {
  LIVE_EVENTS,
  LIVE_PING_EVENT,
  type AgentActivity,
  type GenDoneEvent,
  type GenOutlineEvent,
  type GenSectionEvent,
  type SiteStateEvent,
  type SiteVersionEvent,
} from './liveEvents';
import { GenerationDraft, type SettledDraft } from '@/lib/live/generationDraft';
import type { PageGenDraftStore } from '@/lib/ai/pageGen/draft';
import { DRAFT_FRAME_ATTR } from '@/lib/ai/pageGen/draftAttributes';
import type { PageModelType } from '@/models/PageModel';
import type { LivePlansStore } from '@/lib/live/plansStore';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import type { LiveRevealStore } from '@/lib/live/revealStore';
import { projectRevealPlan, subtreeIdsInProject } from '@/lib/live/reveal';

export const LIVE_POLL_VISIBLE_MS = 5_000;
export const LIVE_POLL_HIDDEN_MS = 60_000;
/** How long after a stream that closed for good (a refusal) a new one is tried; it doubles with each refusal in a row. */
export const LIVE_STREAM_RETRY_MS = 60_000;
/** The longest wait before a new stream is tried. */
export const LIVE_STREAM_RETRY_MAX_MS = 8 * 60_000;
/** The share of a retry wait added at random, so tabs refused together do not come back together. */
export const LIVE_STREAM_RETRY_JITTER = 0.25;
/** The server's `ping` comes this often (the server's own constant, src/lib/ai/sse.ts). */
export const LIVE_HEARTBEAT_MS = SSE_HEARTBEAT_MS;
/** A stream that sent pings before and nothing for this long is reopened. */
export const LIVE_WATCHDOG_MS = Math.round(LIVE_HEARTBEAT_MS * 2.5);
/** The waits before a failed fetch of the stored copy is tried again while the stream is live; the last repeats. */
export const LIVE_FETCH_RETRY_MS = [2_000, 5_000, 15_000] as const;
/** "Load the newer version" while a write of this tab is out waits this long for it to settle. */
export const LOAD_NEWER_WRITE_WAIT_MS = 10_000;
/** The first reconnect after a stream ended (closed by the server, a network drop) waits this long, plus up to as much again at random; it doubles with each failure in a row. */
export const LIVE_RECONNECT_MS = 2_000;
/** The longest wait before reconnecting a stream that ended (a refusal waits LIVE_STREAM_RETRY_MS and more). */
export const LIVE_RECONNECT_MAX_MS = 60_000;

/** The part of a browser EventSource this module uses. */
export interface LiveEventSource {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/** EventSource.CLOSED */
const CLOSED = 2;

export interface DocumentAnswer {
  status: number;
  body?: { version: number; snapshot: ProjectSnapshotOut };
}

export interface LiveSyncDeps {
  /** Opens the stream; null where the browser has no EventSource (then it polls). */
  openStream(url: string): LiveEventSource | null;
  /** GET the snapshot route, naming the version this tab knows. */
  fetchDocument(url: string, knownVersion: number | undefined): Promise<DocumentAnswer>;
  isVisible(): boolean;
  /** Called for every visibility change, answers the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
  /** A number in [0, 1) for the retry jitter (Math.random by default). */
  random?: () => number;
  /**
   * Ask the stream route once, without keeping a stream, why a stream closed for
   * good: its HTTP status, or 'network' when no answer came (the network is down,
   * the request was blocked). An EventSource never shows the status itself.
   * Without it, every close for good counts as a refusal.
   */
  probeStream?: (url: string) => Promise<number | 'network'>;
}

/** How long a probe of the stream route may take before it counts as a network failure. */
export const LIVE_PROBE_TIMEOUT_MS = 8_000;

/** Whether a probe's answer means the server refused streams (wait long) rather than the network failing (reconnect soon). */
export function probeMeansRefusal(answer: number | 'network'): boolean {
  if (answer === 'network') return false;
  // An answer that would open a stream now: the failure is gone, reconnect soon.
  if (answer >= 200 && answer < 300) return false;
  return true;
}

export const browserLiveSyncDeps: LiveSyncDeps = {
  openStream: (url) => (typeof EventSource === 'undefined' ? null : (new EventSource(url) as unknown as LiveEventSource)),
  fetchDocument: async (url, knownVersion) => {
    const res = await fetch(url, {
      headers: knownVersion !== undefined ? { 'if-none-match': `"${knownVersion}"` } : {},
      cache: 'no-store',
    });
    if (res.status !== 200) return { status: res.status };
    return { status: 200, body: (await res.json()) as DocumentAnswer['body'] };
  },
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisibilityChange: (listener) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  probeStream: async (url) => {
    // Only the status line is wanted: the request is aborted as soon as it arrives (or after a timeout).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LIVE_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: abort.signal, headers: { accept: 'text/event-stream' } });
      return res.status;
    } catch {
      return 'network';
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  },
};

export type LiveSyncPhase = 'connecting' | 'live' | 'polling' | 'signed-out' | 'gone' | 'stopped';

/** A fetched copy waiting for the person (unsaved work of this tab). */
export interface HeldVersion {
  version: number;
  snapshot: ProjectSnapshotOut;
  label: string;
  /** The event that announced it, when one did (an automatic adoption later still knows the writer). */
  event?: SiteVersionEvent;
  /** Held only because the person is editing (no dialog): looked at again once the editing settled. */
  whileEditing?: boolean;
}

/**
 * Whether an adopted version plays the per-component reveal (plan section 4):
 * only an agent's write (a Model Context Protocol (MCP) batch, a generated
 * page) the stream announced. The copy must also be exactly that write (see take).
 * Never a catch-up after a reconnect or a version found by polling (the writer
 * is unknown), another tab's or person's save, a publish or an erasure, and
 * never "Load the newer version", which passes no event.
 */
export function revealsOnAdoption(event: SiteVersionEvent | undefined): boolean {
  return !!event && !event.catchUp && !event.own && (event.origin === 'mcp' || event.origin === 'generate');
}

/** The history entry's name for an adopted version: who, and what in one line. */
export function adoptionLabel(event: SiteVersionEvent | undefined): string {
  if (!event || event.catchUp) return 'Changes made elsewhere';
  const who = event.actor?.label || (event.origin === 'editor' ? 'Another tab' : 'Someone');
  const first = event.summary?.[0];
  if (first) return `${who}: ${first}`;
  switch (event.origin) {
    case 'publish':
      return `${who}: published`;
    case 'generate':
      return `${who}: generated a page`;
    case 'erasure':
      return 'Personal data erased';
    case 'mcp':
      return `${who}: edited the site`;
    default:
      return `${who}: saved changes`;
  }
}

/**
 * The pages this tab's copy has that a held newer copy removed, by title (review
 * finding F4): "Save mine over it" would bring them back, which the person cannot
 * see on the page in hand. Empty without a held copy (a 409 reached without one
 * names no pages: this tab never saw that copy).
 */
export function pagesRemovedBy(
  held: HeldVersion | undefined,
  working: { pages?: unknown } | undefined,
  /** The pages of the last server copy this tab knows: a page made here and not saved yet was never the writer's to delete. */
  serverPageIds: ReadonlySet<string> | undefined,
): string[] {
  if (!held || !working || !serverPageIds) return [];
  const kept = (held.snapshot.pages ?? {}) as Record<string, unknown>;
  return Object.entries((working.pages ?? {}) as Record<string, { metadata?: { title?: string } }>)
    .filter(([id]) => serverPageIds.has(id) && !(id in kept))
    .map(([id, page]) => page?.metadata?.title || id)
    .sort((a, b) => a.localeCompare(b));
}

/** Who wrote a held copy, for the dialog's sentence about removed pages. */
export function heldWriter(held: HeldVersion | undefined): string {
  const event = held?.event;
  if (event?.actor?.label) return event.actor.label;
  if (event && (event.origin === 'mcp' || event.origin === 'generate')) return 'the agent';
  return 'someone else';
}

/** The dialog's sentence: what "keep mine" brings back. Empty when it brings back no page. */
export function restoredPagesSentence(titles: readonly string[], writer: string, action: 'save' | 'publish'): string {
  if (titles.length === 0) return '';
  const quoted = titles.map((t) => `\u2018${t}\u2019`);
  const list = quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
  const verb = action === 'publish' ? 'Publishing' : 'Saving';
  return `${verb} yours restores the ${titles.length === 1 ? 'page' : 'pages'} ${list} that ${writer} deleted.`;
}

export class LiveSync {
  readonly projectId: string;
  private readonly rootStore: RootStoreType;
  private readonly deps: LiveSyncDeps;
  private stream: LiveEventSource | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private streamRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposeVisibility: (() => void) | undefined;
  private disposeSettled: (() => void) | undefined;
  private disposeEditing: (() => void) | undefined;
  private fetchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private fetchRetries = 0;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open stream sent a ping: its silence now means it is stuck. */
  private heartbeatSeen = false;
  /** Streams refused in a row (the retry wait doubles). */
  private streamRefusals = 0;
  /** Streams that ended in a row without staying up (the reconnect wait doubles). */
  private reconnects = 0;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private pingsSinceOpen = 0;
  /** Counts probes, so an answer that comes after a newer one (or a stop) is ignored. */
  private probeRun: number | undefined;
  private wasLiveValue = false;
  private draftLostValue = false;
  /** The newest version announced by another writer, with its event. */
  /** `retry`: an earlier fetch for it failed, so the copy that arrives is catch-up, never a live adoption. */
  private wanted: { version: number; event?: SiteVersionEvent; retry?: boolean } | undefined;
  private fetching = false;
  /** Something was announced while a fetch was out: one more fetch follows it. */
  private again = false;
  private held: HeldVersion | undefined;
  private phaseValue: LiveSyncPhase = 'stopped';
  private listeners = new Set<() => void>();
  /** For later slices (presence, reveal): what each adoption created and changed. */
  onAdopted: ((adopted: AdoptedVersion, event: SiteVersionEvent | undefined) => void) | undefined;
  /** The draft of an agent's generate_page running on the site (src/lib/live/generationDraft.ts). */
  private readonly generation: GenerationDraft;

  constructor(projectId: string, rootStore: RootStoreType, deps: LiveSyncDeps = browserLiveSyncDeps) {
    this.projectId = projectId;
    this.rootStore = rootStore;
    this.deps = deps;
    this.generation = new GenerationDraft({
      draft: () => rootStore.editorUI.pageGenDraft as PageGenDraftStore | undefined,
      project: () => {
        const project = rootStore.projectStore.getProject(projectId);
        return project && isAlive(project) ? project : undefined;
      },
      currentPageId: () => rootStore.editorUI.currentPage?.id,
      knownVersion: () => knownServerVersion(projectId),
      draftInView: () => !rootStore.editorUI.previewOpen && draftFramesInView(),
      onDraftLost: () => {
        if (this.draftLostValue) return;
        this.draftLostValue = true;
        this.notify();
      },
    });
  }

  get phase(): LiveSyncPhase {
    return this.phaseValue;
  }

  /** The copy waiting for "Load the newer version", if any. */
  get heldVersion(): HeldVersion | undefined {
    return this.held;
  }

  /** The stream was live at least once in this run: a fall to polling is a lost connection, not a browser without streams. */
  get wasLive(): boolean {
    return this.wasLiveValue;
  }

  /** An agent's streamed draft was dropped while the stream was down (cleared once it is back). */
  get draftLost(): boolean {
    return this.draftLostValue;
  }

  private setHeld(held: HeldVersion | undefined) {
    if (this.held === held) return;
    this.held = held;
    if (held?.whileEditing) this.waitForEditing();
    else this.stopWaitingForEditing();
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setPhase(phase: LiveSyncPhase) {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    if (phase === 'live') {
      this.wasLiveValue = true;
      this.draftLostValue = false;
    }
    this.notify();
  }

  private get base(): string {
    return `/api/projects/${encodeURIComponent(this.projectId)}`;
  }

  start(): void {
    if (this.phaseValue !== 'stopped') return;
    this.disposeVisibility = this.deps.onVisibilityChange(() => this.visibilityChanged());
    // A copy held while this tab's write was out: that write may have succeeded
    // (no 409 will come), so the held copy is looked at again once it settled.
    this.disposeSettled = onWritesSettled((projectId) => {
      if (projectId !== this.projectId) return;
      this.retake();
    });
    this.setPhase('connecting');
    this.openStream();
  }

  stop(): void {
    this.closeStream();
    // Nothing of this site's agents carries over to the next one opened.
    this.presence.reset();
    this.plans.reset();
    this.clearPoll();
    this.clearFetchRetry();
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = undefined;
    this.streamRefusals = 0;
    this.reconnects = 0;
    this.probeRun = (this.probeRun ?? 0) + 1;
    this.stopWaitingForEditing();
    this.disposeVisibility?.();
    this.disposeVisibility = undefined;
    this.disposeSettled?.();
    this.disposeSettled = undefined;
    // Nor does a reveal still playing, or an agent's draft.
    this.reveal.reset();
    this.generation.reset();
    this.wanted = undefined;
    this.held = undefined;
    this.wasLiveValue = false;
    this.draftLostValue = false;
    this.setPhase('stopped');
  }

  // ---- the stream ------------------------------------------------------------

  private openStream() {
    this.closeStream();
    // The stream knows this tab, so it flags this tab's own writes (`own`).
    const stream = this.deps.openStream(`${this.base}/events?tab=${encodeURIComponent(editorTabId())}`);
    if (!stream) {
      this.startPolling();
      return;
    }
    this.stream = stream;
    this.heartbeatSeen = false;
    this.setPhase(this.phaseValue === 'polling' ? 'polling' : 'connecting');
    // Anything heard on this stream: it is alive (the watchdog starts over, once pings proved the server sends them).
    const on = (type: string, listener: (event: { data: string }) => void) =>
      stream.addEventListener(type, (e) => {
        if (this.stream !== stream) return;
        this.heardFromStream();
        listener(e);
      });
    stream.onopen = () => {
      if (this.stream !== stream) return;
      this.clearPoll();
      this.clearStreamRetry();
      this.streamRefusals = 0;
      // The reconnect back-off starts over only once this stream proved it stays:
      // its second ping, or, from a server that sends none, staying up 2.5 heartbeats.
      // A server that accepts and ends streams, or a stream that pings once and
      // stalls, keeps every tab backing off instead of returning every 2 s.
      this.pingsSinceOpen = 0;
      this.clearStable();
      // Past the watchdog's span (2.5 heartbeats): a server that pings has sent its first one by then.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = undefined;
        if (this.stream === stream && this.pingsSinceOpen === 0) this.reconnects = 0;
      }, LIVE_WATCHDOG_MS);
      this.setPhase('live');
    };
    stream.onerror = () => {
      if (this.stream !== stream) return;
      this.clearWatchdog();
      // Polling asks from now on; a later failure while live starts its back-off at 2 s again.
      this.clearFetchRetry();
      // Events can be missed from now on (an agent's draft end among them): its draft goes, the reconnect's state draws it again.
      this.generation.streamLost();
      // Down: poll meanwhile, and reconnect on this tab's own jittered back-off,
      // never the browser's: when the server ends every stream at once (its
      // checks failing closed, a restart), the browser would bring every editor
      // back after the same fixed delay. A stream closed for good is either a
      // refusal (an HTTP 429, 503, 403: wait long) or a network failure (no
      // answer at all: reconnect soon); the EventSource cannot tell, so the
      // route is asked once (probeStream).
      const closedForGood = stream.readyState === CLOSED;
      this.startPolling();
      this.closeStream();
      if (closedForGood) void this.retryAfterProbe();
      else this.reconnectLater();
    };
    on(LIVE_PING_EVENT, () => {
      // The server sends heartbeats: from now on its silence is a stuck stream.
      this.heartbeatSeen = true;
      // Two pings: a stream that keeps going, so the reconnect back-off starts over.
      this.pingsSinceOpen++;
      if (this.pingsSinceOpen >= 2) this.reconnects = 0;
      this.armWatchdog();
    });
    on(LIVE_EVENTS.state, (e) => {
      const state = parse<SiteStateEvent>(e.data);
      if (!state || typeof state.version !== 'number') return;
      // Who works on the site and the feed, replacing what this tab held (a reconnect sends `state` again).
      this.presence.applyState(state);
      // The live skeleton plans, against the version this tab's copy holds.
      this.plans.applyState(state.plans, knownServerVersion(this.projectId));
      // An agent's generation running on the site: its draft so far (a reload mid-run draws it again).
      this.generation.applyState(state.generation);
      this.heard(state.version, undefined);
    });
    on(LIVE_EVENTS.agentActivity, (e) => {
      const activity = parse<AgentActivity>(e.data);
      if (activity) this.presence.applyActivity(activity);
    });
    on(LIVE_EVENTS.planUpdate, (e) => {
      const line = this.plans.applyUpdate(parse<unknown>(e.data));
      // The agent stopped: the feed says so (the same line the server keeps for a reload).
      if (line) this.presence.addLine(line);
    });
    on(LIVE_EVENTS.genOutline, (e) => {
      this.generation.applyOutline(parse<GenOutlineEvent>(e.data));
    });
    on(LIVE_EVENTS.genSection, (e) => {
      this.generation.applySection(parse<GenSectionEvent>(e.data));
    });
    on(LIVE_EVENTS.genDone, (e) => {
      this.generation.applyDone(parse<GenDoneEvent>(e.data));
    });
    on(LIVE_EVENTS.siteVersion, (e) => {
      const event = parse<SiteVersionEvent>(e.data);
      if (!event || typeof event.version !== 'number') return;
      // This tab's own write: its answer moves the known version (and the skeletons it covers go).
      if (event.own) {
        this.plans.noteVersion(event.version);
        return;
      }
      this.heard(event.version, event);
    });
    on(LIVE_EVENTS.authExpired, () => {
      this.signedOut();
    });
  }

  private clearStable() {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }

  private closeStream() {
    this.clearWatchdog();
    this.clearStable();
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    stream.onopen = null;
    stream.onerror = null;
    stream.close();
  }

  /** A stream closed for good: ask the route why, then the quick reconnect (no answer, or it would open now) or the long wait (a refusal). */
  private async retryAfterProbe() {
    const probe = this.deps.probeStream;
    if (!probe) {
      this.retryStreamLater();
      return;
    }
    const run = this.probeRun = (this.probeRun ?? 0) + 1;
    let answer: number | 'network';
    try {
      answer = await probe(`${this.base}/events?tab=${encodeURIComponent(editorTabId())}`);
    } catch {
      answer = 'network';
    }
    // Stopped, signed out, or another stream opened meanwhile: this answer is old.
    if (run !== this.probeRun || this.phaseValue !== 'polling' || this.stream) return;
    if (probeMeansRefusal(answer)) this.retryStreamLater();
    else this.reconnectLater();
  }

  private reconnectLater() {
    if (this.streamRetryTimer) return;
    const base = Math.min(LIVE_RECONNECT_MS * 2 ** this.reconnects, LIVE_RECONNECT_MAX_MS);
    const wait = Math.round(base * (1 + (this.deps.random ?? Math.random)()));
    this.reconnects++;
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = undefined;
      if (this.phaseValue === 'polling') this.openStream();
    }, wait);
  }

  private retryStreamLater() {
    if (this.streamRetryTimer) return;
    // 1, 2, 4, then 8 minutes after refusals in a row, plus up to a quarter more at random.
    const base = Math.min(LIVE_STREAM_RETRY_MS * 2 ** this.streamRefusals, LIVE_STREAM_RETRY_MAX_MS);
    const wait = Math.round(base * (1 + LIVE_STREAM_RETRY_JITTER * (this.deps.random ?? Math.random)()));
    this.streamRefusals++;
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = undefined;
      if (this.phaseValue === 'polling') this.openStream();
    }, wait);
  }

  // ---- the heartbeat watchdog ------------------------------------------------

  private heardFromStream() {
    if (this.heartbeatSeen) this.armWatchdog();
  }

  private armWatchdog() {
    this.clearWatchdog();
    const stream = this.stream;
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      if (!stream || this.stream !== stream) return;
      // Silent for two and a half heartbeats: held open by something that passes nothing. Reopen; poll meanwhile.
      this.generation.streamLost();
      this.closeStream();
      this.clearFetchRetry();
      this.startPolling();
      // On the same jittered, doubling wait as any ended stream (one that pings once and stalls again backs off).
      this.reconnectLater();
    }, LIVE_WATCHDOG_MS);
  }

  private clearWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  // ---- a failed fetch while live ---------------------------------------------

  private retryFetchLater() {
    if (this.fetchRetryTimer || this.phaseValue !== 'live') return;
    const wait = LIVE_FETCH_RETRY_MS[Math.min(this.fetchRetries, LIVE_FETCH_RETRY_MS.length - 1)];
    this.fetchRetries++;
    this.fetchRetryTimer = setTimeout(() => {
      this.fetchRetryTimer = undefined;
      // Polling asks by itself; a stopped or signed-out tab asks nothing. A failed catch-up (a visibility
      // look that named no version) is retried too: the conditional fetch answers 304 when nothing is newer.
      if (this.phaseValue === 'live') void this.fetchNewest();
    }, wait);
  }

  private clearFetchRetry() {
    if (this.fetchRetryTimer) clearTimeout(this.fetchRetryTimer);
    this.fetchRetryTimer = undefined;
    this.fetchRetries = 0;
  }

  // ---- polling ---------------------------------------------------------------

  private startPolling() {
    if (this.phaseValue === 'signed-out' || this.phaseValue === 'gone' || this.phaseValue === 'stopped') return;
    this.setPhase('polling');
    if (!this.pollTimer) this.schedulePoll();
  }

  private schedulePoll() {
    this.clearPoll();
    const wait = this.deps.isVisible() ? LIVE_POLL_VISIBLE_MS : LIVE_POLL_HIDDEN_MS;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll();
    }, wait);
  }

  private clearPoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll() {
    if (this.phaseValue !== 'polling') return;
    // Their `expired` update may never come while the stream is down.
    this.plans.dropExpired(Date.now());
    await this.fetchNewest();
    if (this.phaseValue === 'polling') this.schedulePoll();
  }

  private visibilityChanged() {
    if (!this.deps.isVisible()) return;
    if (this.phaseValue === 'live') {
      // A hidden tab's stream may have been throttled or cut without an error: ask once.
      void this.fetchNewest();
    } else if (this.phaseValue === 'polling') {
      // Shown again: look now, then keep the visible pace.
      this.clearPoll();
      void this.poll();
    } else if (this.phaseValue === 'signed-out') {
      // The person may have signed in again in another tab: one check decides.
      void this.checkBack();
    }
  }

  private async checkBack() {
    let answer: DocumentAnswer;
    try {
      answer = await this.deps.fetchDocument(`${this.base}/document`, knownServerVersion(this.projectId));
    } catch {
      return;
    }
    if (this.phaseValue !== 'signed-out') return;
    if (answer.status === 200 || answer.status === 304) {
      this.setPhase('connecting');
      if (answer.body) this.take(answer.body);
      // A copy held when the session expired is looked at again now that reading works.
      else this.retake();
      this.clearStreamRetry();
      this.openStream();
    }
  }

  /** Forget a pending stream retry (a refusal's or a reconnect's): the next end starts its own wait. */
  private clearStreamRetry() {
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = undefined;
  }

  private signedOut() {
    this.clearStreamRetry();
    this.closeStream();
    this.clearPoll();
    this.clearFetchRetry();
    // A signed-out tab shows no draft content or plans it can no longer read.
    this.generation.reset();
    this.plans.reset();
    this.setPhase('signed-out');
    existingAutosave(this.projectId)?.noteSignedOut();
  }

  // ---- versions --------------------------------------------------------------

  /** A version exists on the server (from the stream's state or an event). */
  private heard(version: number, event: SiteVersionEvent | undefined) {
    const known = knownServerVersion(this.projectId);
    if (known !== undefined && version <= known) return;
    if (this.held && version <= this.held.version) return;
    if (!this.wanted || version > this.wanted.version) this.wanted = { version, event };
    void this.fetchNewest();
  }

  /**
   * Fetch the stored copy, one request at a time: whatever is announced while a
   * request is out makes exactly one more (a burst of events is one fetch of the
   * newest, never one per event).
   */
  private async fetchNewest() {
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.fetching = true;
    try {
      do {
        this.again = false;
        let answer: DocumentAnswer;
        try {
          answer = await this.deps.fetchDocument(`${this.base}/document`, knownServerVersion(this.projectId));
        } catch {
          // A network failure: polling asks again by itself; a live stream may say nothing
          // more for a long time, so the fetch is tried again after a while.
          // That later copy is catch-up: it appears at once, never as the agent's live write.
          if (this.wanted) this.wanted = { ...this.wanted, retry: true };
          this.retryFetchLater();
          return;
        }
        if (this.phaseValue === 'stopped') return;
        if (answer.status === 401 || answer.status === 403) {
          this.signedOut();
          return;
        }
        if (answer.status === 404) {
          // The project is gone (deleted elsewhere): saving says so; nothing to follow.
          this.closeStream();
          this.clearPoll();
          this.generation.reset();
          this.setPhase('gone');
          return;
        }
        if (answer.status === 200 || answer.status === 304) this.clearFetchRetry();
        if (answer.status === 200 && answer.body) {
          const wanted = this.wanted;
          const covers = !!wanted && answer.body.version >= wanted.version;
          if (covers) this.wanted = undefined;
          this.take(answer.body, covers ? wanted?.event : undefined, undefined, !wanted?.retry);
        } else if (this.wanted && answer.status !== 304) {
          this.wanted = { ...this.wanted, retry: true };
          this.retryFetchLater();
        } else if (answer.status === 304 && this.wanted && this.wanted.version <= (knownServerVersion(this.projectId) ?? 0)) {
          this.wanted = undefined;
        }
        // 304: nothing newer than this tab's copy. Anything else: a passing
        // failure; the next event or poll asks again.
      } while (this.again);
    } finally {
      this.fetching = false;
    }
  }

  /** Look at a held copy again: adopt it if the working copy is clean now, else keep asking the person. */
  private retake() {
    const held = this.held;
    // Signed out: adopting would turn the failed save into a saved one while the sign-in action disappears; checkBack looks again.
    if (!held || this.phaseValue === 'stopped' || this.phaseValue === 'signed-out') return;
    const known = knownServerVersion(this.projectId);
    if (known !== undefined && held.version <= known) {
      this.setHeld(undefined);
      return;
    }
    // Still editing (a write of this tab settled meanwhile): never adopt under the cursor; look again once it settled.
    if (held.whileEditing && isEditing(this.rootStore)) return;
    this.setHeld(undefined);
    this.take({ version: held.version, snapshot: held.snapshot }, held.event, held.label);
  }

  /** A copy held while the person edits: looked at again as soon as the editing settled. */
  private waitForEditing() {
    if (this.disposeEditing) return;
    this.disposeEditing = onEditingSettled(this.rootStore, () => {
      if (!this.held?.whileEditing || isEditing(this.rootStore)) return;
      this.retake();
    });
  }

  private stopWaitingForEditing() {
    this.disposeEditing?.();
    this.disposeEditing = undefined;
  }

  /** A fetched copy: adopt it now, or hold it for the person. */
  private take(body: { version: number; snapshot: ProjectSnapshotOut }, event?: SiteVersionEvent, heldLabel?: string, live = true) {
    const known = knownServerVersion(this.projectId);
    if (known !== undefined && body.version <= known) return;
    const label = heldLabel ?? adoptionLabel(event);
    const project = this.rootStore.projectStore.getProject(this.projectId);
    if (!project || !isAlive(project)) return;
    const autosave = existingAutosave(this.projectId);
    const autosavePhase = autosave?.getState().phase;
    const clean =
      !hasWriteInFlight(this.projectId) &&
      autosavePhase !== 'conflict' &&
      autosavePhase !== 'publishing' &&
      isSaved(this.projectId, getSnapshot(project) as unknown as ProjectContent);
    const keep = { version: body.version, snapshot: body.snapshot, label, ...(event && live ? { event } : {}) };
    if (isEditing(this.rootStore)) {
      // Typing, a text edit, a drag or a resize is open (a resize writes on every
      // move, so the copy may already differ): no adoption replacing what the
      // person works on, and no dialog from this copy. Looked at once it settled.
      this.setHeld({ ...keep, whileEditing: true });
      // Already in conflict (an earlier refusal): only the version it names moves.
      if (autosavePhase === 'conflict') autosave?.noteChangedElsewhere(body.version);
      return;
    }
    if (!clean) {
      this.setHeld(keep);
      autosave?.noteChangedElsewhere(body.version);
      return;
    }
    // Only a copy that is exactly the announced write, on top of the copy this tab
    // has, reveals: a fetch that also brought other writers' versions (a burst
    // coalesced into one fetch, a poll after a failed fetch, a held copy replaced
    // by a newer one) would otherwise reveal their nodes as the agent's.
    const exact = live && !!event && event.version === body.version && event.versionBefore === known;
    this.adopt(body.version, body.snapshot, label, event, exact && revealsOnAdoption(event));
  }

  /** The agents' presence of the open site (src/lib/live/presenceStore.ts). */
  private get presence(): LivePresenceStore {
    return this.rootStore.editorUI.livePresence as LivePresenceStore;
  }

  /** The skeleton plans of the open site (src/lib/live/plansStore.ts). */
  private get plans(): LivePlansStore {
    return this.rootStore.editorUI.livePlans as LivePlansStore;
  }

  /** The nodes revealing on the canvas (src/lib/live/revealStore.ts). */
  private get reveal(): LiveRevealStore {
    return this.rootStore.editorUI.liveReveal as LiveRevealStore;
  }

  /**
   * Adopt a copy as one undo step. `reveal`: the copy's new nodes fade in one
   * after another; the reveal is set in the same action as the adoption, so no
   * new node is ever drawn once without it first.
   */
  private adopt(version: number, snapshot: ProjectSnapshotOut, label: string, event: SiteVersionEvent | undefined, reveal: boolean): boolean {
    // Where an ending draft is drawn, read before the adoption writes anything (a
    // layout read after the writes would force the browser to lay out mid-action).
    const framesInView = this.generation.settlesAt(version) ? !this.rootStore.editorUI.previewOpen && draftFramesInView() : undefined;
    const adopted = runInAction(() => {
      const result = adoptServerCopy(this.rootStore, snapshot, version, label);
      // In the same action: an agent's draft whose saved result this copy holds goes in the frame the result appears.
      const settled = result ? this.generation.settle(version, framesInView) : undefined;
      if (result && reveal && result.created.length > 0) {
        // The sections the draft already drew exactly as saved stay still; the rest reveals.
        const still = settled && settled.stillIds.length > 0 ? new Set(subtreeIdsInProject(snapshot, settled.stillIds)) : undefined;
        const created = still ? result.created.filter((id) => !still.has(id)) : result.created;
        if (created.length > 0) this.reveal.start(projectRevealPlan(snapshot, created));
      }
      // In the same action: a skeleton the adopted copy fulfils gives way to its real section in the same frame its reveal starts.
      if (result) this.plans.noteVersion(version);
      if (settled) this.showGeneratedPage(settled);
      return result;
    });
    if (!adopted) return false;
    this.clearNoticeOfRemovedPage();
    this.setHeld(undefined);
    existingAutosave(this.projectId)?.noteServerCopyAdopted();
    this.onAdopted?.(adopted, event);
    return true;
  }

  /** The "New page is ready" notice names a page the adopted copy no longer has (an agent deleted it): Open it would open nothing. */
  private clearNoticeOfRemovedPage() {
    const ui = this.rootStore.editorUI;
    const notice = ui.editorNotice;
    if (notice?.kind !== 'newPage') return;
    const project = this.rootStore.projectStore.getProject(this.projectId);
    if (!project || !isAlive(project)) return;
    if (!(project.pagesArray as PageModelType[]).some((p) => p.id === notice.pageId)) ui.setEditorNotice(undefined);
  }

  /**
   * A new page whose draft the person watched is shown once it is adopted, only
   * when its draft frames were visible in the canvas at that moment and the
   * person is not in the middle of something (typing, a text edit, a drag, a
   * resize, a marquee, typing in a field: src/lib/live/editingInProgress.ts).
   * The camera stays where it is and the new page's frames take the default
   * places, where the page that was open stood, so the result is on screen.
   * Otherwise the page on screen stays and a notice offers the new page ("New
   * page 'X' is ready." with Open it); it also waits in the Pages panel.
   */
  private showGeneratedPage(settled: SettledDraft) {
    const nodeId = settled.newPageNodeId;
    if (!nodeId) return;
    const project = this.rootStore.projectStore.getProject(this.projectId);
    if (!project || !isAlive(project)) return;
    const page = (project.pagesArray as PageModelType[]).find((p) =>
      (p.appComponentTree.children as Array<{ id: string }>).some((child) => child.id === nodeId),
    );
    const ui = this.rootStore.editorUI;
    if (!page || ui.currentPage?.id === page.id) return;
    // Another notice the person may not have read yet (a refusal, a state preview's badge, which is the way out of
    // that preview) is never replaced, and the page is not switched to either (a switch clears a preview and its
    // badge); the page waits in the Pages panel then.
    if (ui.editorNotice && ui.editorNotice.kind !== 'newPage') return;
    if (settled.inView && !isInteracting(this.rootStore)) {
      ui.setCurrentPage(page);
      return;
    }
    ui.setEditorNotice({ kind: 'newPage', pageId: page.id, message: `New page \u2018${page.metadata.title}\u2019 is ready.` });
  }

  /**
   * "Load the newer version": adopt the held copy (or fetch the newest first),
   * dropping this tab's unsaved edits, as one undo step. Answers false when
   * there was nothing newer to adopt (the caller then reloads the page).
   */
  get isStopped(): boolean {
    return this.phaseValue === 'stopped';
  }

  async loadNewer(): Promise<boolean> {
    // A write of this tab out: its answer decides what is newest (a success moves
    // the known version, a refusal names the newer one). Wait for it, a while.
    if (hasWriteInFlight(this.projectId)) {
      const settled = await waitForWrites(this.projectId, LOAD_NEWER_WRITE_WAIT_MS);
      if (!settled || this.phaseValue === 'stopped') return false;
      // The retake after the write may already have adopted the held copy (or a newer one): nothing left to load.
      const known = knownServerVersion(this.projectId);
      if (!this.held && existingAutosave(this.projectId)?.getState().phase !== 'conflict') return true;
      if (this.held && known !== undefined && this.held.version <= known) {
        this.setHeld(undefined);
        return true;
      }
    }
    let held = this.held;
    const conflict = existingAutosave(this.projectId)?.getState();
    const wanted = conflict?.phase === 'conflict' ? conflict.currentVersion : undefined;
    if (!held || (wanted !== undefined && held.version < wanted)) {
      let answer: DocumentAnswer;
      try {
        // No If-None-Match: the working copy may hold edits the known version does not describe.
        answer = await this.deps.fetchDocument(`${this.base}/document`, undefined);
      } catch {
        return false;
      }
      if (answer.status !== 200 || !answer.body || this.phaseValue === 'stopped') return false;
      held = { version: answer.body.version, snapshot: answer.body.snapshot, label: held?.label ?? 'Newer version loaded' };
    }
    if (hasWriteInFlight(this.projectId)) return false;
    // The person asked for it: it appears at once, never as a reveal.
    return this.adopt(held.version, held.snapshot, held.label, undefined, false);
  }
}

/** Resolves true once no write of this tab is out for the project, false after `ms`. */
function waitForWrites(projectId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const dispose = onWritesSettled((settledId) => {
      if (settledId !== projectId || hasWriteInFlight(projectId)) return;
      clearTimeout(timer);
      dispose();
      // After the live sync's own look at a held copy (its listener was registered first).
      queueMicrotask(() => resolve(true));
    });
    const timer = setTimeout(() => {
      dispose();
      resolve(false);
    }, ms);
  });
}

function parse<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

// ---- one per open project --------------------------------------------------------

const syncs = new Map<string, LiveSync>();
let depsOverride: LiveSyncDeps | undefined;
const projectListeners = new Map<string, Set<() => void>>();

function notifyAll(projectId: string) {
  for (const listener of [...(projectListeners.get(projectId) ?? [])]) listener();
}

/**
 * Hear every change of the live sync of a project: one starting or stopping,
 * its phase, its held copy, a dropped draft. For the editor's top bar, which
 * renders before the sync starts. Answers the unsubscribe.
 */
export function subscribeLiveSync(projectId: string, listener: () => void): () => void {
  let set = projectListeners.get(projectId);
  if (!set) projectListeners.set(projectId, (set = new Set()));
  set.add(listener);
  let unsubscribeSync = syncs.get(projectId)?.subscribe(listener);
  const onSyncChange = (changed: string) => {
    if (changed !== projectId) return;
    unsubscribeSync?.();
    unsubscribeSync = syncs.get(projectId)?.subscribe(listener);
  };
  syncChangeListeners.add(onSyncChange);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) projectListeners.delete(projectId);
    syncChangeListeners.delete(onSyncChange);
    unsubscribeSync?.();
  };
}

const syncChangeListeners = new Set<(projectId: string) => void>();
function syncsChanged(projectId: string) {
  for (const listener of [...syncChangeListeners]) listener(projectId);
  notifyAll(projectId);
}

/** Tests only: the stream and the fetch every LiveSync started from now on uses. */
export function setLiveSyncDepsForTests(deps: LiveSyncDeps | undefined): void {
  depsOverride = deps;
  for (const sync of syncs.values()) sync.stop();
  syncs.clear();
}

/** Start following a project (the editor opened it). Answers the stop. */
export function startLiveSync(projectId: string, rootStore: RootStoreType, deps?: LiveSyncDeps): () => void {
  syncs.get(projectId)?.stop();
  const sync = new LiveSync(projectId, rootStore, deps ?? depsOverride);
  syncs.set(projectId, sync);
  syncsChanged(projectId);
  sync.start();
  return () => {
    sync.stop();
    if (syncs.get(projectId) === sync) {
      syncs.delete(projectId);
      syncsChanged(projectId);
    }
  };
}

export function liveSyncFor(projectId: string | undefined): LiveSync | undefined {
  return projectId ? syncs.get(projectId) : undefined;
}

/**
 * SiteChangedDialog's "Load the newer version": adopt the newer copy in place
 * (one undo step, no reload). Without a live sync for the project, or when the
 * copy cannot be fetched, the page reloads as it always did.
 */
export async function loadNewerVersion(projectId: string | undefined): Promise<void> {
  const sync = liveSyncFor(projectId);
  if (sync && (await sync.loadNewer())) return;
  // Its sync stopped meanwhile (another project was opened, the editor left): reloading would reload that other editor.
  if (sync?.isStopped) return;
  reloadDiscarding(projectId);
}

/** Whether a draft frame of a new page is visible in the canvas (any part of it inside the canvas's box) and the document itself is showing. The open Preview covering the canvas is the caller's check. */
export function draftFramesInView(): boolean {
  if (typeof document === 'undefined') return false;
  // A hidden tab shows nothing, whatever its frames' rectangles say.
  if (document.visibilityState === 'hidden') return false;
  const ground = document.querySelector<HTMLElement>('[data-ground]');
  if (!ground) return false;
  const view = ground.getBoundingClientRect();
  return Array.from(document.querySelectorAll<HTMLElement>(`[${DRAFT_FRAME_ATTR}]`)).some((frame) => {
    const box = frame.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom;
  });
}
