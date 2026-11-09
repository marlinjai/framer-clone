// The notice when an agent deletes the page this editor has open, with Undo
// (../AgentDeletedPageWatcher.tsx and src/components/EditorNotice.tsx).

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { applyOperations } from '@/lib/siteOps/applyOps';
import { adoptServerCopy, isSaved, openProject, type ProjectContent } from '@/stores/openProject';
import type { AgentActivity } from '@/lib/projects/liveEvents';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import AgentDeletedPageWatcher, { DELETED_PAGE_LINE_WAIT_MS } from '../AgentDeletedPageWatcher';
import EditorNotice from '@/components/EditorNotice';

const presence = () => store.editorUI.livePresence as LivePresenceStore;

function serverSnapshot(): ProjectSnapshotOut {
  const p = ProjectModel.create({ id: 'site_notice', metadata: { title: 'Notice', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  p.createPage('About');
  return getSnapshot(p) as ProjectSnapshotOut;
}

async function agentWrites(from: ProjectSnapshotOut, ops: unknown[]): Promise<ProjectSnapshotOut> {
  const server = ProjectModel.create(from) as ProjectModelType;
  const outcome = await applyOperations(server, ops);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  return getSnapshot(server) as ProjectSnapshotOut;
}

const pageIdOf = (snap: ProjectSnapshotOut, title: string) => Object.values(snap.pages).find((p) => p.metadata.title === title)!.id;
const project = () => store.projectStore.getProject('site_notice')!;

/** The agent's end of the delete call, as the stream sends it. */
function deleteEnd(pageId: string, over: Partial<AgentActivity> = {}): AgentActivity {
  return { callId: 'del-1', agentId: 'a1', label: 'Claude', tool: 'apply_batch', phase: 'end', outcome: 'ok', pageId, changes: 1, deletedPages: 1, deletedPageIds: [pageId], at: new Date().toISOString(), ...over };
}

/** The feed line of an ended call, as the state event carries it. */
function lineFrom(a: AgentActivity) {
  return { id: a.callId, agentId: a.agentId, label: a.label, actorKind: 'key' as const, tool: a.tool, outcome: 'ok' as const, deletedPageIds: a.deletedPageIds, deletedPages: a.deletedPages, changes: a.changes, at: a.at };
}

let v1: ProjectSnapshotOut;
let aboutId: string;

beforeEach(() => {
  store = createRootStore();
  v1 = serverSnapshot();
  aboutId = pageIdOf(v1, 'About');
  openProject(store, v1, aboutId, 1);
  render(
    <>
      <AgentDeletedPageWatcher />
      <EditorNotice />
    </>,
  );
});

afterEach(() => {
  presence().reset();
  cleanup();
  vi.useRealTimers();
});

const working = () => getSnapshot(project()) as unknown as ProjectSnapshotOut & ProjectContent;
const undoButton = () => screen.queryByRole('button', { name: 'Undo: bring the page back' });

/** The agent deletes About in one batch, adopted here, its feed line after. */
async function agentDeletesAbout(extraOps: unknown[] = []) {
  const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }, ...extraOps]);
  act(() => {
    adoptServerCopy(store, v2, 2, 'Claude: delete a page');
  });
  act(() => presence().applyActivity(deleteEnd(aboutId, { changes: 1 + extraOps.length })));
}

