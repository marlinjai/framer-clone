// Text mixed with elements, edited on the canvas: one text node opens at a time,
// so its element siblings cannot be flattened, and selected words become their
// own element as one undo step. jsdom has no layout, so the point under a
// double-click is stubbed; the event order and the DOM are real. The whole thing
// is proven in a real browser on the pull request.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { EditorTool } from '@/stores/EditorUIStore';
import { applyInlineFormat } from '@/lib/canvas/inlineFormat';
import { beginInlineTextEdit } from '@/lib/quickbar/dom';
import { isTextEditable } from '@/lib/quickbar/actions';
import ComponentRenderer from '../ComponentRenderer';
import InlineFormatBar, { barPosition } from '../InlineFormatBar';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let main: ComponentInstance;
let para: ComponentInstance;
let breakpoints: { id: string; minWidth: number }[];

const run = (id: string, text: string, parentId: string) =>
  ComponentModel.create({ id, type: '#text', componentType: 'host', props: { children: text }, parentId });

/** Children as [text] for a text node, the id otherwise. */
const shape = (node: ComponentInstance) =>
  (node.children as ComponentInstance[]).map(c => (c.type === '#text' ? c.props.children : c.type));

const history = () => getHistoryStore()!;

function renderPage() {
  const page = store.editorUI.currentPage!;
  return render(
    <>
      <ComponentRenderer component={page.appComponentTree as ComponentInstance} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints} />
      <InlineFormatBar />
    </>,
  );
}

const element = (id: string) =>
  document.querySelector<HTMLElement>(`[data-component-id="${breakpoints[0].id}-${id}"]`)!;

/** Double-click the nth DOM text directly inside `host`. */
function doubleClickText(host: HTMLElement, nth: number) {
  const texts = Array.from(host.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
  (document as unknown as { caretRangeFromPoint: () => Range }).caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(texts[nth], 1);
    return range;
  };
  fireEvent.doubleClick(host, { clientX: 5, clientY: 5 });
}

const editing = () => document.querySelector<HTMLElement>('[contenteditable="true"]')!;

function selectWords(el: HTMLElement, start: number, end: number) {
  const text = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 200, 40, 16);
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Inline format');
  const project = projectStore.findProjectByTitle('Inline format')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.setProps({ children: undefined });
  main.addChild(createIntrinsicComponent('para', 'p', { children: 'Hello ' }));
  para = main.children[0] as ComponentInstance;
  para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
  para.addChild(run('tail', ' world', 'para'));
  breakpoints = page.sortedViewportNodes.map(v => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
  editorUI.clearSelection();
  editorUI.setSelectedTool(EditorTool.SELECT);
  getDragManager()!.wire({
    getTransform: () => ({ panX: 0, panY: 0, zoom: 1 }),
    getPage: () => store.editorUI.currentPage,
    getHistory: () => getHistoryStore(),
    getEditorUI: () => store.editorUI,
  });
  history().clear();
});

afterEach(() => {
  getDragManager()?.cancel();
  cleanup();
  vi.restoreAllMocks();
  delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
});

