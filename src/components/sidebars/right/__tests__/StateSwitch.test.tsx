// The state switch on the real panel: picking a state, what each row then shows and
// writes, what stays Normal's, and what steps aside on the canvas.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { storedRulesOf } from '@/lib/rules/rules';
import { contextMenuItemsFor } from '@/lib/quickbar/actions';
import { TransformProvider } from '@/contexts/TransformContext';
import HudSurface from '@/components/HudSurface';
import RightSidebar from '../../RightSidebar';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let box: ComponentInstance;
let desktop: string;
let tablet: string;

function place(type: string, props: Record<string, unknown>, id = 'probe'): ComponentInstance {
  const page = store.editorUI.currentPage!;
  const main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.addChildren([createIntrinsicComponent(id, type as 'div', props)]);
  return main.children.find((child: ComponentInstance) => child.id === id) as ComponentInstance;
}

function mountPanel(variant?: 'sheet') {
  return render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar variant={variant} />
    </DataSourceProviderContext.Provider>,
  );
}

const radio = (name: RegExp) => screen.getByRole('radio', { name });
const pick = (name: RegExp) => fireEvent.click(radio(name));
const rowOf = (label: string) => screen.getByText(label, { selector: 'label, span[id]' }).closest('div.grid, div.flex-col') as HTMLElement;
const captionOf = (label: string) => within(rowOf(label)).queryByTestId('state-source');
const hoverStyle = (node: ComponentInstance = box) => storedRulesOf(node.props)[0]?.style;

