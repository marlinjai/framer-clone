// src/lib/projects/autosave.ts
//
// The editor saves by itself (plan docs/plans/2026-11-04-editor-autosave.md).
// One controller per project id, shared by everything that writes the working
// copy from this tab: the autosave itself, Cmd/Ctrl+S and the status's Retry
// (save now), the generator (a generated page or section is saved at once) and
// Publish (which waits for a save in flight and holds autosave while it runs).
// There is no Save button (decided by the owner on 2026-11-04: "Everything
// should autosave all the time"); the top bar shows the state (SaveStatus).
//
// How it behaves:
//   - A change to the project tree (an MST onPatch on the current project: a
//     patch costs nothing to observe, the snapshot is only taken and compared
//     when the debounce fires, never per change)
//     schedules a save 1.5 s after the last change, and at most 10 s after the
//     first unsaved one, so a long drag or a long typing burst is still saved.
//     A change made while a load puts the server copy in place is not a change
//     (src/stores/openProject.ts `isApplyingServerCopy`), and when the debounce
//     fires on a copy that equals what the server holds (`isSaved`: undo back
//     to the saved state, a rename, a repair), nothing is sent.
//   - One request in flight. Changes during it make exactly one trailing save.
//   - It goes through the same request as Save always did (`postProjectWrite`
//     to /api/projects/save) with the version lock (`knownServerVersion`,
//     `markServerVersion`). Saving never publishes.
//   - 409 `site_changed`: autosave stops for that project and SiteChangedDialog
//     asks (load newer, save mine over it, keep both). It resumes only after a
//     write of this tab succeeds (Save mine over it, a Publish) or the page
//     reloads. "Keep editing" is not a resolution, so a refusal never loops;
//     the status's "Changed elsewhere" (and Cmd+S) reopens the dialog.
//   - A passing failure (network, 5xx, 408, 429) is shown and retried with
//     backoff (2 s, 5 s, 15 s, 30 s, then every 60 s). A refusal (any other
//     4xx: signed out, no permission, too large, malformed) is shown with its
//     status and never retried by itself; the status's Retry (or Cmd+S) tries
//     again.
//   - A passing failure that lasts 10 minutes stops retrying by itself and
//     becomes a refusal: shown with Retry, never once a minute forever.
//   - `anyUnsavedWork` feeds the one beforeunload warning (UnsavedWorkGuard,
//     on every editor route): true while any project of this tab has a save in
//     flight or a working copy that differs from what the server holds, also a
//     project the person has left (to the overview, Preview or another project).
//   - A project without a server version in this tab (the demo, or a demo just
//     kept as a project before its page opens) is never saved automatically.
//   - A controller whose project was left with everything saved leaves the
//     registry, so no model is held after it is closed.
//
// The demo editor at `/` never gets a controller: it has no server copy and
// offers "Keep as project" instead (SaveStatus).

import { getSnapshot, isAlive, isStateTreeNode, onPatch } from 'mobx-state-tree';
import type { ProjectModelType } from '@/models/ProjectModel';
import { KEEPALIVE_BODY_MAX_BYTES, postProjectWrite, type ProjectWriteResult } from './projectWrite';
import {
  changedElsewhereVersion,
  isApplyingServerCopy,
  isSaved,
  knownServerVersion,
  markServerVersion,
  noteWriteInFlight,
  savedContentOf,
  discardWorkingCopy,
  type ProjectContent,
  type SavedContent,
} from '@/stores/openProject';


function newRequestKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
/** Waits before each retry of a passing failure; the last one repeats. */
export const AUTOSAVE_BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000] as const;
/** After this long of passing failures in a row, automatic retries stop (Retry still works). */
export const AUTOSAVE_RETRY_LIMIT_MS = 10 * 60_000;

/** What the top bar's save status and the generator show. */
export type AutosaveState =
  | { phase: 'saved' }
  | { phase: 'unsaved' }
  | { phase: 'saving' }
  /**
   * A passing failure, retried at `retryAt` (epoch ms). `message` is the
   * server's reason, `status` the HTTP status (absent for a network failure).
   * `hidden`: the reason was dismissed on the compact top bar.
   */
  | { phase: 'retrying'; message: string; status?: number; retryAt: number; hidden?: boolean }
  /**
   * A refusal: autosave stopped until Retry (or Cmd+S). `retriesStopped`: a
   * passing failure that lasted AUTOSAVE_RETRY_LIMIT_MS.
   */
  | { phase: 'failed'; message: string; status?: number; retriesStopped?: boolean; hidden?: boolean }
  /** Publish is writing this copy: autosave waits, and Cmd+S has nothing to add. */
  | { phase: 'publishing' }
  /** The version lock refused: the server is at `currentVersion`. */
  | { phase: 'conflict'; currentVersion: number; dialogOpen: boolean; retrying: boolean };

/** The project the controller watches: the editor's live ProjectModel. */
export type AutosaveProject = ProjectModelType;

/** How one save request goes out. */
export interface AutosaveWriteOptions {
  /** Names this attempt; a retry of the same content on the same version reuses it. */
  requestKey: string;
  /** Earlier attempts on the same version whose answers were lost (any of them may have been written). */
  previousRequestKeys?: readonly string[];
  /**
   * The page is going away: the browser should finish the request. Shared by
   * every save of that moment, because the browser caps the keepalive bodies
   * of one page at 64 KB together; a body that does not fit goes normally.
   */
  keepaliveBudget?: { remaining: number };
}

