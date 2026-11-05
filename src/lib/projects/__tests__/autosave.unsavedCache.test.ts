// The unsaved check of a project (AutosaveController.hasUnsavedWork) serialises
// the whole project; the left-behind notice asks for it every second while its
// countdown ticks. It is computed once per change, never per ask (fourth review).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const counted = vi.hoisted(() => ({ snapshots: 0 }));
vi.mock('mobx-state-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mobx-state-tree')>();
  return {
    ...actual,
    getSnapshot: ((node: unknown) => {
      counted.snapshots++;
      return actual.getSnapshot(node as never);
    }) as typeof actual.getSnapshot,
  };
});

import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { openProject } from '@/stores/openProject';
import type { ProjectWriteResult } from '../projectWrite';
import { AUTOSAVE_DEBOUNCE_MS, autosaveFor, resetAutosaveForTests } from '../autosave';

let store: RootStoreType;
const answers: Array<(r: ProjectWriteResult) => void> = [];
const write = () => new Promise<ProjectWriteResult>((resolve) => answers.push(resolve));

beforeEach(() => {
  vi.useFakeTimers();
  answers.length = 0;
  resetAutosaveForTests({ write });
  store = createRootStore();
});
afterEach(() => {
  resetAutosaveForTests();
  vi.useRealTimers();
});

describe('hasUnsavedWork is cached per change', () => {
  it('asking again without a change serialises nothing; a change makes one more', async () => {
    const p = ProjectModel.create({ id: 'site_cache', metadata: { title: 'Site', description: '' }, pages: {} });
    p.createPage('Home').setSlug('');
    const project = openProject(store, getSnapshot(p) as ProjectSnapshotOut, null, 3).project!;
    const autosave = autosaveFor(project.id);
    autosave.attach(project);
    project.updateMetadata({ description: 'left behind' });
    autosave.detach(project); // saves at once
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    answers[0]({ kind: 'error', status: 403, message: 'No.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(autosave.hasUnsavedWork()).toBe(true);
    const before = counted.snapshots;
    for (let i = 0; i < 30; i++) expect(autosave.hasUnsavedWork()).toBe(true);
    expect(counted.snapshots).toBe(before);
    project.updateMetadata({ description: '' }); // back to the server's copy
    expect(autosave.hasUnsavedWork()).toBe(false);
    expect(counted.snapshots).toBe(before + 1);
  });
});
