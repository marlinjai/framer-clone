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
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { holdsText } from '@/lib/renderer/textContent';
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