export interface AutosaveDeps {
  /** The save request. Defaults to POST /api/projects/save. */
  write: (snapshot: unknown, expectedVersion: number | undefined, options: AutosaveWriteOptions) => Promise<ProjectWriteResult>;
}

const defaultDeps: AutosaveDeps = {
  write: (snapshot, expectedVersion, options) =>
    postProjectWrite('/api/projects/save', snapshot, expectedVersion, 'Save failed', options),
};

/** How many lost attempts on one base are named at most (the server takes 8). */
export const MAX_LOST_ATTEMPTS = 8;

/** A failure worth trying again by itself: the request may well pass next time. */
export function isPassingFailure(status: number | undefined): boolean {
  if (status === undefined) return true; // network
  return status === 408 || status === 429 || status >= 500;
}

/**
 * auto: the debounce; skipped while paused or when the copy equals the server's.
 * now: a generated page, a retry timer, leaving the editor; skipped when equal.
 * retry: Retry or Cmd+S after a failure; also while paused, skipped when equal.
 * over: "Save mine over it"; always sends, naming the version the refusal reported.
 * leave: the page is hidden or left; like now, as a keepalive request, never
 *   over a refusal or while a reload on purpose discards the copy.
 */

/** Per run: Publish's settling save goes past the hold; a recovery tries once. */
interface RunOptions {
  bypassHold?: boolean;
  /** One attempt: a passing failure does not start the backoff, it stays failed. */
  once?: boolean;
  keepaliveBudget?: { remaining: number };
}
type Mode = 'auto' | 'now' | 'retry' | 'over' | 'leave';

export class AutosaveController {
  readonly projectId: string;
  private project: AutosaveProject | undefined;
  private disposeSnapshot: (() => void) | undefined;
  /** The state before Publish held the controller, shown again afterwards. */
  private beforeHold: AutosaveState | undefined;
  /** When the current run of passing failures began (epoch ms). */
  private failingSince: number | undefined;
  /** The key of the last attempt, for the content and version it carried. */
  private attempt: { key: string; content: string; expectedVersion: number | undefined } | undefined;
  /**
   * An attempt whose answer never came (network, 5xx): the server may hold it.
   * Only an ok or a conflict settles it; a refusal of a later attempt says
   * nothing about this one.
   */
  private unconfirmed: { keys: string[]; expectedVersion: number | undefined } | undefined;
  /** "Save mine over it" whose answer was lost: its retries keep the version the refusal reported. */
  private overPending: number | undefined;
  /** A 400 refusal: the next change gets one (debounced) attempt, the cause may be fixed. */
  private retryOnceOnChange = false;
  /** The armed debounce is that one attempt, not an ordinary autosave. */
  private debounceIsRetryOnce = false;
  /** The page is going away while a request is out: send the rest at once after it. */
  private leaveAfterFlight: { remaining: number } | undefined;
  /** Moves on every change and every state; keys the cached unsaved check. */
  private stamp = 0;
  /** Bumps the stamp on any change of the held project, also while not watched. */
  private disposeStamp: (() => void) | undefined;
  private stampedProject: AutosaveProject | undefined;
  private unsavedCache: { stamp: number; value: boolean } | undefined;
  private deps: AutosaveDeps;
  private state: AutosaveState = { phase: 'saved' };
  private listeners = new Set<() => void>();

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredByLiveSync = false;
  private editGateTimer: ReturnType<typeof setInterval> | undefined;
  /** A refusal came back during a live hold: its dialog opens once the hold ends. */
  private conflictWaitsForLiveHold = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  /** A change arrived while a request was out (or Publish held the controller). */
  private changedDuringFlight = false;
  /** A save was asked for at once while a request was out. */
  private nowAfterFlight = false;
  /** A change was seen since the last copy known to be saved. */
  private dirtyHint = false;
  /** Passing failures in a row. */
  private attempts = 0;
  /** Publish (or another writer of this tab) is writing: autosave waits. */
  private held = 0;
  /** Settles when the latest queued exclusive write is done. */
  private exclusiveTail: Promise<void> = Promise.resolve();
  /** The page is being reloaded on purpose ("Load the newer version"). */
  private discarding = false;

  constructor(projectId: string, deps: AutosaveDeps = defaultDeps) {
    this.projectId = projectId;
    this.deps = deps;
  }

  // ---- observation ---------------------------------------------------------

  getState = (): AutosaveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(next: AutosaveState) {
    // A dialog waiting for the person's edit to end has nothing to open once the conflict is gone.
    if (next.phase !== 'conflict') this.conflictWaitsForLiveHold = false;
    this.stamp++;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
    notifyRegistry();
  }

  /** True while the editor shows this project (between attach and detach). */
  isAttached(): boolean {
    return this.disposeSnapshot !== undefined;
  }

  /** The project's name, for a notice about a project not on screen. */
  projectTitle(): string {
    const project = this.project;
    return project && isAlive(project) ? project.metadata.title : '';
  }

  /**
   * Leave the registry once the project was left with everything on the
   * server: no request out, no timer, nothing paused. Coming back creates a
   * fresh controller; what the server holds is remembered by openProject.
   */
  private maybeRelease() {
    if (this.isAttached() || this.inFlight || this.held > 0) return;
    if (this.debounceTimer || this.maxWaitTimer || this.retryTimer) return;
    if (this.state.phase !== 'saved' && !this.discarding) return;
    this.disposeStamp?.();
    this.disposeStamp = undefined;
    this.stampedProject = undefined;
    this.project = undefined;
    this.listeners.clear();
    releaseController(this);
  }

