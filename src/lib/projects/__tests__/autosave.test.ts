// The editor's autosave controller (src/lib/projects/autosave.ts) on a REAL
// root store and openProject (the version lock and the saved-state memory),
// with fake timers and a save request the test answers by hand. The four
// stateful-flow paths (knowledge-base standards/stateful-flow-testing.md):
//   forward:   an edit saves once after the debounce; a burst is bounded by the
//              max wait; changes during a request make one trailing save;
//   backtrack: an edit undone before the debounce sends nothing; a revised edit
//              saves the current state;
//   resume:    unsaved or in-flight work is reported for the unload warning,
//              and a later load of what was saved opens clean;
//   re-entry:  a 409 pauses until a write of this tab succeeds; a passing
//              failure retries with backoff; a refusal never retries by itself,
//              Retry (or Cmd+S) tries again.
// Plus: opening is not a change, a generated page saves at once, Publish holds
// autosave, and a load that kept unsaved work over a newer copy pauses it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getUndoManager, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { knownServerVersion, markServerVersion, openProject, type ProjectContent } from '@/stores/openProject';
import type { ProjectWriteResult } from '../projectWrite';
import {
  AUTOSAVE_BACKOFF_MS,
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  anyUnsavedWork,
  autosaveFor,
  existingAutosave,
  isPassingFailure,
  resetAutosaveForTests,
  reloadDiscarding,
  abandonWorkingCopy,
  type AutosaveController,
  type AutosaveWriteOptions,
} from '../autosave';

let store: RootStoreType;
let seq = 0;

interface Call {
  snapshot: ProjectSnapshotOut;
  expectedVersion: number | undefined;
  options: AutosaveWriteOptions;
  answer: (result: ProjectWriteResult) => Promise<void>;
}
let calls: Call[] = [];

/** The request: every call waits for the test's answer. */
function write(snapshot: unknown, expectedVersion: number | undefined, options: AutosaveWriteOptions): Promise<ProjectWriteResult> {
  return new Promise((resolve) => {
    calls.push({
      snapshot: snapshot as ProjectSnapshotOut,
      expectedVersion,
      options,
      answer: async (result) => {
        resolve(result);
        await vi.advanceTimersByTimeAsync(0);
      },
    });
  });
}

const ok = (version: number): ProjectWriteResult => ({ kind: 'ok', version, payload: { savedPages: [''], version } });
const conflict = (currentVersion: number): ProjectWriteResult => ({ kind: 'conflict', currentVersion });
const failure = (status: number | undefined, message = 'Boom.'): ProjectWriteResult => ({
  kind: 'error',
  message,
  ...(status !== undefined ? { status } : {}),
});

function serverSnapshot(id: string, description = ''): ProjectSnapshotOut {
  const p = ProjectModel.create({ id, metadata: { title: 'Site', description }, pages: {} });
  p.createPage('Home').setSlug('');
  return getSnapshot(p) as ProjectSnapshotOut;
}

/** What /projects/<id> does, then the top bar's save status watching the project. */
function openAndWatch(version = 3, id = `site_auto_${++seq}`): { project: ProjectModelType; autosave: AutosaveController } {
  const project = openProject(store, serverSnapshot(id), null, version).project!;
  const autosave = autosaveFor(project.id);
  autosave.attach(project);
  return { project, autosave };
}

const edit = (project: ProjectModelType, description: string) => project.updateMetadata({ description });
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  resetAutosaveForTests({ write });
  store = createRootStore();
});
afterEach(() => {
  resetAutosaveForTests();
  vi.useRealTimers();
});

