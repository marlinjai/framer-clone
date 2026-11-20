// The Page state panel and the Interactions section in the real RightSidebar, on a real
// store with its undo history, through the four paths of the stateful flow standard:
// forward, backtrack and revise, resume from what is saved, and re-entry. See
// docs/plans/2026-11-02-behaviour-model.md, "The panel" and "Stateful paths".
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { openProject } from '@/stores/openProject';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { CanvasNodeType, createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { EditorTool } from '@/stores/EditorUIStore';
import { surfaceBehaviour } from '@/lib/behaviour/surfaceBehaviour';
import { readBehaviourTree, type BehaviourNode } from '@/lib/behaviour/format';
import { editPresetItems, idsInUse } from '@/lib/behaviour/presetItems';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import RightSidebar from '../../RightSidebar';
import { useFocusAfter } from '../sections/behaviourShared';

let project: ProjectModelType;
let root: ComponentInstance;
let main: ComponentInstance;
let button: ComponentInstance;
let drawer: ComponentInstance;

const behaviourOf = (node: ComponentInstance) => (node.props as { behaviour?: Record<string, unknown> }).behaviour;
const history = () => getHistoryStore()!;

function setUp() {
  store = createRootStore();
  store.projectStore.createProject('Panel');
  project = store.projectStore.findProjectByTitle('Panel')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  history().setTargetStore(project);
  root = page.appComponentTree as ComponentInstance;
  main = root.children[0] as ComponentInstance;
  main.addChildren([
    createIntrinsicComponent('menu-button', 'button', { children: 'Menu' }),
    createIntrinsicComponent('drawer', 'nav', { children: 'Links' }),
  ]);
  button = main.children.find((c: ComponentInstance) => c.id === 'menu-button')!;
  drawer = main.children.find((c: ComponentInstance) => c.id === 'drawer')!;
}

function mount() {
  return render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
}

const select = (node: ComponentInstance) => act(() => store.editorUI.selectComponent(node));
const interactions = () => within(screen.getByTestId('interactions-section'));
const pageState = () => within(screen.getByTestId('page-state-panel'));

/** Types into a field that commits on Enter. */
function typeAndCommit(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
}

/** Adds an on or off value to the page and names it. */
function addPageValue(name: string): string {
  fireEvent.click(pageState().getByRole('button', { name: 'Add a value to the page' }));
  const states = (behaviourOf(root)?.state ?? []) as { id: string; name: string }[];
  const added = states[states.length - 1];
  typeAndCommit(pageState().getByLabelText(`Name of ${added.name}`), name);
  return added.id;
}

/** Picks a type for a value and applies it with the button: picking alone changes nothing. */
function retypeTo(name: string, type: string, label: string) {
  fireEvent.change(pageState().getByLabelText(`Type of ${name}`), { target: { value: type } });
  fireEvent.click(pageState().getByRole('button', { name: `Change to ${label}` }));
}

/** Opens the add form, picks the event and saves. Actions start as the form suggests. */
function addInteraction(event: string, before?: () => void) {
  fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
  fireEvent.change(interactions().getByLabelText('Event'), { target: { value: event } });
  before?.();
  fireEvent.click(interactions().getByRole('button', { name: 'Add this interaction' }));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setUp();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('forward', () => {
  it('declares a value, makes a button toggle it, and shows the drawer only while it is on', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    expect(behaviourOf(root)).toEqual({ state: [{ id: menu, name: 'Menu open', type: 'boolean', initial: false }] });

    addInteraction('click');
    const on = behaviourOf(button)?.on as { id: string; on: string; do: unknown[] }[];
    expect(on).toHaveLength(1);
    expect(on[0]).toMatchObject({ on: 'click', do: [{ toggle: menu }] });
    expect(interactions().getByText('On click, toggle Menu open')).toBeTruthy();

    select(drawer);
    fireEvent.change(interactions().getByLabelText('Show when value'), { target: { value: menu } });
    expect(behaviourOf(drawer)).toEqual({ showWhen: { state: menu, eq: true } });
    fireEvent.click(interactions().getByRole('switch'));
    expect(behaviourOf(drawer)).toEqual({ showWhen: { state: menu, eq: true }, noScript: 'hide' });

    // What the canvas shows follows the preview control in the Page state panel.
    const shown = () => surfaceBehaviour(store.editorUI.currentPage!.expansion.root, store.editorUI.previewState).problems;
    fireEvent.change(pageState().getByLabelText('Preview Menu open'), { target: { value: 'true' } });
    expect(store.editorUI.previewState).toEqual({ [menu]: true });
    expect(shown()).toEqual([]);
  });

  it('every edit is one undo step, and committing the same value is none', () => {
    mount();
    select(button);
    const before = history().undoIdx;
    const id = addPageValue('Open');
    expect(history().undoIdx).toBe(before + 2); // add, then rename
    typeAndCommit(pageState().getByLabelText('Name of Open'), 'Open');
    expect(history().undoIdx).toBe(before + 2);
    // The field sees a change here, but the trimmed name is what is stored already.
    typeAndCommit(pageState().getByLabelText('Name of Open'), 'Open ');
    expect(history().undoIdx).toBe(before + 2);
    addInteraction('click');
    expect(history().undoIdx).toBe(before + 3);
    act(() => history().undo());
    expect(behaviourOf(button)).toBeUndefined();
    expect((behaviourOf(root)?.state as { id: string }[])[0].id).toBe(id);
  });

  it('writes an interaction from All events, with the browser response stopped', () => {
    mount();
    select(button);
    const hit = addPageValue('Hit');
    addInteraction('dragover', () => {
      fireEvent.change(interactions().getByLabelText('Action 1'), { target: { value: 'set' } });
      fireEvent.change(interactions().getByLabelText('New value in action 1'), { target: { value: 'true' } });
      fireEvent.click(within(interactions().getByRole('group', { name: 'Interaction' })).getAllByRole('switch')[0]);
    });
    expect((behaviourOf(button)?.on as unknown[])[0]).toMatchObject({ on: 'dragover', prevent: true, do: [{ set: hit, value: true }] });
  });

  it('each type of value takes only what it can hold, and says why it refused', () => {
    mount();
    select(button);
    addPageValue('Size');
    retypeTo('Size', 'number', 'Number');
    const size = () => (behaviourOf(root)?.state as Record<string, unknown>[])[0];
    expect(size()).toMatchObject({ type: 'number', initial: 0 });
    typeAndCommit(pageState().getByLabelText('Lowest of Size'), '5');
    expect(screen.getByRole('alert').textContent).toContain('initial is outside min and max');
    expect(size().min).toBeUndefined();
    typeAndCommit(pageState().getByLabelText('First value of Size'), '7');
    typeAndCommit(pageState().getByLabelText('Lowest of Size'), '5');
    expect(size()).toMatchObject({ initial: 7, min: 5 });

    retypeTo('Size', 'choice', 'Choice');
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, small');
    expect(screen.getByRole('alert').textContent).toContain('two options are the same');
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, large');
    expect(size()).toMatchObject({ type: 'choice', options: ['small', 'large'], initial: 'small' });

    typeAndCommit(pageState().getByLabelText('Name of Size'), '   ');
    expect(screen.getByRole('alert').textContent).toContain('a state needs a name');
    expect(size().name).toBe('Size');
  });

  it('says so when a number\'s first value is not a number, and writes nothing', () => {
    mount();
    select(button);
    addPageValue('Count');
    retypeTo('Count', 'number', 'Number');
    const before = history().undoIdx;
    typeAndCommit(pageState().getByLabelText('First value of Count'), 'abc');
    expect(pageState().getByRole('alert').textContent).toBe('Not changed: abc is not a number.');
    expect((behaviourOf(root)?.state as Record<string, unknown>[])[0].initial).toBe(0);
    expect(history().undoIdx).toBe(before);
    typeAndCommit(pageState().getByLabelText('First value of Count'), '3');
    expect(pageState().queryByRole('alert')).toBeNull();
    expect((behaviourOf(root)?.state as Record<string, unknown>[])[0].initial).toBe(3);
  });

  it('refuses a name another value of the page holds, and a picker tells two of one name apart', () => {
    mount();
    select(button);
    addPageValue('Open');
    const second = addPageValue('Closed');
    typeAndCommit(pageState().getByLabelText('Name of Closed'), ' open ');
    expect(pageState().getByRole('alert').textContent).toBe('Not changed: another value on this page is called Open.');
    expect((behaviourOf(root)?.state as { name: string }[]).map((state) => state.name)).toEqual(['Open', 'Closed']);
    // Two values of one name, as an import or two presets can store them: the picker adds the id.
    act(() => drawer.setBehaviour({ state: [{ id: 'v-drawerop', name: 'Open', type: 'boolean', initial: false }] }));
    select(drawer);
    const options = Array.from((interactions().getByLabelText('Show when value') as HTMLSelectElement).options).map((option) => option.text);
    expect(options).toEqual(['Always', `Open (${(behaviourOf(root)?.state as { id: string }[])[0].id})`, 'Closed', 'Open (v-drawerop)']);
    expect(second).toMatch(/^v-/);
  });

  it('refuses an interaction the parser refuses, writes nothing, and says why', () => {
    mount();
    select(button);
    addPageValue('Open');
    const before = history().undoIdx;
    addInteraction('mouseenter', () => {
      fireEvent.change(interactions().getByLabelText('Action 1'), { target: { value: 'focus' } });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Not saved: .*(focus|click|press)/i);
    expect(behaviourOf(button)).toBeUndefined();
    expect(history().undoIdx).toBe(before);
    fireEvent.click(interactions().getByRole('button', { name: 'Cancel' }));
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
  });

  it('a step action names its Wrap around switch by its number', () => {
    mount();
    select(button);
    addPageValue('Count');
    retypeTo('Count', 'number', 'Number');
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    fireEvent.change(interactions().getByLabelText('Action 1', { exact: true }), { target: { value: 'step' } });
    fireEvent.click(interactions().getByRole('button', { name: 'Add action' }));
    fireEvent.change(interactions().getByLabelText('Action 2', { exact: true }), { target: { value: 'step' } });
    expect(interactions().getByRole('switch', { name: 'Wrap around in action 1' })).toBeTruthy();
    fireEvent.click(interactions().getByRole('switch', { name: 'Wrap around in action 2' }));
    fireEvent.click(interactions().getByRole('button', { name: 'Add this interaction' }));
    expect((behaviourOf(button)?.on as { do: unknown[] }[])[0].do).toMatchObject([{ step: expect.any(String) }, { step: expect.any(String), wrap: true }]);
  });

  it('takes an address that leaves the site only as a safe link, typed by a person', () => {
    mount();
    select(button);
    addInteraction('click', () => {
      fireEvent.change(interactions().getByLabelText('Action 1'), { target: { value: 'navigate' } });
      const address = interactions().getByLabelText('Address in action 1');
      fireEvent.change(address, { target: { value: 'javascript:alert(1)' } });
      expect(interactions().getByRole('alert').textContent).toContain('Use a page path');
      // Save stays off while the field shows an address it would not save.
      const save = interactions().getByRole('button', { name: 'Add this interaction' }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(address, { target: { value: 'https://exam' } });
      expect(save.disabled).toBe(false);
      fireEvent.change(address, { target: { value: 'https:/' } });
      expect(save.disabled).toBe(true);
      fireEvent.change(address, { target: { value: 'https://example.com/book' } });
      expect(save.disabled).toBe(false);
      expect(interactions().getByText(/Leaves the site/)).toBeTruthy();
    });
    expect((behaviourOf(button)?.on as unknown[])[0]).toMatchObject({ on: 'click', do: [{ navigate: 'https://example.com/book' }] });
  });

  it('works in the phone sheet too', () => {
    render(
      <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
        <RightSidebar variant="sheet" />
      </DataSourceProviderContext.Provider>,
    );
    select(button);
    addPageValue('Open');
    addInteraction('click');
    expect(interactions().getByText('On click, toggle Open')).toBeTruthy();
  });
});

describe('focus and what is said', () => {
  const status = (section: () => ReturnType<typeof within>) => section().getByRole('status').textContent;

  it('the interaction editor takes the focus when it opens, and gives it back to a control that is there when it closes', () => {
    mount();
    select(button);
    addPageValue('Open');
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    expect(document.activeElement).toBe(interactions().getByLabelText('Event', { exact: true }));
    fireEvent.click(interactions().getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(interactions().getByRole('button', { name: 'Add interaction' }));

    addInteraction('click');
    expect(document.activeElement).toBe(interactions().getByRole('button', { name: 'Add interaction' }));
    expect(status(interactions)).toBe('Added: On click, toggle Open');
    addInteraction('mouseenter');

    fireEvent.click(interactions().getByRole('button', { name: 'Edit: On click, toggle Open' }));
    expect(document.activeElement).toBe(interactions().getByLabelText('Event', { exact: true }));
    fireEvent.click(interactions().getByRole('button', { name: 'Save this interaction' }));
    expect(document.activeElement).toBe(interactions().getByRole('button', { name: 'Edit: On click, toggle Open' }));
    expect(status(interactions)).toBe('Saved: On click, toggle Open');

    // Deleting the first row: the next row, now first, takes the focus; deleting the last: Add interaction.
    fireEvent.click(interactions().getByRole('button', { name: 'Delete: On click, toggle Open' }));
    expect(document.activeElement).toBe(interactions().getByRole('button', { name: 'Edit: On mouse enter, toggle Open' }));
    expect(status(interactions)).toBe('Deleted: On click, toggle Open');
    fireEvent.click(interactions().getByRole('button', { name: 'Delete: On mouse enter, toggle Open' }));
    expect(document.activeElement).toBe(interactions().getByRole('button', { name: 'Add interaction' }));
  });

  it('a new value\'s name takes the focus; a deleted one gives it to the next value or to Add value', () => {
    mount();
    select(button);
    fireEvent.click(pageState().getByRole('button', { name: 'Add a value to the page' }));
    expect(document.activeElement).toBe(pageState().getByLabelText('Name of Value 1'));
    expect(status(pageState)).toBe('Added Value 1');
    fireEvent.click(pageState().getByRole('button', { name: 'Add a value to the page' }));
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Value 1' }));
    expect(document.activeElement).toBe(pageState().getByLabelText('Name of Value 2'));
    expect(status(pageState)).toBe('Deleted Value 1');
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Value 2' }));
    expect(document.activeElement).toBe(pageState().getByRole('button', { name: 'Add a value to the page' }));
  });

  it('an added action takes the focus, and a removed one gives it to the action before, or to Add action', () => {
    mount();
    select(button);
    addPageValue('Open');
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    const action = (n: number) => interactions().getByLabelText(`Action ${n}`, { exact: true });
    fireEvent.click(interactions().getByRole('button', { name: 'Add action' }));
    expect(document.activeElement).toBe(action(2));
    fireEvent.click(interactions().getByRole('button', { name: 'Remove action 2' }));
    expect(document.activeElement).toBe(action(1));
    fireEvent.click(interactions().getByRole('button', { name: 'Remove action 1' }));
    expect(document.activeElement).toBe(interactions().getByRole('button', { name: 'Add action' }));
  });

  it('a delete that asks first puts the focus on Keep it, and Keep it gives it back to the delete button', () => {
    mount();
    select(button);
    addPageValue('Open');
    addInteraction('click');
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Open' }));
    expect(document.activeElement).toBe(pageState().getByRole('button', { name: 'Keep it' }));
    fireEvent.click(pageState().getByRole('button', { name: 'Keep it' }));
    expect(document.activeElement).toBe(pageState().getByRole('button', { name: 'Delete Open' }));
  });

  it('a quote in a value\'s name never breaks the focus, and Keep it still gives it back to the delete button', () => {
    mount();
    select(button);
    addPageValue('Say "hi"');
    addInteraction('click');
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Say "hi"' }));
    fireEvent.click(pageState().getByRole('button', { name: 'Keep it' }));
    expect(screen.getByTestId('page-state-panel')).toBeTruthy();
    expect(document.activeElement).toBe(pageState().getByRole('button', { name: 'Delete Say "hi"' }));
  });

  it('a quote in a stored value\'s id never breaks the focus after a neighbour is deleted', () => {
    mount();
    act(() => root.setBehaviour({ state: [{ id: 'v-gone', name: 'Gone', type: 'boolean', initial: false }, { id: 'a"b', name: 'Imported', type: 'boolean', initial: false }] }));
    select(button);
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Gone' }));
    expect(screen.getByTestId('page-state-panel')).toBeTruthy();
    expect(document.activeElement).toBe(pageState().getByLabelText('Name of Imported'));
  });

  it('a target that cannot be looked up is passed over, and the next one takes the focus', () => {
    const Probe = () => {
      const focus = useFocusAfter();
      return (
        <div ref={focus.ref}>
          <button type="button" data-next="" onClick={() => focus.request(['[data-x="a"b"]', () => { throw new Error('lost'); }, '[data-next]'], 'Moved')}>Go</button>
          {focus.live}
        </div>
      );
    };
    render(<Probe />);
    const go = screen.getByRole('button', { name: 'Go' });
    expect(() => fireEvent.click(go)).not.toThrow();
    expect(document.activeElement).toBe(go);
    expect(screen.getByRole('status').textContent).toBe('Moved');
  });
});

describe('the page as a whole', () => {
  /** Text values of 4,096 characters: 15 of them fit the page's 64 KB, a 16th does not. */
  const bigText = (n: number, initial = 'x'.repeat(4096)) => ({ id: `v-big${String(n).padStart(5, '0')}`, name: `Big ${n}`, type: 'text', initial });

  it('refuses a value edit that would take the page past its size cap and cut off what reads the page values', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    const stored = behaviourOf(root)!;
    act(() => root.setBehaviour({ ...stored, state: [...(stored.state as unknown[]), ...Array.from({ length: 15 }, (_, i) => bigText(i)), bigText(99, '')] }));
    const before = JSON.stringify(behaviourOf(root));
    // Each value on its own is fine: only the page check sees the cap.
    typeAndCommit(pageState().getByLabelText('First value of Big 99'), 'y'.repeat(4096));
    expect(pageState().getByRole('alert').textContent).toMatch(/^Not changed: .*65536 bytes/);
    expect(JSON.stringify(behaviourOf(root))).toBe(before);
    expect(interactions().queryByText(/Does not run/)).toBeNull();
    expect((behaviourOf(button)?.on as { do: unknown[] }[])[0].do).toEqual([{ toggle: menu }]);
  });

  it('refuses Add value when the page has no room for it, and says why', () => {
    mount();
    select(button);
    // Filled to within a few bytes of the cap, so a new on or off value does not fit: the
    // longest last value the page still takes whole, found by halving.
    const fill = (length: number) => ({ state: [...Array.from({ length: 15 }, (_, i) => bigText(i)), bigText(15, 'x'.repeat(length))] });
    const whole = (length: number) => readBehaviourTree({ id: 'root', type: 'div', props: { behaviour: fill(length) }, children: [] } as never).refused.length === 0;
    let low = 0;
    let high = 4096;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (whole(mid)) low = mid;
      else high = mid - 1;
    }
    expect(whole(low) && !whole(low + 1)).toBe(true);
    act(() => root.setBehaviour(fill(low)));
    fireEvent.click(pageState().getByRole('button', { name: 'Add a value to the page' }));
    expect(pageState().getByRole('alert').textContent).toMatch(/^Not added: .*65536 bytes.*\.$/);
    expect((behaviourOf(root)?.state as unknown[]).length).toBe(16);
  });

  it('changes a type only on the button, never on the pick, and refuses one that breaks what reads the value', () => {
    mount();
    select(button);
    addPageValue('Menu open');
    addInteraction('click');
    const before = history().undoIdx;
    const type = () => pageState().getByLabelText('Type of Menu open') as HTMLSelectElement;
    // Moving through the list (an arrow key fires change in some browsers) writes nothing.
    fireEvent.change(type(), { target: { value: 'number' } });
    fireEvent.change(type(), { target: { value: 'choice' } });
    expect(history().undoIdx).toBe(before);
    expect((behaviourOf(root)?.state as { type: string }[])[0].type).toBe('boolean');
    fireEvent.click(pageState().getByRole('button', { name: 'Keep the type' }));
    expect(type().value).toBe('boolean');
    // Applied: the toggle on the button needs on or off, so the page check refuses it and names the reader.
    retypeTo('Menu open', 'number', 'Number');
    expect(pageState().getByRole('alert').textContent).toMatch(/^Not changed: it would stop "Button" working: /);
    expect(history().undoIdx).toBe(before);
  });

  it('shows on the rows when the page refuses a scope\'s behaviour whole', () => {
    mount();
    select(button);
    act(() => root.setBehaviour({ state: Array.from({ length: 17 }, (_, i) => bigText(i)) }));
    expect(pageState().getByText(/^None of these values is used: .*65536 bytes/)).toBeTruthy();
  });
});

describe('backtrack and revise', () => {
  it('deleting a value marks what reads it refused, visibly, and one undo restores it all', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    select(drawer);
    fireEvent.change(interactions().getByLabelText('Show when value'), { target: { value: menu } });

    // The row says what reads it, and deleting it asks first, naming them.
    expect(pageState().getByText(/^Read by 2 elements: /)).toBeTruthy();
    const before = history().undoIdx;
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Menu open' }));
    const confirm = () => within(pageState().getByRole('group', { name: 'Delete Menu open?' }));
    expect(confirm().getByText(/stops what reads it from working/)).toBeTruthy();
    expect(history().undoIdx).toBe(before);
    fireEvent.click(confirm().getByRole('button', { name: 'Keep it' }));
    expect(pageState().queryByRole('group', { name: 'Delete Menu open?' })).toBeNull();
    expect(history().undoIdx).toBe(before);
    fireEvent.click(pageState().getByRole('button', { name: 'Delete Menu open' }));
    fireEvent.click(confirm().getByRole('button', { name: 'Delete Menu open' }));
    expect(history().undoIdx).toBe(before + 1);
    expect(interactions().getByText(/Shown always: .*menu|Shown always:/)).toBeTruthy();
    select(button);
    expect(interactions().getByText(/Does not run:/)).toBeTruthy();
    // The entries stay stored, so the person sees what broke and can fix or delete it.
    expect((behaviourOf(button)?.on as unknown[])).toHaveLength(1);

    act(() => history().undo());
    expect(interactions().queryByText(/Does not run:/)).toBeNull();
    expect(interactions().getByText('On click, toggle Menu open')).toBeTruthy();
  });

  it('renaming a value changes nothing else, since references use the id', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    const stored = JSON.stringify(behaviourOf(button));
    typeAndCommit(pageState().getByLabelText('Name of Menu open'), 'Drawer open');
    expect(JSON.stringify(behaviourOf(button))).toBe(stored);
    expect(interactions().getByText('On click, toggle Drawer open')).toBeTruthy();
    expect((behaviourOf(root)?.state as { id: string }[])[0].id).toBe(menu);
  });

  it('a preview stays only while its value can still hold it', () => {
    mount();
    select(button);
    const size = addPageValue('Size');
    retypeTo('Size', 'choice', 'Choice');
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, medium, large');
    fireEvent.change(pageState().getByLabelText('Preview Size'), { target: { value: 'large' } });
    expect(store.editorUI.previewState).toEqual({ [size]: 'large' });

    // The same options again keeps it.
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, medium, large, huge');
    expect(store.editorUI.previewState).toEqual({ [size]: 'large' });
    // Taking its option away drops it from the preview itself, not only from what shows.
    typeAndCommit(pageState().getByLabelText('Options of Size'), 'small, medium');
    expect(store.editorUI.previewState).toEqual({});

    fireEvent.change(pageState().getByLabelText('Preview Size'), { target: { value: 'medium' } });
    retypeTo('Size', 'boolean', 'On or off');
    expect(store.editorUI.previewState).toEqual({});
  });

  it('editing an interaction keeps every field it holds that the panel has no control for', () => {
    mount();
    select(button);
    const menu = addPageValue('Open');
    act(() => {
      button.setBehaviour({ on: [{ id: 'mine', on: 'click', if: { state: menu, eq: false }, do: [{ toggle: menu }] }] });
    });
    fireEvent.click(interactions().getByRole('button', { name: /^Edit: / }));
    expect(interactions().getByText(/Also holds a condition/)).toBeTruthy();
    fireEvent.change(interactions().getByLabelText('Event'), { target: { value: 'keydown' } });
    fireEvent.change(interactions().getByLabelText('Keys'), { target: { value: 'Enter' } });
    fireEvent.click(interactions().getByRole('button', { name: 'Save this interaction' }));
    expect(behaviourOf(button)).toEqual({ on: [{ id: 'mine', on: 'keydown', keys: ['Enter'], if: { state: menu, eq: false }, do: [{ toggle: menu }] }] });
  });

  it('an open editor whose interaction an undo changed closes instead of saving over it', () => {
    mount();
    select(button);
    addPageValue('Open');
    addInteraction('click');
    fireEvent.click(interactions().getByRole('button', { name: /^Edit: / }));
    expect(interactions().getByRole('group', { name: 'Interaction' })).toBeTruthy();
    act(() => history().undo());
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
  });

  it('an open editor closes when a long interaction changes only near its end, and when another takes its place', () => {
    mount();
    select(button);
    const open = addPageValue('Open');
    // Five actions: stored, it is longer than the 160 characters the old key was cut to.
    const steps: Record<string, unknown>[] = [{ toggle: open }, { set: open, value: true }, { set: open, value: false }, { emit: 'the-first-event' }, { emit: 'the-second-event' }];
    act(() => button.setBehaviour({ on: [{ id: 't-long0001', on: 'click', do: steps }] }));
    expect(JSON.stringify(behaviourOf(button)).length).toBeGreaterThan(160);
    fireEvent.click(interactions().getByRole('button', { name: /^Edit: / }));
    expect(interactions().getByRole('group', { name: 'Interaction' })).toBeTruthy();
    // Only the last action changes, as an AI edit or another tab could.
    act(() => button.setBehaviour({ on: [{ id: 't-long0001', on: 'click', do: [...steps.slice(0, 4), { emit: 'the-other-event' }] }] }));
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    expect((behaviourOf(button)?.on as { do: unknown[] }[])[0].do[4]).toEqual({ emit: 'the-other-event' });

    // Another trigger in the same place, the same text but another id: the editor closes too.
    fireEvent.click(interactions().getByRole('button', { name: /^Edit: / }));
    const same = (behaviourOf(button)?.on as Record<string, unknown>[])[0];
    act(() => button.setBehaviour({ on: [{ ...same, id: 't-long0002' }] }));
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
  });

  it('shows what a preset wrote with its mark, and offers no edit that the preset would undo', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    expect(pageState().getByText(/Made by a preset/)).toBeTruthy();
    expect(pageState().queryByRole('button', { name: /^Delete Active tab/ })).toBeNull();
    // Only its name and first value are a person's: the preset's range and type are locked.
    const row = within(pageState().getByLabelText(/^Name of Active tab/).closest('[data-state-id]') as HTMLElement);
    for (const label of [/^Lowest of /, /^Highest of /, /^Step of /]) expect((row.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    expect((row.getByLabelText(/^Type of /) as HTMLSelectElement).disabled).toBe(true);
    expect((row.getByLabelText(/^Name of /) as HTMLInputElement).disabled).toBe(false);
    expect((row.getByLabelText(/^First value of /) as HTMLInputElement).disabled).toBe(false);
  });
});

describe('a preset\'s items', () => {
  it('a tab is added and taken out through the preset, one undo step each', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    const before = history().undoIdx;
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().getByText('4 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before + 1);
    // Picking a tab removes nothing: only the Remove button does, so a key moving through the list is safe.
    const pick = () => group().getByLabelText('Tab to remove') as HTMLSelectElement;
    expect((group().getByRole('button', { name: 'Remove the picked tab' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(pick(), { target: { value: '0' } });
    fireEvent.change(pick(), { target: { value: '1' } });
    fireEvent.change(pick(), { target: { value: '0' } });
    expect(group().getByText('4 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before + 1);
    fireEvent.click(group().getByRole('button', { name: 'Remove First' }));
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before + 2);
    expect(Array.from(pick().options).map((o) => o.text)).toEqual(['Pick a tab to remove', 'Second', 'Third', 'Tab 4']);
    act(() => history().undo());
    act(() => history().undo());
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(Array.from(pick().options).map((o) => o.text)).toEqual(['Pick a tab to remove', 'First', 'Second', 'Third']);
  });

  /** Every id in a stored subtree, in order. */
  const idsIn = (node: unknown): string[] => {
    const record = node as { id?: string; children?: unknown[] };
    return [...(record.id ? [record.id] : []), ...(record.children ?? []).flatMap(idsIn)];
  };
  const pageIds = () => idsIn(getSnapshot(store.editorUI.currentPage!.appComponentTree));

  it('a new tab takes no id an element elsewhere holds, nor a removed middle tab\'s id', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    const seed = tabs.id;
    // An element outside the tabs already holds the id the next panel would have taken.
    act(() => main.addChildren([createIntrinsicComponent(`${seed}-panel-3`, 'div', { children: 'Dragged out' })]));
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    const ids = pageIds();
    expect(new Set(ids).size).toBe(ids.length);
    // Remove the middle tab, then add one: the removed ids do not come back.
    const middle = idsIn(getSnapshot(tabs)).filter((id) => /-tab-1$|-panel-1$/.test(id));
    expect(middle).toHaveLength(2);
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '1' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove Second' }));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    const after = pageIds();
    expect(new Set(after).size).toBe(after.length);
    for (const id of middle) expect(after).not.toContain(id);
  });

  it('the last tab\'s ids come back after it is removed only while nothing on the page holds or names them', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const last = () => idsIn(getSnapshot(tabs)).filter((id) => /-tab-2$|-panel-2$/.test(id));
    const removed = last();
    expect(removed).toHaveLength(2);
    const removeThird = () => {
      fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '2' } });
      fireEvent.click(group().getByRole('button', { name: /^Remove (Third|Tab 3)$/ }));
    };
    // Nothing names them: a new third tab takes them again, which no reference can tell apart.
    removeThird();
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(last()).toEqual(removed);
    // A trigger still names the removed panel: the new panel takes another id, so it never takes the reference over.
    const [, panel] = removed;
    expect(panel).toMatch(/-panel-2$/);
    act(() => button.setBehaviour({ on: [{ id: 't-focus', on: 'click', do: [{ focus: panel }] }] }));
    removeThird();
    fireEvent.click(group().getByRole('button', { name: /^Remove Tab 3 anyway$/ }));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(pageIds()).not.toContain(panel);
  });

  it('a preset value keeps the name a person gave it when a tab is added, and a preview past the last tab goes', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    const active = (behaviourOf(tabs)?.state as { id: string; name: string }[])[0];
    typeAndCommit(pageState().getByLabelText(`Name of ${active.name}`), 'Section');
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect((behaviourOf(tabs)?.state as { name: string }[])[0].name).toBe('Section');
    // Previewing the last tab, then removing a tab: the preview no longer fits and goes.
    typeAndCommit(pageState().getByLabelText('Preview Section'), '3');
    expect(store.editorUI.previewState).toEqual({ [active.id]: 3 });
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '0' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove First' }));
    expect(store.editorUI.previewState).toEqual({});
  });

  it('replaceSubtree refuses a new id that an element elsewhere on the page holds, and changes nothing', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    const before = JSON.stringify(getSnapshot(tabs));
    const snapshot = JSON.parse(before) as { children: Record<string, unknown>[] };
    const clash = { ...snapshot, children: [...snapshot.children, { ...snapshot.children[1], id: 'drawer', children: [] }] };
    expect(tabs.replaceSubtree(clash)).toEqual({ ok: false, reason: 'drawer is already an element elsewhere on the page.' });
    expect(JSON.stringify(getSnapshot(tabs))).toBe(before);
    // Its own ids, kept or dropped, are fine.
    expect(tabs.replaceSubtree(JSON.parse(before)).ok).toBe(true);
  });

  it('a carousel gains a slide', () => {
    mount();
    const slides = store.editorUI.currentPage!.insertRegistryComponent('carousel', { kind: 'appTree' })!;
    select(slides);
    fireEvent.click(within(interactions().getByRole('group', { name: 'Slides' })).getByRole('button', { name: 'Add slide' }));
    expect(interactions().getByText('4 slides, made from a preset')).toBeTruthy();
  });

  it('removing a tab something names asks first, names what would stop, and Keep it writes nothing', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    const panel = idsIn(getSnapshot(tabs)).find((id) => /-panel-2$/.test(id))!;
    const trigger = { id: 't-focus', on: 'click', do: [{ focus: panel }] };
    act(() => button.setBehaviour({ on: [trigger] }));
    select(button);
    expect(interactions().queryByText(/Does not run/)).toBeNull();
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const before = history().undoIdx;
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '2' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove Third' }));
    const question = () => within(group().getByRole('group', { name: 'Remove Third?' }));
    expect(question().getByText('Removing Third stops what names it from working: Button.')).toBeTruthy();
    expect(document.activeElement).toBe(question().getByRole('button', { name: 'Keep it' }));
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before);
    fireEvent.click(question().getByRole('button', { name: 'Keep it' }));
    expect(group().queryByRole('group', { name: 'Remove Third?' })).toBeNull();
    expect(document.activeElement).toBe(group().getByRole('button', { name: 'Remove Third' }));
    expect(history().undoIdx).toBe(before);
    // Asked again and confirmed: the tab goes, one undo step, and the trigger shows why it no longer runs.
    fireEvent.click(group().getByRole('button', { name: 'Remove Third' }));
    fireEvent.click(question().getByRole('button', { name: 'Remove Third anyway' }));
    expect(group().getByText('2 tabs, made from a preset')).toBeTruthy();
    // The question that held the focus is gone: the tab picker takes it, and the removal is said.
    expect(document.activeElement).toBe(group().getByLabelText('Tab to remove'));
    expect(interactions().getByRole('status').textContent).toBe('Removed Third');
    expect(history().undoIdx).toBe(before + 1);
    expect(behaviourOf(button)?.on).toEqual([trigger]);
    select(button);
    expect(interactions().getByText(/^Does not run: /)).toBeTruthy();
  });

  it('removing a tab nothing names asks nothing', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '2' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove Third' }));
    expect(group().queryByRole('group', { name: 'Remove Third?' })).toBeNull();
    expect(group().getByText('2 tabs, made from a preset')).toBeTruthy();
    // Remove is off now that nothing is picked, so the focus goes to the picker, and the removal is said.
    expect(document.activeElement).toBe(group().getByLabelText('Tab to remove'));
    expect(interactions().getByRole('status').textContent).toBe('Removed Third');
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(interactions().getByRole('status').textContent).toBe('Added Tab 3');
    // Down to the last tab the picker goes, and the focus falls back to Add tab.
    for (const [index, title] of [['2', 'Tab 3'], ['1', 'Second']]) {
      fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: index } });
      fireEvent.click(group().getByRole('button', { name: `Remove ${title}` }));
    }
    expect(group().getByText('1 tabs, made from a preset')).toBeTruthy();
    expect(group().queryByLabelText('Tab to remove')).toBeNull();
    expect(document.activeElement).toBe(group().getByRole('button', { name: 'Add tab' }));
    // Splicing a node the page does not hold gives no expansion, so the panel says the element is gone.
    expect(store.editorUI.currentPage!.expansionWith({ id: 'nowhere' })).toBeNull();
  });

  it('adds a tab to a tabs preset that floats beside the frames', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'floating', x: 0, y: 0 })!;
    expect(store.editorUI.currentPage!.floatingElements.map((node) => node.id)).toContain(tabs.id);
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().queryByRole('alert')).toBeNull();
    expect(group().getByText('4 tabs, made from a preset')).toBeTruthy();
  });

  it('an undo underneath the remove question closes it, rather than answer it for another tree', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    const panel = idsIn(getSnapshot(tabs)).find((id) => /-panel-2$/.test(id))!;
    act(() => button.setBehaviour({ on: [{ id: 't-focus', on: 'click', do: [{ focus: panel }] }] }));
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '2' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove Third' }));
    expect(group().getByRole('group', { name: 'Remove Third?' })).toBeTruthy();
    act(() => history().undo());
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(group().queryByRole('group', { name: 'Remove Third?' })).toBeNull();
  });

  /** Text values on a page root (`big` of 4,096 characters and one shorter) that fill the page as far as `fits` still takes. */
  const fillTo = (fits: () => boolean, big = 15, on: ComponentInstance = root) => {
    const fill = (length: number) => ({ state: [...Array.from({ length: big }, (_, i) => ({ id: `v-big${i}`, name: `Big ${i}`, type: 'text', initial: 'x'.repeat(4096) })), { id: 'v-last', name: 'Last', type: 'text', initial: 'x'.repeat(length) }] });
    const whole = (length: number) => {
      act(() => on.setBehaviour(fill(length)));
      return fits();
    };
    let low = 0;
    let high = 4096;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (whole(mid)) low = mid;
      else high = mid - 1;
    }
    expect(whole(low)).toBe(true);
  };
  const CAP = 'a page holds at most 65536 bytes of behaviour';
  const pageRefusesNothing = () => readBehaviourTree(store.editorUI.currentPage!.expansion.root as never).refused.length === 0;

  it('refuses a new tab that would take the page past its size cap, and says why', () => {
    mount();
    const tabs = store.editorUI.currentPage!.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    fillTo(pageRefusesNothing);
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const before = JSON.stringify(getSnapshot(tabs));
    const undo = history().undoIdx;
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().getByRole('alert').textContent).toMatch(/^Not changed: .*65536 bytes.*\.$/);
    expect(JSON.stringify(getSnapshot(tabs))).toBe(before);
    expect(history().undoIdx).toBe(undo);
    expect(pageRefusesNothing()).toBe(true);
  });

  it('refuses a new tab whose copied panel holds a placement past the cap, counting the definition\'s behaviour', () => {
    mount();
    const page = store.editorUI.currentPage!;
    const tabs = page.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    // The last panel holds a component whose definition keeps about 3 KB of behaviour; Add tab copies it.
    const lastPanel = page.findComponent(idsIn(getSnapshot(tabs)).find((id) => /-panel-2$/.test(id))!)!;
    act(() => lastPanel.addChildren([createIntrinsicComponent('heavy', 'div', { children: 'Heavy' })]));
    act(() => page.findComponent('heavy')!.setBehaviour({ state: [{ id: 'v-heavy', name: 'Heavy', type: 'text', initial: 'h'.repeat(3000) }] }));
    const made = project.createComponentFromSelection(page.id, ['heavy'], 'Heavy');
    if (!made.ok) throw new Error(made.message);
    const roots = () => [page.expansion.root, ...page.expansion.floating] as unknown as BehaviourNode[];
    const edited = () => editPresetItems(getSnapshot(tabs) as never, { kind: 'addTab' }, idsInUse(roots()))!;
    /** The edited subtree as stored, a placement unexpanded, spliced into the expanded page: the check that missed it. */
    const storedSplice = (node: BehaviourNode, subtree: BehaviourNode): BehaviourNode =>
      node.id === subtree.id ? subtree : { ...node, children: ((node.children ?? []) as BehaviourNode[]).map((child) => storedSplice(child, subtree)) };
    // Full to where the new tab's own bytes still fit, so only the copied placement's behaviour takes the page over.
    // 14 full values, since the definition's 3 KB is on the page already.
    fillTo(() => pageRefusesNothing() && readBehaviourTree(storedSplice(roots()[0], edited() as never)).refused.length === 0, 14);
    expect(readBehaviourTree(page.expansionWith(edited() as never)!.root as never).refused.length).toBeGreaterThan(0);
    select(tabs);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const before = JSON.stringify(getSnapshot(tabs));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().getByRole('alert').textContent).toMatch(/^Not changed: .*65536 bytes.*\.$/);
    expect(JSON.stringify(getSnapshot(tabs))).toBe(before);
    expect(pageRefusesNothing()).toBe(true);
  });

  /** A component placed on the home page, then that page filled to its cap, then the definition opened on the canvas. */
  const openPlacedDefinition = (made: { ok: true; definitionId: string } | { ok: false; message: string }) => {
    if (!made.ok) throw new Error(made.message);
    fillTo(pageRefusesNothing);
    const definition = project.components.get(made.definitionId)!;
    act(() => store.editorUI.setCurrentPage(definition.page as never));
    return definition;
  };

  it('refuses a rename inside a component that would take a page placing it past the cap, naming that page', () => {
    mount();
    const home = store.editorUI.currentPage!;
    act(() => main.addChildren([createIntrinsicComponent('heavy', 'div', { children: 'Heavy' })]));
    act(() => home.findComponent('heavy')!.setBehaviour({ state: [{ id: 'v-heavy', name: 'Note', type: 'text', initial: 'h'.repeat(3000) }] }));
    const definition = openPlacedDefinition(project.createComponentFromSelection(home.id, ['heavy'], 'Heavy'));
    const homeRefuses = () => readBehaviourTree(home.expansion.root as never).refused;
    expect(homeRefuses()).toEqual([]);
    const defRoot = definition.page.appComponentTree as unknown as ComponentInstance;
    select(defRoot);
    const stateOf = () => (behaviourOf(defRoot)?.state as { name: string }[])[0];
    // Its own page holds it easily: only the page placing it is past the cap.
    typeAndCommit(pageState().getByLabelText('Name of Note'), 'Note with a much longer name than before');
    expect(pageState().getByRole('alert').textContent).toBe(`Not changed: it would stop "Container" in "Heavy" working on "${home.metadata.title}": ${CAP}.`);
    expect(stateOf().name).toBe('Note');
    expect(homeRefuses()).toEqual([]);
    // A shorter name fits, and is written.
    typeAndCommit(pageState().getByLabelText('Name of Note'), 'N');
    expect(stateOf().name).toBe('N');
    expect(homeRefuses()).toEqual([]);
  });

  it('judges an edit inside a component placed through another component on the page that places the outer one', () => {
    mount();
    const home = store.editorUI.currentPage!;
    act(() => main.addChildren([createIntrinsicComponent('heavy', 'div', { children: 'Heavy' })]));
    act(() => home.findComponent('heavy')!.setBehaviour({ state: [{ id: 'v-heavy', name: 'Note', type: 'text', initial: 'h'.repeat(3000) }] }));
    const inner = project.createComponentFromSelection(home.id, ['heavy'], 'Heavy');
    if (!inner.ok) throw new Error(inner.message);
    const outer = project.createComponentFromSelection(home.id, [inner.placement.id], 'Outer');
    const innerDefinition = openPlacedDefinition(outer.ok ? { ok: true, definitionId: inner.definitionId } : outer);
    const innerRoot = innerDefinition.page.appComponentTree as unknown as ComponentInstance;
    const placing = (innerDefinition.page as unknown as { placingExpansionsWith(subtree: { id: string }): { name: string }[] })
      .placingExpansionsWith(getSnapshot(innerRoot) as never)
      .map((entry) => entry.name);
    expect(placing.sort()).toEqual([home.metadata.title, 'Outer'].sort());
    select(innerRoot);
    typeAndCommit(pageState().getByLabelText('Name of Note'), 'Note with a much longer name than before');
    expect(pageState().getByRole('alert').textContent).toBe(`Not changed: it would stop "Container" in "Heavy" working on "${home.metadata.title}": ${CAP}.`);
  });

  it('refuses Add tab inside a component when a page placing it has no room, naming that page', () => {
    mount();
    const home = store.editorUI.currentPage!;
    const tabs = home.insertRegistryComponent('tabs', { kind: 'appTree' })!;
    const definition = openPlacedDefinition(project.createComponentFromSelection(home.id, [tabs.id], 'Tabbed'));
    const defRoot = definition.page.appComponentTree as unknown as ComponentInstance;
    select(defRoot);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const before = JSON.stringify(getSnapshot(defRoot));
    fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
    expect(group().getByRole('alert').textContent).toBe(`Not changed: it would stop "Tabs" in "Tabbed" working on "${home.metadata.title}": ${CAP}.`);
    expect(JSON.stringify(getSnapshot(defRoot))).toBe(before);
    expect(readBehaviourTree(home.expansion.root as never).refused).toEqual([]);
  });

  /** "Tabbed" from a tabs preset (and `alongside`, next to it in main) made on Home, then opened on the canvas. */
  const makeTabbed = (alongside: ComponentInstance[] = []) => {
    const home = store.editorUI.currentPage!;
    const tabs = home.insertRegistryComponent('tabs', { kind: 'parent', parentId: main.id })!;
    const panel = idsIn(getSnapshot(tabs)).find((id) => /-panel-2$/.test(id))!;
    return { home, tabs, panel, open: () => {
      const made = project.createComponentFromSelection(home.id, [...alongside.map((node) => node.id), tabs.id], 'Tabbed');
      if (!made.ok) throw new Error(made.message);
      const definition = project.components.get(made.definitionId)!;
      act(() => store.editorUI.setCurrentPage(definition.page as never));
      return definition;
    } };
  };

  it('a confirmed tab removal inside a placed component is made: its reader is inside every placement too', () => {
    mount();
    const { home, tabs, panel, open } = makeTabbed([button]);
    act(() => {
      button.setLabel('Go');
      button.setBehaviour({ on: [{ id: 't-focus', on: 'click', do: [{ focus: panel }] }] });
    });
    const definition = open();
    expect(readBehaviourTree(home.expansion.root as never).refused).toEqual([]);
    select(definition.page.findComponent(tabs.id)!);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const before = history().undoIdx;
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '2' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove Third' }));
    const question = () => within(group().getByRole('group', { name: 'Remove Third?' }));
    expect(question().getByText('Removing Third stops what names it from working: Go.')).toBeTruthy();
    fireEvent.click(question().getByRole('button', { name: 'Remove Third anyway' }));
    expect(group().queryByRole('alert')).toBeNull();
    expect(group().getByText('2 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before + 1);
    act(() => history().undo());
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
  });

  it('a tab removal inside a component is refused when a reader on a page placing it names the tab, naming both', () => {
    mount();
    const { home, panel, open } = makeTabbed();
    const definition = open();
    // The reader stays on Home, out of sight from the definition; a quote in its layer name stays readable.
    act(() => {
      button.setLabel('Go "now"');
      button.setBehaviour({ on: [{ id: 't-focus', on: 'click', do: [{ focus: panel }] }] });
    });
    expect(readBehaviourTree(home.expansion.root as never).refused).toEqual([]);
    select(definition.page.appComponentTree as unknown as ComponentInstance);
    const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
    const before = history().undoIdx;
    fireEvent.change(group().getByLabelText('Tab to remove'), { target: { value: '2' } });
    fireEvent.click(group().getByRole('button', { name: 'Remove Third' }));
    // Nothing in the definition names it, so nothing asks: Home's reader refuses it outright.
    expect(group().queryByRole('group', { name: 'Remove Third?' })).toBeNull();
    expect(group().getByRole('alert').textContent).toBe(`Not changed: it would stop 'Go "now"' working on "${home.metadata.title}": it names something this removes.`);
    expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
    expect(history().undoIdx).toBe(before);
  });

  /**
   * "Tabbed" placed on Home and on a second page, About, which is full. There the placement
   * sits in the page's tree, or inside a floating element (the parser reads each floating
   * tree on its own, so that tree is the one filled).
   */
  const placedTwice = (where: 'tree' | 'floating') => {
    const { open } = makeTabbed();
    const about = project.createPage('About');
    const holder = where === 'tree'
      ? about.appComponentTree as unknown as ComponentInstance
      : about.addCanvasNode({ ...(getSnapshot(createIntrinsicComponent('floating-holder', 'div', {})) as object), canvasNodeType: CanvasNodeType.FLOATING_ELEMENT, canvasX: 0, canvasY: 0 } as never) as unknown as ComponentInstance;
    const definition = open();
    const placed = project.placeComponent(about.id, definition.id, { kind: 'parent', parentId: holder.id });
    if (!placed.ok) throw new Error(placed.message);
    if (where === 'floating') expect(about.floatingElements.map((node) => node.id)).toContain(holder.id);
    const aboutRefuses = () => [about.expansion.root, ...about.expansion.floating].flatMap((tree) => readBehaviourTree(tree as never).refused);
    fillTo(() => aboutRefuses().length === 0, 15, holder);
    expect([...project.pages.values()].at(-1)).toBe(about);
    return { definition, aboutRefuses };
  };

  for (const where of ['tree', 'floating'] as const) {
    it(`refuses Add tab inside a component when the second page placing it (${where === 'tree' ? 'in its tree' : 'floating'}) has no room`, () => {
      mount();
      const { definition, aboutRefuses } = placedTwice(where);
      select(definition.page.appComponentTree as unknown as ComponentInstance);
      const group = () => within(interactions().getByRole('group', { name: 'Tabs' }));
      fireEvent.click(group().getByRole('button', { name: 'Add tab' }));
      expect(group().getByRole('alert').textContent).toBe(`Not changed: it would stop "Tabs" in "Tabbed" working on "About": ${CAP}.`);
      expect(group().getByText('3 tabs, made from a preset')).toBeTruthy();
      expect(aboutRefuses()).toEqual([]);
    });
  }

  it('refuses Hide without JavaScript when the page has no room for it, and says why', () => {
    mount();
    fillTo(pageRefusesNothing);
    select(drawer);
    fireEvent.click(interactions().getByRole('switch', { name: 'Hide without JavaScript' }));
    expect(interactions().getByRole('alert').textContent).toMatch(/^Not changed: .*65536 bytes.*\.$/);
    expect(behaviourOf(drawer)).toBeUndefined();
    expect(pageRefusesNothing()).toBe(true);
  });
});

