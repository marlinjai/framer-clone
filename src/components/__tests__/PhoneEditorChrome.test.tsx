// The phone layout's bottom bar and sheets (plan
// docs/plans/2026-10-24-editor-on-phones.md): the panels open as modal,
// labelled bottom sheets, one at a time, and close by their button, Escape, a
// tap on the backdrop or a swipe down; selecting an element highlights Edit
// instead of opening the properties sheet; the sheets never touch the desktop
// layout's collapse state or remembered width.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import PhoneEditorChrome, { narrowestFrame } from '../PhoneEditorChrome';

let store: RootStoreType;
const fit = vi.fn(() => true);

vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('@/lib/canvas/cameraControls', () => ({
  useCameraControls: () => ({ zoomPercentage: 42, fit, apply: vi.fn(), zoomStep: vi.fn(), reset: vi.fn() }),
}));
// The left sidebar's panes and the properties sections have their own tests.
vi.mock('../sidebars/left/PagesPanel', () => ({ __esModule: true, default: () => <div data-testid="pages-pane" /> }));
vi.mock('../sidebars/left/LayersPanel', () => ({ __esModule: true, default: () => <div data-testid="layers-pane" /> }));
vi.mock('../sidebars/left/ComponentsPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/components/cms/ContentManagerPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('../sidebars/right/sections', () => {
  const Stub = () => <div data-testid="section" />;
  return {
    SizeSection: Stub, PositionSection: Stub, StylesSection: Stub, LayoutSection: Stub, TypographySection: Stub,
    ImageSection: Stub, DataSourceSection: Stub, EffectsSection: Stub, FormSection: Stub, StickyCtaSection: Stub,
  };
});

function seedProject() {
  const { projectStore, editorUI } = store;
  projectStore.createProject('Demo', 'test');
  const project = projectStore.findProjectByTitle('Demo');
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(project?.findPageBySlug(''));
  return project!;
}

/** Some element of the open page other than its root. */
function someChild() {
  const root = store.editorUI.currentPage!.appComponentTree;
  const child = root.children?.[0];
  if (!child) throw new Error('demo page has no child element');
  return child;
}

const bar = () => screen.getByRole('toolbar', { name: 'Editor tools' });
const barButton = (name: string | RegExp) => within(bar()).getByRole('button', { name });

/** Radix registers its outside-pointer listener on the next tick after opening. */
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  store = createRootStore();
  window.localStorage.clear();
  fit.mockClear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('phone bottom bar', () => {
  it('fits the canvas when it mounts, and every button is a 7-item bar', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    expect(within(bar()).getAllByRole('button')).toHaveLength(7);
    expect(barButton(/zoom 42%/)).toBeTruthy();
  });

  it('Select and Hand switch the tool and show which is active', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Hand tool, pan the canvas'));
    expect(store.editorUI.selectedTool).toBe('grab');
    expect(barButton('Hand tool, pan the canvas').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(barButton('Select tool'));
    expect(store.editorUI.selectedTool).toBe('select');
  });
});