  private paused(): boolean {
    return this.state.phase === 'conflict' || this.state.phase === 'failed';
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Watch this project instance. Opening is not a change: nothing is sent, and
   * a working copy that already differs from the server (kept from an earlier
   * visit in this tab) shows as unsaved until the next change or Save.
   */
  attach(project: AutosaveProject): void {
    if (this.project === project && this.disposeSnapshot) return;
    // Only a live tree can be watched (a removed project, or a stand-in object).
    if (!isStateTreeNode(project) || !isAlive(project)) return;
    // Never loaded from the server in this tab (the demo, or a demo just kept
    // as a project before its page opens): nothing to save it over.
    if (knownServerVersion(this.projectId) === undefined) return;
    this.disposeSnapshot?.();
    this.project = project;
    this.disposeSnapshot = onPatch(project, () => this.notifyChange());
    if (this.stampedProject !== project) {
      this.disposeStamp?.();
      this.stampedProject = project;
      this.disposeStamp = onPatch(project, () => {
        this.stamp++;
      });
    }
    notifyRegistry();
    if (this.inFlight) return;
    if (this.paused() || this.state.phase === 'retrying') {
      // A load meanwhile put the server's copy in place (nothing changed
      // elsewhere is pending): the pause is about a copy that is gone.
      if (changedElsewhereVersion(this.projectId) === undefined && isSaved(this.projectId, getSnapshot(project) as ProjectContent)) {
        this.clearTimers();
        this.attempts = 0;
        this.failingSince = undefined;
        this.dirtyHint = false;
        this.setState({ phase: 'saved' });
      }
      return;
    }
    // A load kept this tab's work over a newer server copy: wait for a choice.
    const elsewhere = changedElsewhereVersion(this.projectId);
    if (elsewhere !== undefined) {
      this.dirtyHint = true;
      this.clearTimers();
      this.setState({ phase: 'conflict', currentVersion: elsewhere, dialogOpen: false, retrying: false });
      return;
    }
    this.dirtyHint = !isSaved(this.projectId, getSnapshot(project) as ProjectContent);
    if (!this.debounceTimer) this.setState({ phase: this.dirtyHint ? 'unsaved' : 'saved' });
    // Work kept from an earlier visit in this tab is saved like any change.
    if (this.dirtyHint && !this.debounceTimer) this.schedule();
  }

  /**
   * Stop watching (the editor closed, or another project opened). Unsaved work
   * is saved at once (not when paused by a refusal); the controller stays in
   * the registry, so coming back to the project finds the same request state.
   */
  detach(project?: AutosaveProject): void {
    // Another instance is watched now; one never watched (no server version) just goes.
    if (project && this.project && project !== this.project) return;
    this.disposeSnapshot?.();
    this.disposeSnapshot = undefined;
    notifyRegistry();
    if (this.debounceTimer || this.maxWaitTimer) {
      this.clearDebounce();
      void this.run('now');
      return;
    }
    const left = this.project;
    const saved = !!left && isAlive(left) && isSaved(this.projectId, getSnapshot(left) as ProjectContent);
    // Anything not on the server goes now, also a change that came without a
    // pending timer (a field committed while the editor closed). Not over a
    // refusal or a waiting retry, and never while a request is out.
    if (!saved && left && !this.inFlight && !this.paused() && this.state.phase !== 'retrying' && !this.discarding) {
      void this.run('now');
      return;
    }
    // Opened and left without a change (or nothing waiting): the server holds it.
    if (this.state.phase === 'unsaved' && !this.inFlight && saved) {
      this.setState({ phase: 'saved' });
    }
    this.maybeRelease();
  }

  // ---- changes ---------------------------------------------------------------

  /** A change to the project tree. */
  notifyChange(): void {
    this.stamp++;
    if (isApplyingServerCopy() || this.discarding) return;
    this.dirtyHint = true;
    if (this.inFlight || this.held > 0) {
      this.changedDuringFlight = true;
      return;
    }
    // After a 400 the next change gets one attempt (debounced like any change).
    if (this.retryOnceOnChange && this.state.phase === 'failed') {
      this.retryOnceOnChange = false;
      this.debounceIsRetryOnce = true;
      this.schedule();
      return;
    }
    // Paused by a refusal, or waiting for a retry that carries this change too.
    if (this.paused() || this.state.phase === 'retrying') return;
    if (this.state.phase !== 'unsaved') this.setState({ phase: 'unsaved' });
    this.schedule();
  }

  private schedule() {
    // Held for the person's editing by the live sync: nothing goes out until the hold ends.
    if (this.deferredByLiveSync) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fire(), AUTOSAVE_DEBOUNCE_MS);
    if (!this.maxWaitTimer) this.maxWaitTimer = setTimeout(() => this.fire(), AUTOSAVE_MAX_WAIT_MS);
  }

  private fire() {
    if (this.deferredByLiveSync) {
      this.clearDebounce();
      return;
    }
    const once = this.debounceIsRetryOnce;
    this.debounceIsRetryOnce = false;
    this.clearDebounce();
    void (once ? this.run('retry', undefined, { once: true }) : this.run('auto'));
  }

