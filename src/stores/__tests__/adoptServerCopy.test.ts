// adoptServerCopy: an outside write (an agent's batch, another person's save)
// adopted into the open editor as one undo step, keeping node identity and
// moving the version this tab knows (plan docs/plans/2026-11-08-live-agent-canvas.md).
import { describe, it, expect, beforeEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut, type ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { applyOperations } from '@/lib/siteOps/applyOps';
import {
  adoptServerCopy,
  isApplyingServerCopy,
  isSaved,
  knownServerVersion,
  openProject,
} from '../openProject';

let store: RootStoreType;

function serverSnapshot(): ProjectSnapshotOut {
  const p = ProjectModel.create({ id: 'site_adopt', metadata: { title: 'Adopt', description: '' }, pages: {} });
  const home = p.createPage('Home');
  home.setSlug('');
  p.createPage('About');
  return getSnapshot(p) as ProjectSnapshotOut;
}

/** The server's copy after an agent's batch on `from`. */
async function agentWrites(from: ProjectSnapshotOut, ops: unknown[]): Promise<{ snapshot: ProjectSnapshotOut; created: Record<string, string> }> {
  const server = ProjectModel.create(from) as ProjectModelType;
  const outcome = await applyOperations(server, ops);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  return { snapshot: getSnapshot(server) as ProjectSnapshotOut, created: outcome.created };
}

const homeId = (snap: ProjectSnapshotOut) => Object.values(snap.pages).find((p) => p.slug === '')!.id;
const root = (store: RootStoreType) => store.editorUI.currentPage!.appComponentTree as ComponentInstance;

beforeEach(() => {
  store = createRootStore();
});

describe('adoptServerCopy', () => {
  it('adopts a newer copy as one labelled undo step and moves the known version', async () => {
    const v1 = serverSnapshot();
    openProject(store, v1, null, 1);
    const { snapshot: v2, created } = await agentWrites(v1, [
      { op: 'insertNodes', pageId: homeId(v1), nodes: [{ ref: 'hero', type: 'section', children: [{ ref: 'title', type: 'h1', props: { children: 'Hello' } }] }] },
    ]);

    const out = adoptServerCopy(store, v2, 2, 'Agent: insert 1 node');

    expect(out?.recorded).toBe(true);
    expect(out?.created).toEqual([created.hero, created.title]);
    expect(knownServerVersion('site_adopt')).toBe(2);
    // The store equals what the server holds: nothing for autosave to write.
    expect(isSaved('site_adopt', getSnapshot(store.editorUI.currentProject!))).toBe(true);
    const history = getHistoryStore()!;
    expect(history.history).toHaveLength(1);
    expect(history.labelFor(history.history[0])).toBe('Agent: insert 1 node');
    expect(isApplyingServerCopy()).toBe(false);
  });

  it('keeps the identity of unchanged nodes, the open page and the selection', async () => {
    const v1 = serverSnapshot();
    openProject(store, v1, null, 1);
    const page = store.editorUI.currentPage!;
    const pageRoot = root(store);
    const { snapshot: v2 } = await agentWrites(v1, [
      { op: 'insertNodes', pageId: homeId(v1), nodes: [{ type: 'p', props: { children: 'New' } }] },
    ]);

    adoptServerCopy(store, v2, 2, 'Agent');

    expect(store.editorUI.currentPage).toBe(page);
    expect(root(store)).toBe(pageRoot);
  });

  it('undo across an adopted version restores the exact earlier copy; redo brings the write back', async () => {
    const v1 = serverSnapshot();
    openProject(store, v1, null, 1);
    const before = getSnapshot(store.editorUI.currentProject!);
    const { snapshot: v2 } = await agentWrites(v1, [
      { op: 'insertNodes', pageId: homeId(v1), nodes: [{ type: 'section', children: [{ type: 'h2', props: { children: 'A' } }] }] },
    ]);
    adoptServerCopy(store, v2, 2, 'Agent');
    const adopted = getSnapshot(store.editorUI.currentProject!);

    getHistoryStore()!.undo();
    expect(getSnapshot(store.editorUI.currentProject!)).toEqual(before);
    // The undone state is this tab's own change now: autosave writes it on version 2.
    expect(isSaved('site_adopt', getSnapshot(store.editorUI.currentProject!))).toBe(false);
    expect(knownServerVersion('site_adopt')).toBe(2);

    getHistoryStore()!.redo();
    expect(getSnapshot(store.editorUI.currentProject!)).toEqual(adopted);
    // Undo then redo leaves the copy equal to the saved one: nothing to write.
    expect(isSaved('site_adopt', getSnapshot(store.editorUI.currentProject!))).toBe(true);
  });

  it("keeps the person's earlier undo steps applicable after an adoption", async () => {
    const v1 = serverSnapshot();
    openProject(store, v1, null, 1);
    const project = store.editorUI.currentProject!;
    project.updateMetadata({ description: 'mine' });
    const afterMine = getSnapshot(project);
    // The server holds this tab's edit at version 2 (autosave), then the agent writes version 3.
    const { snapshot: v3 } = await agentWrites(afterMine as ProjectSnapshotOut, [
      { op: 'insertNodes', pageId: homeId(v1), nodes: [{ type: 'p', props: { children: 'Agent' } }] },
    ]);
    adoptServerCopy(store, v3, 3, 'Agent');

    const history = getHistoryStore()!;
    history.undo(); // the agent's write
    expect(getSnapshot(project)).toEqual(afterMine);
    history.undo(); // the person's own edit
    expect(project.metadata.description).toBe('');
  });

  it('refuses a copy that is not newer than the version this tab knows', async () => {
    const v1 = serverSnapshot();
    openProject(store, v1, null, 3);
    const { snapshot: older } = await agentWrites(v1, [
      { op: 'insertNodes', pageId: homeId(v1), nodes: [{ type: 'p' }] },
    ]);
    expect(adoptServerCopy(store, older, 2, 'Agent')).toBeNull();
    expect(adoptServerCopy(store, older, 3, 'Agent')).toBeNull();
    expect(getHistoryStore()!.history).toHaveLength(0);
    expect(knownServerVersion('site_adopt')).toBe(3);
  });

  it('a newer version with the same content moves the version and records no step', () => {
    const v1 = serverSnapshot();
    openProject(store, v1, null, 1);
    const out = adoptServerCopy(store, v1, 2, 'Agent');
    expect(out).toEqual({ created: [], changed: [], recorded: false });
    expect(knownServerVersion('site_adopt')).toBe(2);
    expect(getHistoryStore()!.history).toHaveLength(0);
  });

  it('opens another page when the page on screen was deleted over there', () => {
    const v1 = serverSnapshot();
    const aboutId = Object.values(v1.pages).find((p) => p.metadata.title === 'About')!.id;
    openProject(store, v1, aboutId, 1);
    const pages = { ...v1.pages };
    delete pages[aboutId];
    adoptServerCopy(store, { ...v1, pages }, 2, 'Someone');
    expect(store.editorUI.currentPage?.id).toBe(homeId(v1));
  });
});