describe('forward', () => {
  it('an edit saves once, after the debounce, with the loaded version, and adopts the answered one', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'Fresh bread');
    expect(autosave.getState().phase).toBe('unsaved');
    await advance(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    await advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].expectedVersion).toBe(3);
    expect(calls[0].snapshot.metadata.description).toBe('Fresh bread');
    expect(autosave.getState().phase).toBe('saving');
    await calls[0].answer(ok(4));
    expect(knownServerVersion(project.id)).toBe(4);
    expect(autosave.getState().phase).toBe('saved');
    await advance(60_000);
    expect(calls).toHaveLength(1);
  });

  it('a burst of edits is debounced as one, and a burst longer than the max wait still saves', async () => {
    const { project } = openAndWatch(3);
    for (let i = 0; i < 12; i++) {
      edit(project, `typing ${i}`);
      await advance(1000);
    }
    // 12 s of continuous typing: the max wait (10 s) saved once meanwhile.
    expect(calls).toHaveLength(1);
    expect(AUTOSAVE_MAX_WAIT_MS).toBe(10_000);
    expect(calls[0].snapshot.metadata.description).toBe('typing 9');
  });

  it('changes during a request make exactly one trailing save, of the latest state', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'one');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    edit(project, 'two');
    edit(project, 'three');
    await advance(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(calls).toHaveLength(1); // never two in flight
    await calls[0].answer(ok(4));
    expect(autosave.getState().phase).toBe('unsaved');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1].expectedVersion).toBe(4);
    expect(calls[1].snapshot.metadata.description).toBe('three');
    await calls[1].answer(ok(5));
    await advance(60_000);
    expect(calls).toHaveLength(2);
    expect(autosave.getState().phase).toBe('saved');
  });
});

describe('Cmd+S (flush)', () => {
  it('saves at once instead of waiting for the debounce, and the debounce sends nothing more', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'right now');
    expect(autosave.getState().phase).toBe('unsaved');
    void autosave.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.metadata.description).toBe('right now');
    await calls[0].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
    await advance(AUTOSAVE_MAX_WAIT_MS);
    expect(calls).toHaveLength(1);
  });

  it('a clean copy sends nothing', async () => {
    const { autosave } = openAndWatch(3);
    await autosave.flush();
    expect(calls).toHaveLength(0);
    expect(autosave.getState().phase).toBe('saved');
  });

  it('during a request, it makes one trailing save at once (no second debounce)', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'one');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    edit(project, 'two');
    void autosave.flush();
    expect(calls).toHaveLength(1);
    await calls[0].answer(ok(4));
    expect(calls).toHaveLength(2);
    expect(calls[1].snapshot.metadata.description).toBe('two');
    expect(calls[1].expectedVersion).toBe(4);
  });
});

describe('backtrack', () => {
  it('an edit undone before the debounce sends nothing', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'oops');
    edit(project, '');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);
    expect(autosave.getState().phase).toBe('saved');
    expect(autosave.hasUnsavedWork()).toBe(false);
  });

  it('an edit revised before the debounce saves the current state', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'first');
    edit(project, 'second');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.metadata.description).toBe('second');
  });

  it('back to the saved state after a save: the next debounce sends nothing', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'saved text');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(ok(4));
    edit(project, 'changed');
    edit(project, 'saved text');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
  });
});

describe('resume', () => {
  it('reports unsaved work while dirty and while a request is out, not when clean', async () => {
    const { project, autosave } = openAndWatch(3);
    expect(autosave.hasUnsavedWork()).toBe(false);
    edit(project, 'draft');
    expect(autosave.hasUnsavedWork()).toBe(true);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.hasUnsavedWork()).toBe(true); // in flight
    await calls[0].answer(ok(4));
    expect(autosave.hasUnsavedWork()).toBe(false);
  });

  it('"Load the newer version" reloads without the warning', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'draft');
    autosave.discardForReload();
    expect(autosave.hasUnsavedWork()).toBe(false);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);
  });

  it('after a reload, the saved content opens through openProject and nothing is sent', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'kept across a reload');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    const stored = calls[0].snapshot;
    await calls[0].answer(ok(4));
    // A reload: a new store, the server answers what was saved, at version 4.
    // (The tab's version memory is per project id, so the reload is a new id
    // carrying the same content.)
    resetAutosaveForTests({ write });
    store = createRootStore();
    const reloadedId = `${project.id}_reloaded`;
    const reopened = openProject(store, { ...stored, id: reloadedId }, null, 4).project!;
    expect(reopened.metadata.description).toBe('kept across a reload');
    const autosave = autosaveFor(reloadedId);
    autosave.attach(reopened);
    await advance(60_000);
    expect(calls).toHaveLength(1);
    expect(autosave.getState().phase).toBe('saved');
  });

  it('leaving the editor with a save pending sends it at once', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'leaving');
    autosave.detach(project);
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.metadata.description).toBe('leaving');
  });
});

