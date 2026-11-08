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
//     clears the history, as a load does (undo must not bring erased values back).
//
// The stream also says who works on the site (plan section 2): the `state`
// event's agents and feed and every `agent:activity` go to the editor's
// presence store (src/lib/live/presenceStore.ts), and every adoption drops the
// frames keyed to nodes the new copy no longer has.
//
// When the stream is down (a network loss, the 429 of too many streams, a proxy
// that buffers), the snapshot route is polled with If-None-Match every 5 s while
// the tab is visible and every 60 s while hidden, until the stream is back. On
// `auth:expired` (or a 401 while polling) everything stops and autosave shows the
// signed-out state; the next time the tab is shown, one check decides whether to
// start again.

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
import { editorTabId } from './tabId';
import { LIVE_EVENTS, type AgentActivity, type SiteStateEvent, type SiteVersionEvent } from './liveEvents';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

export const LIVE_POLL_VISIBLE_MS = 5_000;
export const LIVE_POLL_HIDDEN_MS = 60_000;
/** How long after a stream that closed for good (a refusal) a new one is tried. */
export const LIVE_STREAM_RETRY_MS = 60_000;

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
};

export type LiveSyncPhase = 'connecting' | 'live' | 'polling' | 'signed-out' | 'gone' | 'stopped';

/** A fetched copy waiting for the person (unsaved work of this tab). */
export interface HeldVersion {
  version: number;
  snapshot: ProjectSnapshotOut;
  label: string;
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

export class LiveSync {
  readonly projectId: string;
  private readonly rootStore: RootStoreType;
  private readonly deps: LiveSyncDeps;
  private stream: LiveEventSource | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private streamRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposeVisibility: (() => void) | undefined;
  private disposeSettled: (() => void) | undefined;
  /** The newest version announced by another writer, with its event. */
  private wanted: { version: number; event?: SiteVersionEvent } | undefined;
  private fetching = false;
  /** Something was announced while a fetch was out: one more fetch follows it. */
  private again = false;
  private held: HeldVersion | undefined;
  private phaseValue: LiveSyncPhase = 'stopped';
  private listeners = new Set<() => void>();
  /** For later slices (presence, reveal): what each adoption created and changed. */
  onAdopted: ((adopted: AdoptedVersion, event: SiteVersionEvent | undefined) => void) | undefined;

  constructor(projectId: string, rootStore: RootStoreType, deps: LiveSyncDeps = browserLiveSyncDeps) {
    this.projectId = projectId;
    this.rootStore = rootStore;
    this.deps = deps;
  }

  get phase(): LiveSyncPhase {
    return this.phaseValue;
  }

