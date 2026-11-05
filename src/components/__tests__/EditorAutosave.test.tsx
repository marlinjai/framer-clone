// Autosave in the editor UI (SaveStatus, UnsavedWorkGuard, useAutosave, the
// generator dialog) on a REAL root store, with fake timers and a mocked fetch.
// There is no Save button (owner, 2026-11-04): the top bar's status shows the
// state (Saving… only past 300 ms), a failure has Retry, a 409 shows "Changed
// elsewhere" that reopens the version lock dialog, the page warns before
// unloading unsaved work of any project of the tab (also one left behind,
// which a notice names), a reload on purpose never warns, a generated page is
// saved at once, and the demo editor at `/` offers "Keep as project" and never
// autosaves.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { knownServerVersion, openProject } from '@/stores/openProject';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { AUTOSAVE_DEBOUNCE_MS, existingAutosave, resetAutosaveForTests } from '@/lib/projects/autosave';
import { handleSaveShortcut } from '@/lib/projects/saveShortcut';
import type { PageGenHandlers, PageGenTransport } from '@/lib/ai/pageGen/client';
import type { PageGenRequest, PageGenResultPayload } from '@/lib/ai/pageGen/protocol';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import SaveStatus from '../SaveStatus';
import EditorAutosave from '../EditorAutosave';
import UnsavedWorkGuard from '../UnsavedWorkGuard';
import PublishButton from '../PublishButton';
import EditorNotice from '../EditorNotice';
import { GeneratePageDialog } from '../ai/GeneratePageDialog';
import { SAVING_LABEL_DELAY_MS } from '@/hooks/useAutosave';

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
function failure(status: number, message: string) {
  return new Response(JSON.stringify({ error: { code: 'x', message } }), { status });
}
function ok(version: number) {
  return new Response(JSON.stringify({ savedPages: [''], version }), { status: 200 });
}
function conflict(currentVersion: number) {
  return new Response(JSON.stringify({ error: { code: 'site_changed', message: 'changed', currentVersion } }), { status: 409 });
}
const sentVersion = (call: number): unknown => JSON.parse(fetchMock.mock.calls[call][1].body).expectedVersion;
const status = () => screen.getByTestId('save-status');
const label = () => status().textContent ?? '';
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const edit = (project: ProjectModelType, description: string) => act(() => project.updateMetadata({ description }));

/** The editor's chrome: the top bar's status and the tab-wide guard. */
function Editor() {
  return (
    <>
      <EditorAutosave />
      <SaveStatus />
      <UnsavedWorkGuard />
    </>
  );
}