describe('an agent deletes the open page', () => {
  it('says who deleted which page, and Undo brings it back and opens it', async () => {
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Claude: delete a page');
    });
    act(() => presence().applyActivity({ ...deleteEnd(aboutId), phase: 'start', outcome: undefined }));
    act(() => presence().applyActivity(deleteEnd(aboutId)));
    expect(store.editorUI.currentPage?.id).not.toBe(aboutId);
    expect(screen.getByRole('status')).toHaveTextContent('Claude deleted the page ‘About’.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo: bring the page back' }));
    expect(project().pages.has(aboutId)).toBe(true);
    expect(store.editorUI.currentPage?.id).toBe(aboutId);
    expect(store.editorUI.editorNotice).toBeUndefined();
    // The restored page is this tab's change now: autosave has something to save.
    expect(isSaved('site_notice', working())).toBe(false);
  });

  it('closes the notice and opens the page however it comes back (Cmd+Z, not the button)', async () => {
    await agentDeletesAbout();
    expect(screen.getByRole('status')).toHaveTextContent('Claude deleted the page ‘About’.');
    act(() => getHistoryStore()!.undo());
    expect(project().pages.has(aboutId)).toBe(true);
    expect(store.editorUI.currentPage?.id).toBe(aboutId);
    expect(store.editorUI.editorNotice).toBeUndefined();
  });

  it('offers no Undo when the agent\'s step also changed something else (undoing it would take that back too)', async () => {
    const homeId = pageIdOf(v1, 'Home');
    await agentDeletesAbout([{ op: 'insertNodes', pageId: homeId, nodes: [{ ref: 'hero', type: 'section' }] }]);
    expect(screen.getByRole('status')).toHaveTextContent('Claude deleted the page ‘About’.');
    expect(undoButton()).toBeNull();
  });

  it('replaces another notice that was showing', async () => {
    act(() => store.editorUI.setEditorNotice({ kind: 'missingPage', message: 'That page does not exist.' }));
    await agentDeletesAbout();
    expect(screen.getByRole('status')).toHaveTextContent('Claude deleted the page ‘About’.');
    expect(screen.getByRole('status')).not.toHaveTextContent('That page does not exist.');
  });

  it('also when the agent\'s line comes before the adoption', async () => {
    act(() => presence().applyActivity(deleteEnd(aboutId)));
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Claude: delete a page');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Claude deleted the page ‘About’.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo: bring the page back' }));
    expect(project().pages.has(aboutId)).toBe(true);
    expect(store.editorUI.currentPage?.id).toBe(aboutId);
  });

  it('offers no Undo once another step was applied after the agent\'s', async () => {
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Claude: delete a page');
    });
    act(() => presence().applyActivity(deleteEnd(aboutId)));
    expect(screen.getByRole('button', { name: 'Undo: bring the page back' })).toBeInTheDocument();
    // The person edits on: the agent's step is no longer the last one applied.
    act(() => project().createPage('Pricing'));
    expect(screen.queryByRole('button', { name: 'Undo: bring the page back' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Claude deleted the page ‘About’.');
  });

  it('shows nothing when the person deletes the open page in this tab', () => {
    act(() => {
      project().removePage(aboutId);
      store.editorUI.setCurrentPage(project().getPage(pageIdOf(v1, 'Home')));
    });
    act(() => presence().applyActivity(deleteEnd(aboutId)));
    expect(store.editorUI.editorNotice).toBeUndefined();
  });

  it('shows nothing when another person\'s save removed the page (no agent line names it)', async () => {
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Someone: saved changes');
    });
    expect(store.editorUI.editorNotice).toBeUndefined();
    expect(getHistoryStore()!.undoIdx).toBeGreaterThan(0);
  });

  it('never blames an agent with an old line, or one that explained an earlier delete', async () => {
    // Claude deleted About, the person undid it, and the page stood again (the same id).
    await agentDeletesAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Undo: bring the page back' }));
    expect(store.editorUI.currentPage?.id).toBe(aboutId);
    // Later another person deletes it: Claude's line is still in the feed, but it explained the first delete.
    const v3 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v3, 3, 'Someone: saved changes');
    });
    expect(store.editorUI.editorNotice).toBeUndefined();
  });

  it('ignores a line from long before the delete that names the page', async () => {
    act(() => presence().applyState({ agents: [], feed: [{ ...lineFrom(deleteEnd(aboutId)), at: new Date(Date.now() - 10 * 60_000).toISOString() }] }));
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Someone: saved changes');
    });
    expect(store.editorUI.editorNotice).toBeUndefined();
  });

  it('stops waiting for the agent\'s line after DELETED_PAGE_LINE_WAIT_MS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Claude: delete a page');
    });
    vi.setSystemTime(Date.now() + DELETED_PAGE_LINE_WAIT_MS + 1);
    act(() => presence().applyActivity(deleteEnd(aboutId, { at: new Date().toISOString() })));
    expect(store.editorUI.editorNotice).toBeUndefined();
  });

  it('shows nothing when the agent deletes another page', async () => {
    const homeId = pageIdOf(v1, 'Home');
    act(() => store.editorUI.setCurrentPage(project().getPage(homeId)));
    const v2 = await agentWrites(v1, [{ op: 'deletePage', pageId: aboutId }]);
    act(() => {
      adoptServerCopy(store, v2, 2, 'Claude: delete a page');
    });
    act(() => presence().applyActivity(deleteEnd(aboutId)));
    expect(store.editorUI.currentPage?.id).toBe(homeId);
    expect(store.editorUI.editorNotice).toBeUndefined();
  });
});