  /** The copy waiting for "Load the newer version", if any. */
  get heldVersion(): HeldVersion | undefined {
    return this.held;
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
    for (const listener of [...this.listeners]) listener();
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
      if (projectId === this.projectId) this.retake();
    });
    this.setPhase('connecting');
    this.openStream();
  }

  stop(): void {
    this.closeStream();
    // Nothing of this site's agents carries over to the next one opened.
    this.presence.reset();
    this.clearPoll();
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = undefined;
    this.disposeVisibility?.();
    this.disposeVisibility = undefined;
    this.disposeSettled?.();
    this.disposeSettled = undefined;
    this.wanted = undefined;
    this.held = undefined;
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
    this.setPhase(this.phaseValue === 'polling' ? 'polling' : 'connecting');
    stream.onopen = () => {
      if (this.stream !== stream) return;
      this.clearPoll();
      this.setPhase('live');
    };
    stream.onerror = () => {
      if (this.stream !== stream) return;
      // Down: poll meanwhile. A stream closed for good (a refusal such as 429)
      // is tried again later; one that is reconnecting by itself is left to it.
      this.startPolling();
      if (stream.readyState === CLOSED) {
        this.closeStream();
        this.retryStreamLater();
      }
    };
    stream.addEventListener(LIVE_EVENTS.state, (e) => {
      if (this.stream !== stream) return;
      const state = parse<SiteStateEvent>(e.data);
      if (!state || typeof state.version !== 'number') return;
      // Who works on the site and the feed, replacing what this tab held (a reconnect sends `state` again).
      this.presence.applyState(state);
      this.prunePresence();
      this.heard(state.version, undefined);
    });
    stream.addEventListener(LIVE_EVENTS.agentActivity, (e) => {
      if (this.stream !== stream) return;
      const activity = parse<AgentActivity>(e.data);
      if (activity) this.presence.applyActivity(activity);
    });
    stream.addEventListener(LIVE_EVENTS.siteVersion, (e) => {
      const event = parse<SiteVersionEvent>(e.data);
      if (!event || typeof event.version !== 'number') return;
      // This tab's own write: its answer moves the known version.
      if (event.own) return;
      this.heard(event.version, event);
    });
    stream.addEventListener(LIVE_EVENTS.authExpired, () => {
      if (this.stream !== stream) return;
      this.signedOut();
    });
  }

  private closeStream() {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    stream.onopen = null;
    stream.onerror = null;
    stream.close();
  }

  private retryStreamLater() {
    if (this.streamRetryTimer) return;
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = undefined;
      if (this.phaseValue === 'polling') this.openStream();
    }, LIVE_STREAM_RETRY_MS);
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
    await this.fetchNewest();
    if (this.phaseValue === 'polling') this.schedulePoll();
  }

  private visibilityChanged() {
    if (!this.deps.isVisible()) return;
    if (this.phaseValue === 'polling') {
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
      this.openStream();
    }
  }

  private signedOut() {
    this.closeStream();
    this.clearPoll();
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
          // A network failure: the stream reconnects (or the poll comes back) and asks again.
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
          this.setPhase('gone');
          return;
        }
        if (answer.status === 200 && answer.body) {
          const wanted = this.wanted;
          const covers = !!wanted && answer.body.version >= wanted.version;
          if (covers) this.wanted = undefined;
          this.take(answer.body, covers ? wanted?.event : undefined);
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
    if (!held || this.phaseValue === 'stopped') return;
    const known = knownServerVersion(this.projectId);
    if (known !== undefined && held.version <= known) {
      this.held = undefined;
      return;
    }
    this.held = undefined;
    this.take({ version: held.version, snapshot: held.snapshot }, undefined, held.label);
  }

  /** A fetched copy: adopt it now, or hold it for the person. */
  private take(body: { version: number; snapshot: ProjectSnapshotOut }, event?: SiteVersionEvent, heldLabel?: string) {
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
    if (!clean) {
      this.held = { version: body.version, snapshot: body.snapshot, label };
      autosave?.noteChangedElsewhere(body.version);
      return;
    }
    this.adopt(body.version, body.snapshot, label, event);
  }

  /** The agents' presence of the open site (src/lib/live/presenceStore.ts). */
  private get presence(): LivePresenceStore {
    return this.rootStore.editorUI.livePresence as LivePresenceStore;
  }

  /** Frames keyed to nodes the open copy no longer has are dropped. */
  private prunePresence() {
    const project = this.rootStore.editorUI.currentProject;
    if (!project || !isAlive(project)) return;
    const ids = new Set<string>();
    for (const page of project.pages.values()) collectIds(page.appComponentTree as IdTree, ids);
    this.presence.pruneMissing((id) => ids.has(id));
  }

  private adopt(version: number, snapshot: ProjectSnapshotOut, label: string, event: SiteVersionEvent | undefined): boolean {
    const adopted = adoptServerCopy(this.rootStore, snapshot, version, label);
    if (!adopted) return false;
    this.held = undefined;
    this.prunePresence();
    existingAutosave(this.projectId)?.noteServerCopyAdopted();
    this.onAdopted?.(adopted, event);
    return true;
  }

  /**
   * "Load the newer version": adopt the held copy (or fetch the newest first),
   * dropping this tab's unsaved edits, as one undo step. Answers false when
   * there was nothing newer to adopt (the caller then reloads the page).
   */
  async loadNewer(): Promise<boolean> {
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
      if (answer.status !== 200 || !answer.body) return false;
      held = { version: answer.body.version, snapshot: answer.body.snapshot, label: held?.label ?? 'Newer version loaded' };
    }
    if (hasWriteInFlight(this.projectId)) return false;
    return this.adopt(held.version, held.snapshot, held.label, undefined);
  }
}

interface IdTree {
  id: string;
  children: Iterable<IdTree>;
}

function collectIds(node: IdTree | undefined, into: Set<string>): void {
  if (!node) return;
  into.add(node.id);
  for (const child of node.children) collectIds(child, into);
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
  sync.start();
  return () => {
    sync.stop();
    if (syncs.get(projectId) === sync) syncs.delete(projectId);
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
  reloadDiscarding(projectId);
}