describe('re-entry after a 409 site_changed', () => {
  it('pauses (no request on later edits, also after Keep editing) and resumes after "Save mine over it"', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(conflict(9));
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 9, dialogOpen: true });
    expect(knownServerVersion(project.id)).toBe(3);

    edit(project, 'more of mine');
    await advance(60_000);
    expect(calls).toHaveLength(1);
    autosave.dismissConflict();
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    edit(project, 'even more');
    await advance(60_000);
    expect(calls).toHaveLength(1); // a refusal never loops
    expect(autosave.hasUnsavedWork()).toBe(true);

    void autosave.saveOver(9);
    expect(calls).toHaveLength(2);
    expect(calls[1].expectedVersion).toBe(9);
    expect(calls[1].snapshot.metadata.description).toBe('even more');
    await calls[1].answer(ok(10));
    expect(autosave.getState().phase).toBe('saved');
    expect(knownServerVersion(project.id)).toBe(10);
    expect(autosave.hasUnsavedWork()).toBe(false);

    edit(project, 'autosaving again');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(3);
    expect(calls[2].expectedVersion).toBe(10);
  });

  it('Cmd+S while paused reopens the dialog without a request; Retry sends nothing either', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(conflict(9));
    autosave.dismissConflict();
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    await autosave.flush();
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 9, dialogOpen: true });
    await autosave.retry();
    expect(calls).toHaveLength(1);
    expect(knownServerVersion(project.id)).toBe(3);
  });

  it('"Save mine over it" meets yet another write: refused again, the dialog asks with the newer number', async () => {
    const { project, autosave } = openAndWatch(1);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(conflict(2));
    void autosave.saveOver(2);
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', retrying: true });
    await calls[1].answer(conflict(3));
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 3, dialogOpen: true, retrying: false });
    void autosave.saveOver(3);
    await calls[2].answer(ok(4));
    expect([calls[0].expectedVersion, calls[1].expectedVersion, calls[2].expectedVersion]).toEqual([1, 2, 3]);
    expect(knownServerVersion(project.id)).toBe(4);
  });

  it('"Save mine over it" sends even a copy equal to the one this tab loaded (a refused Publish)', async () => {
    const { project, autosave } = openAndWatch(3);
    autosave.noteConflict(7);
    void autosave.saveOver(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].expectedVersion).toBe(7);
    await calls[0].answer(ok(8));
    expect(knownServerVersion(project.id)).toBe(8);
    expect(autosave.getState().phase).toBe('saved');
  });

  it('a generated page does not bypass the pause', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(conflict(9));
    edit(project, 'generated');
    await autosave.saveNow();
    expect(calls).toHaveLength(1);
  });

  it('a load that kept unsaved work over a newer server copy starts paused, with that version', async () => {
    const id = `site_auto_${++seq}`;
    const first = openProject(store, serverSnapshot(id), null, 3).project!;
    first.createPage('Unsaved in this tab'); // no autosave watching yet
    // An agent wrote the site meanwhile (the version moved).
    const reopened = openProject(store, serverSnapshot(id), null, 5);
    expect(reopened.changedElsewhere).toBe(true);
    const autosave = autosaveFor(id);
    autosave.attach(reopened.project!);
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 5, dialogOpen: false });
    edit(reopened.project!, 'still mine');
    await advance(60_000);
    expect(calls).toHaveLength(0);
  });
});

