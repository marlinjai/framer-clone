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
// The frame's renderer is covered elsewhere; here: which page it shows, and
// whether it fills the window.
vi.mock('../PreviewFrame', () => ({
  __esModule: true,
  default: ({ page, fill }: { page: { id: string }; fill?: boolean }) => (
    <div data-testid="frame" data-fill={String(Boolean(fill))}>{page.id}</div>
  ),
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
  window.localStorage.clear();
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
    search = 'utm=x';
    render(<PreviewShell />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Page' }), { target: { value: homeId } });
    expect(screen.getByTestId('frame').textContent).toBe(homeId);
    expect(replaceState.mock.calls.at(-1)?.[2]).toBe(`/projects/site_1/preview?utm=x&page=${homeId}`);
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

  it('fills the window by default, without the device controls', () => {
    render(<PreviewShell />);
    expect(screen.getByTestId('frame').getAttribute('data-fill')).toBe('true');
    expect(screen.getByRole('button', { name: 'Device frame' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('combobox', { name: 'Breakpoint' })).toBeNull();
  });

  it('the device frame shows the breakpoint controls, and the choice is remembered', () => {
    render(<PreviewShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Device frame' }));
    expect(screen.getByTestId('frame').getAttribute('data-fill')).toBe('false');
    expect(screen.getByRole('combobox', { name: 'Breakpoint' })).toBeTruthy();
    cleanup();
    render(<PreviewShell />);
    expect(screen.getByTestId('frame').getAttribute('data-fill')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Device frame' }));
    cleanup();
    render(<PreviewShell />);
    expect(screen.getByTestId('frame').getAttribute('data-fill')).toBe('true');
  });

  it('still opens when storage throws (a private window)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<PreviewShell />);
    expect(screen.getByTestId('frame').getAttribute('data-fill')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Device frame' }));
    expect(screen.getByTestId('frame').getAttribute('data-fill')).toBe('false');
    get.mockRestore();
    set.mockRestore();
  });

  it('over the editor: "Editor" and Escape close it, and the address is left alone', () => {
    const onClose = vi.fn();
    render(<PreviewShell onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /editor/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Page' }), { target: { value: homeId } });
    expect(screen.getByTestId('frame').textContent).toBe(homeId);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('Escape does nothing at a preview route, or while typing in a field', () => {
    const onClose = vi.fn();
    render(<PreviewShell />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(push).not.toHaveBeenCalled();
    cleanup();
    render(<PreviewShell onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Page' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
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
      expect(replaceState).not.toHaveBeenCalled();
    });

    it('Esc ends it (the browser leaves fullscreen): the toolbar is back, the preview stays open', async () => {
      const onClose = vi.fn();
      render(<PreviewShell onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await screen.findByRole('button', { name: 'Exit fullscreen' });
      act(() => {
        current = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull();
      expect(screen.getByRole('combobox', { name: 'Page' })).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
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

    it('Escape leaves the in-window stand-in first, and only then closes the preview', async () => {
      (HTMLElement.prototype.requestFullscreen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
      const onClose = vi.fn();
      render(<PreviewShell onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await screen.findByRole('button', { name: 'Exit fullscreen' });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByRole('combobox', { name: 'Page' })).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
