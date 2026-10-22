// openProject: how the editor and Preview put a project in the shared store.
import { describe, it, expect, beforeEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { markServerVersion, openProject, pickPage } from '../openProject';
import { withDefaultViewports } from '@/lib/canvas/defaultViewports';

let store: RootStoreType;

function serverSnapshot(title = 'Untitled Project'): ProjectSnapshotOut {
  const p = ProjectModel.create({ id: 'site_1', metadata: { title, description: '' }, pages: {} });
  const home = p.createPage('test page');
  home.setSlug('');
  p.createPage('About');
  return getSnapshot(p) as ProjectSnapshotOut;
}

beforeEach(() => {
  store = createRootStore();
});

describe('openProject', () => {
  it('a fresh load ingests the server snapshot and opens the home page', () => {
    const snap = serverSnapshot();
    const out = openProject(store, snap);
    expect(out.keptWorkingCopy).toBe(false);
    expect(store.editorUI.currentProject?.id).toBe('site_1');
    expect(store.editorUI.currentPage?.slug).toBe(pickPage(out.project, null).page?.slug);
  });

  it('opens the page from ?page= when it exists', () => {
    const snap = serverSnapshot();
    const aboutId = Object.values(snap.pages).find((p) => p.metadata.title === 'About')!.id;
    const out = openProject(store, snap, aboutId);
    expect(out.page?.id).toBe(aboutId);
    expect(out.missingPageId).toBeUndefined();
  });

  it('an unknown ?page= falls back to home and reports it', () => {
    const out = openProject(store, serverSnapshot(), 'page-never-saved');
    expect(out.page).toBeDefined();
    expect(out.missingPageId).toBe('page-never-saved');
  });

  it('back from Preview: keeps the working copy (an unsaved generated page survives)', () => {
    openProject(store, serverSnapshot());
    const project = store.editorUI.currentProject!;
    const generated = project.createPage('Crumb & Hearth Bakery'); // not saved
    const out = openProject(store, serverSnapshot(), generated.id);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.page?.id).toBe(generated.id);
    expect(store.editorUI.currentProject?.getPage(generated.id)).toBeDefined();
  });

  it('keeping the working copy still takes the name from the server, outside undo history', () => {
    openProject(store, serverSnapshot('Old name'));
    openProject(store, serverSnapshot('Renamed on the dashboard'));
    expect(store.editorUI.currentProject?.metadata.title).toBe('Renamed on the dashboard');
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('a fresh load is not an undo step (Preview first, then Editor, then Cmd+Z used to delete the project)', () => {
    openProject(store, serverSnapshot()); // the preview's load
    openProject(store, serverSnapshot()); // "Editor": keeps the working copy
    expect(getHistoryStore()!.canUndo).toBe(false);
    getHistoryStore()!.undo();
    expect(store.projectStore.getProject('site_1')).toBeDefined();
  });

  it('undo history belongs to one project: switching project starts it afresh', () => {
    openProject(store, serverSnapshot());
    const other = ProjectModel.create({ id: 'site_2', metadata: { title: 'B', description: '' }, pages: {} });
    other.createPage('B home');
    openProject(store, getSnapshot(other) as ProjectSnapshotOut);
    store.editorUI.currentProject!.updateMetadata({ description: 'edited B' });
    expect(getHistoryStore()!.canUndo).toBe(true);
    openProject(store, serverSnapshot()); // back to A
    expect(getHistoryStore()!.canUndo).toBe(false);
  });
});

describe('openProject when the server copy changed meanwhile', () => {
  function savedElsewhere(): ProjectSnapshotOut {
    // Same project, a page added by another tab or person and saved.
    const snap = serverSnapshot();
    const p = ProjectModel.create(JSON.parse(JSON.stringify(snap)));
    p.createPage('Added elsewhere');
    return getSnapshot(p) as ProjectSnapshotOut;
  }

  it('no unsaved work here: takes the newer server copy', () => {
    openProject(store, serverSnapshot());
    const newer = savedElsewhere();
    const out = openProject(store, newer);
    expect(out.keptWorkingCopy).toBe(false);
    expect(out.changedElsewhere).toBe(false);
    expect(store.editorUI.currentProject!.pagesArray.map((p) => p.metadata.title)).toContain('Added elsewhere');
  });

  it('unsaved work here too: keeps it and reports the conflict', () => {
    openProject(store, serverSnapshot());
    store.editorUI.currentProject!.createPage('Generated here, not saved');
    const out = openProject(store, savedElsewhere());
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    expect(store.editorUI.currentProject!.pagesArray.map((p) => p.metadata.title)).toContain('Generated here, not saved');
  });

  it('after this tab saved, its own save is not mistaken for a change elsewhere', () => {
    openProject(store, serverSnapshot());
    const project = store.editorUI.currentProject!;
    project.createPage('Saved from here');
    const saved = getSnapshot(project) as unknown as ProjectSnapshotOut;
    markServerVersion(project.id, saved.pages);
    // The server now returns what this tab saved (key order may differ).
    const fromServer = JSON.parse(JSON.stringify(saved)) as ProjectSnapshotOut;
    const out = openProject(store, fromServer);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
  });

  it('a frameless page repaired on load compares equal on the next load', () => {
    const snap = JSON.parse(JSON.stringify(serverSnapshot())) as ProjectSnapshotOut;
    const firstPage = Object.keys(snap.pages)[0];
    (snap.pages[firstPage] as { canvasNodes: unknown }).canvasNodes = {};
    const repaired = { ...snap, pages: { ...snap.pages, [firstPage]: withDefaultViewports(snap.pages[firstPage]) } };
    openProject(store, repaired as ProjectSnapshotOut);
    const again = { ...snap, pages: { ...snap.pages, [firstPage]: withDefaultViewports(snap.pages[firstPage]) } };
    const out = openProject(store, again as ProjectSnapshotOut);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
  });

});

describe('restoreStashedDemo (back on `/` after choosing a company or signing in)', () => {
  it('brings the stashed demo project back as the demo, on the requested page', async () => {
    const { stashDemoProject } = await import('@/lib/projects/demoStash');
    const { restoreStashedDemo } = await import('../openProject');
    const demo = ProjectModel.create({ id: 'demo-1', metadata: { title: 'Framer Clone Demo', description: '' }, pages: {} });
    const page = demo.createPage('Generated');
    stashDemoProject(getSnapshot(demo));

    expect(restoreStashedDemo(store, page.id)).toBe(true);
    expect(store.editorUI.currentProject?.id).toBe('demo-1');
    expect(store.editorUI.currentPage?.id).toBe(page.id);
    expect(store.editorUI.isUnsavedDemo).toBe(true);
    // Taken once: a second mount seeds a fresh demo instead.
    expect(restoreStashedDemo(store, null)).toBe(false);
  });

  it('ignores a stash that is not a project', async () => {
    const { stashDemoProject } = await import('@/lib/projects/demoStash');
    const { restoreStashedDemo } = await import('../openProject');
    stashDemoProject({ nope: true });
    expect(restoreStashedDemo(store, null)).toBe(false);
    stashDemoProject({ id: 'x', pages: 'broken' });
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(restoreStashedDemo(store, null)).toBe(false);
    spy.mockRestore();
  });
});