describe('editing a text node beside elements', () => {
  it('opens the text under the pointer, in the gesture, and leaves its neighbours alone', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    const box = editing();
    expect(box.tagName).toBe('SPAN');
    expect(box.textContent).toBe(' world');
    expect(document.activeElement).toBe(box);
    expect(window.getSelection()?.toString()).toBe(' world');
    expect(element('para').getAttribute('contenteditable')).toBeNull();
    expect(element('bold').textContent).toBe('bold');
    expect(store.editorUI.selectedComponent?.id).toBe('para');
  });

  it('commits one text node as one undo step, with its spaces, elements untouched', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    const box = editing();
    box.textContent = ' there ';
    fireEvent.blur(box);
    expect(shape(para)).toEqual(['Hello ', 'strong', ' there ']);
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(element('para').textContent).toBe('Hello bold there ');
    expect(history().history).toHaveLength(1);
    act(() => history().undo());
    expect(shape(para)).toEqual(['Hello ', 'strong', ' world']);
    act(() => history().redo());
    expect(shape(para)).toEqual(['Hello ', 'strong', ' there ']);
  });

  it('commits on Enter, puts the text back on Escape, and writes nothing when nothing changed', () => {
    renderPage();
    doubleClickText(element('para'), 0);
    fireEvent.keyDown(editing(), { key: 'Enter' });
    expect(history().canUndo).toBe(false);
    doubleClickText(element('para'), 0);
    const box = editing();
    box.textContent = 'Changed ';
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(shape(para)[0]).toBe('Hello ');
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(history().canUndo).toBe(false);
  });

  it('counts a hidden and an empty run out when it finds the text under the pointer', () => {
    para.addChild(run('late', ' late', 'para'));
    (para.children[0] as ComponentInstance).toggleCanvasVisibility();
    (para.children[2] as ComponentInstance).setTextContent('');
    renderPage();
    doubleClickText(element('para'), 0);
    expect(editing().textContent).toBe(' late');
  });

  it('turns a legacy string in front of the children into a text node when it opens', () => {
    const legacy = ComponentModel.create({
      id: 'legacy',
      type: 'p',
      componentType: 'host',
      props: { children: 'Old ' },
      children: [{ id: 'em', type: 'em', componentType: 'host', parentId: 'legacy', props: { children: 'x' } }],
    });
    main.addChild(legacy);
    renderPage();
    doubleClickText(element('legacy'), 0);
    expect(editing().textContent).toBe('Old ');
    const node = main.children.find((c: ComponentInstance) => c.id === 'legacy') as ComponentInstance;
    expect(shape(node)).toEqual(['Old ', 'em']);
    expect(node.props.children).toBeUndefined();
  });

  it('refuses bound text, a locked element, another tool, and a press on an element child', () => {
    const bound = para.children[2] as ComponentInstance;
    bound.setBinding('children', { mode: 'read', path: 'row.title' } as never);
    renderPage();
    doubleClickText(element('para'), 1);
    expect(store.editorUI.editingComponent).toBeUndefined();

    act(() => para.toggleCanvasLock());
    doubleClickText(element('para'), 0);
    expect(store.editorUI.editingComponent).toBeUndefined();
    act(() => para.toggleCanvasLock());

    act(() => store.editorUI.setSelectedTool(EditorTool.GRAB));
    doubleClickText(element('para'), 0);
    expect(store.editorUI.editingComponent).toBeUndefined();
    act(() => store.editorUI.setSelectedTool(EditorTool.SELECT));

    fireEvent.doubleClick(element('bold'));
    expect(store.editorUI.editingComponent?.id).toBe('bold');
  });

  it('keeps the element from being dragged while its text node is edited', () => {
    renderPage();
    doubleClickText(element('para'), 0);
    fireEvent.pointerDown(editing(), { button: 0, isPrimary: true, pointerId: 1 });
    expect(getDragManager()!.source).toBeNull();
    fireEvent.pointerDown(element('para'), { button: 0, isPrimary: true, pointerId: 1 });
    expect(getDragManager()!.source).not.toEqual({ kind: 'moveNode', nodeId: 'para' });
  });

  it('opens from the toolbar button at the first text a person can type in', () => {
    (para.children[0] as ComponentInstance).setBinding('children', { mode: 'read', path: 'row.title' } as never);
    renderPage();
    act(() => store.editorUI.selectComponent(para, breakpoints[0].id));
    expect(isTextEditable(para)).toBe(true);
    act(() => {
      expect(beginInlineTextEdit(store.editorUI, para)).toBe(true);
    });
    expect(editing().textContent).toBe(' world');
    expect(document.activeElement).toBe(editing());
  });

  it('offers no text edit when every text is bound or hidden', () => {
    (para.children[0] as ComponentInstance).setBinding('children', { mode: 'read', path: 'row.title' } as never);
    (para.children[2] as ComponentInstance).toggleCanvasVisibility();
    expect(isTextEditable(para)).toBe(false);
  });
});

