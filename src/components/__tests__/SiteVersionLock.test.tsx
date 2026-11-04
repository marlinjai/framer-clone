// The version lock in the editor (src/stores/openProject.ts, SiteChangedDialog),
// on a REAL root store: a save (autosave, here made at once with Cmd+S; there
// is no Save button) and Publish send the version this tab's copy is based on,
// take the new one from the answer, and a 409 `site_changed` asks the person
// instead of overwriting. The four stateful-flow paths: forward (save,
// save again), a conflicting write in between (the dialog and each choice),
// resume after a reload (a fresh load adopts the server's version), and
// re-entry after a refused save (keep editing, then Cmd+S asks again).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { knownServerVersion, openProject } from '@/stores/openProject';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { resetAutosaveForTests } from '@/lib/projects/autosave';
import { handleSaveShortcut } from '@/lib/projects/saveShortcut';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import SaveStatus from '../SaveStatus';
import PublishButton from '../PublishButton';

const fetchMock = vi.fn();
let siteSeq = 0;

const snapshots = new Map<string, ProjectSnapshotOut>();
/**
 * The server copy of a site (its own id: the tab's version memory is per
 * project), the same content on every load, so only the version can differ.
 */
function serverSnapshot(id: string): ProjectSnapshotOut {
  const known = snapshots.get(id);
  if (known) return known;
  const p = ProjectModel.create({ id, metadata: { title: 'Site', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  const snapshot = getSnapshot(p) as ProjectSnapshotOut;
  snapshots.set(id, snapshot);
  return snapshot;
}

/** What /projects/<id> does: hydrate the server snapshot read at `version`. */
function openServerProject(version: number, id = `site_lock_${++siteSeq}`) {
  return openProject(store, serverSnapshot(id), null, version).project!;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200 });
}
function conflict(currentVersion: number) {
  return new Response(
    JSON.stringify({ error: { code: 'site_changed', message: 'changed elsewhere', currentVersion } }),
    { status: 409 },
  );
}
/** Change the working copy and press Cmd+S: the save goes out at once. */
let editSeq = 0;
async function editAndSave(project: { updateMetadata: (m: { description: string }) => void }) {
  // The status attaches autosave in an effect: wait for it, as a person would.
  await waitFor(() => expect(screen.getByTestId('save-status')).toBeTruthy());
  act(() => project.updateMetadata({ description: `edit ${++editSeq}` }));
  act(() => {
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
  });
}
function pressSave() {
  act(() => {
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
  });
}
function sentVersion(call: number): unknown {
  return JSON.parse(fetchMock.mock.calls[call][1].body).expectedVersion;
}

beforeEach(() => {
  resetAutosaveForTests();
  store = createRootStore();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Save and the version lock', () => {
  it('forward: sends the loaded version, adopts the answered one, and the next save sends that', async () => {
    const project = openServerProject(3);
    fetchMock
      .mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 4 }))
      .mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 5 }));
    render(<SaveStatus />);

    await editAndSave(project);
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(4));
    expect(sentVersion(0)).toBe(3);

    await editAndSave(project);
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(5));
    expect(sentVersion(1)).toBe(4);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a conflicting write in between: the dialog asks, "Save mine over it" sends the reported version', async () => {
    const project = openServerProject(3);
    fetchMock
      .mockResolvedValueOnce(conflict(9))
      .mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 10 }));
    render(<SaveStatus />);

    await editAndSave(project);
    const dialog = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    // Nothing adopted from a refusal: the tab is still based on version 3.
    expect(knownServerVersion(project.id)).toBe(3);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save mine over it' }));
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(10));
    expect(sentVersion(1)).toBe(9);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('save-status').textContent).toBe('Saved');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('save over it meets yet another write: refused again, the dialog stays with the newer number', async () => {
    const project = openServerProject(1);
    fetchMock
      .mockResolvedValueOnce(conflict(2))
      .mockResolvedValueOnce(conflict(3))
      .mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 4 }));
    render(<SaveStatus />);
    await editAndSave(project);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine over it' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine over it' }));
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(4));
    expect([sentVersion(0), sentVersion(1), sentVersion(2)]).toEqual([1, 2, 3]);
  });

  it('re-entry after a refused save: Keep editing closes without a request, and Cmd+S asks again', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9)).mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 10 }));
    render(<SaveStatus />);

    await editAndSave(project);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still based on version 3: a later save never silently wins. Cmd+S asks
    // again without a request the server would only refuse.
    pressSave();
    const again = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(knownServerVersion(project.id)).toBe(3);
    fireEvent.click(within(again).getByRole('button', { name: 'Save mine over it' }));
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(10));
    expect(sentVersion(1)).toBe(9);
  });

  it('"Load the newer version" reloads the page (the server copy opens, unsaved changes go)', async () => {
    const project = openServerProject(3);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    fetchMock.mockResolvedValueOnce(conflict(9));
    render(<SaveStatus />);
    await editAndSave(project);
    fireEvent.click(await screen.findByRole('button', { name: 'Load the newer version' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('"Save mine as a new project" keeps both: it opens the save-as dialog with the copy wording', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9));
    render(<SaveStatus />);
    await editAndSave(project);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine as a new project' }));
    const saveAs = await screen.findByRole('dialog', { name: 'Save as a new project' });
    expect(saveAs.textContent).toMatch(/Keeps both versions/);
    expect((within(saveAs).getByRole('textbox') as HTMLInputElement).value).toBe('Site (copy)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('another 409 (erased since load) is an error to read, never the "save over" choice', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'erased_since_load', message: 'Personal data was erased.' } }), {
        status: 409,
      }),
    );
    render(<SaveStatus />);
    await editAndSave(project);
    await waitFor(() => expect(screen.getByTestId('save-status-reason').textContent).toContain('Personal data was erased.'));
    expect(screen.getByTestId('save-status').textContent).toContain('Not saved');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Publish and the version lock', () => {
  it('sends the loaded version; on a conflict "Publish mine anyway" sends the reported one', async () => {
    const project = openServerProject(2);
    fetchMock
      .mockResolvedValueOnce(conflict(6))
      .mockResolvedValueOnce(ok({ publishedPages: [''], subdomain: 'x', version: 7 }));
    render(<PublishButton />);

    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    const dialog = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    expect(sentVersion(0)).toBe(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish mine anyway' }));
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(7));
    expect(sentVersion(1)).toBe(6);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).project.id).toBe(project.id);
  });

  it('a save after a publish sends the version the publish answered', async () => {
    const project = openServerProject(2);
    fetchMock
      .mockResolvedValueOnce(ok({ publishedPages: [''], subdomain: 'x', version: 3 }))
      .mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 4 }));
    render(
      <>
        <PublishButton />
        <SaveStatus />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(3));
    await editAndSave(project);
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(4));
    expect(sentVersion(1)).toBe(3);
  });
});