describe('re-entry after a failure', () => {
  it('a server error is shown and retried with backoff, then saves', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(500, 'Database down.'));
    const state = autosave.getState();
    expect(state.phase).toBe('retrying');
    expect(state.phase === 'retrying' && state.message).toContain('Database down.');
    await advance(AUTOSAVE_BACKOFF_MS[0] - 1);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
    await calls[1].answer(failure(503));
    // An edit while waiting does not jump the backoff.
    edit(project, 'mine, more');
    await advance(AUTOSAVE_BACKOFF_MS[1] - 1);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].snapshot.metadata.description).toBe('mine, more');
    await calls[2].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
    await advance(120_000);
    expect(calls).toHaveLength(3);
  });

  it('a network failure (no status) is retried too', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(undefined, 'Failed to fetch'));
    expect(autosave.getState().phase).toBe('retrying');
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    expect(calls).toHaveLength(2);
  });

  it('the backoff grows and stays at its last step', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    const waits = [...AUTOSAVE_BACKOFF_MS, AUTOSAVE_BACKOFF_MS[AUTOSAVE_BACKOFF_MS.length - 1]];
    for (const [i, wait] of waits.entries()) {
      await calls[i].answer(failure(502));
      await advance(wait - 1);
      expect(calls).toHaveLength(i + 1);
      await advance(1);
      expect(calls).toHaveLength(i + 2);
    }
  });

  it.each([400, 401, 403, 404, 413])('a %i refusal is shown with its status and never retried by itself; Retry tries again', async (status) => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(status, 'Refused.'));
    expect(autosave.getState()).toEqual({ phase: 'failed', message: 'Refused.', status });
    edit(project, 'more');
    await advance(120_000);
    expect(calls).toHaveLength(1);
    void autosave.retry();
    expect(calls).toHaveLength(2);
    expect(calls[1].snapshot.metadata.description).toBe('more');
    await calls[1].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
    // Autosave runs again after the retry succeeded.
    edit(project, 'after the retry');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(3);
  });

  it('Cmd+S after a refusal tries again, like Retry', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(413, 'Too large.'));
    void autosave.flush();
    expect(calls).toHaveLength(2);
    await calls[1].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
  });

  it('Retry while a passing failure waits sends at once and drops the pending timer', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(500));
    expect(autosave.getState().phase).toBe('retrying');
    void autosave.retry();
    expect(calls).toHaveLength(2);
    await calls[1].answer(ok(4));
    await advance(120_000);
    expect(calls).toHaveLength(2);
  });

  it('Retry after an undo back to the saved copy sends nothing and resolves the failure', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'too big');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(413, 'Too large.'));
    edit(project, '');
    await autosave.retry();
    expect(calls).toHaveLength(1);
    expect(autosave.getState().phase).toBe('saved');
  });

  it('classifies statuses', () => {
    expect([undefined, 408, 429, 500, 502, 503].every(isPassingFailure)).toBe(true);
    expect([200, 400, 401, 403, 404, 409, 413].some(isPassingFailure)).toBe(false);
  });
});

describe('opening, generation and Publish', () => {
  it('opening a project is not a change: nothing is sent, also when it is opened again in this tab', async () => {
    const id = `site_auto_${++seq}`;
    const project = openProject(store, serverSnapshot(id), null, 3).project!;
    const autosave = autosaveFor(id);
    autosave.attach(project);
    expect(autosave.getState().phase).toBe('saved');
    // Back from the overview: the server renamed it meanwhile (the rename route
    // writes the name, the load puts it in), the copy is reconciled in place.
    const renamed = { ...serverSnapshot(id), metadata: { ...serverSnapshot(id).metadata, title: 'Renamed' } };
    const again = openProject(store, renamed, null, 3).project!;
    autosave.attach(again);
    // A newer server copy taken over an untouched tab.
    const newer = openProject(store, serverSnapshot(id, 'from the server'), null, 4).project!;
    autosave.attach(newer);
    await advance(60_000);
    expect(calls).toHaveLength(0);
    expect(autosave.getState().phase).toBe('saved');
    expect(autosave.hasUnsavedWork()).toBe(false);
  });

  it('a generated page or section is saved at once, without waiting for the debounce', async () => {
    const { project, autosave } = openAndWatch(3);
    project.createPage('Generated');
    void autosave.saveNow();
    expect(calls).toHaveLength(1);
    await calls[0].answer(ok(4));
    await advance(60_000);
    expect(calls).toHaveLength(1);
  });

  it('Publish holds autosave: a save in flight finishes first, none starts meanwhile', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'before publish');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    let publishStarted = false;
    const published = autosave.exclusive(async () => {
      publishStarted = true;
      // What PublishButton does on success.
      markServerVersion(project.id, getSnapshot(project) as ProjectContent, 5);
    });
    await advance(0);
    expect(publishStarted).toBe(false); // waits for the save in flight
    await calls[0].answer(ok(4));
    await published;
    expect(publishStarted).toBe(true);
    await advance(60_000);
    expect(calls).toHaveLength(1);
    expect(autosave.getState().phase).toBe('saved');
  });

  it('a retry that came due during a failed Publish is armed again, not stranded', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(500));
    expect(autosave.getState().phase).toBe('retrying');
    // Publish runs across the retry's due time and fails (nothing marked saved).
    await autosave.exclusive(async () => {
      await advance(AUTOSAVE_BACKOFF_MS[0] * 2);
    });
    expect(calls).toHaveLength(1);
    expect(autosave.getState().phase).toBe('retrying');
    await advance(AUTOSAVE_BACKOFF_MS[1]);
    expect(calls).toHaveLength(2);
    await calls[1].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
  });

  it('a Publish refused by the version lock pauses autosave quietly', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await autosave.exclusive(async () => autosave.noteConflict(8));
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 8, dialogOpen: false });
    await advance(60_000);
    expect(calls).toHaveLength(0);
  });
});

