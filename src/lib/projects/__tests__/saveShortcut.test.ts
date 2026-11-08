// Cmd/Ctrl+S in the editor (src/lib/projects/saveShortcut.ts): it always keeps
// the browser's "save page" dialog away, also in a field, and saves at once
// instead of after the debounce. The demo at `/` never sends anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { openProject } from '@/stores/openProject';
import { resolveAction } from '@/lib/keyBindings';
import type { ProjectWriteResult } from '../projectWrite';
import { AUTOSAVE_MAX_WAIT_MS, autosaveFor, resetAutosaveForTests } from '../autosave';
import { handleSaveShortcut } from '../saveShortcut';

let store: RootStoreType;
let seq = 0;
const write = vi.fn(
  async (_snapshot: unknown, expectedVersion: number | undefined): Promise<ProjectWriteResult> => ({
    kind: 'ok',
    version: (expectedVersion ?? 0) + 1,
    payload: {},
  }),
);

function open() {
  const p = ProjectModel.create({ id: `site_key_${++seq}`, metadata: { title: 'Site', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  const project = openProject(store, getSnapshot(p) as ProjectSnapshotOut, null, 3).project!;
  autosaveFor(project.id).attach(project);
  return project;
}

const press = (init: KeyboardEventInit, target?: EventTarget) => {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
};

beforeEach(() => {
  vi.useFakeTimers();
  write.mockClear();
  resetAutosaveForTests({ write });
  store = createRootStore();
});
afterEach(() => {
  resetAutosaveForTests();
  vi.useRealTimers();
});

describe('the binding', () => {
  it('matches Cmd+S and Ctrl+S, also in a field, and nothing else', () => {
    const input = document.createElement('input');
    expect(resolveAction(press({ key: 's', metaKey: true }))?.action).toBe('save');
    expect(resolveAction(press({ key: 'S', ctrlKey: true }))?.action).toBe('save');
    expect(resolveAction(press({ key: 's', metaKey: true }, input))?.action).toBe('save');
    expect(resolveAction(press({ key: 's' }))).toBeNull();
    expect(resolveAction(press({ key: 's', metaKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('Cmd+S', () => {
  it('prevents the browser dialog and saves at once (the debounce is flushed)', async () => {
    const project = open();
    project.updateMetadata({ description: 'now' });
    const event = press({ key: 's', metaKey: true });
    expect(handleSaveShortcut(event, store.editorUI)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0][0] as ProjectSnapshotOut).metadata.description).toBe('now');
    expect(write.mock.calls[0][1]).toBe(3);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('with nothing unsaved, prevents the dialog and sends nothing', () => {
    open();
    const event = press({ key: 's', ctrlKey: true });
    expect(handleSaveShortcut(event, store.editorUI)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('in the demo editor, prevents the dialog and never sends', async () => {
    const project = open();
    store.editorUI.markUnsavedDemo(project.id);
    project.updateMetadata({ description: 'demo' });
    const event = press({ key: 's', metaKey: true });
    expect(handleSaveShortcut(event, store.editorUI)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('other keys are left alone', () => {
    open();
    const event = press({ key: 'z', metaKey: true });
    expect(handleSaveShortcut(event, store.editorUI)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