function pending() {
  let answer: (r: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
  return (r: Response) => act(async () => answer(r));
}

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

describe('the top bar has a save status, not a Save button', () => {
  it('renders no Save button, and an always-present polite announcement region', async () => {
    openServerProject(3);
    render(<Editor />);
    await advance(0);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    const region = screen.getByTestId('save-announcement');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(label()).toBe('Saved');
    // Nothing to act on: the status itself is not a stop for the keyboard.
    expect(status().querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('Saved, Unsaved changes, then straight to Saved for a quick save: no request on open, never "Saving…"', async () => {
    // Strict fake time: real time on a loaded machine must not leak into the 300 ms window.
    vi.useRealTimers();
    vi.useFakeTimers();
    const project = openServerProject(3);
    const answer = pending();
    render(<Editor />);
    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(label()).toBe('Saved');

    edit(project, 'Fresh bread');
    expect(label()).toBe('Unsaved changes');
    edit(project, 'Fresh bread and rolls'); // typing on: no flashing
    expect(label()).toBe('Unsaved changes');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/save');
    await advance(SAVING_LABEL_DELAY_MS - 100);
    expect(label()).toBe('Unsaved changes');
    await answer(ok(4));
    await advance(0);
    expect(label()).toBe('Saved');
    await advance(1000);
    expect(label()).toBe('Saved');
    expect(knownServerVersion(project.id)).toBe(4);
  });

  it('a save slower than 300 ms says "Saving…" from 300 ms on, then Saved', async () => {
    // Strict fake time: real time on a loaded machine must not leak into the 300 ms window.
    vi.useRealTimers();
    vi.useFakeTimers();
    const project = openServerProject(3);
    const answer = pending();
    render(<Editor />);
    edit(project, 'slow');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(SAVING_LABEL_DELAY_MS - 1);
    expect(label()).toBe('Unsaved changes');
    await advance(1);
    expect(label()).toBe('Saving…');
    await answer(ok(4));
    await advance(0);
    expect(label()).toBe('Saved');
  });

  it('Cmd+S saves at once with no other UI, and the status follows', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(ok(4));
    render(<Editor />);
    edit(project, 'right now');
    const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true });
    act(() => {
      handleSaveShortcut(event, store.editorUI);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(label()).toBe('Saved');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a server error shows Not saved with the reason and Retry; the automatic retry saves', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(500, 'Database down.')).mockResolvedValueOnce(ok(4));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(label()).toContain('Not saved');
    expect(screen.getByTestId('save-status-reason').textContent).toContain('Database down.');
    expect(screen.getByTestId('save-status-reason').textContent).toContain('Trying again in 2 s');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await advance(2000);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(label()).toBe('Saved');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a refusal waits for Retry; Retry saves and autosave goes on', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(403, 'Not an admin.')).mockResolvedValueOnce(ok(4)).mockResolvedValueOnce(ok(5));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(screen.getByTestId('save-status-reason').textContent).toMatch(/Not an admin\. You do not have permission/);
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(label()).toBe('Saved');
    edit(project, 'after the retry');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('signed out (401): the reason, "Sign in again" in a new tab, and Retry', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(401, 'authentication required'));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(screen.getByTestId('save-status-reason').textContent).toContain('You are signed out.');
    const link = screen.getByRole('link', { name: /Sign in again/ });
    expect(link.getAttribute('href')).toBe('/projects');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('too large (413): says the limit and what to remove, not just "try again"', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(413, 'body too large'));
    render(<Editor />);
    edit(project, 'huge');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    const reason = screen.getByTestId('save-status-reason').textContent ?? '';
    expect(reason).toContain('larger than the 10 MB a save can take');
    expect(reason).toContain('Remove large embedded content');
  });
});

describe('the full reason on the wide bar', () => {
  it('a Details disclosure the keyboard reaches shows the whole reason', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(413, 'body too large'));
    render(<Editor />);
    edit(project, 'huge');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByTestId('save-status-details');
    expect(details.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.textContent).toContain('larger than the 10 MB a save can take');
    // Focus elsewhere, or Escape handled by something else: it stays open.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.getByTestId('save-status-details')).toBeTruthy();
    details.focus();
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => {
      document.dispatchEvent(handled);
    });
    expect(screen.getByTestId('save-status-details')).toBeTruthy();
    // Focus in the status: Escape closes it and the focus stays on Details.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByTestId('save-status-details')).toBeNull();
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(details);
    elsewhere.remove();
  });
});

describe('Cmd+S on the projects overview', () => {
  it('keeps the browser dialog away and saves a project left behind at once', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(403, 'Not an admin.')).mockResolvedValueOnce(ok(4));
    const { rerender } = render(<Editor />);
    await advance(0);
    edit(project, 'left behind');
    rerender(<UnsavedWorkGuard saveShortcut />); // the overview
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(0);
    expect(unloadWarns()).toBe(false);
  });
});

describe('Cmd+S on the overview with a project changed elsewhere', () => {
  it('opens no dialog and sends nothing; the notice says to go back to resolve it', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9));
    const { rerender } = render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep editing' }));
    await advance(0);
    rerender(<UnsavedWorkGuard saveShortcut />);
    await advance(0);
    const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existingAutosave(project.id)?.getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    expect(screen.getByTestId('unsaved-work-notice').textContent).toContain('Changed elsewhere: go back to it to choose what to keep.');
  });
});