describe('the review of 2026-11-04', () => {
  it('a project without a server version in this tab (a demo just kept as a project) is never saved automatically', async () => {
    const project = ProjectModel.create({ id: `site_auto_${++seq}`, metadata: { title: 'Demo', description: '' }, pages: {} });
    const autosave = autosaveFor(project.id);
    autosave.attach(project);
    expect(autosave.isAttached()).toBe(false);
    edit(project, 'demo work');
    await advance(AUTOSAVE_MAX_WAIT_MS);
    await autosave.saveNow();
    await autosave.flush();
    expect(anyUnsavedWork()).toBe(false);
    autosave.detach(project);
    expect(calls).toHaveLength(0);
    // Nothing held: no warning on unload, no model kept in the registry.
    expect(existingAutosave(project.id)).toBeUndefined();
  });

  it('passing failures stop retrying by themselves after 10 minutes and become a refusal with Retry', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    let answered = 0;
    while (autosave.getState().phase !== 'failed' && answered < 40) {
      await calls[answered].answer(failure(503, 'Unavailable.'));
      answered++;
      const state = autosave.getState();
      if (state.phase === 'retrying') await advance(state.retryAt - Date.now());
    }
    expect(autosave.getState()).toMatchObject({ phase: 'failed', status: 503, retriesStopped: true });
    // About ten minutes of tries: the backoff steps, then once a minute.
    expect(answered).toBeGreaterThan(8);
    expect(answered).toBeLessThanOrEqual(16);
    const sent = calls.length;
    await advance(30 * 60_000);
    expect(calls).toHaveLength(sent);
    void autosave.retry();
    expect(calls).toHaveLength(sent + 1);
    await calls[sent].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
  });

  it('while Publish writes, the state says publishing and Cmd+S sends nothing of its own', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'publish me');
    let finish: () => void = () => {};
    const publishing = autosave.exclusive(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            markServerVersion(project.id, getSnapshot(project) as ProjectContent, 4);
            resolve();
          };
        }),
    );
    await advance(0);
    expect(autosave.getState().phase).toBe('publishing');
    await autosave.flush();
    expect(calls).toHaveLength(0);
    finish();
    await publishing;
    expect(autosave.getState().phase).toBe('saved');
    await advance(AUTOSAVE_MAX_WAIT_MS);
    expect(calls).toHaveLength(0);
  });

  it('a Publish that fails without writing shows the earlier state again, and autosave goes on', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await autosave.exclusive(async () => undefined);
    expect(autosave.getState().phase).toBe('unsaved');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
  });

  it('after Cmd+S, changes made during the request show as unsaved, not saved', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'one');
    void autosave.flush();
    edit(project, 'two');
    await calls[0].answer(ok(4));
    expect(autosave.getState().phase).toBe('unsaved');
    expect(autosave.hasUnsavedWork()).toBe(true);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls[1].snapshot.metadata.description).toBe('two');
  });

  it('switching projects mid-debounce saves the left one at once, with its own version, and leaves the new one alone', async () => {
    const a = openAndWatch(3);
    edit(a.project, 'A work');
    // What the editor does on opening another project: the status detaches A, attaches B.
    const b = openProject(store, serverSnapshot(`site_auto_${++seq}`), null, 7).project!;
    a.autosave.detach(a.project);
    const bAutosave = autosaveFor(b.id);
    bAutosave.attach(b);
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.id).toBe(a.project.id);
    expect(calls[0].snapshot.metadata.description).toBe('A work');
    expect(calls[0].expectedVersion).toBe(3);
    await calls[0].answer(ok(4));
    await advance(AUTOSAVE_MAX_WAIT_MS);
    expect(calls).toHaveLength(1);
    expect(knownServerVersion(a.project.id)).toBe(4);
  });

  it('a left project leaves the registry once saved; one that failed stays and counts for the unload warning', async () => {
    const saved = openAndWatch(3);
    saved.autosave.detach(saved.project);
    expect(existingAutosave(saved.project.id)).toBeUndefined();

    const pending = openAndWatch(3);
    edit(pending.project, 'leaving');
    pending.autosave.detach(pending.project);
    expect(existingAutosave(pending.project.id)).toBe(pending.autosave);
    await calls[0].answer(ok(4));
    expect(existingAutosave(pending.project.id)).toBeUndefined();

    const failing = openAndWatch(3);
    edit(failing.project, 'not on the server');
    failing.autosave.detach(failing.project);
    await calls[1].answer(failure(401, 'authentication required'));
    expect(existingAutosave(failing.project.id)).toBe(failing.autosave);
    expect(failing.autosave.isAttached()).toBe(false);
    expect(anyUnsavedWork()).toBe(true);
  });

  it('a network failure of a left project keeps retrying in the background and saves', async () => {
    const left = openAndWatch(3);
    edit(left.project, 'retry me');
    left.autosave.detach(left.project);
    await calls[0].answer(failure(undefined, 'Failed to fetch'));
    expect(anyUnsavedWork()).toBe(true);
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    expect(calls).toHaveLength(2);
    await calls[1].answer(ok(4));
    expect(anyUnsavedWork()).toBe(false);
    expect(existingAutosave(left.project.id)).toBeUndefined();
  });

  it('opening the project again during its own save is not "saved somewhere else" (the version moved by this save)', async () => {
    const id = `site_auto_${++seq}`;
    const project = openProject(store, serverSnapshot(id), null, 3).project!;
    const autosave = autosaveFor(id);
    autosave.attach(project);
    edit(project, 'in flight');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    // Preview mounting (or coming back) reads the server after the save committed.
    const server = getSnapshot(project) as ProjectSnapshotOut;
    const reopened = openProject(store, server, null, 4);
    expect(reopened.changedElsewhere).toBe(false);
    expect(reopened.keptWorkingCopy).toBe(true);
    await calls[0].answer(ok(4));
    expect(knownServerVersion(id)).toBe(4);
    expect(autosave.getState().phase).toBe('saved');
  });

  it('a write by someone else during this save is still caught: the save is refused and asks', async () => {
    const id = `site_auto_${++seq}`;
    const project = openProject(store, serverSnapshot(id), null, 3).project!;
    const autosave = autosaveFor(id);
    autosave.attach(project);
    edit(project, 'in flight');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    openProject(store, serverSnapshot(id, 'theirs'), null, 4);
    // The version this tab is based on did not move with the load.
    expect(knownServerVersion(id)).toBe(3);
    await calls[0].answer(conflict(4));
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 4, dialogOpen: true });
  });
});

