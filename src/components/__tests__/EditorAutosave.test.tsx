// Autosave in the editor UI (SaveButton, useAutosave, the generator dialog) on
// a REAL root store, with fake timers and a mocked fetch: the Save button shows
// the state, the page warns before unloading unsaved or in-flight work, a 409
// opens the version lock dialog and pauses autosave until a choice writes, a
// generated page is saved at once, and the demo editor at `/` never autosaves.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { knownServerVersion, openProject } from '@/stores/openProject';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { AUTOSAVE_DEBOUNCE_MS, resetAutosaveForTests } from '@/lib/projects/autosave';
import type { PageGenHandlers, PageGenTransport } from '@/lib/ai/pageGen/client';
import type { PageGenRequest, PageGenResultPayload } from '@/lib/ai/pageGen/protocol';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import SaveButton from '../SaveButton';
import { GeneratePageDialog } from '../ai/GeneratePageDialog';

const fetchMock = vi.fn();
let seq = 0;

function serverSnapshot(id: string): ProjectSnapshotOut {
  const p = ProjectModel.create({ id, metadata: { title: 'Site', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  return getSnapshot(p) as ProjectSnapshotOut;
}
function openServerProject(version = 3): ProjectModelType {
  return openProject(store, serverSnapshot(`site_ui_${++seq}`), null, version).project!;
}
function ok(version: number) {
  return new Response(JSON.stringify({ savedPages: [''], version }), { status: 200 });
}
function conflict(currentVersion: number) {
  return new Response(JSON.stringify({ error: { code: 'site_changed', message: 'changed', currentVersion } }), { status: 409 });
}
const sentVersion = (call: number): unknown => JSON.parse(fetchMock.mock.calls[call][1].body).expectedVersion;
const saveButton = () => screen.getByRole('button', { name: /saved?|saving|unsaved|not saved/i });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const edit = (project: ProjectModelType, description: string) => act(() => project.updateMetadata({ description }));

/** Dispatch a beforeunload and report whether the page asked to stay. */
function unloadWarns(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetAutosaveForTests();
  store = createRootStore();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  resetAutosaveForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Save button shows autosave', () => {
  it('Saved, Unsaved changes, Saving..., Saved: one request after the debounce, none on open', async () => {
    const project = openServerProject(3);
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    render(<SaveButton />);
    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveButton().textContent).toBe('Saved');

    edit(project, 'Fresh bread');
    expect(saveButton().textContent).toBe('Unsaved changes');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/save');
    expect(saveButton().textContent).toBe('Saving...');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer(ok(4)));
    await advance(0);
    expect(saveButton().textContent).toBe('Saved');
    expect(knownServerVersion(project.id)).toBe(4);
    // An autosave pops no notice; only the label changed.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a server error is shown in the top bar, and the retry saves', async () => {
    const project = openServerProject(3);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'save_failed', message: 'Database down.' } }), { status: 500 }))
      .mockResolvedValueOnce(ok(4));
    render(<SaveButton />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(screen.getByRole('alert').textContent).toContain('Database down.');
    expect(saveButton().textContent).toBe('Not saved');
    await advance(2000);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saveButton().textContent).toBe('Saved');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('beforeunload', () => {
  it('warns while dirty and while a save is out, not when clean', async () => {
    const project = openServerProject(3);
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    render(<SaveButton />);
    expect(unloadWarns()).toBe(false);
    edit(project, 'draft');
    expect(unloadWarns()).toBe(true);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(unloadWarns()).toBe(true); // in flight
    await act(async () => answer(ok(4)));
    await advance(0);
    expect(unloadWarns()).toBe(false);
  });

  it('is gone once the editor closes', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValue(ok(4));
    const { unmount } = render(<SaveButton />);
    edit(project, 'draft');
    unmount(); // leaving to the overview flushes the pending save
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(unloadWarns()).toBe(false);
  });
});

describe('the version lock', () => {
  it('a 409 opens the dialog and pauses; Keep editing stays paused; Save asks again; Save mine over it resumes', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9)).mockResolvedValueOnce(conflict(9)).mockResolvedValueOnce(ok(10)).mockResolvedValueOnce(ok(11));
    render(<SaveButton />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    const dialog = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await advance(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('changed somewhere else');

    edit(project, 'more');
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unloadWarns()).toBe(true);

    fireEvent.click(saveButton());
    const again = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    expect(sentVersion(1)).toBe(3);
    fireEvent.click(within(again).getByRole('button', { name: 'Save mine over it' }));
    await advance(0);
    expect(sentVersion(2)).toBe(9);
    expect(knownServerVersion(project.id)).toBe(10);
    expect(screen.getByRole('status').textContent).toContain('Saved 1 page');

    edit(project, 'autosaving again');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sentVersion(3)).toBe(10);
  });

  it('"Load the newer version" reloads without the unload warning', async () => {
    const project = openServerProject(3);
    const reload = vi.fn(() => {
      expect(unloadWarns()).toBe(false);
    });
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    fetchMock.mockResolvedValueOnce(conflict(9));
    render(<SaveButton />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(await screen.findByRole('button', { name: 'Load the newer version' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the demo editor at /', () => {
  it('never autosaves and never warns; Save still offers Save as', async () => {
    const project = openServerProject(3);
    act(() => store.editorUI.markUnsavedDemo(project.id));
    render(<SaveButton />);
    edit(project, 'demo work');
    await advance(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unloadWarns()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: 'Save as a new project' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a generated page', () => {
  function manualTransport() {
    const calls: Array<{ req: PageGenRequest; handlers: PageGenHandlers; finish: () => void }> = [];
    const transport: PageGenTransport = (req, handlers) =>
      new Promise<void>((resolve) => {
        calls.push({ req, handlers, finish: resolve });
      });
    return { transport, calls };
  }
  function resultFor(req: PageGenRequest): PageGenResultPayload {
    const raw = { title: 'Bakery', nodes: [{ type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Bread' } }] }] };
    const out = validateGeneration(raw, { breakpoints: deriveBreakpointKeys(req.breakpoints) });
    if (!out.ok) throw new Error(out.errors.join('; '));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { imageRequests, ...result } = out.result;
    return { generationId: 'gen-1', model: 'claude-sonnet-5-5', ...result, images: { requested: 0, resolved: 0, fellBack: {}, credits: [] } };
  }

  it('is saved at once, and the dialog says Saved instead of asking for Save', async () => {
    window.localStorage.setItem('framer-clone:visual-review', JSON.stringify({ auto: false, model: 'SONNET' }));
    openServerProject(3);
    fetchMock.mockResolvedValueOnce(ok(4));
    const { transport, calls } = manualTransport();
    render(
      <>
        <SaveButton />
        <GeneratePageDialog open onOpenChange={() => {}} transport={transport} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'A bakery' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => {
      calls[0].handlers.onResult?.(resultFor(calls[0].req));
      calls[0].finish();
    });
    // No debounce: the request went out with the result.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(screen.getByText(/Added \d+ components? on a new page\. Saved\./)).toBeTruthy();
    expect(screen.queryByText(/Save the project to keep it/)).toBeNull();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
