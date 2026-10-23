// The left sidebar's width handle: an accessible vertical separator that
// resizes by keyboard and pointer, resets on double-click, remembers the width
// and gets out of the way when the sidebar is collapsed.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import LeftSidebar from '../../LeftSidebar';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));
// The panes are covered by their own tests.
vi.mock('../PagesPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('../LayersPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('../ComponentsPanel', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/components/cms/ContentManagerPanel', () => ({ __esModule: true, default: () => <div /> }));

const KEY = 'framer-clone:left-sidebar-width';

beforeEach(() => {
  store = createRootStore();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const handle = () => screen.getByRole('separator', { name: 'Resize sidebar' });
const sidebarWidth = () => (handle().parentElement as HTMLElement).style.width;

describe('left sidebar width', () => {
  it('starts at the remembered width', () => {
    window.localStorage.setItem(KEY, '320');
    render(<LeftSidebar />);
    expect(sidebarWidth()).toBe('320px');
    expect(handle().getAttribute('aria-valuenow')).toBe('320');
    expect(handle().getAttribute('aria-valuemin')).toBe('220');
    expect(handle().getAttribute('aria-valuemax')).toBe('480');
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
  });

  it('Arrow keys step 16px within the limits, and the width is remembered', () => {
    render(<LeftSidebar />);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(sidebarWidth()).toBe('272px');
    expect(window.localStorage.getItem(KEY)).toBe('272');
    fireEvent.keyDown(handle(), { key: 'Home' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(sidebarWidth()).toBe('220px');
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(sidebarWidth()).toBe('480px');
  });

  it('a pointer drag resizes, clamped, and saves when released', () => {
    render(<LeftSidebar />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 256 });
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 356 }));
    });
    expect(sidebarWidth()).toBe('356px');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 2000 }));
      document.dispatchEvent(new MouseEvent('pointerup', { clientX: 2000 }));
    });
    expect(sidebarWidth()).toBe('480px');
    expect(window.localStorage.getItem(KEY)).toBe('480');
  });

  it('double-click resets to the default width', () => {
    window.localStorage.setItem(KEY, '400');
    render(<LeftSidebar />);
    fireEvent.doubleClick(handle());
    expect(sidebarWidth()).toBe('256px');
    expect(window.localStorage.getItem(KEY)).toBe('256');
  });

  it('the collapsed sidebar has no handle, and expands back to its width', () => {
    window.localStorage.setItem(KEY, '300');
    render(<LeftSidebar />);
    act(() => store.editorUI.toggleLeftSidebar());
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
    act(() => store.editorUI.toggleLeftSidebar());
    expect(sidebarWidth()).toBe('300px');
  });
});
