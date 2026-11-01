// A drop the page refuses: nothing moves, no indicator promises otherwise, and
// the person is told why on release. The resolver is stubbed because jsdom has
// no layout; what is under test is what the manager does with its answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { InsertTarget, PageModelType } from '@/models/PageModel';

const stub = vi.hoisted(() => ({ target: null as unknown }));

vi.mock('./resolveDropTarget', async (original) => ({
  ...(await original<typeof import('./resolveDropTarget')>()),
  resolveDropTarget: () => ({
    target: stub.target,
    indicator: { kind: 'inside', rect: new DOMRect(0, 0, 10, 10), targetId: 'x' },
  }),
}));

let store: RootStoreType;
let page: PageModelType;
let para: ComponentInstance;
let run: ComponentInstance;
let row: ComponentInstance;

function press(node: ComponentInstance) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return getDragManager()!.begin(
    { kind: 'moveNode', nodeId: node.id },
    {
      isPrimary: true,
      button: 0,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      currentTarget: el,
      stopPropagation() {},
    } as unknown as React.PointerEvent,
    node,
  );
}

function pointer(type: string, x: number) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, clientX: x, clientY: 0, isPrimary: true });
  document.dispatchEvent(event);
}

function dragTo(target: InsertTarget, node: ComponentInstance) {
  stub.target = target;
  expect(press(node)).toBe(true);
  pointer('pointermove', 40);
  pointer('pointermove', 60);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Refusal');
  const project = projectStore.findProjectByTitle('Refusal')!;
  page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.setProps({ children: undefined });
  main.addChild(createIntrinsicComponent('para', 'p', {}));
  main.addChild(createIntrinsicComponent('row', 'tr', {}));
  para = main.children.find((c: ComponentInstance) => c.id === 'para') as ComponentInstance;
  row = main.children.find((c: ComponentInstance) => c.id === 'row') as ComponentInstance;
  para.addChild(ComponentModel.create({ id: 'run', type: '#text', componentType: 'host', props: { children: 'Hi' }, parentId: 'para' }));
  para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'b' }));
  run = para.children[0] as ComponentInstance;
  getDragManager()!.wire({
    getTransform: () => ({ panX: 0, panY: 0, zoom: 1 }),
    getPage: () => store.editorUI.currentPage,
    getHistory: () => getHistoryStore(),
    getEditorUI: () => store.editorUI,
  });
  getHistoryStore()!.clear();
});

afterEach(() => {
  getDragManager()?.cancel();
  vi.restoreAllMocks();
});

describe('a drop the page refuses', () => {
  it('moves nothing, paints no indicator, and says why on release', () => {
    dragTo({ kind: 'parent', parentId: 'row' }, run);
    expect(getDragManager()!.indicator).toBeNull();
    pointer('pointerup', 60);
    expect(para.children[0].id).toBe('run');
    expect(row.children).toHaveLength(0);
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused', message: expect.stringContaining('table row') });
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('paints the indicator for a drop that is allowed, and clears an old refusal when it lands', () => {
    store.editorUI.setEditorNotice({ kind: 'refused', message: 'old' });
    dragTo({ kind: 'parent', parentId: 'row' }, para.children[1] as ComponentInstance);
    expect(getDragManager()!.indicator).not.toBeNull();
    pointer('pointerup', 60);
    expect(row.children.map((c: ComponentInstance) => c.id)).toEqual(['bold']);
    expect(store.editorUI.editorNotice).toBeUndefined();
  });

  it('leaves another notice in place', () => {
    store.editorUI.setEditorNotice({ kind: 'missingPage', message: 'kept' });
    dragTo({ kind: 'parent', parentId: 'row' }, para.children[1] as ComponentInstance);
    pointer('pointerup', 60);
    expect(store.editorUI.editorNotice?.message).toBe('kept');
  });
});
