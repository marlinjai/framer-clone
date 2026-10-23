// Layers row actions on the real stores: lock covers the subtree, delete keeps
// the selection consistent and is one undo step, and both flags are undoable
// project data that survives a save.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import ProjectModel from '@/models/ProjectModel';
import { ancestorIdsOf, canDeleteLayer, deleteLayer, isLockedOnCanvas } from '../layerActions';

function setup() {
  const store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Layer actions');
  const project = projectStore.findProjectByTitle('Layer actions')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
  const [main, image] = root.children as ComponentInstance[];
  main.addChildren([createIntrinsicComponent('span-child', 'span', { children: 'Nested' })]);
  const nested = main.children[0] as ComponentInstance;
  const desktop = page.sortedViewportNodes[0];
  const history = getHistoryStore()!;
  history.clear();
  const find = (id: string) => page.findComponent(id);
  return { project, page, editorUI, history, root, main, image, nested, desktop, find };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ancestors and lock', () => {
  it('lists ancestors nearest first', () => {
    const { root, main, nested, find } = setup();
    expect(ancestorIdsOf(nested, find)).toEqual([main.id, root.id]);
    expect(ancestorIdsOf(root, find)).toEqual([]);
  });

  it('a locked container locks everything inside it on the canvas', () => {
    const { main, nested, image, find } = setup();
    expect(isLockedOnCanvas(nested, find)).toBe(false);
    main.toggleCanvasLock();
    expect(isLockedOnCanvas(main, find)).toBe(true);
    expect(isLockedOnCanvas(nested, find)).toBe(true);
    expect(isLockedOnCanvas(image, find)).toBe(false);
  });
});

describe('flags are project data', () => {
  it('hide and lock are undoable steps', () => {
    const { main, history } = setup();
    main.toggleCanvasVisibility();
    main.toggleCanvasLock();
    expect(main.canvasVisible).toBe(false);
    expect(main.canvasLocked).toBe(true);
    history.undo();
    expect(main.canvasLocked).toBe(false);
    history.undo();
    expect(main.canvasVisible).toBe(true);
  });

  it('hide and lock survive a save and reload of the project', () => {
    const { project, main } = setup();
    main.toggleCanvasVisibility();
    main.toggleCanvasLock();
    const reloaded = ProjectModel.create(JSON.parse(JSON.stringify(getSnapshot(project))));
    const copy = reloaded.findPageBySlug('')!.findComponent(main.id)!;
    expect(copy.canvasVisible).toBe(false);
    expect(copy.canvasLocked).toBe(true);
  });
});

describe('deleteLayer', () => {
  it('never deletes the page root or a breakpoint frame', () => {
    const { page, editorUI, history, root, desktop } = setup();
    expect(canDeleteLayer(root)).toBe(false);
    expect(canDeleteLayer(desktop)).toBe(false);
    expect(deleteLayer(page, editorUI, history, root)).toBe(0);
    expect(page.appComponentTree).toBe(root);
  });

  it('deleting a node that is not selected keeps the selection', () => {
    const { page, editorUI, history, main, image, desktop } = setup();
    editorUI.selectComponent(image, desktop.breakpointId);
    expect(deleteLayer(page, editorUI, history, main)).toBe(1);
    expect(page.findComponent(main.id)).toBeUndefined();
    expect(editorUI.selectedComponent).toBe(image);
  });

  it('deleting a selected node deletes the whole selection as one undo step', () => {
    const { page, editorUI, history, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    expect(deleteLayer(page, editorUI, history, image)).toBe(2);
    expect(page.findComponent(main.id)).toBeUndefined();
    expect(page.findComponent(image.id)).toBeUndefined();
    expect(editorUI.selectedComponentList).toEqual([]);
    history.undo();
    expect(page.findComponent(main.id)).toBeDefined();
    expect(page.findComponent(image.id)).toBeDefined();
  });

  it('deleting the container of the primary promotes the next selected node', () => {
    const { page, editorUI, history, main, image, nested, desktop } = setup();
    editorUI.setSelection([nested, image], desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(nested);
    expect(deleteLayer(page, editorUI, history, main)).toBe(1);
    expect(editorUI.selectedComponent).toBe(image);
    expect(editorUI.selectedComponentList.map(c => c.id)).toEqual([image.id]);
    expect(editorUI.selectedViewportNode).toBe(desktop);
  });
});
