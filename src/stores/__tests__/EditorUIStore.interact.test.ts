// The Interact tool in the store: what entering and leaving it does to the rest of the
// editor's state. docs/plans/2026-11-02-behaviour-model.md, "Interact: the page runs, in the
// frame". The page itself running is proven in a browser (test/behaviour/canvasInteract.spec.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootStore, getHistoryStore, getUndoManager, type RootStoreType } from '../RootStore';
import { EditorTool } from '../EditorUIStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';

let store: RootStoreType;
let project: ProjectModelType;
let root: ComponentInstance;
let panel: ComponentInstance;

const ui = () => store.editorUI;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Interact test');
  project = store.projectStore.findProjectByTitle('Interact test')!;
  ui().setCurrentProject(project);
  ui().setCurrentPage(project.findPageBySlug('')!);
  getHistoryStore()!.setTargetStore(project);
  root = ui().currentPage!.appComponentTree as ComponentInstance;
  root.setBehaviour({ state: [{ id: 'menu', name: 'Menu open', type: 'boolean', initial: false }] });
  root.addChildren([createIntrinsicComponent('drawer', 'nav', { children: 'Links' })]);
  panel = root.children.find((child: ComponentInstance) => child.id === 'drawer')!;
  panel.setBehaviour({ showWhen: { state: 'menu', eq: true } });
});

describe('entering Interact', () => {
  it('ends a Select preview and its notice, so the page starts from its first values', () => {
    ui().selectComponent(panel);
    expect(ui().previewState).toEqual({ menu: true });
    ui().setSelectedTool(EditorTool.INTERACT);
    expect(ui().previewState).toEqual({});
    expect(ui().editorNotice).toBeUndefined();
    expect(ui().interactOn).toBe(true);
  });

  it('ends a text edit and the phone context menu', () => {
    ui().beginTextEdit(panel);
    ui().openPhoneContextMenu({ x: 1, y: 2 });
    ui().setSelectedTool(EditorTool.INTERACT);
    expect(ui().editingComponent).toBeUndefined();
    expect(ui().phoneContextMenu).toBeUndefined();
  });

  it('previews nothing for a layer picked while the page runs', () => {
    ui().setSelectedTool(EditorTool.INTERACT);
    ui().selectComponent(panel);
    expect(ui().previewState).toEqual({});
    expect(ui().editorNotice).toBeUndefined();
  });

  it('writes nothing to the project: no undo step', () => {
    const before = getUndoManager()!.undoIdx;
    ui().setSelectedTool(EditorTool.INTERACT);
    ui().setSelectedTool(EditorTool.SELECT);
    expect(getUndoManager()!.undoIdx).toBe(before);
  });
});

describe('the run of the page', () => {
  it('starts and ends with a new epoch, and a tool picked again changes nothing', () => {
    const start = ui().interactEpoch;
    ui().setSelectedTool(EditorTool.INTERACT);
    expect(ui().interactEpoch).toBe(start + 1);
    ui().setSelectedTool(EditorTool.INTERACT);
    expect(ui().interactEpoch).toBe(start + 1);
    ui().setSelectedTool(EditorTool.GRAB);
    expect(ui().interactEpoch).toBe(start + 2);
    expect(ui().interactOn).toBe(false);
    ui().setSelectedTool(EditorTool.SELECT);
    expect(ui().interactEpoch).toBe(start + 2);
  });

  it('keeps running while Space pans for a moment, and comes back to Interact', () => {
    ui().setSelectedTool(EditorTool.INTERACT);
    const epoch = ui().interactEpoch;
    ui().beginTemporaryGrab();
    expect(ui().selectedTool).toBe(EditorTool.GRAB);
    expect(ui().interactOn).toBe(true);
    ui().endTemporaryGrab();
    expect(ui().selectedTool).toBe(EditorTool.INTERACT);
    expect(ui().interactEpoch).toBe(epoch);
  });

  it('ends when another tool is picked while Space is held in it', () => {
    ui().setSelectedTool(EditorTool.INTERACT);
    const epoch = ui().interactEpoch;
    ui().beginTemporaryGrab();
    ui().setSelectedTool(EditorTool.SELECT);
    expect(ui().interactOn).toBe(false);
    expect(ui().interactEpoch).toBe(epoch + 1);
  });

  it('is not kept: a new editor opens on Select', () => {
    ui().setSelectedTool(EditorTool.INTERACT);
    expect(createRootStore().editorUI.selectedTool).toBe(EditorTool.SELECT);
  });
});