describe('leaving with two projects unsaved', () => {
  it('the project on screen takes the keepalive budget first; the other goes as a normal request when it does not fit', async () => {
    const left = openServerProject(3);
    const { rerender } = render(<Editor />);
    await advance(0);
    fetchMock.mockResolvedValueOnce(failure(503, 'Busy.'));
    act(() => left.updateMetadata({ description: 'x'.repeat(40 * 1024) }));
    rerender(<UnsavedWorkGuard />);
    await advance(0);
    const shown = openServerProject(3);
    rerender(<Editor />);
    await advance(0);
    edit(shown, 'y'.repeat(30 * 1024));
    fetchMock.mockResolvedValue(ok(4));
    fetchMock.mockClear();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    const sentFor = (id: string) => fetchMock.mock.calls.find((c) => JSON.parse(c[1].body).project.id === id)![1];
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).project.id).toBe(shown.id);
    expect(sentFor(shown.id).keepalive).toBe(true);
    expect(sentFor(left.id).keepalive).toBeUndefined();
  });
});

describe('what a screen reader hears', () => {
  const announced = () => screen.getByTestId('save-announcement').textContent ?? '';

  it('nothing for ordinary typing and saving; the failure; then Saved once', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(ok(4)).mockResolvedValueOnce(failure(500, 'Database down.')).mockResolvedValueOnce(ok(5));
    render(<Editor />);
    edit(project, 'one');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(label()).toBe('Saved');
    expect(announced()).toBe('');
    edit(project, 'two');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(announced()).toContain('Not saved. Database down.');
    await advance(2000);
    await advance(0);
    expect(label()).toBe('Saved');
    expect(announced()).toBe('Saved.');
  });

  it('the conflict is announced', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(announced()).toContain('changed somewhere else');
  });
});

describe('the retry countdown', () => {
  it('ticks once a second while shown', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(503, 'Busy.')).mockResolvedValueOnce(failure(503, 'Busy.'));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    const reason = () => screen.getByTestId('save-status-reason').textContent ?? '';
    expect(reason()).toContain('Trying again in 2 s');
    await advance(1000);
    expect(reason()).toContain('Trying again in 1 s');
  });
});

