// The editor chrome of the live agent canvas hardening (review of 2026-11-09):
// the top bar's live connection state (H1), the notice for an agent's new page
// (H2) and the Site Changed dialog naming the pages "keep mine" brings back (F4),
// on a real root store and a real LiveSync whose stream and snapshot route are fakes.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { openProject } from '@/stores/openProject';
import { autosaveFor, resetAutosaveForTests } from '@/lib/projects/autosave';
import { setLiveSyncDepsForTests, startLiveSync, type LiveEventSource, type LiveSyncDeps } from '@/lib/projects/liveSync';
import LiveConnectionStatus, { LIVE_BACK_MS, LIVE_PAUSED_GRACE_MS, LIVE_PAUSED_TEXT, LIVE_BACK_TEXT } from '../live/LiveConnectionStatus';
import EditorNotice from '../EditorNotice';
import SiteChangedDialog from '../SiteChangedDialog';

vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

class FakeStream implements LiveEventSource {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();
  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
  fail() {
    this.readyState = 0;
    this.onerror?.({});
  }
}

let store: RootStoreType;
let streams: FakeStream[];
let server: { version: number; snapshot: ProjectSnapshotOut };
let seq = 0;
let site = '';
const deps: LiveSyncDeps = {
  openStream: () => {
    const s = new FakeStream();
    streams.push(s);
    return s;
  },
  fetchDocument: async (_url, known) =>
    known === server.version ? { status: 304 } : { status: 200, body: { version: server.version, snapshot: server.snapshot } },
  isVisible: () => true,
  onVisibilityChange: () => () => {},
  random: () => 0,
};
const stream = () => streams[streams.length - 1];
const project = () => store.projectStore.getProject(site) as ProjectModelType;

beforeEach(() => {
  vi.useFakeTimers();
  streams = [];
  site = `site_chrome_${++seq}`;
  resetAutosaveForTests({ write: async () => ({ kind: 'conflict', currentVersion: server.version }) });
  setLiveSyncDepsForTests(deps);
  store = createRootStore();
  const p = ProjectModel.create({ id: site, metadata: { title: 'Site', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  p.createPage('About');
  server = { version: 1, snapshot: getSnapshot(p) as ProjectSnapshotOut };
  openProject(store, server.snapshot, null, 1);
  autosaveFor(site).attach(project());
});

afterEach(() => {
  cleanup();
  setLiveSyncDepsForTests(undefined);
  resetAutosaveForTests();
  vi.useRealTimers();
});

describe('LiveConnectionStatus (H1)', () => {
  it('says nothing while live; paused after the grace; back for a moment once the stream returns', () => {
    render(<LiveConnectionStatus projectId={site} />);
    // Rendered before the sync starts (the top bar comes first): it still hears it.
    act(() => {
      startLiveSync(site, store);
      stream().open();
    });
    const region = screen.getByTestId('live-connection-status');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');

    // The server simply closes the stream (no auth:expired); the browser reconnects by itself.
    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(LIVE_PAUSED_GRACE_MS - 1));
    expect(region.textContent).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(region.textContent).toContain(LIVE_PAUSED_TEXT);
    // A short word stays in sight on a small screen (touch cannot open a tooltip).
    expect(region.querySelector('[aria-hidden="true"].md\\:hidden')?.textContent).toBe('Paused');

    act(() => stream().open());
    expect(region.textContent).toContain(LIVE_BACK_TEXT);
    act(() => vi.advanceTimersByTime(LIVE_BACK_MS));
    expect(region.textContent).toBe('');
  });

  it('a reconnect within the grace says nothing at all', () => {
    act(() => {
      startLiveSync(site, store);
      stream().open();
    });
    render(<LiveConnectionStatus projectId={site} />);
    const region = screen.getByTestId('live-connection-status');
    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(LIVE_PAUSED_GRACE_MS / 2));
    act(() => stream().open());
    act(() => vi.advanceTimersByTime(LIVE_BACK_MS));
    expect(region.textContent).toBe('');
  });

  it('a browser that never had a stream (polling from the start) is not "paused"', () => {
    setLiveSyncDepsForTests({ ...deps, openStream: () => null });
    act(() => {
      startLiveSync(site, store);
    });
    render(<LiveConnectionStatus projectId={site} />);
    act(() => vi.advanceTimersByTime(LIVE_PAUSED_GRACE_MS * 2));
    expect(screen.getByTestId('live-connection-status').textContent).toBe('');
  });
});

describe('EditorNotice: an agent\'s new page (H2)', () => {
  it('Open it shows the page and puts the notice away', () => {
    const about = project().pagesArray.find((p) => p.metadata.title === 'About')!;
    render(<EditorNotice />);
    act(() => store.editorUI.setEditorNotice({ kind: 'newPage', pageId: about.id, message: 'New page ‘About’ is ready.' }));
    expect(screen.getByText('New page ‘About’ is ready.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(store.editorUI.currentPage?.id).toBe(about.id);
    expect(store.editorUI.editorNotice).toBeUndefined();
  });
});

describe('SiteChangedDialog: the pages keeping mine restores (F4)', () => {
  it('names the page the held copy removed and who removed it', async () => {
    act(() => {
      startLiveSync(site, store);
      stream().open();
      stream().emit('state', { version: 1, plans: [], agents: [], feed: [] });
    });
    // Unsaved work here; the agent deletes About on the server.
    project().updateMetadata({ description: 'mine' });
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const about = model.pagesArray.find((p) => p.metadata.title === 'About')!;
    model.removePage(about.id);
    server = { version: 2, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    await act(async () => {
      stream().emit('site:version', { origin: 'mcp', actor: { kind: 'key', label: 'Claude' }, version: 2, versionBefore: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });
    const noop = () => {};
    render(<SiteChangedDialog open action="save" busy={false} onKeepEditing={noop} onLoadNewer={noop} onKeepMine={noop} onSaveAsNew={noop} />);
    expect(screen.getByRole('dialog').textContent).toContain('Saving yours restores the page ‘About’ that Claude deleted.');
  });

  it('names nothing when no held copy removed a page', () => {
    const noop = () => {};
    render(<SiteChangedDialog open action="publish" busy={false} onKeepEditing={noop} onLoadNewer={noop} onKeepMine={noop} onSaveAsNew={noop} />);
    expect(screen.getByRole('dialog').textContent).not.toContain('restores');
  });
});
