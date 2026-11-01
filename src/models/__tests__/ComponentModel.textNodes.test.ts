// Every way a tree changes around text: a child arriving at a text holder, a
// node leaving a mixed element, duplication, undo, selection, and the targets a
// text node must refuse (each refused before anything is detached).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { holdsText, textNodesOf } from '@/lib/renderer/textContent';
import { canHoldChildren, tapInsertTarget } from '@/lib/layers/tapInsertTarget';
import { deleteLayer, duplicateLayer } from '@/lib/layers/layerActions';

let store: RootStoreType;
let page: PageModelType;
let main: ComponentInstance;
let para: ComponentInstance;

const textChild = (id: string, value: unknown, parentId: string) =>
  ComponentModel.create({ id, type: '#text', componentType: 'host', props: { children: value }, parentId });

const shape = (node: ComponentInstance): unknown =>
  (node.children as ComponentInstance[]).map(c => (c.type === '#text' ? c.props.children : c.id));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Text nodes');
  const project = projectStore.findProjectByTitle('Text nodes')!;
  page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
  main = root.children[0] as ComponentInstance;
  main.addChild(createIntrinsicComponent('para', 'p', { children: 'Hello ', className: 'lead' }));
  para = main.children.find((c: ComponentInstance) => c.id === 'para') as ComponentInstance;
  getHistoryStore()!.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('a child arriving at a text holder', () => {
  it('turns the text into a leading text node, keeping the space and other props', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
    expect(shape(para)).toEqual(['Hello ', 'bold']);
    expect(para.props).toEqual({ className: 'lead' });
    expect(para.children[0].parentId).toBe('para');
  });

  it('keeps the text in front of an explicit index', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}), 0);
    expect(shape(para)).toEqual(['Hello ', 'bold']);
  });

  it('shifts a sibling index on a legacy row by the text it adds', () => {
    const legacy = ComponentModel.create({
      id: 'legacy',
      type: 'p',
      componentType: 'host',
      props: { children: 'Old ' },
      children: [{ id: 'one', type: 'em', componentType: 'host', parentId: 'legacy' }, { id: 'two', type: 'em', componentType: 'host', parentId: 'legacy' }],
    });
    legacy.addChild(createIntrinsicComponent('mid', 'em', {}), 1);
    expect(shape(legacy)).toEqual(['Old ', 'one', 'mid', 'two']);
  });

  it('moves a number and a text binding with it', () => {
    const price = createIntrinsicComponent('price', 'p', { children: 0 });
    price.addChild(createIntrinsicComponent('b', 'b', {}));
    expect(shape(price)).toEqual([0, 'b']);

    const binding = { mode: 'read', expression: '{{row.title}}' } as const;
    const bound = createIntrinsicComponent('bound', 'p', {});
    bound.setBinding('children', binding);
    bound.addChildren([createIntrinsicComponent('c', 'b', {})]);
    expect(bound.getBinding('children')).toBeUndefined();
    expect(bound.children[0].type).toBe('#text');
    expect(bound.children[0].getBinding('children')).toEqual(binding);
  });

  it('adds no text node to an element without text', () => {
    const box = createIntrinsicComponent('box', 'div', { children: '' });
    box.addChild(createIntrinsicComponent('c', 'p', {}));
    expect(shape(box)).toEqual(['c']);
  });

  it('leaves the label of a form submit button in its props', () => {
    const submit = createIntrinsicComponent('send', 'button', { 'data-form-kind': 'form-submit', children: 'Send' });
    submit.addChild(createIntrinsicComponent('c', 'span', {}));
    expect(submit.props.children).toBe('Send');
    expect(shape(submit)).toEqual(['c']);
  });

  it('covers an insert from the component list and a move', () => {
    page.insertRegistryComponent('text', { kind: 'parent', parentId: 'para' });
    expect((shape(para) as unknown[])[0]).toBe('Hello ');
    expect(para.children).toHaveLength(2);

    const box = page.insertRegistryComponent('container', { kind: 'parent', parentId: main.id })!;
    box.setTextContent('Boxed text');
    const moved = page.moveTreeComponent('para', { kind: 'parent', parentId: box.id });
    expect(moved).toBeDefined();
    expect(box.children[0].type).toBe('#text');
    expect(box.children[0].props.children).toBe('Boxed text');
    expect(box.children[1].id).toBe('para');
  });

  it('is one undo step that restores the plain text', () => {
    const before = getSnapshot(para);
    page.insertRegistryComponent('text', { kind: 'parent', parentId: 'para' });
    expect(para.children).toHaveLength(2);
    getHistoryStore()!.undo();
    expect(getSnapshot(para)).toEqual(before);
    getHistoryStore()!.redo();
    expect(para.children).toHaveLength(2);
    expect(para.children[0].props.children).toBe('Hello ');
  });
});