function typeInto(label: string, value: string) {
  const field = within(rowOf(label)).getAllByRole('textbox')[0];
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
  fireEvent.blur(field);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Switch');
  const project = projectStore.findProjectByTitle('Switch')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(project);
  desktop = page.sortedViewportNodes[0].breakpointId!;
  tablet = page.sortedViewportNodes[1].breakpointId!;
  box = place('div', { style: { color: '#111111', width: '100px' } });
  editorUI.selectComponent(box, desktop);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the switch', () => {
  it('is a radio group of the four states, Normal picked', () => {
    mountPanel();
    const group = screen.getByRole('radiogroup', { name: 'Element state' });
    const names = within(group).getAllByRole('radio').map((el) => el.textContent);
    expect(names).toEqual(['Normal', 'Hover', 'Pressed', 'Focused']);
    expect(radio(/Normal/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/Normal/).tabIndex).toBe(0);
    expect(radio(/Hover/).tabIndex).toBe(-1);
  });

  it('moves and picks with the arrow keys, Home and End, and wraps', () => {
    mountPanel();
    radio(/Normal/).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(store.editorUI.activeRule).toBe('hover');
    expect(document.activeElement).toBe(radio(/Hover/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(store.editorUI.activeRule).toBe('pressed');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(store.editorUI.activeRule).toBe('focused');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(store.editorUI.activeRule).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(store.editorUI.activeRule).toBe('focused');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(store.editorUI.activeRule).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(store.editorUI.activeRule).toBe('focused');
  });

  it('marks a state that holds values, in words too', () => {
    box.setRuleStyle('hover', 'color', '#00f', desktop);
    mountPanel();
    expect(within(radio(/Hover/)).getByTestId('state-dot')).toBeTruthy();
    expect(radio(/Hover/).textContent).toContain('holds values');
    expect(within(radio(/Pressed/)).queryByTestId('state-dot')).toBeNull();
  });

  it('is hidden for a frame, several nodes and nothing selected', () => {
    mountPanel();
    expect(screen.queryByRole('radiogroup')).not.toBeNull();
    const page = store.editorUI.currentPage!;
    act(() => store.editorUI.setSelectedViewportNode(page.sortedViewportNodes[0]));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    act(() => store.editorUI.selectComponent(box, desktop));
    const sibling = page.appComponentTree.children[1] as ComponentInstance;
    act(() => store.editorUI.toggleInSelection(sibling, desktop));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    act(() => store.editorUI.clearSelection());
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('is larger in the phone sheet', () => {
    mountPanel('sheet');
    expect(screen.getByRole('radiogroup').className).toContain('h-11');
  });
});

describe('a row in a state', () => {
  it('shows the inherited value greyed, reading from Normal', () => {
    mountPanel();
    pick(/Hover/);
    expect(captionOf('Text')?.textContent).toBe('from Normal');
    expect(within(rowOf('Text')).getAllByRole('textbox')[0]).toHaveProperty('value', '#111111');
    expect(rowOf('Text').querySelector('.opacity-55')).not.toBeNull();
  });

  it('shows no source where nothing is set anywhere', () => {
    mountPanel();
    pick(/Hover/);
    expect(captionOf('Fill')).toBeNull();
  });

  it('reads from Hover in Pressed', () => {
    box.setRuleStyle('hover', 'color', '#0000ff', desktop);
    mountPanel();
    pick(/Pressed/);
    expect(captionOf('Text')?.textContent).toBe('from Hover');
    expect(within(rowOf('Text')).getAllByRole('textbox')[0]).toHaveProperty('value', '#0000ff');
  });

  it('creates the rule on the first edit and not on the switch, and reads it back as set', () => {
    mountPanel();
    pick(/Hover/);
    expect('rules' in (box.props as object)).toBe(false);
    typeInto('Text', '#0000ff');
    expect(hoverStyle()).toEqual({ color: '#0000ff' });
    expect((box.props.style as Record<string, unknown>).color).toBe('#111111');
    expect(captionOf('Text')?.textContent).toBe('set in Hover');
    expect(rowOf('Text').querySelector('.opacity-55')).toBeNull();
  });

  it('leaves nothing behind when a grey field is only visited', () => {
    mountPanel();
    pick(/Hover/);
    const field = within(rowOf('Text')).getAllByRole('textbox')[0];
    fireEvent.focus(field);
    fireEvent.blur(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect('rules' in (box.props as object)).toBe(false);
  });

  it('removes the value with its reset, drops the dot and stays on the state', () => {
    mountPanel();
    pick(/Hover/);
    typeInto('Text', '#0000ff');
    expect(within(radio(/Hover/)).getByTestId('state-dot')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set in Hover, click to remove' }));
    expect('rules' in (box.props as object)).toBe(false);
    expect(within(radio(/Hover/)).queryByTestId('state-dot')).toBeNull();
    expect(store.editorUI.activeRule).toBe('hover');
    expect(captionOf('Text')?.textContent).toBe('from Normal');
  });

  it('writes a breakpoint inside the state, and a smaller frame names where a value comes from', () => {
    box.setRuleStyle('hover', 'borderRadius', '12px', desktop);
    mountPanel();
    act(() => store.editorUI.selectComponent(box, tablet));
    pick(/Hover/);
    expect(captionOf('Radius')?.textContent).toBe('Hover, Desktop');
    typeInto('Text', '#00aa00');
    expect(hoverStyle()).toEqual({ borderRadius: '12px', color: { [tablet]: '#00aa00' } });
    expect(captionOf('Text')?.textContent).toBe('set in Hover');
    act(() => store.editorUI.selectComponent(box, desktop));
    expect(captionOf('Text')?.textContent).toBe('from Normal');
    expect(store.editorUI.activeRule).toBe('hover');
  });

  it('names the state and the frame on a section', () => {
    mountPanel();
    act(() => store.editorUI.selectComponent(box, tablet));
    pick(/Hover/);
    expect(screen.getAllByText('Hover · Tablet').length).toBeGreaterThan(0);
  });

  it('writes Padding as sides of the state, in one undo step', () => {
    mountPanel();
    pick(/Hover/);
    typeInto('Padding', '12');
    expect(hoverStyle()).toEqual({ paddingTop: '12px', paddingRight: '12px', paddingBottom: '12px', paddingLeft: '12px' });
    act(() => getHistoryStore()!.undo());
    expect('rules' in (box.props as object)).toBe(false);
  });

  it('says why a value was refused, stores nothing, and clears the message on the next good write', () => {
    mountPanel();
    pick(/Hover/);
    typeInto('Image', 'https://example.test/x.jpg');
    expect(screen.getByRole('alert').textContent).toContain('external address');
    expect('rules' in (box.props as object)).toBe(false);
    typeInto('Text', '#0000ff');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a stored rule that does not parse with its reason, and it can be reset', () => {
    box.setProps({ rules: [{ id: 'hover', selector: '&:hover', at: ['@media (hover:hover) and (pointer:fine)'], style: { color: 'url(https://example.test/x)' } }] });
    mountPanel();
    pick(/Hover/);
    expect(screen.getByTestId('state-refused').textContent).toContain('does not reach the page');
    fireEvent.click(within(rowOf('Text')).getByRole('button', { name: 'Set in Hover, click to remove' }));
    expect('rules' in (box.props as object)).toBe(false);
    expect(screen.queryByTestId('state-refused')).toBeNull();
  });
});

describe('the Custom section in a state', () => {
  const custom = (kind: string) => screen.getByLabelText(`CSS property ${kind}`);

  function add(name: string, value: string) {
    fireEvent.change(custom('name'), { target: { value: name } });
    fireEvent.change(custom('value'), { target: { value } });
    fireEvent.keyDown(custom('value'), { key: 'Enter' });
  }

  it('adds any property to the state and removes it again', () => {
    mountPanel();
    pick(/Hover/);
    add('clip-path', 'circle(50%)');
    expect(hoverStyle()).toEqual({ clipPath: 'circle(50%)' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove clip-path from Hover on every breakpoint' }));
    expect('rules' in (box.props as object)).toBe(false);
    expect(store.editorUI.activeRule).toBe('hover');
  });

  it('shows what Normal holds as inherited, with nothing to remove', () => {
    box.updateResponsiveStyle('clipPath', 'circle(10%)', desktop);
    mountPanel();
    pick(/Hover/);
    expect(captionOf('clip-path')?.textContent).toBe('from Normal');
    expect(screen.queryByRole('button', { name: /Remove clip-path/ })).toBeNull();
  });

  it('keeps what was typed when a value is refused', () => {
    mountPanel();
    pick(/Hover/);
    add('mask-image', 'url(https://example.test/x.png)');
    expect('rules' in (box.props as object)).toBe(false);
    expect(custom('value')).toHaveProperty('value', 'url(https://example.test/x.png)');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('what does not follow a state', () => {
  it('dims the props sections and offers the way back', () => {
    const link = place('a', { children: 'Go', href: '/', style: {} }, 'link');
    act(() => store.editorUI.selectComponent(link, desktop));
    mountPanel();
    expect(screen.queryByTestId('normal-only')).toBeNull();
    pick(/Hover/);
    expect(screen.getAllByTestId('normal-only')[0].textContent).toContain('Editing Hover.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to Normal' })[0]);
    expect(store.editorUI.activeRule).toBeNull();
    expect(screen.queryByTestId('normal-only')).toBeNull();
  });

  it('keeps Effects live', () => {
    mountPanel();
    pick(/Hover/);
    const effects = screen.getByRole('button', { name: /Effects/ });
    expect(effects.closest('[inert]')).toBeNull();
  });

  it('puts the tag and the attributes out of reach and keeps CSS in reach', () => {
    mountPanel();
    pick(/Hover/);
    expect(screen.getByLabelText('Attribute name').closest('[inert]')).not.toBeNull();
    expect(screen.getByLabelText('CSS property name').closest('[inert]')).toBeNull();
  });

  it('does not offer Paste style in a state', () => {
    const page = store.editorUI.currentPage!;
    expect(contextMenuItemsFor(box, page, true)).toContain('pasteStyle');
    expect(contextMenuItemsFor(box, page, false)).not.toContain('pasteStyle');
  });
});

describe('the canvas in a state', () => {
  function renderHud() {
    return render(
      <TransformProvider>
        <HudSurface />
      </TransformProvider>,
    );
  }

  const handlesShown = () => {
    const wrapper = document.querySelector<HTMLElement>('[data-testid="resize-handles"]')!.parentElement!;
    return wrapper.style.display !== 'none';
  };

  it('hides the handles and names the state on the selection, and Normal brings them back', () => {
    renderHud();
    expect(handlesShown()).toBe(true);
    expect(screen.queryByTestId('state-badge')).toBeNull();
    act(() => store.editorUI.setActiveRule('pressed'));
    expect(handlesShown()).toBe(false);
    expect(screen.getByTestId('state-badge').textContent).toBe('Pressed');
    act(() => store.editorUI.setActiveRule(null));
    expect(handlesShown()).toBe(true);
    expect(screen.queryByTestId('state-badge')).toBeNull();
  });
});
