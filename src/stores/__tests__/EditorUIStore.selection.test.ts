// Multi-selection on the canvas (Shift+click, marquee) layered over the
// single selection every existing consumer reads (`selectedComponent`,
// `selectedViewportNode`), plus the held-Space temporary Grab tool and the
// one-undo-step delete of a multi-selection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRootStore, getHistoryStore } from '../RootStore';
import { EditorTool } from '../EditorUIStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { deleteSelection } from '@/lib/canvas/deleteSelection';

function setup() {
  const store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Selection test');
  const project = projectStore.findProjectByTitle('Selection test')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);

  // Demo tree: root(header) > [main, img]. Give main a child so parent and
  // child rules can be tested.
  const root = page.appComponentTree as ComponentInstance;
  const [main, image] = root.children as ComponentInstance[];
  main.addChildren([createIntrinsicComponent('span-child', 'span', { children: 'Nested' })]);
  const nested = main.children[0] as ComponentInstance;
  const desktop = page.sortedViewportNodes[0];
  const floating = page.floatingElements;

  const history = getHistoryStore()!;
  history.clear();
  return { store, editorUI, page, root, main, image, nested, desktop, floating, history };
}

const ids = (list: ComponentInstance[]) => list.map(c => c.id);

beforeEach(() => {
  // selectComponent logs every call; keep the test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('single selection stays as before', () => {
  it('selectComponent holds exactly one node, with its frame as context', () => {
    const { editorUI, main, desktop } = setup();
    editorUI.selectComponent(main, desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(main);
    expect(editorUI.selectedViewportNode).toBe(desktop);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id]);
    expect(editorUI.isSelected(main.id)).toBe(true);
  });

  it('selecting another node replaces the whole multi-selection', () => {
    const { editorUI, main, image, nested, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    editorUI.selectComponent(nested, desktop.breakpointId);
    expect(ids(editorUI.selectedComponentList)).toEqual([nested.id]);
  });

  it('selecting a frame clears every selected component', () => {
    const { editorUI, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    editorUI.setSelectedViewportNode(desktop);
    expect(editorUI.selectedComponent).toBeUndefined();
    expect(editorUI.selectedComponentList).toEqual([]);
    expect(editorUI.selectedViewportNode).toBe(desktop);
  });
});

describe('setSelection (marquee)', () => {
  it('first node is the primary, the frame becomes the context', () => {
    const { editorUI, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(main);
    expect(editorUI.selectedViewportNode).toBe(desktop);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id, image.id]);
    expect(editorUI.isSelected(image.id)).toBe(true);
  });

  it('never keeps a parent together with its child, and drops duplicates', () => {
    const { editorUI, main, nested, image, desktop } = setup();
    editorUI.setSelection([nested, main, image, main], desktop.breakpointId);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id, image.id]);
  });

  it('an empty result clears the selection', () => {
    const { editorUI, main, desktop } = setup();
    editorUI.selectComponent(main, desktop.breakpointId);
    editorUI.setSelection([], desktop.breakpointId);
    expect(editorUI.selectedComponent).toBeUndefined();
    expect(editorUI.selectedViewportNode).toBeUndefined();
    expect(editorUI.selectedComponentList).toEqual([]);
  });

  it('a tree node leads over a floating element, so the frame context holds', () => {
    const { editorUI, main, floating, desktop } = setup();
    editorUI.setSelection([floating[0], main], desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(main);
    expect(editorUI.selectedViewportNode).toBe(desktop);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id, floating[0].id]);
  });

  it('floating elements only: no frame context', () => {
    const { editorUI, floating } = setup();
    editorUI.setSelection([floating[0], floating[1]]);
    expect(editorUI.selectedComponent).toBe(floating[0]);
    expect(editorUI.selectedViewportNode).toBeUndefined();
    expect(editorUI.selectedComponentList).toHaveLength(2);
  });
});

