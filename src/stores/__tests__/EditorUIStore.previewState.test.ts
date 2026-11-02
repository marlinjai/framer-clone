// Page state as the canvas previews it in Select, through the four paths of the stateful
// flow standard: forward, backtrack, resume and re-entry. docs/plans/2026-11-02-behaviour-model.md,
// "Select: nothing runs, a state can be previewed".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, getUndoManager, type RootStoreType } from '../RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { surfaceBehaviour } from '@/lib/behaviour/surfaceBehaviour';

let store: RootStoreType;
let project: ProjectModelType;
let root: ComponentInstance;
let panel: ComponentInstance;

const ui = () => store.editorUI;
const shown = () => surfaceBehaviour(ui().currentPage!.expansion.root, ui().previewState).dom;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Preview test');
  project = store.projectStore.findProjectByTitle('Preview test')!;
  const page = project.findPageBySlug('')!;
  ui().setCurrentProject(project);
  ui().setCurrentPage(page);
  getHistoryStore()!.setTargetStore(project);
  root = page.appComponentTree as ComponentInstance;
  root.setBehaviour({ state: [{ id: 'menu', name: 'Menu open', type: 'boolean', initial: false }] });
  root.addChildren([createIntrinsicComponent('drawer', 'nav', { children: 'Links' })]);
  panel = root.children.find((child: ComponentInstance) => child.id === 'drawer')!;
  panel.setBehaviour({ showWhen: { state: 'menu', eq: true } });
});

describe('forward', () => {
  it('shows a state at its preview value on the canvas', () => {
    ui().setPreviewValue('menu', true);
    expect(shown().get(root.id)?.attributes['data-fcs-menu']).toBe('true');
    ui().setPreviewValue('menu', undefined);
    expect(shown().get(root.id)?.attributes['data-fcs-menu']).toBe('false');
  });

  it('reveals a layer a Show when hides, picked in Layers, and names the state', () => {
    ui().selectComponent(panel);
    expect(ui().previewState).toEqual({ menu: true });
    expect(ui().editorNotice).toMatchObject({ kind: 'previewState', message: expect.stringContaining('Menu open') });
  });

  it('changes nothing for a layer nothing hides', () => {
    ui().selectComponent(root);
    expect(ui().previewState).toEqual({});
    expect(ui().editorNotice).toBeUndefined();
  });

  it('never writes the page: no save, no undo step', () => {
    const before = getUndoManager()!.undoIdx;
    ui().selectComponent(panel);
    ui().setPreviewValue('menu', false);
    expect(getUndoManager()!.undoIdx).toBe(before);
    expect((root.props as { behaviour: { state: { initial: boolean }[] } }).behaviour.state[0].initial).toBe(false);
  });
});

describe('backtrack', () => {
  it('drops a preview its state can no longer hold, and keeps the state', () => {
    root.setBehaviour({ state: [{ id: 'menu', name: 'Menu open', type: 'choice', initial: 'shut', options: ['shut', 'open'] }] });
    ui().setPreviewValue('menu', 'open');
    expect(shown().get(root.id)?.attributes['data-fcs-menu']).toBe('open');
    root.setBehaviour({ state: [{ id: 'menu', name: 'Menu open', type: 'choice', initial: 'shut', options: ['shut', 'half'] }] });
    expect(shown().get(root.id)?.attributes['data-fcs-menu']).toBe('shut');
  });

  it('a deleted state takes its Show when out with it, visibly, and undo restores both in one step', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    root.setBehaviour(undefined);
    const result = surfaceBehaviour(ui().currentPage!.expansion.root);
    expect(result.problems.map((problem) => problem.node)).toContain('drawer');
    getUndoManager()!.undo();
    expect(surfaceBehaviour(ui().currentPage!.expansion.root).problems).toEqual([]);
    warn.mockRestore();
  });

  it('Show first values ends the preview and its notice', () => {
    ui().selectComponent(panel);
    ui().clearPreviewState();
    expect(ui().previewState).toEqual({});
    expect(ui().editorNotice).toBeUndefined();
  });
});

describe('resume', () => {
  it('is never part of what is saved', () => {
    ui().setPreviewValue('menu', true);
    expect(JSON.stringify(getSnapshot(project))).not.toContain('"previewState"');
    expect(Object.keys(getSnapshot(ui()))).not.toContain('previewState');
  });
});

describe('re-entry', () => {
  it('another page starts from first values', () => {
    ui().selectComponent(panel);
    const other = project.createPage('Other');
    ui().setCurrentPage(other);
    expect(ui().previewState).toEqual({});
    expect(ui().editorNotice).toBeUndefined();
  });

  it('coming back to the page starts from first values too', () => {
    const page = ui().currentPage!;
    ui().setPreviewValue('menu', true);
    ui().setCurrentPage(project.createPage('Away'));
    ui().setCurrentPage(page);
    expect(ui().previewState).toEqual({});
  });
});