describe('a node leaving a mixed element', () => {
  it('collapses back to a plain text element after a delete, as one undo step', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
    getHistoryStore()!.clear();
    page.deleteComponent('bold');
    expect(para.props.children).toBe('Hello ');
    expect(para.children).toHaveLength(0);
    getHistoryStore()!.undo();
    expect(shape(para)).toEqual(['Hello ', 'bold']);
    expect(para.props.children).toBeUndefined();
  });

  it('collapses after a move out, and a binding goes back too', () => {
    const binding = { mode: 'read', expression: '{{row.title}}' } as const;
    para.setBinding('children', binding);
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    page.moveTreeComponent('bold', { kind: 'parent', parentId: main.id });
    expect(para.children).toHaveLength(0);
    expect(para.getBinding('children')).toEqual(binding);
  });

  it('keeps order when an element is reordered around the text in the same parent', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    const run = para.children[0] as ComponentInstance;
    page.moveTreeComponent('bold', { kind: 'sibling', siblingId: run.id, position: 'before' });
    expect(shape(para)).toEqual(['bold', 'Hello ']);
    expect(para.children[1].id).toBe(run.id);
  });

  it('keeps a mixed element with two text nodes, and a hidden text node as a layer', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    para.addChild(textChild('tail', ' world', 'para'));
    page.deleteComponent('bold');
    expect(shape(para)).toEqual(['Hello ', ' world']);

    const box = createIntrinsicComponent('box', 'div', {});
    box.addChildren([textChild('hidden', 'x', 'box')]);
    (box.children[0] as ComponentInstance).toggleCanvasVisibility();
    box.collapseTextChild();
    expect(box.children).toHaveLength(1);
  });

  it('deletes a text node from its Layers row', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    deleteLayer(page, store.editorUI, getHistoryStore(), para.children[0] as ComponentInstance);
    expect(para.props.children).toBeUndefined();
    expect(shape(para)).toEqual(['bold']);
  });
});

describe('copying and saving', () => {
  it('duplicates text nodes with fresh ids and parents, in order', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
    para.addChild(textChild('tail', ' world', 'para'));
    const copy = page.duplicateComponent('para') as ComponentInstance;
    expect(String(shape(copy))).toContain('Hello ');
    expect((copy.children as ComponentInstance[]).map(c => c.type)).toEqual(['#text', 'strong', '#text']);
    for (const child of copy.children as ComponentInstance[]) {
      expect(child.parentId).toBe(copy.id);
      expect(['tail', 'bold', para.children[0].id]).not.toContain(child.id);
    }
  });

  it('duplicates one text node from its row, and the selection lands on the element', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    duplicateLayer(page, store.editorUI, getHistoryStore(), para.children[0] as ComponentInstance);
    expect(shape(para)).toEqual(['Hello ', 'Hello ', 'bold']);
    expect(store.editorUI.selectedComponent?.id).toBe('para');
  });

  it('survives a save and load unchanged', () => {
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
    para.addChild(textChild('tail', ' world', 'para'));
    const saved = JSON.parse(JSON.stringify(getSnapshot(para)));
    const loaded = ComponentModel.create(saved);
    expect(getSnapshot(loaded)).toEqual(saved);
  });
});