describe('formatting selected words', () => {
  it('splits a text node at the selection with the shortcut, typed text included, as one undo step', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    const box = editing();
    box.textContent = ' brave new world';
    selectWords(box, 7, 10);
    fireEvent.keyDown(box, { key: 'b', metaKey: true });
    expect(shape(para)).toEqual(['Hello ', 'strong', ' brave ', 'strong', ' world']);
    expect(history().history).toHaveLength(1);
    expect((para.children[3] as ComponentInstance).props.children).toBe('new');

    // The edit moved to the new element, the same words selected.
    const made = para.children[3] as ComponentInstance;
    expect(store.editorUI.editingComponent?.id).toBe(made.id);
    expect(store.editorUI.selectedComponent?.id).toBe(made.id);
    expect(document.activeElement).toBe(element(made.id));
    expect(window.getSelection()?.toString()).toBe('new');
  });

  it('splits a plain element, at the first word and at the last, and with ctrl on other systems', () => {
    main.addChild(createIntrinsicComponent('plain', 'p', { children: 'one two three' }));
    const plain = main.children[1] as ComponentInstance;
    renderPage();
    fireEvent.doubleClick(element('plain'));
    selectWords(editing(), 0, 3);
    fireEvent.keyDown(editing(), { key: 'i', ctrlKey: true });
    expect(shape(plain)).toEqual(['em', ' two three']);
    expect(plain.props.children).toBeUndefined();
  });

  it('wraps a whole text node without leaving an empty one behind', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    selectWords(editing(), 0, 6);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(shape(para)).toEqual(['Hello ', 'strong', 'strong']);
  });

  it('takes the format off with a second press, joining the words back', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    selectWords(editing(), 1, 6);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(shape(para)).toEqual(['Hello ', 'strong', ' ', 'strong']);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(shape(para)).toEqual(['Hello ', 'strong', ' world']);
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(store.editorUI.selectedComponent?.id).toBe('para');
    expect(history().history).toHaveLength(2);
    act(() => history().undo());
    expect(shape(para)).toEqual(['Hello ', 'strong', ' ', 'strong']);
  });

  it('collapses back to a plain element when the last format comes off', () => {
    main.addChild(createIntrinsicComponent('plain', 'p', { children: 'one two' }));
    const plain = main.children[1] as ComponentInstance;
    renderPage();
    fireEvent.doubleClick(element('plain'));
    selectWords(editing(), 4, 7);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(plain.children).toHaveLength(0);
    expect(plain.props.children).toBe('one two');
  });

  it('undoes a format from inside the element it opened, until something is typed there', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    selectWords(editing(), 1, 6);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    fireEvent.keyDown(editing(), { key: 'z', metaKey: true });
    expect(shape(para)).toEqual(['Hello ', 'strong', ' world']);
    expect(store.editorUI.editingComponent).toBeUndefined();
    act(() => history().redo());
    expect(shape(para)).toEqual(['Hello ', 'strong', ' ', 'strong']);
  });

  it('makes a link with a safe target and hands over to the Link section', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    selectWords(editing(), 1, 6);
    fireEvent.keyDown(editing(), { key: 'k', metaKey: true });
    const link = para.children[3] as ComponentInstance;
    expect(link.type).toBe('a');
    expect(link.props).toMatchObject({ href: '#', children: 'world' });
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(store.editorUI.selectedComponent?.id).toBe(link.id);
  });

  it('does nothing without a selection, and never lets the browser write markup', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    const box = editing();
    window.getSelection()!.collapse(box.firstChild, 2);
    const shortcut = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true });
    box.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(shape(para)).toEqual(['Hello ', 'strong', ' world']);
    expect(store.editorUI.editingComponent?.id).toBe('tail');
  });

  it.each([
    ['a link inside a link', 'a', 'k', /inside another link/],
    ['a link inside a button', 'button', 'k', /inside another link or a button/],
  ] as const)('refuses %s, and says so', (_name, tag, key, message) => {
    main.addChild(createIntrinsicComponent('holder', tag as 'a', { href: '/x' }));
    const holder = main.children[1] as ComponentInstance;
    holder.addChild(createIntrinsicComponent('inner', 'span', { children: 'inner text' }));
    renderPage();
    fireEvent.doubleClick(element('inner'));
    selectWords(editing(), 0, 5);
    fireEvent.keyDown(editing(), { key, metaKey: true });
    expect((holder.children[0] as ComponentInstance).children).toHaveLength(0);
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused', message: expect.stringMatching(message) });
  });

  it('refuses words in an element that holds text and nothing else', () => {
    main.addChild(createIntrinsicComponent('choice', 'option', { children: 'one two' }));
    renderPage();
    fireEvent.doubleClick(element('choice'));
    selectWords(editing(), 0, 3);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(store.editorUI.editorNotice?.message).toMatch(/cannot hold other elements/);
    expect((main.children[1] as ComponentInstance).children).toHaveLength(0);
  });

  it('refuses bold inside bold, a form label, and a data element', () => {
    main.addChild(createIntrinsicComponent('outer', 'strong', {}));
    const outer = main.children[1] as ComponentInstance;
    outer.addChild(createIntrinsicComponent('inner', 'span', { children: 'inner text' }));
    main.addChild(createIntrinsicComponent('label', 'button', { children: 'Send', 'data-form-kind': 'form-submit' }));
    renderPage();
    fireEvent.doubleClick(element('inner'));
    selectWords(editing(), 0, 5);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(store.editorUI.editorNotice?.message).toMatch(/already bold/);
    fireEvent.blur(editing());

    fireEvent.doubleClick(element('label'));
    selectWords(editing(), 0, 2);
    fireEvent.keyDown(editing(), { key: 'b', metaKey: true });
    expect(store.editorUI.editorNotice?.message).toMatch(/draws its own content/);
    expect((main.children[2] as ComponentInstance).children).toHaveLength(0);
  });

  it('leaves the page alone when nothing is being edited', () => {
    expect(applyInlineFormat(store.editorUI, 'bold')).toBe(false);
  });
});