describe('opening with work kept from an earlier visit', () => {
  it('a copy that differs from the server when the status attaches is saved after the debounce', async () => {
    const id = `site_auto_${++seq}`;
    const project = openProject(store, serverSnapshot(id), null, 3).project!;
    edit(project, 'changed while nothing watched');
    const autosave = autosaveFor(id);
    autosave.attach(project);
    expect(autosave.getState().phase).toBe('unsaved');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.metadata.description).toBe('changed while nothing watched');
  });
});

describe('real content edits (through the repairs isSaved applies)', () => {
  it('a style edit on a page node saves, and an undo and a redo are saved too', async () => {
    const { project } = openAndWatch(3);
    const tree = project.findPageBySlug('')!.appComponentTree;
    tree.updateResponsiveStyle('color', 'rgb(200, 0, 0)');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    await calls[0].answer(ok(4));

    getUndoManager()!.undo();
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].snapshot.pages)).not.toContain('rgb(200, 0, 0)');
    await calls[1].answer(ok(5));

    getUndoManager()!.redo();
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[2].snapshot.pages)).toContain('rgb(200, 0, 0)');
  });

  it('a new page saves; undoing it back to the loaded copy sends nothing more', async () => {
    const { project } = openAndWatch(3);
    project.createPage('About');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].snapshot.pages)).toHaveLength(2);
    await calls[0].answer(ok(4));
    getUndoManager()!.undo();
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].snapshot.pages)).toHaveLength(1);
  });

  it('site settings and a component definition are saved', async () => {
    const { project } = openAndWatch(3);
    project.updateSiteSettings({ language: 'de' });
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect((calls[0].snapshot as { siteSettings?: { language?: string } }).siteSettings?.language).toBe('de');
    await calls[0].answer(ok(4));

    expect(calls).toHaveLength(1);
  });

  it('a change to a component definition is saved, and the load of it opens clean', async () => {
    const host = (id: string, type: string, children: unknown[] = []) => ({ id, type, componentType: 'host', props: {}, children });
    const card = {
      id: 'card',
      name: 'Card',
      page: { id: 'page-card', metadata: { title: 'Card' }, appComponentTree: host('c-root', 'article', [host('c-title', 'h3')]), canvasNodes: {} },
      inputs: [],
      states: [],
    };
    const id = `site_auto_${++seq}`;
    const withCard = { ...serverSnapshot(id), components: { card } } as unknown as ProjectSnapshotOut;
    const project = openProject(store, withCard, null, 3).project!;
    const autosave = autosaveFor(id);
    autosave.attach(project);
    await advance(AUTOSAVE_MAX_WAIT_MS);
    expect(calls).toHaveLength(0);
    expect(project.renameDefinition('card', 'Tile').ok).toBe(true);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect((calls[0].snapshot.components as Record<string, { name: string }>).card.name).toBe('Tile');
  });
});