describe('words becoming their own element', () => {
  const bold = { tag: 'strong', label: 'Bold' };
  const history = () => getHistoryStore()!;

  it('splits a plain element into text, element, text, as one undo step that also holds the typing', () => {
    const made = para.wrapTextRange('para', 'Hello big world', 6, 9, bold)!;
    expect(shape(para)).toEqual(['Hello ', made.id, ' world']);
    expect(made).toMatchObject({ type: 'strong', label: 'Bold', parentId: 'para' });
    expect(made.props.children).toBe('big');
    expect(para.props.children).toBeUndefined();
    expect(para.props.className).toBe('lead');
    expect(history().history).toHaveLength(1);

    history().undo();
    expect(para.children).toHaveLength(0);
    expect(para.props.children).toBe('Hello ');
    history().redo();
    expect(shape(para)).toEqual(['Hello ', made.id, ' world']);
  });

  it('splits one text node and leaves everything around it where it is', () => {
    para.addChild(createIntrinsicComponent('kid', 'em', { children: 'x' }));
    para.addChild(textChild('tail', ' one two', 'para'));
    const made = para.wrapTextRange('tail', ' one two', 1, 4, bold)!;
    expect(shape(para)).toEqual(['Hello ', 'kid', ' ', made.id, ' two']);
  });

  it('leaves no empty text node at either end, or when every word is taken', () => {
    para.addChild(createIntrinsicComponent('kid', 'em', {}));
    para.addChild(textChild('tail', 'one two', 'para'));
    const first = para.wrapTextRange('tail', 'one two', 0, 3, bold)!;
    expect(shape(para)).toEqual(['Hello ', 'kid', first.id, ' two']);
    const lead = para.children[0].id;
    const second = para.wrapTextRange(lead, 'Hello ', 0, 6, bold)!;
    expect(shape(para)).toEqual([second.id, 'kid', first.id, ' two']);
  });

  it('refuses without a change: bound text, a range that does not fit, an unknown run, a data element', () => {
    para.addChild(createIntrinsicComponent('kid', 'em', {}));
    para.addChild(textChild('tail', 'one two', 'para'));
    const before = getSnapshot(para);
    (para.children[2] as ComponentInstance).setBinding('children', { mode: 'read', path: 'row.title' } as never);
    history().clear();
    expect(para.wrapTextRange('tail', 'one two', 0, 3, bold)).toBeUndefined();
    expect(para.wrapTextRange(para.children[0].id, 'Hello ', 4, 4, bold)).toBeUndefined();
    expect(para.wrapTextRange(para.children[0].id, 'Hello ', 2, 99, bold)).toBeUndefined();
    expect(para.wrapTextRange('kid', 'x', 0, 1, bold)).toBeUndefined();
    expect(para.wrapTextRange('nothing', 'x', 0, 1, bold)).toBeUndefined();
    expect(history().canUndo).toBe(false);
    expect((getSnapshot(para) as { children: unknown[] }).children).toHaveLength((before as { children: unknown[] }).children.length);

    const island = createIntrinsicComponent('island', 'div', { children: 'x', 'data-component-kind': 'collection' });
    main.addChild(island);
    const live = main.children.find((c: ComponentInstance) => c.id === 'island') as ComponentInstance;
    expect(live.wrapTextRange('island', 'x', 0, 1, bold)).toBeUndefined();
    const boundOwn = createIntrinsicComponent('own', 'p', { children: 'x' });
    main.addChild(boundOwn);
    const liveOwn = main.children.find((c: ComponentInstance) => c.id === 'own') as ComponentInstance;
    liveOwn.setBinding('children', { mode: 'read', path: 'row.title' } as never);
    expect(liveOwn.wrapTextRange('own', 'x', 0, 1, bold)).toBeUndefined();
  });

  it('gives words back joined to the text on both sides, and collapses to a plain element', () => {
    const made = para.wrapTextRange('para', 'one two three', 4, 7, bold)!;
    history().clear();
    para.unwrapChild(made.id, 'TWO');
    expect(para.children).toHaveLength(0);
    expect(para.props.children).toBe('one TWO three');
    expect(history().history).toHaveLength(1);
    history().undo();
    expect(shape(para)).toEqual(['one ', made.id, ' three']);
  });

  it('gives words back as a text node between elements, and leaves bound and hidden text whole', () => {
    para.setProps({ children: undefined });
    para.addChild(createIntrinsicComponent('a1', 'em', {}));
    para.addChild(createIntrinsicComponent('mid', 'strong', { children: 'x' }));
    para.addChild(createIntrinsicComponent('a2', 'em', {}));
    para.unwrapChild('mid', 'x');
    expect(shape(para)).toEqual(['a1', 'x', 'a2']);

    para.addChild(textChild('hidden', 'h', 'para'));
    (para.children[3] as ComponentInstance).toggleCanvasVisibility();
    para.addChild(createIntrinsicComponent('mid2', 'strong', { children: 'y' }));
    para.addChild(textChild('bound', 'b', 'para'));
    (para.children[5] as ComponentInstance).setBinding('children', { mode: 'read', path: 'row.title' } as never);
    para.unwrapChild('mid2', 'y');
    expect(shape(para)).toEqual(['a1', 'x', 'a2', 'h', 'y', 'b']);
    para.unwrapChild('nothing', 'z');
    expect(para.children).toHaveLength(6);
  });

  it('turns a legacy string into a leading text node, and leaves a plain element alone', () => {
    para.adoptOwnText();
    expect(para.children).toHaveLength(0);
    const legacy = ComponentModel.create({
      id: 'legacy',
      type: 'p',
      componentType: 'host',
      props: { children: 'Old ' },
      children: [{ id: 'em', type: 'em', componentType: 'host', parentId: 'legacy' }],
    });
    legacy.adoptOwnText();
    expect(shape(legacy)).toEqual(['Old ', 'em']);
  });
});