  private clearDebounce() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
  }

  private clearTimers() {
    this.clearDebounce();
    if (this.editGateTimer) clearInterval(this.editGateTimer);
    this.editGateTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  // ---- saving ----------------------------------------------------------------

  /**
   * Save at once (a generated page or section landed). Skipped when the copy
   * equals the server's, and while autosave is paused by a refusal.
   */
  saveNow(): Promise<void> {
    if (this.paused()) return Promise.resolve();
    return this.run('now');
  }

  /**
   * Cmd/Ctrl+S: save at once instead of waiting for the debounce. After a
   * failure it tries again (as Retry does); while the version lock's refusal
   * stands it reopens the dialog instead of sending (the server would only
   * refuse again: this tab's version is still the old one). A copy equal to
   * the server's sends nothing.
   */
  flush(): Promise<void> {
    const phase = this.state.phase;
    // Publish writes this very copy; the status already says so.
    if (phase === 'publishing') return Promise.resolve();
    if (phase === 'conflict') {
      this.openConflict();
      return Promise.resolve();
    }
    if (phase === 'failed' || phase === 'retrying') return this.retry();
    return this.run('now');
  }

  /**
   * The status's Retry: try a failed save again now, also while paused by a
   * refusal (signed out, too large). Nothing is sent when the copy meanwhile
   * equals the server's (an undo back), which resolves the failure.
   */
  retry(): Promise<void> {
    if (this.overPending !== undefined) return this.run('over', this.overPending);
    return this.run('retry');
  }

  /**
   * "Save mine over it": write this tab's copy over the server's on purpose,
   * naming the version the refusal reported. Always sends. Refused again, the
   * dialog comes back with the newer number; a success resumes autosave.
   */
  saveOver(currentVersion: number): Promise<void> {
    return this.run('over', currentVersion);
  }

  private async run(mode: Mode, overVersion?: number, opts: RunOptions = {}): Promise<void> {
    if (this.inFlight) {
      if (mode === 'auto') this.changedDuringFlight = true;
      else this.nowAfterFlight = true;
      return this.inFlight;
    }
    // Publish is writing this copy: it is picked up once Publish is done.
    if (this.held > 0 && !opts.bypassHold) {
      this.changedDuringFlight = true;
      return;
    }
    const project = this.project;
    if (!project || !isAlive(project)) return;
    // No server copy known to this tab (a demo, or a demo just kept as a
    // project before its page loads): nothing to save over automatically.
    if ((mode === 'auto' || mode === 'now' || mode === 'leave') && knownServerVersion(this.projectId) === undefined) return;
    // Leaving the page never decides a refusal for the person.
    if (mode === 'leave' && (this.paused() || this.discarding)) return;
    // A refusal pauses autosave: only Retry, or the dialog's choice, writes.
    if (mode === 'auto' && this.paused()) return;
    // The version lock's refusal is resolved only by a choice in its dialog.
    if (mode === 'retry' && this.state.phase === 'conflict') return;
    this.clearTimers();
    const snapshot = getSnapshot(project);
    // Serialised once for this save: compared now, recorded after the answer.
    const content = savedContentOf(snapshot as ProjectContent);
    // Equal to the server's copy is no reason to skip while an earlier attempt's
    // answer was lost: the server may hold that attempt instead (an undo back).
    if (mode !== 'over' && !this.unconfirmed && isSaved(this.projectId, content)) {
      this.dirtyHint = false;
      this.attempts = 0;
      this.failingSince = undefined;
      if (this.state.phase !== 'saved') this.setState({ phase: 'saved' });
      this.maybeRelease();
      return;
    }
    const prev = this.state;
    this.setState(
      overVersion !== undefined && prev.phase === 'conflict'
        ? { ...prev, retrying: true }
        : { phase: 'saving' },
    );
    this.changedDuringFlight = false;
    this.nowAfterFlight = false;
    // Tells a load meanwhile (Preview, coming back) that a version move may be this save's.
    noteWriteInFlight(this.projectId, true);
    const expectedVersion = overVersion ?? knownServerVersion(this.projectId);
    // The same content on the same version is the same attempt: a retry after
    // a lost answer gets the stored result instead of a 409 against itself.
    if (!this.attempt || this.attempt.content !== content.key || this.attempt.expectedVersion !== expectedVersion) {
      this.attempt = { key: newRequestKey(), content: content.key, expectedVersion };
    }
    // Newer content after a lost answer: name the lost attempt, so the server
    // can tell its own write from someone else's.
    const previous = this.lostAttemptKeys(expectedVersion).filter((key) => key !== this.attempt!.key);
    if (mode === 'over') this.overPending = overVersion;
    const options: AutosaveWriteOptions = {
      requestKey: this.attempt.key,
      ...(previous.length > 0 ? { previousRequestKeys: previous } : {}),
      ...(mode === 'leave' ? { keepaliveBudget: opts.keepaliveBudget ?? { remaining: KEEPALIVE_BODY_MAX_BYTES } } : {}),
    };
    const request = this.send(snapshot, expectedVersion, options, content, opts.once === true);
    this.inFlight = request;
    try {
      await request;
    } finally {
      this.inFlight = undefined;
      noteWriteInFlight(this.projectId, false);
    }
    this.afterFlight();
    this.maybeRelease();
  }

  private async send(
    snapshot: unknown,
    expectedVersion: number | undefined,
    options: AutosaveWriteOptions,
    content: SavedContent,
    once = false,
  ): Promise<void> {
    let result: ProjectWriteResult;
    try {
      result = await this.deps.write(snapshot, expectedVersion, options);
    } catch (err) {
      result = { kind: 'error', message: err instanceof Error ? err.message : 'Network error: Save failed.' };
    }
    // A passing failure leaves the outcome open; only an ok or a conflict
    // settles it (a refusal of this attempt says nothing about a lost one).
    if (result.kind === 'error' && isPassingFailure(result.status)) {
      // Every lost attempt on this base is kept (a short list): two lost answers
      // in a row leave the second one as the latest write.
      if (!this.unconfirmed || this.unconfirmed.expectedVersion !== expectedVersion) {
        this.unconfirmed = { keys: [options.requestKey], expectedVersion };
      } else if (!this.unconfirmed.keys.includes(options.requestKey)) {
        this.unconfirmed.keys = [...this.unconfirmed.keys, options.requestKey].slice(-MAX_LOST_ATTEMPTS);
      }
    } else if (result.kind === 'ok' || result.kind === 'conflict') {
      this.unconfirmed = undefined;
    }
    // A lost "Save mine over it" retries over the same reported version; any answer ends that.
    if (!(result.kind === 'error' && isPassingFailure(result.status))) this.overPending = undefined;
    // A 400 may be fixed by a change: the next change after each 400 gets one
    // debounced attempt (refused again, the next change gets another).
    this.retryOnceOnChange = result.kind === 'error' && result.status === 400;
    if (result.kind === 'conflict') {
      this.clearTimers();
      this.attempts = 0;
      this.failingSince = undefined;
      this.dirtyHint = true;
      // While the person is in the middle of an edit (a live hold, or the edit gate the
      // live sync installs, for a refusal that beats the agent's copy), the dialog waits
      // for the edit to settle: never under the cursor.
      const later = this.deferredByLiveSync || this.editInProgress();
      this.setState({ phase: 'conflict', currentVersion: result.currentVersion, dialogOpen: !later, retrying: false });
      if (later) {
        this.conflictWaitsForLiveHold = true;
        this.openWhenEditEnds();
      }
      return;
    }
    if (result.kind === 'error') {
      this.dirtyHint = true;
      const now = Date.now();
      if (isPassingFailure(result.status)) this.failingSince ??= now;
      // A recovery is one attempt: still failing, it stays failed.
      const stillTrying = !once && this.failingSince !== undefined && now - this.failingSince < AUTOSAVE_RETRY_LIMIT_MS;
      if (isPassingFailure(result.status) && stillTrying) {
        const wait = this.armRetry();
        this.setState({ phase: 'retrying', message: result.message, status: result.status, retryAt: now + wait });
      } else {
        const retriesStopped = isPassingFailure(result.status);
        this.attempts = 0;
        this.failingSince = undefined;
        this.setState({
          phase: 'failed',
          message: result.message,
          status: result.status,
          ...(retriesStopped ? { retriesStopped: true } : {}),
        });
      }
      return;
    }
    // The server now holds exactly this snapshot, at this version.
    markServerVersion(this.projectId, snapshot as ProjectContent, result.version, content);
    this.attempts = 0;
    this.failingSince = undefined;
    this.dirtyHint = this.changedDuringFlight;
    this.setState({ phase: this.dirtyHint ? 'unsaved' : 'saved' });
  }

  /** Schedule the next retry of a passing failure; answers the wait. */
  private armRetry(): number {
    const wait = AUTOSAVE_BACKOFF_MS[Math.min(this.attempts, AUTOSAVE_BACKOFF_MS.length - 1)];
    this.attempts++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void (this.overPending !== undefined ? this.run('over', this.overPending) : this.run('now'));
    }, wait);
    return wait;
  }

  /** One trailing save for the changes made while the request was out. */
  private afterFlight() {
    // The page is going: what changed during the request goes at once, not after a debounce.
    const leaving = this.leaveAfterFlight;
    if (leaving) {
      this.leaveAfterFlight = undefined;
      this.changedDuringFlight = false;
      this.nowAfterFlight = false;
      if (!this.paused()) void this.run('leave', undefined, { keepaliveBudget: leaving });
      return;
    }
    if (this.paused() || this.state.phase === 'retrying') {
      this.changedDuringFlight = false;
      this.nowAfterFlight = false;
      return;
    }
    if (this.nowAfterFlight) {
      this.nowAfterFlight = false;
      this.changedDuringFlight = false;
      void this.run('now');
    } else if (this.changedDuringFlight) {
      this.changedDuringFlight = false;
      this.setState({ phase: 'unsaved' });
      this.schedule();
    }
  }

  // ---- the version lock's dialog ---------------------------------------------

  /** "Keep editing": the dialog closes, autosave stays paused. */
  dismissConflict(): void {
    // "Keep editing" is the person's answer: a dialog waiting for an edit to end does not come back by itself.
    this.conflictWaitsForLiveHold = false;
    if (this.state.phase === 'conflict' && !this.state.retrying) this.setState({ ...this.state, dialogOpen: false });
  }

  /** Reopen the dialog (the status's "Changed elsewhere", or Cmd+S). */
  openConflict(): void {
    this.conflictWaitsForLiveHold = false;
    if (this.state.phase === 'conflict') this.setState({ ...this.state, dialogOpen: true });
  }

  /** "Load the newer version": the reload that follows must not warn. */
  discardForReload(): void {
    this.discarding = true;
    this.clearTimers();
  }

  /**
   * The reload did not happen (the person chose Stay when the browser asked
   * about another project's unsaved work): this project saves and warns again.
   */
  cancelDiscard(): void {
    if (!this.discarding) return;
    this.discarding = false;
    const project = this.project;
    if (!project || !isAlive(project) || this.paused() || this.state.phase === 'retrying') return;
    if (!isSaved(this.projectId, getSnapshot(project) as ProjectContent)) {
      this.dirtyHint = true;
      this.setState({ phase: 'unsaved' });
      this.schedule();
    }
  }

  /**
   * The page is being hidden or left (pagehide, a hidden tab): send what is not
   * saved now, as a request the browser finishes after the page is gone when
   * the body fits its 64 KB limit. A larger project relies on the normal
   * request and the unload warning. Never while a refusal waits for a choice.
   */
  saveOnLeave(keepaliveBudget: { remaining: number } = { remaining: KEEPALIVE_BODY_MAX_BYTES }): Promise<void> {
    // A request is out: what changes during it goes as soon as it is answered.
    if (this.inFlight) {
      this.leaveAfterFlight = keepaliveBudget;
      return this.inFlight;
    }
    if (!this.hasUnsavedWork()) return Promise.resolve();
    return this.run('leave', undefined, { keepaliveBudget });
  }

  /**
   * This tab's save attempts on `expectedVersion` whose answers were lost (the
   * server may hold the latest of them). Publish names them too, so it builds
   * on a landed one instead of meeting it as someone else's change.
   */
  /**
   * The lost attempts and the base version they were made on (the known
   * version, or the version a lost "Save mine over it" named). Publish sends
   * that base with them, so the server can recognise a landed one.
   */
  lostAttempts(): { expectedVersion: number | undefined; keys: string[] } | undefined {
    return this.unconfirmed ? { expectedVersion: this.unconfirmed.expectedVersion, keys: [...this.unconfirmed.keys] } : undefined;
  }

  lostAttemptKeys(expectedVersion: number | undefined): string[] {
    return this.unconfirmed && this.unconfirmed.expectedVersion === expectedVersion ? [...this.unconfirmed.keys] : [];
  }

  /**
   * Back online, or the tab is visible again: a waiting retry goes now; a
   * failure whose automatic retries stopped, or a sign-out (401: the person may
   * have signed in again in another tab), gets exactly one more attempt. Still
   * failing (also with a 5xx), it stays failed, without a new 10 minutes of
   * retries, until the next such moment or Retry.
   */
  recover(): Promise<void> {
    const state = this.state;
    if (state.phase === 'retrying') return this.retry();
    if (state.phase === 'failed' && (state.retriesStopped || state.status === 401)) {
      return this.run('retry', undefined, { once: true });
    }
    return Promise.resolve();
  }

  /**
   * This tab's copy now lives on as another project ("Save mine as a new
   * project"): nothing of it is saved here, warned about or named in a notice.
   */
  abandon(): void {
    this.discarding = true;
    this.clearTimers();
    this.attempts = 0;
    this.failingSince = undefined;
    this.dirtyHint = false;
    this.setState({ phase: 'saved' });
    this.maybeRelease();
  }

  /** Hide a failure's reason on the compact top bar; the failure stays what it is. */
  dismissMessage(): void {
    const state = this.state;
    if (state.phase === 'failed' || state.phase === 'retrying') this.setState({ ...state, hidden: true });
  }

  /**
   * The live sync holds an agent's newer copy while the person types, drags or
   * resizes (src/lib/projects/liveSync.ts). A save now would go out on the old
   * version and be refused, opening the dialog under the cursor (a long resize
   * reaches the 10 s maximum wait). So the debounce waits, without any dialog,
   * until the hold ends; the live sync then adopts or asks. A save already out
   * when the hold began and refused meanwhile keeps its dialog closed until then
   * too. Cmd+S and the save on leaving the page still save.
   */
  /** Whether the person is in the middle of an edit, as the live sync sees it (setEditInProgressCheck). */
  private editInProgress(): boolean {
    return editInProgressChecks.get(this.projectId)?.() ?? false;
  }

  /** A refusal's dialog waiting without a live hold: opened once no edit is in progress (looked at every 500 ms). */
  private openWhenEditEnds() {
    if (this.editGateTimer) return;
    this.editGateTimer = setInterval(() => {
      if (!this.conflictWaitsForLiveHold || this.state.phase !== 'conflict') {
        clearInterval(this.editGateTimer);
        this.editGateTimer = undefined;
        return;
      }
      // A live hold took over: it opens the dialog when it ends.
      if (this.deferredByLiveSync || this.editInProgress()) return;
      clearInterval(this.editGateTimer);
      this.editGateTimer = undefined;
      this.conflictWaitsForLiveHold = false;
      if (!this.state.dialogOpen) this.setState({ ...this.state, dialogOpen: true });
    }, 500);
  }

  deferWhileLiveHeld(defer: boolean): void {
    if (this.deferredByLiveSync === defer) return;
    this.deferredByLiveSync = defer;
    if (defer) {
      this.clearDebounce();
      return;
    }
    if (this.conflictWaitsForLiveHold) {
      this.conflictWaitsForLiveHold = false;
      if (this.state.phase === 'conflict' && !this.state.dialogOpen) this.setState({ ...this.state, dialogOpen: true });
      return;
    }
    if (this.state.phase === 'unsaved' && !this.inFlight && this.held === 0) this.schedule();
  }

  // ---- other writers of this tab (Publish) -----------------------------------

  /**
   * Run another write of the working copy (Publish) with autosave held: a save
   * in flight finishes first, none starts meanwhile, and the version lock sees
   * one writer. Afterwards autosave picks up whatever is still unsaved.
   * Publish counts as a save: a success resolves a pause or a pending retry.
   */
  async exclusive<T>(write: () => Promise<T>): Promise<T> {
    // One exclusive write at a time: a second Publish waits for the first, so it
    // builds on the version the first produced instead of meeting it as someone
    // else's change (both would send the same expectedVersion).
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await this.runExclusive(write);
    } finally {
      release();
    }
  }

  private async runExclusive<T>(write: () => Promise<T>): Promise<T> {
    let landed = false;
    if (this.held === 0) this.beforeHold = this.state;
    this.held++;
    this.clearDebounce();
    try {
      while (this.inFlight) await this.inFlight;
      // A save whose answer was lost, or one waiting for its retry, is settled
      // first (past the hold): Publish then writes on the version it produced,
      // instead of meeting it as someone else's change.
      if (this.unconfirmed || this.state.phase === 'retrying') {
        // A lost "Save mine over it" is settled over the version its conflict reported.
        await (this.overPending !== undefined
          ? this.run('over', this.overPending, { bypassHold: true })
          : this.run('retry', undefined, { bypassHold: true }));
        while (this.inFlight) await this.inFlight;
      }
      if (this.state.phase !== 'publishing') {
        this.beforeHold = this.state;
        this.setState({ phase: 'publishing' });
      }
      noteWriteInFlight(this.projectId, true);
      const versionBefore = knownServerVersion(this.projectId);
      try {
        return await write();
      } finally {
        noteWriteInFlight(this.projectId, false);
        // The other write landed (it moved the known version): it settles any
        // lost save on the old base, which it built on or replaced.
        if (knownServerVersion(this.projectId) !== versionBefore) {
          landed = true;
          this.unconfirmed = undefined;
          this.overPending = undefined;
        }
      }
    } finally {
      this.held--;
      if (this.held === 0) {
        if (this.state.phase === 'publishing') this.setState(this.beforeHold ?? { phase: 'unsaved' });
        this.beforeHold = undefined;
        this.afterOtherWrite(landed);
        this.maybeRelease();
      }
    }
  }

  /**
   * The site's live stream announced a version from another writer while this
   * tab has unsaved work or a write out (src/lib/projects/liveSync.ts): this
   * tab's save is certain to be refused, so autosave pauses now and the dialog
   * opens at once, instead of after the 409. Nothing is sent. A dialog the
   * person already closed ("Keep editing") stays closed; its number moves.
   */
  noteChangedElsewhere(currentVersion: number): void {
    this.clearTimers();
    this.dirtyHint = true;
    const state = this.state;
    if (state.phase === 'conflict') {
      // Versions only go up: an older held copy never lowers what a 409 reported.
      if (currentVersion > state.currentVersion && !state.retrying) this.setState({ ...state, currentVersion });
      return;
    }
    // A write of this tab is out: its answer (the 409) opens the dialog.
    if (this.inFlight || this.held > 0) return;
    this.setState({ phase: 'conflict', currentVersion, dialogOpen: true, retrying: false });
  }

  /**
   * A newer server copy was adopted into the store (src/stores/openProject.ts
   * adoptServerCopy): automatically, or because the person chose "Load the
   * newer version". The store now equals what the server holds at the known
   * version, so whatever paused or waited is resolved, and an attempt whose
   * answer was lost is settled too (the adopted copy is the newest write).
   */
  noteServerCopyAdopted(): void {
    if (this.inFlight) return;
    this.clearTimers();
    this.attempts = 0;
    this.failingSince = undefined;
    this.unconfirmed = undefined;
    this.overPending = undefined;
    this.retryOnceOnChange = false;
    this.debounceIsRetryOnce = false;
    this.dirtyHint = false;
    this.discarding = false;
    this.setState({ phase: 'saved' });
  }

  /**
   * The live stream ended because the session or the permission is gone: shown
   * as the signed-out failure (with "Sign in again"), and like it, the next sign
   * of the person being back (the tab shown again) tries once more.
   */
  noteSignedOut(): void {
    if (this.inFlight || this.state.phase === 'failed') return;
    this.clearTimers();
    this.setState({
      phase: 'failed',
      message: 'Your session or your access to this project ended.',
      status: 401,
    });
  }

  /** The other writer's version lock refused: pause like a refused save, quietly. */
  noteConflict(currentVersion: number): void {
    this.clearTimers();
    this.dirtyHint = true;
    this.setState({ phase: 'conflict', currentVersion, dialogOpen: false, retrying: false });
  }

  private afterOtherWrite(landed: boolean) {
    const project = this.project;
    if (!project || !isAlive(project)) return;
    const saved = isSaved(this.projectId, getSnapshot(project) as ProjectContent);
    this.changedDuringFlight = false;
    if (saved && !this.unconfirmed) {
      // The other write stored this copy: whatever paused or waited is resolved.
      this.clearTimers();
      this.attempts = 0;
      this.failingSince = undefined;
      this.dirtyHint = false;
      this.setState({ phase: 'saved' });
    } else if (this.state.phase === 'retrying') {
      // A retry that came due while the other write ran was skipped: arm it again.
      if (!this.retryTimer) {
        const wait = this.armRetry();
        this.setState({ ...this.state, retryAt: Date.now() + wait });
      }
    } else if (landed && !this.unconfirmed && !this.discarding) {
      // The other write succeeded (it moved the known version) but an edit made
      // meanwhile is still unsaved: the pause it resolves (a conflict, a failure)
      // is over, so autosave picks the remaining edit up.
      this.clearTimers();
      this.attempts = 0;
      this.failingSince = undefined;
      this.dirtyHint = true;
      this.setState({ phase: 'unsaved' });
      this.schedule();
    } else if (this.dirtyHint && !this.paused()) {
      this.setState({ phase: 'unsaved' });
      this.schedule();
    }
  }

  // ---- leaving the page ------------------------------------------------------

  /** True while leaving the page would lose work: a request out, or changes not on the server. */
  hasUnsavedWork(): boolean {
    if (this.discarding) return false;
    if (knownServerVersion(this.projectId) === undefined) return false;
    if (this.inFlight) return true;
    // An attempt whose answer was lost: the server may not hold what this tab shows.
    if (this.unconfirmed) return true;
    const project = this.project;
    if (!project || !isAlive(project)) return false;
    if (!this.dirtyHint && !this.paused() && this.state.phase !== 'retrying') return false;
    // Serialising a large project is the costly part: once per change, not per ask
    // (the left-behind notice asks every second while its countdown ticks).
    if (this.unsavedCache?.stamp !== this.stamp) {
      this.unsavedCache = { stamp: this.stamp, value: !isSaved(this.projectId, getSnapshot(project) as ProjectContent) };
    }
    return this.unsavedCache.value;
  }

  /** Tests only: drop timers and listeners. */
  disposeForTests(): void {
    this.held = 0;
    this.disposeStamp?.();
    this.disposeStamp = undefined;
    this.clearTimers();
    this.disposeSnapshot?.();
    this.disposeSnapshot = undefined;
    this.listeners.clear();
  }
}