describe('toggleInSelection (Shift+click)', () => {
  it('on an empty selection it selects the node', () => {
    const { editorUI, main, desktop } = setup();
    editorUI.clearSelection();
    editorUI.toggleInSelection(main, desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(main);
    expect(editorUI.selectedViewportNode).toBe(desktop);
  });

  it('adds a node and keeps the primary where it was', () => {
    const { editorUI, main, image, desktop } = setup();
    editorUI.selectComponent(main, desktop.breakpointId);
    editorUI.toggleInSelection(image, desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(main);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id, image.id]);
  });

  it('removes a selected node again', () => {
    const { editorUI, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    editorUI.toggleInSelection(image, desktop.breakpointId);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id]);
  });

  it('removing the primary promotes the next node and keeps the frame', () => {
    const { editorUI, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    editorUI.toggleInSelection(main, desktop.breakpointId);
    expect(editorUI.selectedComponent).toBe(image);
    expect(editorUI.selectedViewportNode).toBe(desktop);
    expect(ids(editorUI.selectedComponentList)).toEqual([image.id]);
  });

  it('removing the last node clears everything', () => {
    const { editorUI, main, desktop } = setup();
    editorUI.selectComponent(main, desktop.breakpointId);
    editorUI.toggleInSelection(main, desktop.breakpointId);
    expect(editorUI.selectedComponent).toBeUndefined();
    expect(editorUI.selectedViewportNode).toBeUndefined();
    expect(editorUI.selectedComponentList).toEqual([]);
  });

  it('adding a child replaces its selected parent (and the other way round)', () => {
    const { editorUI, main, image, nested, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    editorUI.toggleInSelection(nested, desktop.breakpointId);
    expect(ids(editorUI.selectedComponentList)).toEqual([image.id, nested.id]);

    editorUI.toggleInSelection(main, desktop.breakpointId);
    expect(ids(editorUI.selectedComponentList)).toEqual([image.id, main.id]);
  });
});

describe('clearSelection and lifecycle', () => {
  it('clears component, extra nodes and frame', () => {
    const { editorUI, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    editorUI.clearSelection();
    expect(editorUI.selectedComponent).toBeUndefined();
    expect(editorUI.selectedViewportNode).toBeUndefined();
    expect(editorUI.selectedComponentList).toEqual([]);
    expect(editorUI.isSelected(main.id)).toBe(false);
  });

  it('a deleted node drops out of the selection by itself', () => {
    const { editorUI, page, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    page.deleteComponent(image.id);
    expect(ids(editorUI.selectedComponentList)).toEqual([main.id]);
    expect(editorUI.isSelected(image.id)).toBe(false);
  });

  it('switching project forgets the multi-selection', () => {
    const { store, editorUI, main, image, desktop } = setup();
    editorUI.setSelection([main, image], desktop.breakpointId);
    store.projectStore.createProject('Other');
    editorUI.setCurrentProject(store.projectStore.findProjectByTitle('Other'));
    expect(editorUI.selectedComponents.length).toBe(0);
  });
});

describe('deleteSelection', () => {
  it('deletes every selected node as one undo step, and undo restores them all', () => {
    const { editorUI, page, root, main, image, desktop, floating, history } = setup();
    editorUI.setSelection([main, image, floating[0]], desktop.breakpointId);
    const floatingId = floating[0].id;

    expect(deleteSelection(page, editorUI, history)).toBe(3);
    expect(root.children).toHaveLength(0);
    expect(page.findComponent(floatingId)).toBeUndefined();
    expect(history.history.length).toBe(1);
    expect(editorUI.selectedComponentList).toEqual([]);

    history.undo();
    expect(root.children).toHaveLength(2);
    expect(page.findComponent(floatingId)).toBeDefined();
  });

  it('a single node deletes as before', () => {
    const { editorUI, page, root, image, desktop, history } = setup();
    editorUI.selectComponent(image, desktop.breakpointId);
    expect(deleteSelection(page, editorUI, history)).toBe(1);
    expect(root.children).toHaveLength(1);
    expect(history.history.length).toBe(1);
  });

  it('never deletes the page root, and nothing selected deletes nothing', () => {
    const { editorUI, page, root, history } = setup();
    editorUI.selectComponent(root);
    expect(deleteSelection(page, editorUI, history)).toBe(0);
    editorUI.clearSelection();
    expect(deleteSelection(page, editorUI, history)).toBe(0);
    expect(history.history.length).toBe(0);
  });
});

describe('temporary Grab (held Space)', () => {
  it('switches to Grab and returns to the previous tool on release', () => {
    const { editorUI } = setup();
    expect(editorUI.selectedTool).toBe(EditorTool.SELECT);
    editorUI.beginTemporaryGrab();
    expect(editorUI.selectedTool).toBe(EditorTool.GRAB);
    editorUI.beginTemporaryGrab(); // key repeat
    editorUI.endTemporaryGrab();
    expect(editorUI.selectedTool).toBe(EditorTool.SELECT);
  });

  it('a release without a press changes nothing', () => {
    const { editorUI } = setup();
    editorUI.setSelectedTool(EditorTool.GRAB);
    editorUI.endTemporaryGrab();
    expect(editorUI.selectedTool).toBe(EditorTool.GRAB);
  });

  it('a tool picked while Space is held sticks after release', () => {
    const { editorUI } = setup();
    editorUI.beginTemporaryGrab();
    editorUI.setSelectedTool(EditorTool.SELECT);
    editorUI.endTemporaryGrab();
    expect(editorUI.selectedTool).toBe(EditorTool.SELECT);
    expect(editorUI.toolBeforeTemporaryGrab).toBeUndefined();
  });
});
