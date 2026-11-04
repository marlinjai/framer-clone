// src/lib/projects/autosave.ts
//
// The editor saves by itself (plan docs/plans/2026-11-04-editor-autosave.md).
// One controller per project id, shared by everything that writes the working
// copy from this tab: the autosave itself, the Save button ("save now"), the
// generator (a generated page or section is saved at once) and Publish (which
// waits for a save in flight and holds autosave while it runs).
//
// How it behaves:
//   - A change to the project tree (an MST onSnapshot on the current project)
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
//     write of this tab succeeds (Save mine over it, a manual Save, a Publish)
//     or the page reloads. "Keep editing" is not a resolution, so a refusal
//     never loops.
//   - A passing failure (network, 5xx, 408, 429) is shown and retried with
//     backoff (2 s, 5 s, 15 s, 30 s, then every 60 s). A refusal (any other
//     4xx: signed out, no permission, too large, malformed) is shown and never
//     retried by itself; the next click on Save tries again.
//   - `hasUnsavedWork` feeds the beforeunload warning: true while a save is in
//     flight or the working copy differs from what the server holds.
//
// The demo editor at `/` never gets a controller: it has no server copy and
// keeps its Save-as flow (SaveButton).

import { getSnapshot, isAlive, isStateTreeNode, onSnapshot } from 'mobx-state-tree';
import type { ProjectModelType } from '@/models/ProjectModel';
import { postProjectWrite, type ProjectWriteResult } from './projectWrite';
import {
  changedElsewhereVersion,
  isApplyingServerCopy,
  isSaved,
  knownServerVersion,
  markServerVersion,
  type ProjectContent,
} from '@/stores/openProject';

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
/** Waits before each retry of a passing failure; the last one repeats. */
export const AUTOSAVE_BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000] as const;

/** What the Save button and the generator show. */
export type AutosaveState =
  | { phase: 'saved' }
  | { phase: 'unsaved' }
  | { phase: 'saving' }
  /** A manual save just succeeded: the brief confirmation Save always showed. */
  | { phase: 'savedNow'; message: string }
  /** A passing failure, retried at `retryAt` (epoch ms). `hidden`: the message was dismissed. */
  | { phase: 'retrying'; message: string; retryAt: number; hidden?: boolean }
  /** A refusal: autosave stopped until the next manual Save. */
  | { phase: 'failed'; message: string; hidden?: boolean }
  /** The version lock refused: the server is at `currentVersion`. */
  | { phase: 'conflict'; currentVersion: number; dialogOpen: boolean; retrying: boolean };

/** The project the controller watches: the editor's live ProjectModel. */
export type AutosaveProject = ProjectModelType;

export interface AutosaveDeps {
  /** The save request. Defaults to POST /api/projects/save. */
  write: (snapshot: unknown, expectedVersion: number | undefined) => Promise<ProjectWriteResult>;
}

const defaultDeps: AutosaveDeps = {
  write: (snapshot, expectedVersion) => postProjectWrite('/api/projects/save', snapshot, expectedVersion, 'Save failed'),
};

/** A failure worth trying again by itself: the request may well pass next time. */
export function isPassingFailure(status: number | undefined): boolean {
  if (status === undefined) return true; // network
  return status === 408 || status === 429 || status >= 500;
}

type Mode = 'auto' | 'now' | 'manual';