describe('a publish that committed before a later step failed', () => {
  it('shows the error and adopts the written version, so the next Save is not a conflict with itself', async () => {
    const project = openServerProject(2);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'subdomain_allocation_failed', message: 'No address.', writtenVersion: 3 } }),
          { status: 500 },
        ),
      )
      .mockResolvedValueOnce(ok({ siteId: project.id, savedPages: [''], version: 4 }));
    render(
      <>
        <PublishButton />
        <SaveStatus />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No address.'));
    expect(knownServerVersion(project.id)).toBe(3);
    await editAndSave(project);
    await waitFor(() => expect(knownServerVersion(project.id)).toBe(4));
    expect(sentVersion(1)).toBe(3);
  });
});

describe('resume after a reload (openProject)', () => {
  it('a version that moved while this tab had no unsaved work: the newer copy and its version are taken', () => {
    const id = `site_lock_${++siteSeq}`;
    openServerProject(3, id);
    openServerProject(5, id); // e.g. back from Preview after an agent wrote the site
    expect(knownServerVersion(id)).toBe(5);
  });

  it('a version that moved while this tab has unsaved work: the work is kept and so is the OLD version', () => {
    const id = `site_lock_${++siteSeq}`;
    const project = openServerProject(3, id);
    project.createPage('Unsaved page');
    const out = openProject(store, serverSnapshot(id), null, 5);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    // Its next Save must be refused and ask, not win.
    expect(knownServerVersion(id)).toBe(3);
  });

  it('the same version: unsaved work is kept with no warning', () => {
    const id = `site_lock_${++siteSeq}`;
    const project = openServerProject(3, id);
    project.createPage('Unsaved page');
    const out = openProject(store, serverSnapshot(id), null, 3);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
    expect(knownServerVersion(id)).toBe(3);
  });
});