describe('what a text node refuses', () => {
  let run: ComponentInstance;

  beforeEach(() => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    run = para.children[0] as ComponentInstance;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('holds no child, however one is offered', () => {
    run.addChild(createIntrinsicComponent('x', 'em', {}));
    run.addChildren([createIntrinsicComponent('y', 'em', {})]);
    expect(run.children).toHaveLength(0);
    expect(page.insertRegistryComponent('text', { kind: 'parent', parentId: run.id })).toBeUndefined();
    expect(run.children).toHaveLength(0);
  });

  it('keeps a moved node where it was when the target is a text node', () => {
    expect(page.moveTreeComponent('bold', { kind: 'parent', parentId: run.id })).toBeUndefined();
    expect(para.children.map((c: ComponentInstance) => c.id)).toContain('bold');
  });

  it('stays inside an element: no floating text', () => {
    expect(page.moveTreeComponent(run.id, { kind: 'floating', x: 10, y: 10 })).toBeUndefined();
    expect(para.children[0].id).toBe(run.id);
  });

  it('moves to another element, and between siblings', () => {
    expect(page.moveTreeComponent(run.id, { kind: 'parent', parentId: main.id })).toBeDefined();
    expect(run.parentId).toBe(main.id);
  });

  it.each(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'select', 'optgroup'] as const)(
    'stays out of <%s>, where a browser would move it, and says why',
    (tag) => {
      const holder = createIntrinsicComponent('holder', tag, {});
      main.addChild(holder);
      const cell = createIntrinsicComponent('cell', 'td', {});
      holder.addChild(cell);
      const target = { kind: 'parent', parentId: 'holder' } as const;
      expect(page.dropRefusal(run.id, target)).toMatch(/move it out of place/);
      expect(page.dropRefusal(run.id, { kind: 'sibling', siblingId: 'cell', position: 'before' })).toMatch(/move it out of place/);
      expect(page.moveTreeComponent(run.id, target)).toBeUndefined();
      expect(page.moveTreeComponent(run.id, { kind: 'sibling', siblingId: 'cell', position: 'after' })).toBeUndefined();
      expect(para.children[0].id).toBe(run.id);
      holder.addChild(textChild('direct', 'x', 'holder'));
      holder.addChildren([textChild('direct-2', 'x', 'holder')]);
      expect(holder.children.map((c: ComponentInstance) => c.id)).toEqual(['cell']);
    },
  );

  it('moves freely inside a table cell, and an element still moves into a table row', () => {
    const row = createIntrinsicComponent('row', 'tr', {});
    const cell = createIntrinsicComponent('cell', 'td', {});
    main.addChild(row);
    row.addChild(cell);
    expect(page.dropRefusal(run.id, { kind: 'parent', parentId: 'cell' })).toBeUndefined();
    expect(page.dropRefusal('bold', { kind: 'parent', parentId: 'row' })).toBeUndefined();
    expect(page.moveTreeComponent(run.id, { kind: 'parent', parentId: 'cell' })).toBeDefined();
    expect(run.parentId).toBe('cell');
  });

  it('gives a reason for the two other refusals, and none for a node that is gone', () => {
    expect(page.dropRefusal(run.id, { kind: 'floating', x: 1, y: 1 })).toMatch(/inside an element/);
    expect(page.dropRefusal('bold', { kind: 'parent', parentId: run.id })).toMatch(/cannot hold/);
    expect(page.dropRefusal('nothing', { kind: 'appTree' })).toBeUndefined();
  });

  it('takes no generated nodes', () => {
    const out = page.applyGeneratedNodes('insert', run.id, [{ id: 'g', type: 'p', componentType: 'host' }], 'gen');
    expect(out.ok).toBe(false);
  });
});