export class AutosaveController {
  readonly projectId: string;
  private project: AutosaveProject | undefined;
  private disposeSnapshot: (() => void) | undefined;
  private deps: AutosaveDeps;
  private state: AutosaveState = { phase: 'saved' };
  private listeners = new Set<() => void>();

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.state = next;
    for (const listener of [...this.listeners]) listener();
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
    this.disposeSnapshot?.();
    this.project = project;
    this.disposeSnapshot = onSnapshot(project, () => this.notifyChange());
    if (this.inFlight || this.paused() || this.state.phase === 'retrying') return;
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
  }

  /**
   * Stop watching (the editor closed, or another project opened). Unsaved work
   * is saved at once (not when paused by a refusal); the controller stays in
   * the registry, so coming back to the project finds the same request state.
   */
  detach(project?: AutosaveProject): void {
    if (project && project !== this.project) return;
    this.disposeSnapshot?.();
    this.disposeSnapshot = undefined;
    if (this.debounceTimer || this.maxWaitTimer) {
      this.clearDebounce();
      void this.run('now');
    }
  }

  // ---- changes ---------------------------------------------------------------

  /** A change to the project tree. */
  notifyChange(): void {
    if (isApplyingServerCopy() || this.discarding) return;
    this.dirtyHint = true;
    if (this.inFlight || this.held > 0) {
      this.changedDuringFlight = true;
      return;
    }
    // Paused by a refusal, or waiting for a retry that carries this change too.
    if (this.paused() || this.state.phase === 'retrying') return;
    if (this.state.phase !== 'unsaved') this.setState({ phase: 'unsaved' });
    this.schedule();
  }

  private schedule() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fire(), AUTOSAVE_DEBOUNCE_MS);
    if (!this.maxWaitTimer) this.maxWaitTimer = setTimeout(() => this.fire(), AUTOSAVE_MAX_WAIT_MS);
  }

  private fire() {
    this.clearDebounce();
    void this.run('auto');
  }

  private clearDebounce() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
  }

  private clearTimers() {
    this.clearDebounce();
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
   * The Save button: always sends (also an unchanged copy, as Save always did),
   * also while paused: a refusal comes back as the dialog again, a success
   * resumes autosave. `overVersion` saves over the server's copy on purpose
   * ("Save mine over it"), naming the version the refusal reported.
   */
  saveManually(overVersion?: number): Promise<void> {
    return this.run('manual', overVersion);
  }

  private async run(mode: Mode, overVersion?: number): Promise<void> {
    if (this.inFlight) {
      if (mode === 'auto') this.changedDuringFlight = true;
      else this.nowAfterFlight = true;
      return this.inFlight;
    }
    // Publish is writing this copy: it is picked up once Publish is done.
    if (this.held > 0) {
      this.changedDuringFlight = true;
      return;
    }
    const project = this.project;
    if (!project || !isAlive(project)) return;
    // A refusal pauses autosave: only a click, or the dialog's choice, writes.
    if (mode === 'auto' && this.paused()) return;
    this.clearTimers();
    const snapshot = getSnapshot(project);
    if (mode !== 'manual' && isSaved(this.projectId, snapshot as ProjectContent)) {
      this.dirtyHint = false;
      this.attempts = 0;
      if (this.state.phase !== 'saved') this.setState({ phase: 'saved' });
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
    const request = this.send(snapshot, overVersion ?? knownServerVersion(this.projectId), mode);
    this.inFlight = request;
    try {
      await request;
    } finally {
      this.inFlight = undefined;
    }
    this.afterFlight();
  }

  private async send(snapshot: unknown, expectedVersion: number | undefined, mode: Mode): Promise<void> {
    let result: ProjectWriteResult;
    try {
      result = await this.deps.write(snapshot, expectedVersion);
    } catch (err) {
      result = { kind: 'error', message: err instanceof Error ? err.message : 'Network error: Save failed.' };
    }
    if (result.kind === 'conflict') {
      this.clearTimers();
      this.attempts = 0;
      this.dirtyHint = true;
      this.setState({ phase: 'conflict', currentVersion: result.currentVersion, dialogOpen: true, retrying: false });
      return;
    }
    if (result.kind === 'error') {
      this.dirtyHint = true;
      if (isPassingFailure(result.status)) {
        const wait = AUTOSAVE_BACKOFF_MS[Math.min(this.attempts, AUTOSAVE_BACKOFF_MS.length - 1)];
        this.attempts++;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.run('now');
        }, wait);
        this.setState({
          phase: 'retrying',
          message: `Not saved: ${result.message} Trying again in ${Math.round(wait / 1000)} s.`,
          retryAt: Date.now() + wait,
        });
      } else {
        this.attempts = 0;
        this.setState({ phase: 'failed', message: `Not saved: ${result.message} Click Save to try again.` });
      }
      return;
    }
    // The server now holds exactly this snapshot, at this version.
    markServerVersion(this.projectId, snapshot as ProjectContent, result.version);
    this.attempts = 0;
    this.dirtyHint = this.changedDuringFlight;
    if (mode === 'manual') {
      const saved = result.payload.savedPages;
      const count = Array.isArray(saved) ? saved.length : 0;
      this.setState({ phase: 'savedNow', message: `Saved ${count} ${count === 1 ? 'page' : 'pages'}.` });
    } else {
      this.setState({ phase: this.dirtyHint ? 'unsaved' : 'saved' });
    }
  }

  /** One trailing save for the changes made while the request was out. */
  private afterFlight() {
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
      if (this.state.phase !== 'savedNow') this.setState({ phase: 'unsaved' });
      this.schedule();
    }
  }

  // ---- the version lock's dialog ---------------------------------------------

  /** "Keep editing": the dialog closes, autosave stays paused. */
  dismissConflict(): void {
    if (this.state.phase === 'conflict' && !this.state.retrying) this.setState({ ...this.state, dialogOpen: false });
  }

  /** Reopen the dialog (the status line's "Choose"). */
  openConflict(): void {
    if (this.state.phase === 'conflict') this.setState({ ...this.state, dialogOpen: true });
  }

  /** "Load the newer version": the reload that follows must not warn. */
  discardForReload(): void {
    this.discarding = true;
    this.clearTimers();
  }

  /** Close the "Saved n pages" confirmation, or a refusal's message. */
  dismissMessage(): void {
    const state = this.state;
    if (state.phase === 'savedNow') this.setState({ phase: this.dirtyHint ? 'unsaved' : 'saved' });
    // A failure stays what it is (paused, or retrying): only its message goes.
    else if (state.phase === 'failed' || state.phase === 'retrying') this.setState({ ...state, hidden: true });
  }

  // ---- other writers of this tab (Publish) -----------------------------------

  /**
   * Run another write of the working copy (Publish) with autosave held: a save
   * in flight finishes first, none starts meanwhile, and the version lock sees
   * one writer. Afterwards autosave picks up whatever is still unsaved.
   */
  async exclusive<T>(write: () => Promise<T>): Promise<T> {
    this.held++;
    this.clearDebounce();
    try {
      while (this.inFlight) await this.inFlight;
      return await write();
    } finally {
      this.held--;
      if (this.held === 0) this.afterOtherWrite();
    }
  }

  /** The other writer's version lock refused: pause like a refused save, quietly. */
  noteConflict(currentVersion: number): void {
    this.clearTimers();
    this.dirtyHint = true;
    this.setState({ phase: 'conflict', currentVersion, dialogOpen: false, retrying: false });
  }

  private afterOtherWrite() {
    const project = this.project;
    if (!project || !isAlive(project)) return;
    const saved = isSaved(this.projectId, getSnapshot(project) as ProjectContent);
    this.changedDuringFlight = false;
    if (saved) {
      // The other write stored this copy: whatever paused or waited is resolved.
      this.clearTimers();
      this.attempts = 0;
      this.dirtyHint = false;
      this.setState({ phase: 'saved' });
    } else if (this.dirtyHint && !this.paused() && this.state.phase !== 'retrying') {
      this.setState({ phase: 'unsaved' });
      this.schedule();
    }
  }

  // ---- leaving the page ------------------------------------------------------

  /** True while leaving the page would lose work: a request out, or changes not on the server. */
  hasUnsavedWork(): boolean {
    if (this.discarding) return false;
    if (this.inFlight) return true;
    const project = this.project;
    if (!project || !isAlive(project)) return false;
    if (!this.dirtyHint && !this.paused() && this.state.phase !== 'retrying') return false;
    return !isSaved(this.projectId, getSnapshot(project) as ProjectContent);
  }

  /** Tests only: drop timers and listeners. */
  disposeForTests(): void {
    this.clearTimers();
    this.disposeSnapshot?.();
    this.disposeSnapshot = undefined;
    this.listeners.clear();
  }
}

// ---- registry ------------------------------------------------------------------

const controllers = new Map<string, AutosaveController>();
let depsOverride: AutosaveDeps | undefined;

/** The controller of a project, created on first use. */
export function autosaveFor(projectId: string): AutosaveController {
  let controller = controllers.get(projectId);
  if (!controller) {
    controller = new AutosaveController(projectId, depsOverride ?? defaultDeps);
    controllers.set(projectId, controller);
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
  depsOverride = deps;
}