describe('the re-review of 2026-11-04', () => {
  it('a retry of the same content on the same version reuses the attempt key; new content gets a new one', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(504, 'Gateway timeout.'));
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.requestKey).toBe(calls[0].options.requestKey);
    // The server committed the first attempt: the repeat is answered with its version.
    await calls[1].answer(ok(4));
    edit(project, 'more');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls[2].options.requestKey).not.toBe(calls[0].options.requestKey);
    expect(calls[2].expectedVersion).toBe(4);
  });

  it('a 2xx without a version is a server error that retries (with the same key), never a refusal', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer({ kind: 'error', status: 502, message: 'The server did not confirm the save (its answer had no project version).' });
    expect(autosave.getState()).toMatchObject({ phase: 'retrying', status: 502 });
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    expect(calls[1].options.requestKey).toBe(calls[0].options.requestKey);
  });

  it('a reload that did not happen (Stay) re-arms only on a real sign: the person using the page again', async () => {
    const { project, autosave } = openAndWatch(3);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    edit(project, 'mine');
    reloadDiscarding(project.id);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(autosave.hasUnsavedWork()).toBe(false);
    // Time alone is no sign: a slow reload is still a reload.
    await advance(60_000);
    expect(autosave.hasUnsavedWork()).toBe(false);
    expect(calls).toHaveLength(0);
    // The person stayed and types again.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    edit(project, 'typed after staying');
    expect(autosave.hasUnsavedWork()).toBe(true);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.metadata.description).toBe('typed after staying');
    vi.restoreAllMocks();
  });

  it('never re-arms once the page is going (pagehide)', async () => {
    const { project, autosave } = openAndWatch(3);
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload: vi.fn() } as Location);
    edit(project, 'mine');
    reloadDiscarding(project.id);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(autosave.hasUnsavedWork()).toBe(false);
    await advance(AUTOSAVE_MAX_WAIT_MS);
    expect(calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('re-arms when the page is shown again from the back-forward cache', () => {
    const { project, autosave } = openAndWatch(3);
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload: vi.fn() } as Location);
    edit(project, 'mine');
    reloadDiscarding(project.id);
    const shown = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(shown, 'persisted', { value: true });
    window.dispatchEvent(shown);
    expect(autosave.hasUnsavedWork()).toBe(true);
    vi.restoreAllMocks();
  });

  it('coming back to a paused project whose copy now equals the server clears the pause', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'refused');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(403, 'Not an admin.'));
    autosave.detach(project);
    // Meanwhile the copy went back to what the server holds (an undo, a load of the server copy).
    edit(project, '');
    autosave.attach(project);
    expect(autosave.getState().phase).toBe('saved');
    edit(project, 'new work');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
  });

  it('leaving the page sends the unsaved copy at once, as a keepalive request; never over a refusal', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'last words');
    void autosave.saveOnLeave();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.keepalive).toBe(true);
    expect(calls[0].snapshot.metadata.description).toBe('last words');
    await calls[0].answer(conflict(9));
    edit(project, 'more');
    await autosave.saveOnLeave();
    expect(calls).toHaveLength(1);
  });

  it('back online, a waiting retry goes at once', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(undefined, 'Failed to fetch'));
    void autosave.recover();
    expect(calls).toHaveLength(2);
  });
});