describe('leaving the page', () => {
  it('pagehide commits and sends the unsaved copy as a keepalive request', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(ok(4));
    render(<Editor />);
    await advance(0);
    edit(project, 'last words');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).project.metadata.description).toBe('last words');
  });

  it('a hidden tab sends it too; back online, a waiting retry goes at once', async () => {
    const project = openServerProject(3);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok(4));
    render(<Editor />);
    await advance(0);
    edit(project, 'hidden');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(label()).toContain('Not saved');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(0);
    expect(label()).toBe('Saved');
  });

  it('a "Load the newer version" the person cancels (Stay) leaves autosave and the warning working', async () => {
    const project = openServerProject(3);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    fetchMock.mockResolvedValueOnce(conflict(9));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(await screen.findByRole('button', { name: 'Load the newer version' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(unloadWarns()).toBe(false);
    // Time alone re-arms nothing (a slow reload is still a reload).
    await advance(5000);
    expect(unloadWarns()).toBe(false);
    // The person stayed and uses the page: the conflict stands, and so does the warning.
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(unloadWarns()).toBe(true);
  });
});

describe('beforeunload, for every project of the tab', () => {
  it('warns while dirty and while a save is out, not when clean', async () => {
    const project = openServerProject(3);
    const answer = pending();
    render(<Editor />);
    await advance(0);
    expect(unloadWarns()).toBe(false);
    edit(project, 'draft');
    expect(unloadWarns()).toBe(true);
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(unloadWarns()).toBe(true); // in flight
    await answer(ok(4));
    await advance(0);
    expect(unloadWarns()).toBe(false);
  });

  it('leaving the editor saves a pending change at once; once saved, nothing warns', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValue(ok(4));
    const { rerender } = render(<Editor />);
    await advance(0);
    edit(project, 'draft');
    // To the overview: the status goes, the guard (in the layout) stays.
    rerender(<UnsavedWorkGuard />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(unloadWarns()).toBe(false);
  });

  it('a project left with a failed save still warns, and a notice names it with a way back', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(401, 'authentication required'));
    const { rerender } = render(<Editor />);
    await advance(0);
    edit(project, 'not on the server');
    rerender(<UnsavedWorkGuard />);
    await advance(0);
    expect(unloadWarns()).toBe(true);
    const notice = screen.getByTestId('unsaved-work-notice');
    // The visible notice is no live region; its own polite region announced it once.
    expect(notice.getAttribute('role')).toBeNull();
    expect(screen.getByTestId('unsaved-work-announcement').textContent).toContain('Site is not saved. You are signed out.');
    expect(notice.textContent).toContain('Site is not saved.');
    expect(notice.textContent).toContain('You are signed out.');
    expect(within(notice).getByRole('link', { name: 'Go back to it' }).getAttribute('href')).toBe(`/projects/${project.id}`);
  });

  it('the countdown in the notice ticks outside the live region; the announcement does not repeat', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const project = openServerProject(3);
    fetchMock.mockResolvedValue(failure(503, 'Busy.'));
    const { rerender } = render(<Editor />);
    await advance(0);
    edit(project, 'left behind');
    rerender(<UnsavedWorkGuard />);
    await advance(0);
    const notice = screen.getByTestId('unsaved-work-notice');
    const region = screen.getByTestId('unsaved-work-announcement');
    expect(notice.textContent).toContain('Trying again in 2 s');
    const said = region.textContent;
    expect(said).toContain('Site is not saved.');
    await advance(1000);
    expect(notice.textContent).toContain('Trying again in 1 s');
    expect(region.textContent).toBe(said);
    expect(region.contains(notice)).toBe(false);
  });

  it('the project on screen is not named in the notice (its status says it)', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(403, 'Not an admin.'));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(0);
    expect(screen.queryByTestId('unsaved-work-notice')).toBeNull();
  });
});