// ---- registry ------------------------------------------------------------------

const controllers = new Map<string, AutosaveController>();
let depsOverride: AutosaveDeps | undefined;
const registryListeners = new Set<() => void>();
let registryVersion = 0;

function notifyRegistry() {
  registryVersion++;
  for (const listener of [...registryListeners]) listener();
}

function releaseController(controller: AutosaveController) {
  if (controllers.get(controller.projectId) === controller) {
    controllers.delete(controller.projectId);
    notifyRegistry();
  }
}

/** Any change to any controller (its state, attached or not, added or released). */
export function subscribeAutosaveRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/** Moves on every change the registry subscription reports (for useSyncExternalStore). */
export function autosaveRegistryVersion(): number {
  return registryVersion;
}

/** Every controller of this tab. */
export function allAutosaves(): AutosaveController[] {
  return [...controllers.values()];
}

/** True while leaving the page would lose work in ANY project of this tab. */
export function anyUnsavedWork(): boolean {
  for (const controller of controllers.values()) if (controller.hasUnsavedWork()) return true;
  return false;
}

/** Reload on purpose, discarding this project's unsaved work without the unload warning. */
export function reloadDiscarding(projectId: string | undefined): void {
  const controller = existingAutosave(projectId);
  controller?.discardForReload();
  if (controller) {
    // The reload may not happen: the browser asks about other unsaved work and
    // the person stays. Only a real sign of that re-arms this project: the
    // person using the page again, or the page shown again from the back-forward
    // cache. A time alone is no sign (a slow reload is still a reload), and
    // nothing re-arms once the page is going (pagehide).
    const signs = ['pointerdown', 'keydown'] as const;
    const stop = () => {
      for (const type of signs) window.removeEventListener(type, stayed, true);
      window.removeEventListener('pageshow', shownAgain);
      window.removeEventListener('pagehide', stop);
    };
    const stayed = () => {
      stop();
      controller.cancelDiscard();
    };
    const shownAgain = (event: PageTransitionEvent) => {
      if (event.persisted) stayed();
    };
    for (const type of signs) window.addEventListener(type, stayed, true);
    window.addEventListener('pageshow', shownAgain);
    window.addEventListener('pagehide', stop);
  }
  window.location.reload();
}