describe('panel sheets', () => {
  it('Layers opens a modal sheet labelled by its title, holding the same left sidebar', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Pages and layers'));
    const sheet = screen.getByRole('dialog', { name: 'Pages and layers' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(within(sheet).getByTestId('pages-pane')).toBeTruthy();
    expect(within(sheet).getByTestId('layers-pane')).toBeTruthy();
    // Focus moved into the sheet.
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it('closes by its close button', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Pages and layers'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Pages and layers' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape without clearing the selection', () => {
    seedProject();
    const child = someChild();
    store.editorUI.selectComponent(child);
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton(/^Edit /));
    const sheet = screen.getByRole('dialog', { name: 'Properties' });
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      sheet.dispatchEvent(esc);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // EditorApp clears the selection on an Escape nobody handled; the sheet handled this one.
    expect(esc.defaultPrevented).toBe(true);
    expect(store.editorUI.selectedComponent?.id).toBe(child.id);
  });

  it('closes on a tap on the backdrop', async () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Pages and layers'));
    await tick();
    fireEvent.pointerDown(screen.getByTestId('layers-sheet-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a swipe down on its title row, a short drag does not', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Pages and layers'));
    const title = screen.getByText('Pages and layers', { selector: 'h2' });
    // react-remove-scroll (inside Radix) reads clientX from touches and changedTouches.
    const at = (clientY: number) => [{ clientX: 50, clientY }];
    const swipe = (to: number) => {
      fireEvent.touchStart(title, { touches: at(100), changedTouches: at(100) });
      fireEvent.touchMove(title, { touches: at(to), changedTouches: at(to) });
      fireEvent.touchEnd(title, { touches: [], changedTouches: at(to) });
    };
    swipe(130);
    expect(screen.getByRole('dialog')).toBeTruthy();
    swipe(260);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('only one sheet is open at a time', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Pages and layers'));
    expect(screen.getByRole('dialog', { name: 'Pages and layers' })).toBeTruthy();
    // The bar is hidden from assistive technology behind the modal sheet, but
    // the state allows only one sheet whatever opens the next one.
    const props = within(screen.getByTestId('phone-bottom-bar')).getByRole('button', { name: /^Edit |^Properties$/, hidden: true });
    fireEvent.click(props);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeTruthy();
  });
});

describe('selection on a phone', () => {
  it('the root the page selects by itself does not highlight Edit', () => {
    seedProject();
    expect(store.editorUI.selectedComponent).toBeTruthy();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    const edit = barButton(/^Edit /);
    expect(edit.className).not.toContain('bg-brand text-white');
  });

  it('a new selection highlights Edit, named after it, and does not open the sheet', () => {
    seedProject();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    const child = someChild();
    act(() => store.editorUI.selectComponent(child));
    const edit = barButton(`Edit ${child.displayName}`);
    expect(edit.className).toContain('bg-brand text-white');
    expect(screen.queryByRole('dialog')).toBeNull();
    // Opening it marks the selection as seen.
    fireEvent.click(edit);
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Properties' }));
    expect(barButton(`Edit ${child.displayName}`).className).not.toContain('bg-brand text-white');
  });

  it('with nothing selected the button reads Properties', () => {
    seedProject();
    act(() => store.editorUI.clearSelection());
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    expect(barButton('Properties')).toBeTruthy();
  });
});

describe('desktop state stays desktop', () => {
  it('opening and closing both sheets leaves collapse flags and the remembered width alone', () => {
    seedProject();
    const ui = store.editorUI;
    const before = { left: ui.leftSidebarCollapsed, right: ui.rightSidebarCollapsed, width: ui.leftSidebarWidth };
    render(<PhoneEditorChrome editorUI={ui} />);
    fireEvent.click(barButton('Pages and layers'));
    const layers = screen.getByRole('dialog', { name: 'Pages and layers' });
    // No desktop-only controls in the sheet.
    expect(within(layers).queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
    expect(within(layers).queryByRole('button', { name: /collapse sidebar/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Pages and layers' }));
    fireEvent.click(barButton(/^Edit |^Properties$/));
    const props = screen.getByRole('dialog', { name: 'Properties' });
    expect(within(props).queryByRole('button', { name: 'Collapse properties' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Properties' }));
    expect({ left: ui.leftSidebarCollapsed, right: ui.rightSidebarCollapsed, width: ui.leftSidebarWidth }).toEqual(before);
    expect(window.localStorage.getItem('framer-clone:left-sidebar-width')).toBeNull();
  });

  it('a sheet shows the panels even when the desktop sidebars are collapsed', () => {
    seedProject();
    store.editorUI.toggleLeftSidebar();
    store.editorUI.toggleRightSidebar();
    render(<PhoneEditorChrome editorUI={store.editorUI} />);
    fireEvent.click(barButton('Pages and layers'));
    expect(screen.getByTestId('layers-pane')).toBeTruthy();
    expect(store.editorUI.leftSidebarCollapsed).toBe(true);
  });
});

describe('narrowestFrame', () => {
  it('picks the narrowest frame (the phone breakpoint) for the opening fit', () => {
    const frames = [
      { x: 0, y: 0, width: 1280, height: 800 },
      { x: 1400, y: 0, width: 320, height: 600 },
      { x: 1800, y: 0, width: 768, height: 900 },
    ];
    expect(narrowestFrame(frames)).toEqual([frames[1]]);
    expect(narrowestFrame([])).toEqual([]);
  });
});
