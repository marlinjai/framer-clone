// Preview of a project: the page the person was on, a page switcher, and every
// link and toggle staying inside THIS project's preview.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { openProject } from '@/stores/openProject';

let store: RootStoreType;
let pathname = '/projects/site_1/preview';
let search = '';
const replace = vi.fn();
const push = vi.fn();
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// The frame's renderer is covered elsewhere; here: which page it shows.
vi.mock('../PreviewFrame', () => ({
  __esModule: true,
  default: ({ page }: { page: { id: string } }) => <div data-testid="frame">{page.id}</div>,
}));
vi.mock('@/components/EditorCommerceProvider', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PreviewShell from '../PreviewShell';

let homeId: string;
let bakeryId: string;

let replaceState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  store = createRootStore();
  pathname = '/projects/site_1/preview';
  search = '';
  replace.mockReset();
  push.mockReset();
  const p = ProjectModel.create({ id: 'site_1', metadata: { title: 'Untitled Project', description: '' }, pages: {} });
  const home = p.createPage('test page');
  home.setSlug('');
  homeId = home.id;
  bakeryId = p.createPage('Crumb & Hearth Bakery').id;
  openProject(store, getSnapshot(p) as ProjectSnapshotOut, bakeryId);
});
afterEach(() => {
  cleanup();
  replaceState.mockRestore();
});

describe('PreviewShell', () => {
  it('shows the page the person was on', () => {
    render(<PreviewShell />);
    expect(screen.getByTestId('frame').textContent).toBe(bakeryId);
    expect((screen.getByRole('combobox', { name: 'Page' }) as HTMLSelectElement).value).toBe(bakeryId);
  });

  it('the page switcher shows another page and keeps it in the address, without a server reload', () => {
    search = 'fullscreen=1';
    render(<PreviewShell />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Page' }), { target: { value: homeId } });
    expect(screen.getByTestId('frame').textContent).toBe(homeId);
    expect(replaceState.mock.calls.at(-1)?.[2]).toBe(`/projects/site_1/preview?fullscreen=1&page=${homeId}`);
    expect(replace).not.toHaveBeenCalled();
  });

  it('pages with the same title are told apart by their address', () => {
    const p = store.editorUI.currentProject!;
    const twin = p.createPage('test page');
    render(<PreviewShell />);
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).toContain('test page (/)');
    expect(labels).toContain(`test page (/${twin.slug})`);
  });

  it('fullscreen stays on this project preview (it used to jump to /preview)', () => {
    search = `page=${bakeryId}`;
    render(<PreviewShell />);
    fireEvent.click(screen.getByRole('button', { name: /fullscreen/i }));
    expect(replaceState.mock.calls.at(-1)?.[2]).toBe(`/projects/site_1/preview?page=${bakeryId}&fullscreen=1`);
  });

  it('"Editor" returns to this project on this page (it used to open the demo editor at /)', () => {
    render(<PreviewShell />);
    fireEvent.click(screen.getByRole('button', { name: /editor/i }));
    expect(push).toHaveBeenCalledWith(`/projects/site_1?page=${bakeryId}`);
  });

  it('a page that is not in the saved project: says so (announced), shows home', async () => {
    render(<PreviewShell missingPageId="never-saved" />);
    const status = screen.getByRole('status');
    await waitFor(() => expect(status.textContent).toContain('not in the saved project'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('for the browser-only demo project, "Editor" goes back to the demo editor', () => {
    store.editorUI.markUnsavedDemo('site_1');
    pathname = '/preview';
    render(<PreviewShell />);
    fireEvent.click(screen.getByRole('button', { name: /editor/i }));
    expect(push).toHaveBeenCalledWith(`/?page=${bakeryId}`);
  });

  describe('fullscreen', () => {
    let current: Element | null;
    beforeEach(() => {
      current = null;
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
      HTMLElement.prototype.requestFullscreen = vi.fn(async function (this: HTMLElement) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        current = this;
        document.dispatchEvent(new Event('fullscreenchange'));
      });
    });
    afterEach(() => {
      delete (document as unknown as Record<string, unknown>).fullscreenElement;
      delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
    });

    it('the button enters real fullscreen: only the page, plus a way out', async () => {
      render(<PreviewShell />);
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await screen.findByRole('button', { name: 'Exit fullscreen' });
      expect(screen.queryByRole('combobox', { name: 'Page' })).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByTestId('frame')).toBeTruthy();
      expect(replaceState.mock.calls.at(-1)?.[2]).toBe('/projects/site_1/preview?fullscreen=1');
    });

    it('Esc ends it: the fitted preview is back and the param is removed', async () => {
      search = 'fullscreen=1';
      render(<PreviewShell />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Enter fullscreen' })[0]);
      await screen.findByRole('button', { name: 'Exit fullscreen' });
      act(() => {
        current = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull();
      expect(replaceState.mock.calls.at(-1)?.[2]).toBe('/projects/site_1/preview');
    });

    it('a load with ?fullscreen=1 fills the window and offers Enter fullscreen (no dead state)', () => {
      search = 'fullscreen=1';
      render(<PreviewShell />);
      expect(screen.getAllByRole('button', { name: 'Enter fullscreen' }).length).toBeGreaterThan(0);
      expect(screen.getByRole('combobox', { name: 'Page' })).toBeTruthy();
      expect(HTMLElement.prototype.requestFullscreen).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Show fitted preview' }));
      expect(replaceState.mock.calls.at(-1)?.[2]).toBe('/projects/site_1/preview');
    });

    it('F toggles fullscreen, but not while typing in a field', async () => {
      render(<PreviewShell />);
      const select = screen.getByRole('combobox', { name: 'Page' });
      fireEvent.keyDown(select, { key: 'f' });
      expect(HTMLElement.prototype.requestFullscreen).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'f' });
      await screen.findByRole('button', { name: 'Exit fullscreen' });
      expect(HTMLElement.prototype.requestFullscreen).toHaveBeenCalledTimes(1);
    });

    it('a rejected request still gives the chrome-free view and an exit', async () => {
      (HTMLElement.prototype.requestFullscreen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
      render(<PreviewShell />);
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      const exit = await screen.findByRole('button', { name: 'Exit fullscreen' });
      expect(screen.queryByRole('combobox', { name: 'Page' })).toBeNull();
      fireEvent.click(exit);
      expect(screen.getByRole('combobox', { name: 'Page' })).toBeTruthy();
    });
  });
});
