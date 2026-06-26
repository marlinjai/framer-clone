// ProjectStore hydration tests (MT-08).
//
// The editor shell no longer fabricates a demo project on mount; instead it
// ingests a server-loaded snapshot and selects it. This asserts the store-level
// contract that EditorApp relies on: ingestProjectSnapshot + setCurrentProject
// + setCurrentPage switch cleanly between two snapshots with no stale
// safeReference left pointing at the previous project.
import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore } from '@/stores/RootStore';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

// Build a real project snapshot by seeding a throwaway store, then renaming it
// so two snapshots have distinct ids AND titles.
function makeSnapshot(title: string): ProjectSnapshotOut {
  const store = createRootStore();
  store.projectStore.createProject(title, `${title} description`);
  const project = store.projectStore.findProjectByTitle(title)!;
  return getSnapshot(project);
}

describe('ProjectStore hydration (MT-08)', () => {
  it('ingests a snapshot and selects its home page', () => {
    const snapshot = makeSnapshot('Alpha');
    const store = createRootStore();

    const id = store.projectStore.ingestProjectSnapshot(snapshot);
    expect(id).toBe(snapshot.id);

    const project = store.projectStore.getProject(id);
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(project?.findPageBySlug(''));

    expect(store.editorUI.currentProject?.id).toBe(snapshot.id);
    expect(store.editorUI.currentProject?.metadata.title).toBe('Alpha');
    // Home page has slug '' and was selected.
    expect(store.editorUI.currentPage?.slug).toBe('');
    expect(store.editorUI.currentPage).toBeDefined();
  });

  it('hydrating snapshot A then snapshot B switches currentProject cleanly', () => {
    const snapA = makeSnapshot('Alpha');
    const snapB = makeSnapshot('Beta');
    expect(snapA.id).not.toBe(snapB.id);

    const store = createRootStore();

    // Hydrate A.
    const idA = store.projectStore.ingestProjectSnapshot(snapA);
    const projectA = store.projectStore.getProject(idA);
    store.editorUI.setCurrentProject(projectA);
    store.editorUI.setCurrentPage(projectA?.findPageBySlug(''));
    expect(store.editorUI.currentProject?.id).toBe(snapA.id);
    expect(store.editorUI.currentProject?.metadata.title).toBe('Alpha');

    // Hydrate B and re-point selection.
    const idB = store.projectStore.ingestProjectSnapshot(snapB);
    const projectB = store.projectStore.getProject(idB);
    store.editorUI.setCurrentProject(projectB);
    store.editorUI.setCurrentPage(projectB?.findPageBySlug(''));

    // currentProject follows the latest ingested/selected snapshot — no stale
    // safeReference left on A.
    expect(store.editorUI.currentProject?.id).toBe(snapB.id);
    expect(store.editorUI.currentProject?.metadata.title).toBe('Beta');
    expect(store.editorUI.currentPage).toBeDefined();
  });
});
