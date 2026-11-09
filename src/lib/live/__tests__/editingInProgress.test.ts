import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { getSnapshot } from 'mobx-state-tree';
import { openProject } from '@/stores/openProject';
import { registerOpenDraft } from '@/lib/projects/openDrafts';
import { isEditing, isInteracting, onEditingSettled, onPersonTookOver } from '../editingInProgress';
import type { ComponentInstance } from '@/models/ComponentModel';
import { applyOperations } from '@/lib/siteOps/applyOps';

let store: RootStoreType;
let seq = 0;

beforeEach(async () => {
  store = createRootStore();
  const p = ProjectModel.create({ id: `site_edit_${++seq}`, metadata: { title: 'S', description: '' }, pages: {} }) as ProjectModelType;
  const home = p.createPage('Home');
  home.setSlug('');
  const outcome = await applyOperations(p, [{ op: 'insertNodes', pageId: home.id, nodes: [{ type: 'p', props: { children: 'One' } }, { type: 'p', props: { children: 'Two' } }] }]);
  if (!outcome.ok) throw new Error('refused');
  openProject(store, getSnapshot(p) as ProjectSnapshotOut, null, 1);
});

const root = () => store.editorUI.currentPage!.appComponentTree as ComponentInstance;
const child = (i: number) => root().children[i] as ComponentInstance;

describe('isEditing and isInteracting', () => {
  it('a dirty draft, a text edit, a resize and a batched gesture are editing; a clean draft is not', () => {
    expect(isEditing(store)).toBe(false);
    let dirty = false;
    const unregister = registerOpenDraft({ isDirty: () => dirty, commit: () => {} });
    expect(isEditing(store)).toBe(false);
    dirty = true;
    expect(isEditing(store)).toBe(true);
    unregister();

    store.editorUI.beginTextEdit(root());
    expect(isEditing(store)).toBe(true);
    store.editorUI.endTextEdit();

    store.editorUI.startResize({} as never);
    expect(isEditing(store)).toBe(true);
    store.editorUI.endResize();

    getHistoryStore()!.startBatch('Move');
    expect(isEditing(store)).toBe(true);
    getHistoryStore()!.cancelBatch();
    expect(isEditing(store)).toBe(false);
  });

  it('a marquee or the focus in a field is interacting, not editing', () => {
    store.editorUI.setMarqueeActive(true);
    expect(isEditing(store)).toBe(false);
    expect(isInteracting(store)).toBe(true);
    store.editorUI.setMarqueeActive(false);
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    expect(isInteracting(store)).toBe(true);
    input.remove();
    expect(isInteracting(store)).toBe(false);
  });
});

describe('onEditingSettled', () => {
  it('hears a text edit ending at once and a draft settling by its announcement', async () => {
    const heard = vi.fn();
    store.editorUI.beginTextEdit(root());
    const stop = onEditingSettled(store, heard);
    store.editorUI.endTextEdit();
    expect(heard).toHaveBeenCalledTimes(1);
    const unregister = registerOpenDraft({ isDirty: () => true, commit: () => {} });
    unregister();
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('onPersonTookOver', () => {
  it('a new selection or a text edit start takes over; a selection that only shrinks does not', () => {
    const tookOver = vi.fn();
    const stop = onPersonTookOver(store, tookOver);
    store.editorUI.selectComponent(child(0));
    expect(tookOver).toHaveBeenCalledTimes(1);
    store.editorUI.clearSelection();
    expect(tookOver).toHaveBeenCalledTimes(1);
    store.editorUI.beginTextEdit(child(0));
    expect(tookOver).toHaveBeenCalledTimes(2);
    stop();
    store.editorUI.endTextEdit();
    store.editorUI.selectComponent(child(1));
    expect(tookOver).toHaveBeenCalledTimes(2);
  });

  it('a page switch, which selects the new page root by itself, is not taking over', () => {
    const project = store.editorUI.currentProject!;
    const other = project.createPage('Other');
    const tookOver = vi.fn();
    const stop = onPersonTookOver(store, tookOver);
    store.editorUI.setCurrentPage(other);
    expect(store.editorUI.selectedComponent?.id).toBe(other.appComponentTree.id);
    expect(tookOver).not.toHaveBeenCalled();
    stop();
  });
});