describe('the third review of 2026-11-04', () => {
  it('an edit during the backoff after a lost answer gets a new key, naming the lost one', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'first');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(504, 'Gateway timeout.'));
    edit(project, 'second'); // waits for the retry, which carries it
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    expect(calls).toHaveLength(2);
    expect(calls[1].snapshot.metadata.description).toBe('second');
    expect(calls[1].options.requestKey).not.toBe(calls[0].options.requestKey);
    expect(calls[1].options.previousRequestKey).toBe(calls[0].options.requestKey);
    expect(calls[1].expectedVersion).toBe(3);
    await calls[1].answer(ok(5)); // the server built on the lost write (4)
    expect(knownServerVersion(project.id)).toBe(5);
    edit(project, 'third');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    // Confirmed: no lost attempt is named any more.
    expect(calls[2].options.previousRequestKey).toBeUndefined();
  });

  it('a new version gets a new key, and a refusal settles a lost attempt', async () => {
    const { project } = openAndWatch(3);
    edit(project, 'one');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(ok(4));
    edit(project, 'two');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls[1].options.requestKey).not.toBe(calls[0].options.requestKey);
    expect(calls[1].options.previousRequestKey).toBeUndefined();
    await calls[1].answer(failure(500));
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    await calls[2].answer(failure(403, 'No.'));
    edit(project, 'three');
    void autosaveFor(project.id).retry();
    expect(calls[3].options.previousRequestKey).toBeUndefined();
  });

  it('recovering: a stopped failure and a sign-out are tried once more; still refused, they stay failed', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(401, 'authentication required'));
    expect(autosave.getState()).toMatchObject({ phase: 'failed', status: 401 });
    void autosave.recover();
    expect(calls).toHaveLength(2);
    await calls[1].answer(failure(401, 'authentication required'));
    expect(autosave.getState()).toMatchObject({ phase: 'failed', status: 401 });
    void autosave.recover();
    await calls[2].answer(ok(4));
    expect(autosave.getState().phase).toBe('saved');
  });

  it('recovering leaves other refusals alone (a 413 needs the person)', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'huge');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(413, 'too large'));
    await autosave.recover();
    expect(calls).toHaveLength(1);
  });

  it('leaving with a change that has no timer pending (a field committed as the editor closed) still saves it', async () => {
    const { project, autosave } = openAndWatch(3);
    // The patch listener goes first, then the field commits: no debounce was armed.
    autosave.detach(project);
    autosave.attach(project);
    project.updateMetadata({ description: 'committed on the way out' });
    // A detach whose timer was cleared by a save in flight meanwhile is the same case:
    (autosave as unknown as { clearDebounce(): void }).clearDebounce();
    autosave.detach(project);
    expect(calls).toHaveLength(1);
    expect(calls[0].snapshot.metadata.description).toBe('committed on the way out');
  });

  it('"Save mine as a new project": the original gives up its copy, no warning, and opens the server copy next time', async () => {
    const id = `site_auto_${++seq}`;
    const project = openProject(store, serverSnapshot(id), null, 3).project!;
    const autosave = autosaveFor(id);
    autosave.attach(project);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(conflict(9));
    expect(anyUnsavedWork()).toBe(true);
    abandonWorkingCopy(id);
    expect(anyUnsavedWork()).toBe(false);
    autosave.detach(project);
    expect(existingAutosave(id)).toBeUndefined();
    await advance(60_000);
    expect(calls).toHaveLength(1);
    const reopened = openProject(store, serverSnapshot(id, 'theirs'), null, 9);
    expect(reopened.keptWorkingCopy).toBe(false);
    expect(reopened.changedElsewhere).toBe(false);
    expect(reopened.project?.metadata.description).toBe('theirs');
    expect(knownServerVersion(id)).toBe(9);
  });
});