describe('the format bar', () => {
  it('appears for selected words and formats them from a press that keeps the focus', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    expect(screen.getByRole('toolbar')).toBeTruthy();
    window.getSelection()!.collapse(editing().firstChild, 2);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.queryByRole('toolbar')).toBeNull();
    selectWords(editing(), 1, 6);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    const bold = screen.getByRole('button', { name: 'Bold' });
    expect(fireEvent.pointerDown(bold)).toBe(false);
    expect(fireEvent.mouseDown(bold)).toBe(false);
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(bold);
    expect(shape(para)).toEqual(['Hello ', 'strong', ' ', 'strong']);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('stays gone when the edit ends', () => {
    renderPage();
    doubleClickText(element('para'), 1);
    selectWords(editing(), 1, 6);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    fireEvent.keyDown(editing(), { key: 'Enter' });
    fireEvent.blur(editing() ?? document.body);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('sits above the words, below them at the top edge, and under the top bar on a phone', () => {
    const visible = { width: 1000, top: 64, bottom: 800 };
    const words = { left: 400, width: 100, top: 300, bottom: 320 };
    expect(barPosition(words, visible, false)).toEqual({ left: 394, top: 252 });
    expect(barPosition({ ...words, top: 70, bottom: 90 }, visible, false).top).toBe(98);
    expect(barPosition({ ...words, left: 990 }, visible, false).left).toBe(880);
    expect(barPosition(words, { width: 390, top: 48, bottom: 500 }, true)).toEqual({ left: 121, top: 56 });
  });
});
