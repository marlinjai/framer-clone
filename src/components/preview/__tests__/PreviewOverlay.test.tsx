// The preview over the editor (src/components/preview/PreviewOverlay.tsx):
// opens at once from the store, owns one history entry so Back closes it,
// survives a reload through `?preview=1`, and hands focus back on close.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { openProject } from '@/stores/openProject';

let store: RootStoreType;
const push = vi.fn();
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../PreviewFrame', () => ({
  __esModule: true,
  default: ({ page }: { page: { id: string } }) => <div data-testid="frame">{page.id}</div>,
}));
vi.mock('@/components/EditorCommerceProvider', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PreviewOverlay, { previewRequestedInLocation } from '../PreviewOverlay';

let pageId: string;

function setAddress(search: string) {
  window.history.replaceState(null, '', `/projects/site_1${search}`);
}

beforeEach(() => {
  window.localStorage.clear();
  setAddress(`?page=x`);
  push.mockReset();
  store = createRootStore();
  const p = ProjectModel.create({ id: 'site_1', metadata: { title: 'Site' }, pages: {} });
  const home = p.createPage('Home');
  home.setSlug('');
  pageId = home.id;
  openProject(store, getSnapshot(p) as ProjectSnapshotOut, pageId);
});
afterEach(() => {
  cleanup();
  setAddress('');
});

function Harness() {
  return (
    <>
      <button type="button" onClick={() => store.editorUI.setPreviewOpen(true)}>
        Preview
      </button>
      <PreviewOverlay />
    </>
  );
}

describe('PreviewOverlay', () => {
  it('nothing is shown until the preview is opened', () => {
    render(<Harness />);
    expect(screen.queryByTestId('preview-overlay')).toBeNull();
  });

  it('opens at once over the editor, on the page being edited, filling the window', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const dialog = screen.getByRole('dialog', { name: 'Preview' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('frame').textContent).toBe(pageId);
    expect(push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dialog);
  });

  it('adds one history entry, so Back closes it and keeps the editor address', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(previewRequestedInLocation()).toBe(true);
    expect(window.location.search).toContain('page=x');
    // The browser's Back: the address loses the parameter, then popstate.
    act(() => {
      setAddress('?page=x');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.queryByTestId('preview-overlay')).toBeNull();
    expect(store.editorUI.previewOpen).toBe(false);
    pushState.mockRestore();
  });

  it('"Editor" steps back over its own entry (no stale Forward), and focus returns to Preview', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
      setAddress('?page=x');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Preview' });
    trigger.focus();
    fireEvent.click(trigger);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /editor/i }));
    });
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('preview-overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    back.mockRestore();
  });

  it('opened by a reload with ?preview=1: no extra entry, and closing just drops the parameter', () => {
    setAddress('?page=x&preview=1');
    const pushState = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back');
    store.editorUI.setPreviewOpen(true);
    render(<Harness />);
    expect(screen.getByTestId('preview-overlay')).toBeTruthy();
    expect(pushState).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(back).not.toHaveBeenCalled();
    expect(screen.queryByTestId('preview-overlay')).toBeNull();
    expect(window.location.search).toBe('?page=x');
    pushState.mockRestore();
    back.mockRestore();
  });

  it('Forward after Back opens it again', () => {
    render(<Harness />);
    act(() => {
      setAddress('?page=x&preview=1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('preview-overlay')).toBeTruthy();
  });

  it('opening closes the phone long-press menu', () => {
    store.editorUI.openPhoneContextMenu({ x: 10, y: 10 });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(store.editorUI.phoneContextMenu).toBeUndefined();
  });
});
