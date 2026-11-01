// The Text field at the top of the properties panel: the dependable way to
// change an element's text on a phone (a form field always opens the
// keyboard). One committed edit is one undo step; bound text shows the
// binding instead of a field.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render as rtlRender, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { holdsText, textRunLabel } from '@/lib/renderer/textContent';
import { TextContentSection } from '../sections/TextContentSection';
import { DataSourceSection } from '../sections/DataSourceSection';

let store: RootStoreType;

/** Render inside a data source (the bind button and binding chip read it). */
function render(ui: React.ReactElement) {
  const provider = new InMemoryDataSourceProvider({ collections: [], rows: {} });
  const wrap = (node: React.ReactElement) => (
    <DataSourceProviderContext.Provider value={provider}>{node}</DataSourceProviderContext.Provider>
  );
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(wrap(next)) };
}

/** A project whose page holds a paragraph, a heading and a container, under history. */
function seed() {
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Text field');
  const project = projectStore.findProjectByTitle('Text field')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
  const main = root.children[0] as ComponentInstance;
  main.setProps({ children: undefined }); // the seed's text would become a leading text node
  main.addChildren([
    createIntrinsicComponent('text-para', 'p', { children: 'Hello' }),
    createIntrinsicComponent('heading-1', 'h1', { children: 'Title' }),
  ]);
  const para = main.children.find((c: ComponentInstance) => c.id === 'text-para') as ComponentInstance;
  const heading = main.children.find((c: ComponentInstance) => c.id === 'heading-1') as ComponentInstance;
  getHistoryStore()!.clear();
  return { main, para, heading };
}

afterEach(() => cleanup());

const field = () => screen.getByRole('textbox', { name: 'Text content' }) as HTMLTextAreaElement;

describe('TextContentSection', () => {
  it('shows only for elements that hold their own text', () => {
    const { main, para, heading } = seed();
    expect(holdsText(para)).toBe(true);
    expect(holdsText(heading)).toBe(true);
    expect(holdsText(main)).toBe(false);
    const { rerender } = render(<TextContentSection component={main} />);
    expect(screen.queryByTestId('text-content-section')).toBeNull();
    rerender(<TextContentSection component={heading} />);
    expect(field().value).toBe('Title');
  });

  it('typing changes nothing until the edit is committed; the commit is one undo step', () => {
    const { heading } = seed();
    render(<TextContentSection component={heading} />);
    const history = getHistoryStore()!;
    const undoBefore = history.canUndo;
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'T' } });
    fireEvent.change(field(), { target: { value: 'Th' } });
    fireEvent.change(field(), { target: { value: 'The new title' } });
    expect(heading.props.children).toBe('Title');
    fireEvent.blur(field());
    expect(heading.props.children).toBe('The new title');
    expect(history.canUndo).toBe(true);
    act(() => history.undo());
    expect(heading.props.children).toBe('Title');
    // The field follows the undo, and one undo was the whole edit.
    expect(field().value).toBe('Title');
    expect(history.canUndo).toBe(undoBefore);
  });

  it('Enter commits, Escape puts the text back', () => {
    const { heading } = seed();
    render(<TextContentSection component={heading} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'Typed' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(heading.props.children).toBe('Typed');
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'Discarded' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('Typed');
    fireEvent.blur(field());
    expect(heading.props.children).toBe('Typed');
  });

  it('a draft still open when the selection moves lands on the element it was typed for', () => {
    const { heading, para } = seed();
    const { rerender } = render(<TextContentSection component={heading} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'For the heading' } });
    rerender(<TextContentSection component={para} />);
    expect(heading.props.children).toBe('For the heading');
    expect(para.props.children).toBe('Hello');
    expect(field().value).toBe('Hello');
  });

  it('follows text changed elsewhere (inline editing) while not focused', () => {
    const { heading } = seed();
    render(<TextContentSection component={heading} />);
    act(() => heading.setTextContent('From the canvas'));
    expect(field().value).toBe('From the canvas');
  });

  it('bound text shows the binding, not an editable field', () => {
    const { para } = seed();
    para.setBinding('children', { mode: 'read', expression: '{{page.params.slug}}' });
    render(<TextContentSection component={para} />);
    expect(screen.queryByRole('textbox', { name: 'Text content' })).toBeNull();
    expect(screen.getByText('{{page.params.slug}}')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Unbind/ })).toBeTruthy();
  });

  it('a bindable text offers the bind button next to the field', () => {
    const { para } = seed();
    render(<TextContentSection component={para} />);
    expect(field().value).toBe('Hello');
    expect(screen.getByRole('button', { name: /^Bind / })).toBeTruthy();
  });

  it('the Data section does not repeat the text field of a text element', () => {
    const { para } = seed();
    render(<DataSourceSection component={para} />);
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull();
  });
});

