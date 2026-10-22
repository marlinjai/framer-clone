// Save and Publish versus the browser-only demo project (`/`), on a REAL root
// store (the singleton every route of a tab shares).
//
// The owner's bug: visiting `/` set a demo flag on the shared UI state that
// nothing cleared, so a dashboard project opened later in the same tab
// refused to save ("This demo project exists only in this browser"). The demo
// state now belongs to the demo PROJECT: it applies only while that project
// is the current one, in either order of visits.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { openProject } from '@/stores/openProject';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import SaveButton from '../SaveButton';
import PublishButton from '../PublishButton';

const fetchMock = vi.fn();

/** What `/` does: seed the demo project and mark it as the demo. */
function visitDemo() {
  store.projectStore.createProject('Framer Clone Demo', 'demo');
  const demo = store.projectStore.findProjectByTitle('Framer Clone Demo')!;
  store.editorUI.setCurrentProject(demo);
  store.editorUI.setCurrentPage(demo.findPageBySlug(''));
  store.editorUI.markUnsavedDemo(demo.id);
  return demo;
}

/** What /projects/<id> does: hydrate the server snapshot. */
function openServerProject(id = 'site_real') {
  const p = ProjectModel.create({ id, metadata: { title: 'Untitled Project', description: '' }, pages: {} });
  p.createPage('test page');
  return openProject(store, getSnapshot(p) as ProjectSnapshotOut).project!;
}

beforeEach(() => {
  store = createRootStore();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ siteId: 'site_real', savedPages: [''] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('demo state belongs to the demo project', () => {
  it('visiting `/` first, then opening a dashboard project: Save calls the save route', async () => {
    visitDemo();
    openServerProject();
    expect(store.editorUI.isUnsavedDemo).toBe(false);
    render(<SaveButton />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/save', expect.anything()));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a dashboard project first, then `/`: the demo is the demo again (Save offers a new project)', async () => {
    openServerProject();
    visitDemo();
    expect(store.editorUI.isUnsavedDemo).toBe(true);
    render(<SaveButton />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('dialog', { name: 'Save as a new project' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('back to the dashboard project after the demo: Publish calls the publish route', async () => {
    visitDemo();
    openServerProject();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ publishedPages: [''], subdomain: 'x' }), { status: 200 }));
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/publish', expect.anything()));
  });

  it('in the demo, Publish points at Save instead of calling the server', () => {
    visitDemo();
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    expect(screen.getByRole('alert').textContent).toBe(
      'This demo project exists only in this browser. Save it as a project first (Save), then publish it from there.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switching project clears what was being edited or pointed at in the demo', () => {
    const demo = visitDemo();
    const frame = demo.findPageBySlug('')!.viewportNodes[0];
    store.editorUI.setSelectedViewportNode(frame);
    store.editorUI.beginTextEdit(demo.findPageBySlug('')!.appComponentTree);
    openServerProject();
    expect(store.editorUI.selectedViewportNode).toBeUndefined();
    expect(store.editorUI.editingComponent).toBeUndefined();
  });

  it('once saved as a project, the demo is no longer offered as the demo', () => {
    const demo = visitDemo();
    store.editorUI.consumeDemo();
    expect(store.editorUI.isUnsavedDemo).toBe(false);
    expect(store.editorUI.demoProjectId).toBeUndefined();
    expect(store.editorUI.consumedDemoProjectId).toBe(demo.id);
  });
});