describe('resume', () => {
  it('a saved page reads back with every row, and a refused entry with its reason; previews and drafts do not come back', () => {
    mount();
    select(button);
    const menu = addPageValue('Menu open');
    addInteraction('click');
    act(() => drawer.setBehaviour({ showWhen: { state: 'gone', eq: true } }));
    fireEvent.change(pageState().getByLabelText('Preview Menu open'), { target: { value: 'true' } });
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    cleanup();

    // A fresh editor opened on what was saved, through the loader the editor uses.
    store = createRootStore();
    openProject(store, saved, null, 1);
    const page = store.editorUI.currentPage!;
    mount();
    act(() => store.editorUI.selectComponent(page.findComponent('menu-button')!));
    expect(interactions().getByText('On click, toggle Menu open')).toBeTruthy();
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    expect(store.editorUI.previewState).toEqual({});
    expect((pageState().getByLabelText('Preview Menu open') as HTMLSelectElement).value).toBe('');
    act(() => store.editorUI.selectComponent(page.findComponent('drawer')!));
    expect(interactions().getByText(/Shown always: .*gone/)).toBeTruthy();
    expect(menu).toMatch(/^v-/);
  });
});

describe('re-entry', () => {
  it('a half-typed draft on one element never lands on another', () => {
    mount();
    select(button);
    addPageValue('Open');
    fireEvent.click(interactions().getByRole('button', { name: 'Add interaction' }));
    fireEvent.change(interactions().getByLabelText('Event'), { target: { value: 'mouseenter' } });
    select(drawer);
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    select(button);
    expect(interactions().queryByRole('group', { name: 'Interaction' })).toBeNull();
    expect(behaviourOf(drawer)).toBeUndefined();
    expect(behaviourOf(button)).toBeUndefined();
  });

  it('the selected element going away leaves the panel standing, and its values with the page', () => {
    mount();
    select(button);
    addPageValue('Open');
    act(() => {
      store.editorUI.clearSelection();
      main.removeChild(button.id);
    });
    expect(screen.queryByTestId('interactions-section')).toBeNull();
    expect(pageState().getByLabelText('Name of Open')).toBeTruthy();
  });

  it('in Interact the preview is off, since the page runs from its first values', () => {
    mount();
    select(button);
    addPageValue('Open');
    act(() => store.editorUI.setSelectedTool(EditorTool.INTERACT));
    expect((pageState().getByLabelText('Preview Open') as HTMLSelectElement).disabled).toBe(true);
    expect(pageState().getByText(/runs in Interact/)).toBeTruthy();
    act(() => store.editorUI.setSelectedTool(EditorTool.SELECT));
    expect((pageState().getByLabelText('Preview Open') as HTMLSelectElement).disabled).toBe(false);
  });

  it('offers no Interactions for a frame, a text run or a placement, and Keep per row inside a list', () => {
    mount();
    select(root);
    expect(screen.queryByTestId('interactions-section')).toBeTruthy();
    act(() => store.editorUI.setSelectedViewportNode(store.editorUI.currentPage!.sortedViewportNodes[0]));
    expect(screen.queryByTestId('interactions-section')).toBeNull();

    act(() => {
      main.addChildren([createIntrinsicComponent('list', 'div', { 'data-component-kind': 'collection' })]);
      (main.children.find((c: ComponentInstance) => c.id === 'list') as ComponentInstance).addChildren([createIntrinsicComponent('card', 'article', {})]);
    });
    select(store.editorUI.currentPage!.findComponent('card')!);
    expect(pageState().getByRole('button', { name: /^Keep per row/ })).toBeTruthy();
    fireEvent.click(pageState().getByRole('button', { name: /^Keep per row/ }));
    expect(behaviourOf(store.editorUI.currentPage!.findComponent('card')!)?.state).toHaveLength(1);
    expect(pageState().getByRole('group', { name: 'Values of Article' })).toBeTruthy();

    // A placement: its behaviour is its definition's, so it has no Interactions and keeps no value.
    const made = project.createComponentFromSelection(store.editorUI.currentPage!.id, [drawer.id], 'Card');
    if (!made.ok) throw new Error(made.message);
    select(made.placement);
    expect(made.placement.type).toBe('#component');
    expect(screen.queryByTestId('interactions-section')).toBeNull();
    expect(pageState().queryByRole('button', { name: /^Keep / })).toBeNull();
    expect(pageState().getByRole('button', { name: 'Add a value to the page' })).toBeTruthy();
    // State an older build kept on a placement is never used, so it is not listed as a scope.
    act(() => made.placement.setBehaviour({ state: [{ id: 'v-oldplace', name: 'Old', type: 'boolean', initial: false }] }));
    expect(pageState().queryByLabelText('Name of Old')).toBeNull();
    expect(pageState().getAllByRole('group', { name: /^Values of / }).map((group) => group.getAttribute('aria-label'))).toEqual(['Values of This page']);
  });

  it('keeps a second value on an element that already keeps one', () => {
    mount();
    act(() => {
      main.addChildren([createIntrinsicComponent('list', 'div', { 'data-component-kind': 'collection' })]);
      (main.children.find((c: ComponentInstance) => c.id === 'list') as ComponentInstance).addChildren([createIntrinsicComponent('card', 'article', {})]);
    });
    const card = store.editorUI.currentPage!.findComponent('card')!;
    select(card);
    fireEvent.click(pageState().getByRole('button', { name: /^Keep per row/ }));
    fireEvent.click(pageState().getByRole('button', { name: /^Keep per row/ }));
    const kept = behaviourOf(card)?.state as { id: string; name: string }[];
    expect(kept).toHaveLength(2);
    expect(new Set(kept.map((state) => state.name)).size).toBe(2);
    const group = within(pageState().getByRole('group', { name: 'Values of Article' }));
    for (const state of kept) expect(group.getByLabelText(`Name of ${state.name}`)).toBeTruthy();
  });
});