/**
 * "Save mine as a new project" succeeded: the original project's working copy
 * is given up (its pause, warning and notice end), and coming back to the
 * original opens the server's copy.
 */
export function abandonWorkingCopy(projectId: string): void {
  existingAutosave(projectId)?.abandon();
  discardWorkingCopy(projectId);
}

/** The controller of a project, created on first use. */
// project id -> whether the person is mid-edit (src/lib/live/editingInProgress.ts), installed by the
// live sync, which may start before the project's autosave controller exists.
const editInProgressChecks = new Map<string, () => boolean>();

/** The live sync tells autosave how to see that the person is mid-edit; undefined removes it. */
export function setEditInProgressCheck(projectId: string, check: (() => boolean) | undefined): void {
  if (check) editInProgressChecks.set(projectId, check);
  else editInProgressChecks.delete(projectId);
}

export function autosaveFor(projectId: string): AutosaveController {
  let controller = controllers.get(projectId);
  if (!controller) {
    controller = new AutosaveController(projectId, depsOverride ?? defaultDeps);
    controllers.set(projectId, controller);
    notifyRegistry();
  }
  return controller;
}

/** The controller of a project if the editor watches it (never for the demo). */
export function existingAutosave(projectId: string | undefined): AutosaveController | undefined {
  return projectId ? controllers.get(projectId) : undefined;
}

/** Tests only: forget every controller, optionally with another request. */
export function resetAutosaveForTests(deps?: AutosaveDeps): void {
  for (const controller of controllers.values()) controller.disposeForTests();
  controllers.clear();
  registryListeners.clear();
  depsOverride = deps;
}