describe('TextContentSection on mixed text', () => {
  const fields = () => screen.getAllByRole('textbox') as HTMLTextAreaElement[];

  /** The paragraph, split by a strong element, plus a closing text node. */
  function mixed() {
    const { para } = seed();
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'bold' }));
    para.addChild(ComponentModel.create({ id: 'tail', type: '#text', componentType: 'host', props: { children: ' world' }, parentId: para.id }));
    getHistoryStore()!.clear();
    return { para };
  }

  it('lists one field per text node, in page order, and none for the element child', () => {
    const { para } = mixed();
    render(<TextContentSection component={para} />);
    expect(fields().map(f => f.value)).toEqual(['Hello', ' world']);
    expect(screen.getByRole('textbox', { name: '"Hello" before "bold"' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '"world" after "bold"' })).toBeTruthy();
    // Visible too: the two fields are told apart by reading them.
    expect(screen.getByText('"Hello" before "bold"')).toBeTruthy();
  });

  it('names a run between two elements, an empty run, a bound run and a hidden run', () => {
    const { para } = seed();
    para.addChild(createIntrinsicComponent('bold', 'strong', { children: 'a very long element text that keeps going' }));
    para.addChild(ComponentModel.create({ id: 'gap', type: '#text', componentType: 'host', props: { children: '' }, parentId: para.id }));
    para.addChild(createIntrinsicComponent('pic', 'img', { alt: '' }));
    para.addChild(ComponentModel.create({ id: 'tail', type: '#text', componentType: 'host', props: { children: 'one two three four five six seven' }, parentId: para.id }));
    const tail = para.children[para.children.length - 1] as ComponentInstance;
    tail.toggleCanvasVisibility();
    para.addChild(ComponentModel.create({ id: 'bound', type: '#text', componentType: 'host', props: {}, bindings: { children: { mode: 'read', path: 'row.title' } }, parentId: para.id }));
    const [lead, , gap, , , bound] = para.children as ComponentInstance[];
    expect(textRunLabel(para, lead)).toBe('"Hello" before "a very long element..."');
    expect(textRunLabel(para, gap)).toBe('Empty text between "a very long element..." and Image');
    expect(textRunLabel(para, tail)).toBe('"one two three four five..." after Image, hidden');
    expect(textRunLabel(para, bound)).toBe('Text from data after Image');
  });

  it('edits one text node as one undo step, leaving the element child and spaces alone', () => {
    const { para } = mixed();
    render(<TextContentSection component={para} />);
    const second = screen.getByRole('textbox', { name: '"world" after "bold"' });
    fireEvent.focus(second);
    fireEvent.change(second, { target: { value: ' there ' } });
    fireEvent.blur(second);
    expect((para.children as ComponentInstance[]).map(c => c.props.children)).toEqual(['Hello', 'bold', ' there ']);
    expect(para.children[1].id).toBe('bold');
    act(() => getHistoryStore()!.undo());
    expect(para.children[2].props.children).toBe(' world');
  });

  it('keeps a text node that is emptied, as a layer that can still be typed into', () => {
    const { para } = mixed();
    render(<TextContentSection component={para} />);
    const first = screen.getByRole('textbox', { name: '"Hello" before "bold"' });
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: '' } });
    fireEvent.blur(first);
    expect(para.children).toHaveLength(3);
    expect(para.children[0].props.children).toBe('');
  });

  it('shows a numeric text node and a legacy string, so old rows stay editable', () => {
    const legacy = ComponentModel.create({
      id: 'legacy',
      type: 'p',
      componentType: 'host',
      props: { children: 'Old ' },
      children: [
        { id: 'run', type: '#text', componentType: 'host', parentId: 'legacy', props: { children: 7 } },
        { id: 'el', type: 'em', componentType: 'host', parentId: 'legacy' },
      ],
    });
    render(<TextContentSection component={legacy} />);
    expect(fields().map(f => f.value)).toEqual(['Old ', '7']);
    const first = screen.getByRole('textbox', { name: '"Old" before Em' });
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: 'New ' } });
    fireEvent.blur(first);
    expect(legacy.props.children).toBe('New ');
    expect(legacy.children).toHaveLength(2);
  });

  it('shows a text node bound to data as the binding', () => {
    const { para } = mixed();
    (para.children[0] as ComponentInstance).setBinding('children', { mode: 'read', expression: '{{row.title}}' });
    render(<TextContentSection component={para} />);
    expect(screen.getByText('The text comes from data. Unlink it to type your own.')).toBeTruthy();
    expect(fields().map(f => f.value)).toEqual([' world']);
  });
});