describe('the version lock', () => {
  it('a 409 opens the dialog and pauses; Keep editing leaves "Changed elsewhere", which reopens it; Save mine over it resumes', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9)).mockResolvedValueOnce(ok(10)).mockResolvedValueOnce(ok(11));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    const dialog = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await advance(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    const reopen = within(status()).getByRole('button', { name: 'Changed elsewhere' });
    expect(reopen.getAttribute('aria-haspopup')).toBe('dialog');

    edit(project, 'more');
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unloadWarns()).toBe(true);

    fireEvent.click(reopen);
    const again = await screen.findByRole('dialog', { name: 'This project was changed somewhere else' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // reopening asks, it sends nothing
    fireEvent.click(within(again).getByRole('button', { name: 'Save mine over it' }));
    await advance(0);
    expect(sentVersion(1)).toBe(9);
    expect(knownServerVersion(project.id)).toBe(10);
    expect(label()).toBe('Saved');

    edit(project, 'autosaving again');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentVersion(2)).toBe(10);
  });

  it('Cmd+S while paused reopens the dialog without a request', async () => {
    const project = openServerProject(3);
    fetchMock.mockResolvedValueOnce(conflict(9));
    render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep editing' }));
    await advance(0);
    act(() => {
      handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }), store.editorUI);
    });
    expect(await screen.findByRole('dialog', { name: 'This project was changed somewhere else' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the save status dialog', 'save'],
    ['the Publish dialog', 'publish'],
    ['the notice above the canvas', 'notice'],
  ])('"Load the newer version" from %s reloads without the unload warning', async (_where, from) => {
    const project = openServerProject(3);
    const reload = vi.fn(() => {
      expect(unloadWarns()).toBe(false);
    });
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    render(
      <>
        <Editor />
        <PublishButton />
        <EditorNotice />
      </>,
    );
    await advance(0);
    edit(project, 'mine');
    expect(unloadWarns()).toBe(true);
    if (from === 'save') {
      fetchMock.mockResolvedValueOnce(conflict(9));
      await advance(AUTOSAVE_DEBOUNCE_MS);
      fireEvent.click(await screen.findByRole('button', { name: 'Load the newer version' }));
    } else if (from === 'publish') {
      fetchMock.mockResolvedValueOnce(conflict(9));
      fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
      fireEvent.click(await screen.findByRole('button', { name: 'Load the newer version' }));
    } else {
      act(() => store.editorUI.setEditorNotice({ kind: 'changedElsewhere', message: 'Changed elsewhere.' }));
      fireEvent.click(screen.getByRole('button', { name: 'Load the newer version' }));
    }
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('"Save mine as a new project"', () => {
  it('on success, the original project stops warning and leaves no notice', async () => {
    const project = openServerProject(3);
    fetchMock
      .mockResolvedValueOnce(conflict(9))
      .mockResolvedValueOnce(new Response(JSON.stringify({ siteId: 'site_copy' }), { status: 201 }));
    const { rerender } = render(<Editor />);
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine as a new project' }));
    const saveAs = await screen.findByRole('dialog', { name: 'Save as a new project' });
    expect(unloadWarns()).toBe(true);
    fireEvent.click(within(saveAs).getByRole('button', { name: 'Save project' }));
    await advance(0);
    await advance(0);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects');
    expect(unloadWarns()).toBe(false);
    // The new project's page replaces the editor: nothing is left behind.
    rerender(<UnsavedWorkGuard />);
    await advance(60_000);
    expect(screen.queryByTestId('unsaved-work-notice')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Publish after a lost "Save mine over it"', () => {
  it('sends the version the conflict reported, naming the lost attempt', async () => {
    const project = openServerProject(3);
    fetchMock
      .mockResolvedValueOnce(conflict(9))
      .mockResolvedValueOnce(failure(502, 'Bad gateway.')) // the save over it: answer lost
      .mockResolvedValueOnce(failure(503, 'Busy.')) // Publish's settling retry: lost again
      .mockResolvedValueOnce(new Response(JSON.stringify({ publishedPages: [''], subdomain: 'x', version: 11 }), { status: 200 }));
    render(
      <>
        <Editor />
        <PublishButton />
      </>,
    );
    edit(project, 'mine');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine over it' }));
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await advance(0);
    await advance(0);
    const over = JSON.parse(fetchMock.mock.calls[1][1].body);
    const settle = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(fetchMock.mock.calls[3][0]).toBe('/api/projects/publish');
    const publish = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(over.expectedVersion).toBe(9);
    expect(settle).toMatchObject({ expectedVersion: 9, requestKey: over.requestKey });
    expect(publish.expectedVersion).toBe(9);
    expect(publish.previousRequestKeys).toEqual([over.requestKey]);
    expect(publish.requestKey).toBeUndefined();
    expect(knownServerVersion(project.id)).toBe(11);
  });
});

describe('Publish and the status', () => {
  it('while Publish writes, the status says Publishing… and Cmd+S sends nothing', async () => {
    const project = openServerProject(3);
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    render(
      <>
        <Editor />
        <PublishButton />
      </>,
    );
    edit(project, 'publish me');
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await advance(0);
    expect(label()).toBe('Publishing…');
    act(() => {
      handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => answer(new Response(JSON.stringify({ publishedPages: [''], subdomain: 'x', version: 4 }), { status: 200 })));
    await advance(0);
    expect(label()).toBe('Saved');
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the demo editor at /', () => {
  it('says it is not saved, offers "Keep as project", never autosaves and never warns', async () => {
    const project = openServerProject(3);
    act(() => store.editorUI.markUnsavedDemo(project.id));
    render(<Editor />);
    expect(label()).toContain('Demo, not saved');
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    edit(project, 'demo work');
    await advance(60_000);
    act(() => {
      handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unloadWarns()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep as project' }));
    expect(await screen.findByRole('dialog', { name: 'Keep as project' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a generated page', () => {
  // The dialog also asks for page ideas on its own; only saves are counted here.
  const saves = () => fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/projects/save').length;
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

  it('is saved at once, and the dialog says Saved, in the same words as the top bar', async () => {
    window.localStorage.setItem('framer-clone:visual-review', JSON.stringify({ auto: false, model: 'SONNET' }));
    openServerProject(3);
    fetchMock.mockResolvedValueOnce(ok(4));
    const { transport, calls } = manualTransport();
    render(
      <>
        <Editor />
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
    expect(saves()).toBe(1);
    await advance(0);
    expect(screen.getByText(/Added \d+ components? on a new page\. Saved\./)).toBeTruthy();
    expect(screen.queryByText(/Save the project to keep it/)).toBeNull();
    expect(label()).toBe('Saved');
    await advance(60_000);
    expect(saves()).toBe(1);
  });
});

describe('a demo kept as a project', () => {
  it('leaves no unload warning and no notice behind once kept', async () => {
    const demo = ProjectModel.create({ id: `demo_${++seq}`, metadata: { title: 'Demo', description: '' }, pages: {} });
    act(() => {
      store.projectStore.ingestProjectSnapshot(getSnapshot(demo) as ProjectSnapshotOut);
      const live = store.projectStore.getProject(demo.id)!;
      store.editorUI.setCurrentProject(live);
      store.editorUI.markUnsavedDemo(live.id);
    });
    const { rerender } = render(<Editor />);
    act(() => store.editorUI.consumeDemo()); // what "Keep as project" does before the new page opens
    await advance(0);
    act(() => store.projectStore.getProject(demo.id)!.updateMetadata({ description: 'kept' }));
    rerender(<UnsavedWorkGuard />); // the new project's page replaces the editor
    await advance(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unloadWarns()).toBe(false);
    expect(screen.queryByTestId('unsaved-work-notice')).toBeNull();
  });
});

describe('the generator note follows the top bar', () => {
  it('Not saved in both when the save of a generated page fails', async () => {
    window.localStorage.setItem('framer-clone:visual-review', JSON.stringify({ auto: false, model: 'SONNET' }));
    openServerProject(3);
    fetchMock.mockResolvedValueOnce(failure(403, 'Not an admin.'));
    const calls: Array<{ req: PageGenRequest; handlers: PageGenHandlers; finish: () => void }> = [];
    const transport: PageGenTransport = (req, handlers) => new Promise<void>((resolve) => calls.push({ req, handlers, finish: resolve }));
    render(
      <>
        <Editor />
        <GeneratePageDialog open onOpenChange={() => {}} transport={transport} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'A bakery' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    const raw = { title: 'Bakery', nodes: [{ type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Bread' } }] }] };
    const out = validateGeneration(raw, { breakpoints: deriveBreakpointKeys(calls[0].req.breakpoints) });
    if (!out.ok) throw new Error(out.errors.join('; '));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { imageRequests, ...result } = out.result;
    await act(async () => {
      calls[0].handlers.onResult?.({ generationId: 'gen-2', model: 'claude-sonnet-5-5', ...result, images: { requested: 0, resolved: 0, fellBack: {}, credits: [] } });
      calls[0].finish();
    });
    await advance(0);
    expect(label()).toContain('Not saved');
    expect(screen.getByText(/Not saved: see the save status in the top bar\./)).toBeTruthy();
  });
});
