// The phone long-press menu: items per element, picking one runs it and
// closes, Escape and the scrim close it, and slide-to-select (the highlight
// follows the finger, lifting on an item runs it, lifting elsewhere keeps the
// menu, one selection tick per item change; haptics mocked).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import PhoneContextMenu, { scrimClipPath, slideMenuMove, slideMenuRelease } from '../PhoneContextMenu';

const tickSpy = vi.fn();
vi.mock('@/lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/haptics')>()),
  selectionTick: (key: string | null) => tickSpy(key),
  haptic: vi.fn(),
}));

let store: RootStoreType;

function setup() {
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Menu');
  const project = projectStore.findProjectByTitle('Menu')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.addChildren([createIntrinsicComponent('m-heading', 'h1', { children: 'Hello', style: { color: 'rgb(1, 2, 3)' } })]);
  const heading = page.findComponent('m-heading')!;
  const frames = page.sortedViewportNodes;
  const mobile = frames[frames.length - 1];
  editorUI.selectComponent(heading, mobile.breakpointId);
  getHistoryStore()!.clear();
  render(<PhoneContextMenu editorUI={editorUI} />);
  act(() => editorUI.openPhoneContextMenu({ x: 100, y: 200 }));
  return { editorUI, page, heading, main, mobile };
}

const item = (name: string) => document.querySelector<HTMLElement>(`[data-menu-item="${name}"]`)!;
/** Make document.elementFromPoint return `el` (jsdom has no layout). */
function pointAt(el: Element | null) {
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => el;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  tickSpy.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the menu', () => {
  it('lists the items for a text element and labels itself', () => {
    setup();
    expect(screen.getByRole('menu', { name: 'Actions for Heading' })).toBeTruthy();
    const names = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(names).toEqual(['Select parent', 'Edit text', 'Duplicate', 'Copy style', 'Delete']);
  });

  it('Copy style then Paste style on another element, one undo step', () => {
    const { editorUI, heading, main, mobile } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy style/ }));
    expect(editorUI.phoneContextMenu).toBeUndefined();
    expect(editorUI.copiedStyle).toEqual({ color: 'rgb(1, 2, 3)' });
    act(() => {
      editorUI.selectComponent(main, mobile.breakpointId);
      editorUI.openPhoneContextMenu({ x: 10, y: 10 });
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste style/ }));
    expect(main.getOwnResponsiveStyleValue('color', mobile.breakpointId)).toBe('rgb(1, 2, 3)');
    const history = getHistoryStore()!;
    expect(history.history.length).toBe(1);
    act(() => history.undo());
    expect(main.getOwnResponsiveStyleValue('color', mobile.breakpointId)).toBeUndefined();
    expect(heading).toBeTruthy();
  });

  it('Escape and a tap on the scrim close it', () => {
    const { editorUI } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(editorUI.phoneContextMenu).toBeUndefined();
    act(() => editorUI.openPhoneContextMenu({ x: 1, y: 1 }));
    fireEvent.click(screen.getByTestId('phone-context-menu-scrim'));
    expect(editorUI.phoneContextMenu).toBeUndefined();
  });

  it('closes when a text edit starts', () => {
    const { editorUI } = setup();
    expect(screen.getByTestId('phone-context-menu')).toBeTruthy();
    act(() => editorUI.closePhoneContextMenu());
    expect(screen.queryByTestId('phone-context-menu')).toBeNull();
  });

  it('the scrim has a hole where the element is', () => {
    expect(scrimClipPath(390, 844, null)).toBeUndefined();
    expect(scrimClipPath(390, 844, { left: 10, top: 20, width: 100, height: 50 })).toContain('evenodd');
  });
});

describe('slide-to-select', () => {
  it('the highlight follows the finger, one tick per item change', () => {
    const { editorUI } = setup();
    pointAt(item('duplicate'));
    act(() => slideMenuMove(editorUI, 0, 0));
    expect(item('duplicate').getAttribute('data-highlighted')).toBe('true');
    act(() => slideMenuMove(editorUI, 0, 2));
    expect(tickSpy).toHaveBeenCalledTimes(1);
    pointAt(item('copyStyle'));
    act(() => slideMenuMove(editorUI, 0, 40));
    expect(item('copyStyle').getAttribute('data-highlighted')).toBe('true');
    expect(item('duplicate').hasAttribute('data-highlighted')).toBe(false);
    expect(tickSpy).toHaveBeenCalledTimes(2);
    expect(tickSpy).toHaveBeenLastCalledWith('copyStyle');
    // Off the menu: no highlight, no tick for "nothing".
    pointAt(screen.getByTestId('phone-context-menu-scrim'));
    act(() => slideMenuMove(editorUI, 300, 600));
    expect(editorUI.phoneContextMenuHover).toBeUndefined();
    expect(tickSpy).toHaveBeenLastCalledWith(null);
  });

  it('lifting on an item runs it and closes the menu', () => {
    const { editorUI, page, main } = setup();
    const before = main.children.length;
    pointAt(item('duplicate'));
    act(() => slideMenuMove(editorUI, 0, 0));
    let ran = false;
    act(() => {
      ran = slideMenuRelease(editorUI, 0, 0);
    });
    expect(ran).toBe(true);
    expect(main.children.length).toBe(before + 1);
    expect(editorUI.phoneContextMenu).toBeUndefined();
    expect(page).toBeTruthy();
  });

  it('lifting outside the menu keeps it open for a tap', () => {
    const { editorUI } = setup();
    pointAt(screen.getByTestId('phone-context-menu-scrim'));
    let ran = true;
    act(() => {
      ran = slideMenuRelease(editorUI, 300, 600);
    });
    expect(ran).toBe(false);
    expect(editorUI.phoneContextMenu).toBeDefined();
    expect(screen.getByTestId('phone-context-menu')).toBeTruthy();
  });
});
