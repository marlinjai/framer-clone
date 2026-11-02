// The switch's `+`: a raw field for what no control names, and each custom rule as a
// row of the switch, edited with the normal sections.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { storedRulesOf } from '@/lib/rules/rules';
import RightSidebar from '../../RightSidebar';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let box: ComponentInstance;
let main: ComponentInstance;
let desktop: string;

function mountPanel() {
  return render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
}

// By attribute: a role query walks the Custom section's hundreds of suggestions on every call.
const radios = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="radio"]'));
const radio = (name: string | RegExp) => {
  const found = radios().find((el) => (typeof name === 'string' ? el.textContent === name : name.test(el.textContent ?? '')));
  if (!found) throw new Error(`no radio ${name}`);
  return found;
};
const hasRadio = (name: RegExp) => radios().some((el) => name.test(el.textContent ?? ''));
const button = (name: string) => {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>('button')).find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const hasButton = (name: string) => Array.from(document.body.querySelectorAll('button')).some((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === name);
const alertText = () => document.body.querySelector('[role="alert"]')?.textContent ?? '';

const open = () => fireEvent.click(button('Add a custom rule'));
const field = () => screen.getByLabelText('Selector or CSS rule');

function add(text: string) {
  open();
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.keyDown(field(), { key: 'Enter' });
}

const rules = (node: ComponentInstance = box) => storedRulesOf(node.props);
const notes = () => screen.queryAllByTestId('rule-note').map((note) => note.textContent);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Custom');
  const project = projectStore.findProjectByTitle('Custom')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(project);
  desktop = page.sortedViewportNodes[0].breakpointId!;
  main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.addChildren([createIntrinsicComponent('probe', 'div', { style: { color: '#111111' } })]);
  box = main.children.find((child: ComponentInstance) => child.id === 'probe') as ComponentInstance;
  editorUI.selectComponent(box, desktop);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adding a rule', () => {
  it('stores a selector, closes the field and picks the rule', () => {
    mountPanel();
    add(':nth-child(2n)');
    expect(rules()).toMatchObject([{ selector: '&:nth-child(2n)', style: {} }]);
    expect(screen.queryByLabelText('Selector or CSS rule')).toBeNull();
    expect(store.editorUI.activeRule).toBe(rules()[0].id);
    expect(radio('&:nth-child(2n)').getAttribute('aria-checked')).toBe('true');
  });

  it('stores nothing and says why when the text is refused, keeping what was typed', () => {
    mountPanel();
    add('& + p');
    expect(rules()).toEqual([]);
    expect(alertText()).toContain('& + p');
    expect(field()).toHaveProperty('value', '& + p');
  });

  it('shows why :root stands nowhere but on the page root, and stores nothing', () => {
    mountPanel();
    add(':root { color: red }');
    expect(alertText()).toBe(':root: only the root of a page can hold a rule on :root.');
    expect(rules()).toEqual([]);
  });

  it('takes :root on the page root, and shows it as a working rule', () => {
    const root = store.editorUI.currentPage!.appComponentTree as ComponentInstance;
    store.editorUI.selectComponent(root, desktop);
    mountPanel();
    add(':root { scroll-behavior: smooth }');
    expect(alertText()).toBe('');
    expect(rules(root).map((rule) => ('selector' in rule ? rule.selector : ''))).toEqual([':root']);
    expect(document.body.querySelector('.bg-destructive')).toBeNull();
  });

  it('refuses a property the document does not take before it writes, and shows the reason', () => {
    const root = store.editorUI.currentPage!.appComponentTree as ComponentInstance;
    store.editorUI.selectComponent(root, desktop);
    mountPanel();
    add(':root { color: red }');
    const before = rules(root);
    fireEvent.change(screen.getByLabelText('CSS property name'), { target: { value: 'clip-path' } });
    fireEvent.change(screen.getByLabelText('CSS property value'), { target: { value: 'circle(50%)' } });
    fireEvent.keyDown(screen.getByLabelText('CSS property value'), { key: 'Enter' });
    expect(rules(root)).toEqual(before);
    expect(document.body.textContent).toContain('clipPath cannot be set on the document');
  });

  it('gives the reason for a near miss of :root, and stores nothing', () => {
    mountPanel();
    add(':ROOT { color: red }');
    expect(alertText()).toContain('every part of a selector starts with &');
    expect(rules()).toEqual([]);
  });

  it('asks for something on empty text', () => {
    mountPanel();
    add('   ');
    expect(alertText()).toContain('Type a selector');
  });

  it('takes a paste whole or not at all, in one undo step', () => {
    mountPanel();
    add(':first-child { color: red } & + p { color: blue }');
    expect(rules()).toEqual([]);
    fireEvent.change(field(), { target: { value: ':first-child { color: red } :last-child { color: blue }' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(rules()).toHaveLength(2);
    act(() => getHistoryStore()!.undo());
    expect(rules()).toEqual([]);
    expect(store.editorUI.activeRule).toBeNull();
  });

  it('cancels with Escape and keeps a newline on Shift+Enter', () => {
    mountPanel();
    open();
    fireEvent.change(field(), { target: { value: ':first-child' } });
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(rules()).toEqual([]);
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByLabelText('Selector or CSS rule')).toBeNull();
    expect(rules()).toEqual([]);
  });

  it('reads :hover as the Hover state, picking it without a rule of its own', () => {
    mountPanel();
    add(':hover');
    expect(rules()).toHaveLength(1);
    expect(store.editorUI.activeRule).toBe('hover');
    expect(radio(/Hover/).getAttribute('aria-checked')).toBe('true');
    expect(hasRadio(/&:hover/)).toBe(false);
    add(':hover');
    expect(rules()).toHaveLength(1);
  });

  it('refuses a state it already has when given values', () => {
    box.setRuleStyle('hover', 'color', '#00f', desktop);
    mountPanel();
    add(':hover { color: red }');
    expect(alertText()).toContain('already exists');
    expect(rules()).toHaveLength(1);
  });

  it('refuses a definition that clashes on the page and takes an identical one', () => {
    main.addRule({ define: '@keyframes u-spin', blocks: [{ selector: 'from', style: { opacity: '0' } }] });
    mountPanel();
    add('@keyframes u-spin { from { opacity: 1 } }');
    expect(alertText()).toContain('already defined differently');
    fireEvent.change(field(), { target: { value: '@keyframes u-spin { from { opacity: 0 } }' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(rules()).toHaveLength(1);
  });
});

describe('a custom rule in the switch', () => {
  it('is edited with the normal sections, reading from Normal', () => {
    mountPanel();
    add(':nth-child(2n)');
    const row = screen.getByText('Text', { selector: 'label' }).closest('div.grid') as HTMLElement;
    expect(within(row).getByTestId('state-source').textContent).toBe('from Normal');
    const input = within(row).getAllByRole('textbox')[0];
    fireEvent.change(input, { target: { value: '#00ff00' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rules()[0]).toMatchObject({ style: { color: '#00ff00' } });
    expect(within(radio(/&:nth-child/)).getByTestId('state-dot')).toBeTruthy();
  });

  it('is reached with the arrow keys after the states', () => {
    mountPanel();
    add(':first-child');
    act(() => store.editorUI.setActiveRule(null));
    radio('Normal').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(store.editorUI.activeRule).toBe(rules()[0].id);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(store.editorUI.activeRule).toBeNull();
  });

  it('is deleted from the switch, returning to Normal', () => {
    mountPanel();
    add(':first-child');
    fireEvent.click(button('Delete rule'));
    expect(rules()).toEqual([]);
    expect(store.editorUI.activeRule).toBeNull();
    expect(hasRadio(/first-child/)).toBe(false);
  });

  it('offers no delete on Normal or on a state with no rule', () => {
    mountPanel();
    expect(hasButton('Delete rule')).toBe(false);
    fireEvent.click(radio('Hover'));
    expect(hasButton('Delete rule')).toBe(false);
  });

  it('shows a refused rule with its reason, marked, and it can be deleted', () => {
    box.setProps({ rules: [{ id: 'bad', selector: 'no-ampersand', style: { color: 'red' } }] });
    mountPanel();
    fireEvent.click(radio(/no-ampersand/));
    expect(screen.getByTestId('state-refused').textContent).toContain('does not reach the page');
    fireEvent.click(button('Delete rule'));
    expect(rules()).toEqual([]);
  });

  it('notes a rule the canvas cannot show by itself', () => {
    mountPanel();
    add('@media print');
    expect(notes()[0]).toContain('device or settings');
    add('@media (width > 40em)');
    expect(notes()[0]).toContain('cannot measure');
    add(':focus');
    expect(notes()[0]).toContain('only while this rule is picked');
  });

  it('notes no such thing for a named state or a structural rule', () => {
    box.setRuleStyle('hover', 'color', '#00f', desktop);
    mountPanel();
    fireEvent.click(radio(/Hover/));
    expect(notes()).toEqual([]);
    add(':first-child');
    expect(notes()).toEqual([]);
  });

  it('notes a structural rule on the page root', () => {
    const root = store.editorUI.currentPage!.appComponentTree as ComponentInstance;
    act(() => store.editorUI.selectComponent(root, desktop));
    mountPanel();
    add(':first-child');
    expect(notes()[0]).toContain('structural selector');
  });
});

describe('a definition', () => {
  const definition = () => screen.getByLabelText('Definition');

  it('opens as text, with no sections', () => {
    mountPanel();
    add('@keyframes u-spin { from { opacity: 0 } }');
    expect(definition()).toHaveProperty('value', expect.stringContaining('@keyframes u-spin'));
    expect(hasButton('Size')).toBe(false);
  });

  it('applies an edit and keeps the rule', () => {
    mountPanel();
    add('@keyframes u-spin { from { opacity: 0 } }');
    const { id } = rules()[0];
    fireEvent.change(definition(), { target: { value: '@keyframes u-spin { to { opacity: 1 } }' } });
    fireEvent.click(button('Apply'));
    expect(rules()).toEqual([{ id, define: '@keyframes u-spin', blocks: [{ selector: 'to', style: { opacity: '1' } }] }]);
    expect(store.editorUI.activeRule).toBe(id);
  });

  it('keeps the rule as it was when the edit is refused', () => {
    mountPanel();
    add('@keyframes u-spin { from { opacity: 0 } }');
    const before = rules()[0];
    fireEvent.change(definition(), { target: { value: '@keyframes spin { to { opacity: 1 } }' } });
    fireEvent.click(button('Apply'));
    expect(rules()[0]).toEqual(before);
    expect(alertText()).not.toBe('');
  });

  it('refuses something other than one definition', () => {
    mountPanel();
    add('@keyframes u-spin { from { opacity: 0 } }');
    fireEvent.change(definition(), { target: { value: ':hover { color: red }' } });
    fireEvent.click(button('Apply'));
    expect(alertText()).toContain('one definition');
  });
});

describe('what a page holds', () => {
  it('warns on a name nothing defines, and stops when it is defined', () => {
    box.updateResponsiveStyle('animation', 'u-spin 1s', desktop);
    mountPanel();
    expect(notes()[0]).toContain('Nothing on this page defines u-spin');
    add('@keyframes u-spin { from { opacity: 0 } }');
    expect(notes()).toEqual([]);
  });

  it('reports a Normal custom property with an external address once a rule exists', () => {
    box.updateResponsiveStyle('--photo', 'url(https://example.test/x.jpg)', desktop);
    mountPanel();
    expect(notes()).toEqual([]);
    add(':first-child');
    expect(notes()[0]).toContain('--photo holds an external address');
  });
});
