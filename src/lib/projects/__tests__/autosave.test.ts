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
//              failure retries with backoff; a refusal never retries by itself.
// Plus: opening is not a change, a generated page saves at once, Publish holds
// autosave, and a load that kept unsaved work over a newer copy pauses it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { knownServerVersion, markServerVersion, openProject, type ProjectContent } from '@/stores/openProject';
import type { ProjectWriteResult } from '../projectWrite';
import {
  AUTOSAVE_BACKOFF_MS,
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  autosaveFor,
  isPassingFailure,
  resetAutosaveForTests,
  type AutosaveController,
} from '../autosave';

let store: RootStoreType;
let seq = 0;

interface Call {
  snapshot: ProjectSnapshotOut;
  expectedVersion: number | undefined;
  answer: (result: ProjectWriteResult) => Promise<void>;
}
let calls: Call[] = [];

/** The request: every call waits for the test's answer. */
function write(snapshot: unknown, expectedVersion: number | undefined): Promise<ProjectWriteResult> {
  return new Promise((resolve) => {
    calls.push({
      snapshot: snapshot as ProjectSnapshotOut,
      expectedVersion,
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

/** What /projects/<id> does, then the Save button watching the project. */
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

    void autosave.saveManually(9);
    expect(calls).toHaveLength(2);
    expect(calls[1].expectedVersion).toBe(9);
    await calls[1].answer(ok(10));
    expect(autosave.getState().phase).toBe('savedNow');

    edit(project, 'autosaving again');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(3);
    expect(calls[2].expectedVersion).toBe(10);
  });

  it('a manual Save while paused sends the old version and asks again', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(conflict(9));
    autosave.dismissConflict();
    void autosave.saveManually();
    expect(calls[1].expectedVersion).toBe(3);
    await calls[1].answer(conflict(9));
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
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

  it.each([400, 401, 403, 404, 413])('a %i refusal is shown and never retried by itself; a click tries again', async (status) => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await calls[0].answer(failure(status, 'Refused.'));
    expect(autosave.getState()).toMatchObject({ phase: 'failed' });
    edit(project, 'more');
    await advance(120_000);
    expect(calls).toHaveLength(1);
    void autosave.saveManually();
    expect(calls).toHaveLength(2);
    await calls[1].answer(ok(4));
    expect(autosave.getState().phase).toBe('savedNow');
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

  it('a Publish refused by the version lock pauses autosave quietly', async () => {
    const { project, autosave } = openAndWatch(3);
    edit(project, 'mine');
    await autosave.exclusive(async () => autosave.noteConflict(8));
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 8, dialogOpen: false });
    await advance(60_000);
    expect(calls).toHaveLength(0);
  });
});