describe('selecting and reading text nodes', () => {
  let run: ComponentInstance;

  beforeEach(() => {
    para.addChild(createIntrinsicComponent('bold', 'strong', {}));
    run = para.children[0] as ComponentInstance;
  });

  it('selects the element a text node sits in, by click, shift+click and group', () => {
    const ui = store.editorUI;
    ui.selectComponent(run);
    expect(ui.selectedComponent?.id).toBe('para');

    ui.clearSelection();
    ui.toggleInSelection(run);
    expect(ui.selectedComponent?.id).toBe('para');

    const tail = textChild('tail', ' x', 'para');
    para.addChild(tail);
    ui.setSelection([run, para.children[2] as ComponentInstance]);
    expect(ui.selectedComponentList.map((c: ComponentInstance) => c.id)).toEqual(['para']);
  });

  it('reads as its text in the Layers panel', () => {
    expect(run.displayName).toBe('Hello');
    run.setTextContent('   ');
    expect(run.displayName).toBe('Text');
    run.setTextContent('x'.repeat(60));
    expect(run.displayName).toBe(`${'x'.repeat(40)}...`);
    run.setProps({ children: 12 });
    expect(run.displayName).toBe('12');
    expect(createIntrinsicComponent('labelled', 'p', {}).displayName).toBe('Paragraph');
  });

  it('lists an element\'s text in page order, a legacy string first', () => {
    expect(textNodesOf(para).map(n => n.props.children)).toEqual(['Hello ']);
    expect(holdsText(para)).toBe(false);
    const legacy = ComponentModel.create({
      id: 'legacy',
      type: 'p',
      componentType: 'host',
      props: { children: 'Old ' },
      children: [{ id: 'run', type: '#text', componentType: 'host', parentId: 'legacy', props: { children: 'new' } }],
    });
    expect(holdsText(legacy)).toBe(true);
    expect(textNodesOf(legacy).map((n: ComponentInstance) => n.props.children)).toEqual(['Old ', 'new']);
  });

  it('leaves a tap insert inside a mixed element, after its children', () => {
    expect(canHoldChildren(para)).toBe(true);
    expect(tapInsertTarget(para)).toEqual({ kind: 'parent', parentId: 'para' });
  });
});
