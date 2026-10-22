// /preview: previews the browser-only demo project from the store (it used to
// send it to /projects/<in-browser id>/preview, a 404).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';

let store: RootStoreType;
const replace = vi.fn();
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function PreviewShellStub({ missingPageId }: { missingPageId?: string }) {
      return <div data-testid="shell">{`${store.editorUI.currentPage?.id}|${missingPageId ?? ''}`}</div>;
    },
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import PreviewPage from '../page';

beforeEach(() => {
  store = createRootStore();
  replace.mockReset();
  window.history.replaceState(null, '', '/preview');
});
afterEach(() => cleanup());

function seedDemo() {
  store.projectStore.createProject('Framer Clone Demo');
  const demo = store.projectStore.findProjectByTitle('Framer Clone Demo')!;
  store.editorUI.setCurrentProject(demo);
  store.editorUI.markUnsavedDemo(demo.id);
  return demo;
}

describe('/preview', () => {
  it('previews the demo project from this tab, on the requested page', async () => {
    const demo = seedDemo();
    const page = demo.createPage('Generated');
    window.history.replaceState(null, '', `/preview?page=${page.id}`);
    render(<PreviewPage />);
    expect((await screen.findByTestId('shell')).textContent).toBe(`${page.id}|`);
    expect(replace).not.toHaveBeenCalled();
  });

  it('an unknown page shows the demo home with the notice', async () => {
    seedDemo();
    window.history.replaceState(null, '', '/preview?page=gone');
    render(<PreviewPage />);
    expect((await screen.findByTestId('shell')).textContent).toMatch(/\|gone$/);
  });

  it('a dashboard project in the store goes to its own preview, parameters kept', async () => {
    store.projectStore.createProject('Real');
    store.editorUI.setCurrentProject(store.projectStore.findProjectByTitle('Real'));
    window.history.replaceState(null, '', '/preview?page=p1&fullscreen=1');
    const id = store.editorUI.currentProject!.id;
    render(<PreviewPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/projects/${id}/preview?page=p1&fullscreen=1`));
  });

  it('a dashboard project open in this tab wins over an older demo', async () => {
    seedDemo();
    store.projectStore.createProject('Real');
    const real = store.projectStore.findProjectByTitle('Real')!;
    store.editorUI.setCurrentProject(real);
    render(<PreviewPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/projects/${real.id}/preview`));
  });

  it('nothing in this tab (after a full reload): says so and offers the way on', async () => {
    render(<PreviewPage />);
    expect(await screen.findByRole('heading', { name: 'Nothing to preview' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Your projects' }).getAttribute('href')).toBe('/projects');
  });
});
