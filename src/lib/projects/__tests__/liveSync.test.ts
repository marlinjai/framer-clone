// liveSync: the open editor follows the site's live stream (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 1), on a REAL root store
// and a REAL autosave controller; only the stream, the snapshot route and the
// save request are fakes. The four stateful-flow paths:
//   1. forward: three agent writes, three adoptions, three undo steps, and the
//      person's next edit saves on the last version without a 409;
//   2. backtrack: undoing the agent's write is saved on the adopted version;
//      undo then redo writes nothing; unsaved work holds the newer copy and
//      opens the dialog at once, and "Load the newer version" adopts it in place;
//   3. resume: a reconnect's state brings a newer version in one fetch; a lower
//      version is ignored; the stream down means polling, 5 s visible, 60 s hidden;
//   4. re-entry: after auth:expired nothing reconnects until the tab is shown
//      and one check passes; a project gone stops following.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyPatch, getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { applyOperations } from '@/lib/siteOps/applyOps';
import { hasWriteInFlight, knownServerPageIds, knownServerVersion, noteWriteInFlight, openProject } from '@/stores/openProject';
import { autosaveFor, resetAutosaveForTests, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, HELD_DIALOG_CHECK_MS, HELD_DIALOG_MAX_MS, type AutosaveState } from '../autosave';
import type { ProjectWriteResult } from '../projectWrite';
import { editorTabId } from '../tabId';
import {
  adoptionLabel,
  heldWriter,
  LIVE_FETCH_RETRY_MS,
  LIVE_RECONNECT_MS,
  LIVE_PROBE_TIMEOUT_MS,
  probeStreamWith,
  LIVE_HEARTBEAT_MS,
  LIVE_WATCHDOG_MS,
  LOAD_NEWER_WRITE_WAIT_MS,
  LIVE_HELD_FETCH_MS,
  pagesRemovedBy,
  restoredPagesSentence,
  heldStepSentence,
  LIVE_POLL_HIDDEN_MS,
  LIVE_POLL_VISIBLE_MS,
  LIVE_STREAM_RETRY_MS,
  loadNewerVersion,
  revealsOnAdoption,
  liveSyncFor,
  LiveSync,
  setLiveSyncDepsForTests,
  setReplayApplyForTests,
  startLiveSync,
  type DocumentAnswer,
  type LiveEventSource,
  type LiveSyncDeps,
} from '../liveSync';
import { LIVE_PING_EVENT, type SiteVersionEvent } from '../liveEvents';
import { registerOpenDraft } from '../openDrafts';
import { handleSaveShortcut } from '../saveShortcut';
import { EDITING_RECHECK_MS } from '@/lib/live/editingInProgress';
import { GEN_DRAFT_LIMITS } from '../liveEvents';
import { REVEAL_SETTLE_MS } from '@/lib/live/revealStore';
import { autorun } from 'mobx';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

class FakeStream implements LiveEventSource {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
  fail(forGood: boolean) {
    this.readyState = forGood ? 2 : 0;
    this.onerror?.({});
  }
}

const SITE = 'site_live';
let store: RootStoreType;
let streams: FakeStream[];
let visible: boolean;
let visibilityListeners: Array<() => void>;
/** What the server holds. */
let server: { version: number; snapshot: ProjectSnapshotOut; status?: number };
let fetches: Array<number | undefined>;
let holdFetch: { release: () => void } | undefined;
/** The next fetch fails on the network. */
let failFetch = false;
let saves: Array<{ expectedVersion: number | undefined; snapshot: ProjectSnapshotOut }>;

const deps: LiveSyncDeps = {
  openStream: (url) => {
    const stream = new FakeStream(url);
    streams.push(stream);
    return stream;
  },
  fetchDocument: async (_url, knownVersion): Promise<DocumentAnswer> => {
    fetches.push(knownVersion);
    if (failFetch) {
      failFetch = false;
      throw new Error('network');
    }
    if (holdFetch) {
      await new Promise<void>((resolve) => {
        holdFetch = { release: resolve };
      });
    }
    if (server.status) return { status: server.status };
    if (knownVersion === server.version) return { status: 304 };
    return { status: 200, body: { version: server.version, snapshot: server.snapshot } };
  },
  isVisible: () => visible,
  random: () => 0,
  onVisibilityChange: (listener) => {
    visibilityListeners.push(listener);
    return () => {
      visibilityListeners = visibilityListeners.filter((l) => l !== listener);
    };
  },
};

function baseSnapshot(): ProjectSnapshotOut {
  const p = ProjectModel.create({ id: SITE, metadata: { title: 'Live', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  return getSnapshot(p) as ProjectSnapshotOut;
}
const homeId = () => Object.values(server.snapshot.pages).find((p) => p.slug === '')!.id;
const project = () => store.projectStore.getProject(SITE) as ProjectModelType;
const working = () => getSnapshot(project()) as unknown as ProjectSnapshotOut;
const stream = () => streams[streams.length - 1];

/** The agent writes a batch on the server: a new version, announced on the stream. */
async function agentWrites(text: string, announce = true): Promise<SiteVersionEvent> {
  const model = ProjectModel.create(server.snapshot) as ProjectModelType;
  const outcome = await applyOperations(model, [{ op: 'insertNodes', pageId: homeId(), nodes: [{ type: 'p', props: { children: text } }] }]);
  if (!outcome.ok) throw new Error('refused');
  const event: SiteVersionEvent = {
    origin: 'mcp',
    actor: { kind: 'key', label: 'Claude' },
    summary: [`insert 1 node: ${text}`],
    version: server.version + 1,
    versionBefore: server.version,
  };
  server = { version: server.version + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
  if (announce) stream().emit('site:version', event);
  await settle();
  return event;
}

/** Let promises and zero-delay work run. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  streams = [];
  visible = true;
  visibilityListeners = [];
  fetches = [];
  saves = [];
  holdFetch = undefined;
  failFetch = false;
  server = { version: 1, snapshot: baseSnapshot() };
  resetAutosaveForTests({
    write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
      saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
      if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
      server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
      return { kind: 'ok', payload: {}, version: server.version };
    },
  });
  setLiveSyncDepsForTests(deps);
  store = createRootStore();
  openProject(store, server.snapshot, null, server.version);
  autosaveFor(SITE).attach(project());
});

afterEach(() => {
  setLiveSyncDepsForTests(undefined);
  resetAutosaveForTests();
  vi.useRealTimers();
});

/** The stream ended (closed by the server, a drop): this tab reopens it after its own back-off (random 0 in these tests), and it opens. */
async function reconnect() {
  await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
  stream().open();
}

function start() {
  const stop = startLiveSync(SITE, store);
  stream().open();
  stream().emit('state', { version: server.version, plans: [], agents: [], feed: [] });
  return stop;
}

describe('liveSync: forward', () => {
  it('adopts three agent writes as three labelled undo steps; the next edit saves on the last version', async () => {
    start();
    await settle();
    expect(fetches).toEqual([]); // the state named the version this tab has
    await agentWrites('one');
    await agentWrites('two');
    await agentWrites('three');

    expect(knownServerVersion(SITE)).toBe(4);
    expect(working()).toEqual(server.snapshot);
    const history = getHistoryStore()!;
    expect(history.history.map((entry) => history.labelFor(entry))).toEqual([
      'Claude: insert 1 node: one',
      'Claude: insert 1 node: two',
      'Claude: insert 1 node: three',
    ]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(saves).toEqual([]); // adopting is never a change to save

    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves.map((s) => s.expectedVersion)).toEqual([4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
  });

  it("ignores this tab's own write: no fetch, its answer moved the version", async () => {
    start();
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(knownServerVersion(SITE)).toBe(2);
    expect(stream().url).toBe(`/api/projects/${SITE}/events?tab=${editorTabId()}`);
    stream().emit('site:version', { origin: 'editor', own: true, version: 2, versionBefore: 1 });
    await settle();
    expect(fetches).toEqual([]);
    expect(getHistoryStore()!.history).toHaveLength(1); // the person's own edit only
  });

  it('coalesces a burst: events during a fetch make one more fetch of the newest, not one each', async () => {
    start();
    holdFetch = { release: () => {} };
    await agentWrites('a');
    await agentWrites('b', true);
    await agentWrites('c', true);
    expect(fetches).toHaveLength(1);
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await settle();
    expect(fetches).toHaveLength(2);
    expect(knownServerVersion(SITE)).toBe(4);
    expect(working()).toEqual(server.snapshot);
  });
});

describe('liveSync: backtrack and revise', () => {
  it("undoing the agent's write is saved on the adopted version; the agent's next write meets it", async () => {
    start();
    await agentWrites('agent');
    getHistoryStore()!.undo();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves.map((s) => s.expectedVersion)).toEqual([2]);
    expect(server.version).toBe(3);
    // The person's undo is the newest server copy: the page holds no agent node.
    expect(JSON.stringify(server.snapshot)).not.toContain('agent');
  });

  it('undo then redo leaves the copy saved: nothing is written', async () => {
    start();
    await agentWrites('agent');
    getHistoryStore()!.undo();
    getHistoryStore()!.redo();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves).toEqual([]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
  });

  it('unsaved work holds the newer copy and opens the dialog at once; Load the newer version adopts it in place', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    start();
    project().updateMetadata({ description: 'unsaved' });
    await agentWrites('agent');

    // Nothing merged, the dialog is open, autosave is paused.
    expect(working().metadata.description).toBe('unsaved');
    expect(knownServerVersion(SITE)).toBe(1);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', currentVersion: 2, dialogOpen: true });
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saves).toEqual([]);

    await loadNewerVersion(SITE);
    expect(reload).not.toHaveBeenCalled();
    expect(working()).toEqual(server.snapshot);
    expect(knownServerVersion(SITE)).toBe(2);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    // Even this step can be undone: the person's unsaved edit comes back as an edit to save.
    getHistoryStore()!.undo();
    expect(working().metadata.description).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves.map((s) => s.expectedVersion)).toEqual([2]);
    vi.unstubAllGlobals();
  });

  it('a write of this tab out when the event comes: held, and the 409 decides', async () => {
    start();
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent');
    expect(knownServerVersion(SITE)).toBe(1);
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(2);
    finish({ kind: 'conflict', currentVersion: 2 });
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', currentVersion: 2, dialogOpen: true });
  });
});

describe('liveSync: a write of this tab that succeeds while a newer version is held', () => {
  it('adopts the held version once the write settled, instead of waiting for a 409 that never comes', async () => {
    start();
    let finish!: () => void;
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        // The server commits at once; the answer is late.
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        const version = server.version;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { kind: 'ok', payload: {}, version };
      },
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    // The agent writes on top of this tab's committed save, before its answer arrives.
    await agentWrites('on top');
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(3);
    expect(knownServerVersion(SITE)).toBe(1);

    finish();
    await settle();
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
    expect(working()).toEqual(server.snapshot);
    expect(liveSyncFor(SITE)?.heldVersion).toBeUndefined();
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
  });
});

describe('liveSync: a held copy older than the 409', () => {
  it('never lowers the version the dialog names, and Load the newer version fetches the newest', async () => {
    start();
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('v2'); // held at 2
    await agentWrites('v3', false); // the server moved on unannounced
    finish({ kind: 'conflict', currentVersion: 3 });
    await settle();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', currentVersion: 3 });
    await loadNewerVersion(SITE);
    expect(knownServerVersion(SITE)).toBe(3);
    expect(working()).toEqual(server.snapshot);
  });
});

describe('liveSync: an erasure', () => {
  it('is adopted without an undo step and clears the history, so undo cannot bring erased values back', async () => {
    start();
    await agentWrites('before');
    expect(getHistoryStore()!.history).toHaveLength(1);
    const erased = ProjectModel.create(server.snapshot) as ProjectModelType;
    const snap = getSnapshot(erased) as ProjectSnapshotOut;
    server = { version: server.version + 1, snapshot: { ...snap, metadata: { ...snap.metadata, erasureEpoch: 1 } } };
    stream().emit('site:version', { origin: 'erasure', version: server.version, versionBefore: server.version - 1 });
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
    expect(working().metadata.erasureEpoch).toBe(1);
    expect(getHistoryStore()!.history).toHaveLength(0);
  });
});

describe('liveSync: resume', () => {
  it("a reconnect's state brings a newer version in one fetch; a lower one is ignored", async () => {
    start();
    await agentWrites('while away', false);
    stream().fail(false); // closed by the server: reopened after this tab's back-off
    await reconnect();
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [] });
    await settle();
    expect(fetches).toEqual([1]);
    expect(knownServerVersion(SITE)).toBe(2);

    stream().emit('site:version', { origin: 'mcp', version: 1, versionBefore: 0 });
    await settle();
    expect(fetches).toEqual([1]);
  });

  it('polls while the stream is down: every 5 s visible, 60 s hidden, and goes back to the stream', async () => {
    start();
    stream().fail(true); // refused (a 429): closed for good
    expect(liveSyncFor(SITE)?.phase).toBe('polling');
    expect(stream().closed).toBe(true);
    const refusedStreams = streams.length;
    await agentWrites('polled', false);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS); // 5 s after the refusal
    expect(knownServerVersion(SITE)).toBe(2);

    visible = false;
    fetches = [];
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS); // 10 s: the poll armed while visible
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 2); // 20 s: hidden, the next is a minute away
    expect(fetches).toHaveLength(1);

    // A new stream is tried a minute after the refusal.
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS - 4 * LIVE_POLL_VISIBLE_MS); // 60 s
    expect(streams.length).toBe(refusedStreams + 1);
    // Not open yet: polling goes on at the hidden pace.
    await vi.advanceTimersByTimeAsync(LIVE_POLL_HIDDEN_MS - 2 * LIVE_POLL_VISIBLE_MS); // 70 s
    expect(fetches).toHaveLength(2);

    // Open: polling stops.
    stream().open();
    expect(liveSyncFor(SITE)?.phase).toBe('live');
    fetches = [];
    await vi.advanceTimersByTimeAsync(LIVE_POLL_HIDDEN_MS * 2);
    expect(fetches).toEqual([]);
  });
});

describe('liveSync: re-entry', () => {
  it('auth:expired stops everything and shows the signed-out state; the tab shown again checks once and resumes', async () => {
    start();
    stream().emit('auth:expired', {});
    expect(stream().closed).toBe(true);
    expect(liveSyncFor(SITE)?.phase).toBe('signed-out');
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'failed', status: 401 });
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS * 2);
    expect(streams.length).toBe(count);

    // Still signed out when shown: nothing reopens.
    server.status = 401;
    for (const listener of visibilityListeners) listener();
    await settle();
    expect(streams.length).toBe(count);

    // Signed in again (another tab): the next showing resumes.
    server.status = undefined;
    for (const listener of visibilityListeners) listener();
    await settle();
    expect(streams.length).toBe(count + 1);
  });

  it.each(['document', 'stream'] as const)('a branch closed elsewhere stops following and tells the tab: heard from the %s', async (how) => {
    const heard: string[] = [];
    const onClosed = (e: Event) => heard.push((e as CustomEvent<{ siteId: string }>).detail.siteId);
    window.addEventListener('lumitra:branch-closed', onClosed);
    start();
    if (how === 'document') {
      // The document answers 410 for a merged or discarded branch.
      server.status = 410;
      stream().emit('site:version', { origin: 'merge', version: 9, versionBefore: 1 });
    } else {
      stream().emit('branch:closed', { status: 'merged' });
    }
    await settle();
    window.removeEventListener('lumitra:branch-closed', onClosed);
    expect(liveSyncFor(SITE)?.phase).toBe('gone');
    expect(heard).toEqual([SITE]);
  });

  it('a project gone (404) stops following', async () => {
    start();
    server.status = 404;
    stream().emit('site:version', { origin: 'mcp', version: 9, versionBefore: 1 });
    await settle();
    expect(liveSyncFor(SITE)?.phase).toBe('gone');
    expect(stream().closed).toBe(true);
  });

  it('stopping and starting again leaves nothing from the earlier run', async () => {
    const stop = start();
    project().updateMetadata({ description: 'unsaved' });
    await agentWrites('held');
    expect(liveSyncFor(SITE)?.heldVersion).toBeDefined();
    stop();
    expect(liveSyncFor(SITE)).toBeUndefined();
    start();
    expect(liveSyncFor(SITE)?.heldVersion).toBeUndefined();
  });
});

describe('adoptionLabel', () => {
  it('names the writer and the first summary line, or what kind of write it was', () => {
    expect(adoptionLabel({ origin: 'mcp', actor: { kind: 'key', label: 'Claude' }, summary: ['insert 3 nodes'], version: 2, versionBefore: 1 })).toBe('Claude: insert 3 nodes');
    expect(adoptionLabel({ origin: 'publish', actor: { kind: 'user', label: 'Marlin' }, version: 2, versionBefore: 1 })).toBe('Marlin: published');
    expect(adoptionLabel({ origin: 'editor', version: 2, versionBefore: 1 })).toBe('Another tab: saved changes');
    expect(adoptionLabel({ origin: 'editor', version: 5, versionBefore: 2, catchUp: true })).toBe('Changes made elsewhere');
    expect(adoptionLabel(undefined)).toBe('Changes made elsewhere');
  });
});

describe('liveSync: presence (live agent canvas, slice 2)', () => {
  const presence = () => store.editorUI.livePresence;
  const activity = (over: Record<string, unknown> = {}) => ({
    callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'apply_batch', phase: 'start', nodeIds: ['gone-node'], at: new Date().toISOString(), ...over,
  });

  it("hands the state's agents and feed and every agent:activity to the presence store", async () => {
    start();
    stream().emit('state', {
      version: server.version, plans: [], agents: [activity()],
      feed: [{ id: 'row-1', agentId: 'a1', label: 'Claude', actorKind: 'key', tool: 'apply_batch', outcome: 'ok', at: new Date().toISOString() }],
    });
    expect(presence().feed.map((l) => l.id)).toEqual(['row-1']);
    expect(presence().agents.get('a1')?.openCalls).toEqual(['c1']);
    stream().emit('agent:activity', activity({ phase: 'end', outcome: 'ok', nodeIds: [] }));
    expect(presence().feed.map((l) => l.id)).toEqual(['c1', 'row-1']);
    // Garbage on the stream changes nothing.
    stream().emit('agent:activity', 'not an activity');
    expect(presence().feed).toHaveLength(2);
  });

  it('keeps a focus on nodes this tab has not adopted yet (the layer resolves them when it draws)', async () => {
    start();
    await settle();
    stream().emit('state', { version: server.version, plans: [], agents: [activity({ nodeIds: ['made-by-the-agent'] })], feed: [] });
    await agentWrites('one');
    expect(presence().agents.get('a1')?.focus.nodeIds).toEqual(['made-by-the-agent']);
    expect(presence().agents.get('a1')?.frameShown).toBe(true);
  });

  it('forgets the presence when the editor stops following the site', () => {
    const stop = start();
    stream().emit('agent:activity', activity());
    expect(presence().anyActive).toBe(true);
    stop();
    expect(presence().anyActive).toBe(false);
    expect(presence().feed).toEqual([]);
  });
});

describe('liveSync: the per-component reveal (live agent canvas, slice 3)', () => {
  const reveal = () => store.editorUI.liveReveal;
  /** The ids of the page's nodes in document order. */
  const pageIds = (snapshot: ProjectSnapshotOut) => {
    const ids: string[] = [];
    const visit = (n: { id: string; children?: unknown[] }) => {
      ids.push(n.id);
      for (const c of (n.children ?? []) as Array<{ id: string; children?: unknown[] }>) visit(c);
    };
    visit(Object.values(snapshot.pages).find((p) => p.slug === '')!.appComponentTree as never);
    return ids;
  };

  /** A writer adds a section with a heading, a text and a button; answers the four new ids in document order. */
  async function writes(event: Partial<SiteVersionEvent> | null): Promise<string[]> {
    const before = new Set(pageIds(server.snapshot));
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const outcome = await applyOperations(model, [
      {
        op: 'insertNodes',
        pageId: homeId(),
        nodes: [{ type: 'section', children: [{ type: 'h2', props: { children: 'Title' } }, { type: 'p', props: { children: 'Text' } }, { type: 'button', props: { children: 'Go' } }] }],
      },
    ]);
    if (!outcome.ok) throw new Error('refused');
    const versionBefore = server.version;
    server = { version: server.version + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    if (event) stream().emit('site:version', { origin: 'mcp', actor: { kind: 'key', label: 'Claude' }, version: server.version, versionBefore, ...event });
    await settle();
    return pageIds(server.snapshot).filter((id) => !before.has(id));
  }
  const entries = () => [...reveal().delays.entries()];

  it('forward: an agent batch reveals its new nodes in document order, 45 ms apart, then forgets them', async () => {
    start();
    const created = await writes({});
    expect(created).toHaveLength(4);
    expect(entries()).toEqual(created.map((id, i) => [id, i * 45]));
    // Set in the same action as the adoption: every new node of the copy has its delay.
    expect(pageIds(working()).filter((id) => created.includes(id))).toEqual(created);

    // A second batch inside the first's window does not cut the first short.
    await vi.advanceTimersByTimeAsync(100);
    const second = await writes({});
    expect(entries().map(([id]) => id)).toEqual([...created, ...second]);
    // Each batch's timer runs from its first paint, two animation frames (2 x 16 ms) after it started.
    await vi.advanceTimersByTimeAsync(3 * 45 + 180 + REVEAL_SETTLE_MS - 100 + 32);
    expect(entries().map(([id]) => id)).toEqual(second);
    await vi.advanceTimersByTimeAsync(200);
    expect(reveal().size).toBe(0);
  });

  it("a generated page's result reveals too", async () => {
    start();
    const created = await writes({ origin: 'generate' });
    expect(entries().map(([id]) => id)).toEqual(created);
  });

  it("never for another tab's or person's save, a publish or an erasure", async () => {
    start();
    await writes({ origin: 'editor', actor: { kind: 'user', label: 'Sam' } });
    await writes({ origin: 'publish' });
    expect(knownServerVersion(SITE)).toBe(3);
    expect(reveal().size).toBe(0);
  });

  it('never for a catch-up, a reconnect state or a poll: the writer is not known', async () => {
    start();
    await writes({ catchUp: true });
    expect(knownServerVersion(SITE)).toBe(2);
    await writes(null);
    stream().fail(false);
    await reconnect();
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [] });
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
    stream().fail(true);
    await writes(null);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(knownServerVersion(SITE)).toBe(4);
    expect(reveal().size).toBe(0);
  });

  it('never on the first load or for the person\'s own edits', async () => {
    start();
    await settle();
    expect(reveal().size).toBe(0);
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    stream().emit('site:version', { origin: 'editor', own: true, version: server.version, versionBefore: server.version - 1 });
    await settle();
    expect(saves).toHaveLength(1);
    expect(reveal().size).toBe(0);
  });

  it('backtrack: "Load the newer version" appears at once, though an agent wrote it', async () => {
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
    start();
    project().updateMetadata({ description: 'unsaved' });
    await writes({});
    expect(liveSyncFor(SITE)?.heldVersion?.event?.origin).toBe('mcp');
    await loadNewerVersion(SITE);
    expect(knownServerVersion(SITE)).toBe(2);
    expect(reveal().size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('backtrack: undo removes the nodes (their entries are inert); a redo after the reveal ended appears at once', async () => {
    start();
    const created = await writes({});
    getHistoryStore()!.undo();
    expect(pageIds(working()).some((id) => created.includes(id))).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reveal().size).toBe(0);
    getHistoryStore()!.redo();
    expect(pageIds(working()).filter((id) => created.includes(id))).toEqual(created);
    expect(reveal().size).toBe(0);
  });

  it('a held agent write adopted once this tab\'s own write settled reveals as it is adopted', async () => {
    start();
    let finish!: () => void;
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        const version = server.version;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { kind: 'ok', payload: {}, version };
      },
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    const created = await writes({});
    expect(reveal().size).toBe(0);
    finish();
    await settle();
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
    expect(entries().map(([id]) => id)).toEqual(created);
  });

  it('a burst coalesced into one fetch reveals nothing, in either order: the copy holds more than the agent wrote', async () => {
    start();
    holdFetch = { release: () => {} };
    await writes({ origin: 'editor', actor: { kind: 'user', label: 'Sam' } }); // fetch out, held
    await writes({}); // the agent, while it is out
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
    expect(reveal().size).toBe(0);

    holdFetch = { release: () => {} };
    await writes({});
    await writes({ origin: 'editor', actor: { kind: 'user', label: 'Sam' } });
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await settle();
    expect(knownServerVersion(SITE)).toBe(5);
    expect(reveal().size).toBe(0);
  });

  it("a poll after a failed fetch brings the agent's write with others: no reveal", async () => {
    start();
    failFetch = true;
    await writes({});
    expect(knownServerVersion(SITE)).toBe(1);
    stream().fail(true);
    await writes(null); // another writer, unannounced
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(knownServerVersion(SITE)).toBe(3);
    expect(reveal().size).toBe(0);
  });

  it("the poll that retries a failed fetch of exactly the agent's write: catch-up, no reveal", async () => {
    start();
    failFetch = true;
    await writes({});
    expect(knownServerVersion(SITE)).toBe(1);
    stream().fail(true);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(knownServerVersion(SITE)).toBe(2);
    expect(reveal().size).toBe(0);
  });

  it('a held agent write replaced by a newer one before it was adopted: no reveal for the two together', async () => {
    start();
    let finish!: () => void;
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        const version = server.version;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { kind: 'ok', payload: {}, version };
      },
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await writes({});
    await writes({});
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(4);
    finish();
    await settle();
    await settle();
    expect(knownServerVersion(SITE)).toBe(4);
    expect(reveal().size).toBe(0);
  });

  it('re-entry: stopping forgets a reveal still playing; the next run starts with none', async () => {
    const stop = start();
    await writes({});
    expect(reveal().size).toBe(4);
    stop();
    expect(reveal().size).toBe(0);
    start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reveal().size).toBe(0);
  });

  it('revealsOnAdoption: only an announced agent write', () => {
    const e = (over: Partial<SiteVersionEvent>): SiteVersionEvent => ({ origin: 'mcp', version: 2, versionBefore: 1, ...over });
    expect(revealsOnAdoption(e({}))).toBe(true);
    expect(revealsOnAdoption(e({ origin: 'generate' }))).toBe(true);
    expect(revealsOnAdoption(e({ catchUp: true }))).toBe(false);
    expect(revealsOnAdoption(e({ own: true }))).toBe(false);
    for (const origin of ['editor', 'publish', 'erasure'] as const) expect(revealsOnAdoption(e({ origin }))).toBe(false);
    expect(revealsOnAdoption(undefined)).toBe(false);
  });
});

describe('liveSync: skeleton plans (slice 4)', () => {
  const plans = () => store.editorUI.livePlans;
  const drawn = () => plans().onPage(homeId()).flatMap((p) => p.sections.map((s) => s.ref));
  const plan = (sections: Array<{ ref: string; fulfilledAt?: number }>, planId = 'plan-1') => ({
    planId,
    agentId: 'agent-a',
    label: 'Claude',
    pageId: homeId(),
    sections: sections.map((s) => ({ title: s.ref, kind: 'generic', ...s })),
    expiresAt: '',
  });

  it('draws the plans of `state`, and a section leaves in the same action as the adoption of the version that created it', async () => {
    const stop = startLiveSync(SITE, store);
    stream().open();
    stream().emit('state', { version: server.version, plans: [plan([{ ref: 'hero' }, { ref: 'faq' }])], agents: [], feed: [] });
    expect(drawn()).toEqual(['hero', 'faq']);
    // The batch commits at version 2: the plan update comes before the copy is adopted.
    const versionBefore = server.version;
    stream().emit('plan:update', { plan: plan([{ ref: 'hero', fulfilledAt: versionBefore + 1 }, { ref: 'faq' }]) });
    expect(drawn()).toEqual(['hero', 'faq']);
    holdFetch = { release: () => {} };
    await agentWrites('hero');
    expect(drawn()).toEqual(['hero', 'faq']); // the copy is still on its way
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    expect(knownServerVersion(SITE)).toBe(versionBefore + 1);
    expect(drawn()).toEqual(['faq']);
    stop();
    expect(plans().plans.size).toBe(0); // nothing carries over to the next site opened
  });

  it("an agent that stopped leaves its line in the feed; this tab's own save moves the version a held plan waits for", async () => {
    const stop = start();
    stream().emit('plan:update', { plan: plan([{ ref: 'hero' }]) });
    stream().emit('plan:update', { plan: plan([{ ref: 'hero' }]), ended: 'expired' });
    expect(store.editorUI.livePresence.feed[0]).toMatchObject({ id: 'plan-stopped:plan-1', tool: 'sections_stopped' });
    stream().emit('plan:update', { plan: plan([{ ref: 'cta', fulfilledAt: 2 }], 'plan-2') });
    expect(drawn()).toContain('cta');
    stream().emit('site:version', { origin: 'editor', own: true, version: 2, versionBefore: 1 });
    expect(drawn()).not.toContain('cta');
    stop();
  });

  it('a reconnect replaces the plans with those of its `state`: one that ended meanwhile never comes back', async () => {
    const stop = start();
    stream().emit('plan:update', { plan: plan([{ ref: 'hero' }]) });
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [] });
    expect(drawn()).toEqual([]);
    stop();
  });
});

describe("liveSync: an agent's generate_page draft (slice 6)", () => {
  const draft = () => store.editorUI.pageGenDraft;
  const rootId = () => server.snapshot.pages[homeId()].appComponentTree.id;
  const target = () => ({ kind: 'insert', pageId: homeId(), parentId: rootId() });
  const breakpoints = () =>
    Object.values(server.snapshot.pages[homeId()].canvasNodes ?? {})
      .filter((n) => (n as { breakpointId?: string }).breakpointId)
      .map((n) => ({ label: (n as { label: string }).label, minWidth: (n as { breakpointMinWidth: number }).breakpointMinWidth }));
  /** A preview section as the generator validates it. */
  const node = (label: string) => {
    const out = validateGeneration({ nodes: [{ type: 'section', label, children: [{ type: 'h2', props: { children: label } }] }] }, { breakpoints: deriveBreakpointKeys(breakpoints()) });
    if (!out.ok) throw new Error(out.errors.join('; '));
    return out.result.nodes[0];
  };
  const homeChildren = (snapshot: ProjectSnapshotOut) => (snapshot.pages[homeId()].appComponentTree.children ?? []) as Array<{ id: string; children?: Array<{ id: string }> }>;

  /** The server saves the result (one section per label) at the next version: gen:done first, then site:version. */
  async function saved(runId: string, labels: string[], drawnAs: number[][], opts: { announce?: boolean } = {}) {
    const before = new Set(homeChildren(server.snapshot).map((c) => c.id));
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const outcome = await applyOperations(model, [
      { op: 'insertNodes', pageId: homeId(), nodes: labels.map((label) => ({ type: 'section', label, children: [{ type: 'h2', props: { children: label } }] })) },
    ]);
    if (!outcome.ok) throw new Error('refused');
    const versionBefore = server.version;
    server = { version: server.version + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    const insertedIds = homeChildren(server.snapshot).map((c) => c.id).filter((id) => !before.has(id));
    stream().emit('gen:done', { runId, status: 'saved', version: server.version, insertedIds, drawnAs });
    if (opts.announce !== false) {
      stream().emit('site:version', { origin: 'generate', actor: { kind: 'key', label: 'Claude' }, version: server.version, versionBefore });
    }
    await settle();
    return insertedIds;
  }

  it('forward: draws the outline, then the sections; the draft goes in the same action the saved result is adopted', async () => {
    const stop = start();
    expect(breakpoints().length).toBeGreaterThan(0);
    stream().emit('gen:outline', { runId: 'run-1', target: target(), outline: [{ title: 'Hero', kind: 'hero' }, { title: 'Order', kind: 'cta' }] });
    expect(draft().target).toMatchObject({ requestKey: 'agent:run-1', kind: 'insert', pageId: homeId(), componentId: rootId(), targetIsRoot: true });
    expect(draft().skeletons.map((s) => s.title)).toEqual(['Hero', 'Order']);
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 1, slot: 1, node: node('Order') });
    expect(draft().sections.map((s) => s.index)).toEqual([0, 1]);
    expect(draft().skeletons).toEqual([]);
    draft().markShown(0);
    draft().markShown(1);

    // Never both on screen, never neither: watch the two together.
    const seen: string[] = [];
    const dispose = autorun(() => {
      const drafted = !!draft().target;
      const result = homeChildren(getSnapshot(project()) as unknown as ProjectSnapshotOut).length > 0;
      seen.push(drafted && result ? 'both' : drafted ? 'draft' : result ? 'result' : 'neither');
    });
    holdFetch = { release: () => {} };
    // Hero drawn exactly as saved; the second section was rewritten by a repair.
    const inserted = await saved('run-1', ['Hero', 'Order'], [[0], []]);
    expect(draft().target).toBeDefined(); // the copy is still on its way
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    dispose();
    expect(knownServerVersion(SITE)).toBe(2);
    expect(draft().target).toBeUndefined();
    expect(seen).toEqual(['draft', 'result']);
    // The hero the draft drew stays still; the rewritten section reveals.
    const revealed = [...store.editorUI.liveReveal.delays.keys()];
    const [hero, order] = homeChildren(working()).filter((c) => inserted.includes(c.id));
    expect(revealed).toContain(order.id);
    expect(revealed).not.toContain(hero.id);
    expect(revealed.some((id) => hero.children?.some((c) => c.id === id))).toBe(false);
    stop();
  });

  it('backtrack: a second run replaces the first draft, and the first run\'s end changes nothing', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('First') });
    stream().emit('gen:done', { runId: 'run-1', status: 'superseded' });
    expect(draft().target).toBeUndefined();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('First') });
    stream().emit('gen:outline', { runId: 'run-2', target: target(), outline: [{ title: 'Second', kind: 'generic' }] });
    expect(draft().target?.requestKey).toBe('agent:run-2');
    expect(draft().sections).toEqual([]);
    stream().emit('gen:done', { runId: 'run-1', status: 'failed' });
    expect(draft().target?.requestKey).toBe('agent:run-2');
    stop();
    expect(draft().target).toBeUndefined(); // nothing carries over to the next site opened
  });

  it("resume: a reload mid-run draws the state's draft again; a state without one drops it", async () => {
    const stop = startLiveSync(SITE, store);
    stream().open();
    const generation = {
      runId: 'run-1',
      target: target(),
      outline: [{ title: 'Hero', kind: 'hero' }, { title: 'FAQ', kind: 'faq' }],
      sections: [{ index: 0, slot: 0, node: node('Hero') }],
    };
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [], generation });
    expect(draft().sections.map((s) => s.index)).toEqual([0]);
    expect(draft().skeletons.map((s) => s.title)).toEqual(['FAQ']);
    // A reconnect repeats it: nothing is drawn twice.
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [], generation });
    expect(draft().sections).toHaveLength(1);
    // The run ended while the stream was away.
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [] });
    expect(draft().target).toBeUndefined();
    stop();
  });

  it('re-entry: a stopped or failed run drops the draft and adopts nothing; the next run starts clean', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    stream().emit('gen:done', { runId: 'run-1', status: 'stopped' });
    await settle();
    expect(draft().target).toBeUndefined();
    expect(fetches).toEqual([]);
    expect(knownServerVersion(SITE)).toBe(1);
    stream().emit('gen:outline', { runId: 'run-2', target: target(), outline: [{ title: 'Again', kind: 'hero' }] });
    expect(draft().sections).toEqual([]);
    expect(draft().skeletons.map((s) => s.title)).toEqual(['Again']);
    stream().emit('gen:done', { runId: 'run-2', status: 'failed' });
    expect(draft().target).toBeUndefined();
    stop();
  });

  it("the person's own Generate keeps the draft; the agent's draws once it ended", async () => {
    const stop = start();
    draft().begin({ requestKey: 'own', kind: 'newPage', pageId: homeId(), targetIsRoot: false, title: 'Mine', breakpoints: [], viewports: [], locale: 'en' });
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Agent') });
    expect(draft().target?.requestKey).toBe('own');
    stream().emit('gen:done', { runId: 'run-1', status: 'failed' });
    expect(draft().target?.requestKey).toBe('own'); // never drops the person's draft
    draft().clear('own');
    stream().emit('gen:section', { runId: 'run-2', target: target(), index: 0, slot: 0, node: node('Agent') });
    stream().emit('gen:section', { runId: 'run-2', target: target(), index: 1, slot: 1, node: node('More') });
    expect(draft().target?.requestKey).toBe('agent:run-2');
    expect(draft().sections).toHaveLength(2);
    stop();
  });

  it('a saved result held for the person (unsaved edits) leaves the draft at most 15 s', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    project().getPage(homeId())!.setSlug('edited'); // unsaved work: the copy is held
    await saved('run-1', ['Hero'], [[0]]);
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(2);
    expect(draft().target).toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(draft().target).toBeUndefined();
    stop();
  });

  it('a new page: draft frames beside whichever page is on screen; with its frames out of view the result waits behind a notice, though the camera follows', async () => {
    const stop = start();
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    expect(draft().target).toMatchObject({ kind: 'newPage', title: 'Menu', followsCurrentPage: true });
    expect(draft().target?.viewports.map((v) => v.label)).toEqual(['Desktop', 'Tablet', 'Mobile']);
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    expect(draft().targetOn(homeId())).toBeDefined();
    expect(draft().targetOn('another-page')).toBeDefined();

    // The server makes the new page and saves it.
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const page = model.createPage('Menu');
    const versionBefore = server.version;
    const outcome = await applyOperations(model, [{ op: 'insertNodes', pageId: page.id, nodes: [{ type: 'section', label: 'Hero' }] }]);
    if (!outcome.ok) throw new Error('refused');
    server = { version: versionBefore + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    const inserted = (server.snapshot.pages[page.id].appComponentTree.children as Array<{ id: string }>).map((c) => c.id);
    stream().emit('gen:done', { runId: 'run-1', status: 'saved', version: server.version, insertedIds: inserted, drawnAs: [[]] });
    stream().emit('site:version', { origin: 'generate', version: server.version, versionBefore });
    await settle();
    expect(draft().target).toBeUndefined();
    // Following the agent alone no longer switches the page (decided 2026-11-09): the frames were not in view.
    expect(store.editorUI.livePresence.follow).toBe(true);
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'newPage', pageId: page.id, message: 'New page \u2018Menu\u2019 is ready.' });
    stop();
  });

  it("a newer run waits while an earlier run's saved result is fetched, and is drawn in the action that adopts it", async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    draft().markShown(0);
    holdFetch = { release: () => {} };
    const inserted = await saved('run-1', ['Hero'], [[0]]);
    // The agent goes on at once: a second generation into the section the first one made (this copy has no such node yet).
    const intoHero = { kind: 'insert', pageId: homeId(), parentId: inserted[0] };
    stream().emit('gen:outline', { runId: 'run-2', target: intoHero, outline: [{ title: 'Inside', kind: 'generic' }] });
    expect(draft().target?.requestKey).toBe('agent:run-1'); // the first draft stays until its result is on screen
    const seen: string[] = [];
    const dispose = autorun(() => {
      const key = draft().target?.requestKey ?? 'none';
      const result = homeChildren(getSnapshot(project()) as unknown as ProjectSnapshotOut).length > 0;
      seen.push(`${key}${result ? '+result' : ''}`);
    });
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    dispose();
    // One step from the first draft to the result with the second draft: never both the first draft and its result.
    expect(seen).toEqual(['agent:run-1', 'agent:run-2+result']);
    expect(draft().target).toMatchObject({ componentId: inserted[0] });
    expect([...store.editorUI.liveReveal.delays.keys()]).not.toContain(inserted[0]);
    stop();
  });

  it('a reconnect while the saved result is fetched keeps the draft until the adoption', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    holdFetch = { release: () => {} };
    await saved('run-1', ['Hero'], [[0]]);
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [] });
    expect(draft().target?.requestKey).toBe('agent:run-1');
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    expect(draft().target).toBeUndefined();
    stop();
  });

  it('the stream going down keeps the draft until the reconnect says, and a poll that adopts the result never shows both', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    stream().fail(false);
    // A brief drop redraws nothing: the draft stays while the stream reconnects.
    expect(draft().target?.requestKey).toBe('agent:run-1');
    await reconnect();
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [], generation: { runId: 'run-1', target: target(), outline: [], sections: [{ index: 0, slot: 0, node: node('Hero') }] } });
    expect(draft().target?.requestKey).toBe('agent:run-1');
    expect(draft().sections).toHaveLength(1);

    // Down again, and the run saves meanwhile: its end is missed, the poll adopts the result.
    stream().fail(false);
    const seen: string[] = [];
    const dispose = autorun(() => {
      const drafted = !!draft().target;
      const result = homeChildren(getSnapshot(project()) as unknown as ProjectSnapshotOut).length > 0;
      seen.push(drafted && result ? 'both' : drafted ? 'draft' : result ? 'result' : 'neither');
    });
    await saved('run-1', ['Hero'], [[0]], { announce: false });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    await settle();
    dispose();
    expect(knownServerVersion(SITE)).toBe(2);
    expect(seen).toEqual(['draft', 'result']);
    // Reconnected while another run goes on: its state draws that one.
    stream().open();
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [], generation: { runId: 'run-2', target: target(), outline: [], sections: [{ index: 0, slot: 0, node: node('Next') }] } });
    expect(draft().target?.requestKey).toBe('agent:run-2');
    stop();
  });

  it('a draft whose stream stays down with no state for a minute goes (the run may have failed meanwhile)', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    stream().fail(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(draft().target).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(draft().target).toBeUndefined();
    stop();
  });

  it('a run that saved while it waited behind an earlier one is drawn once the earlier result shows', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    holdFetch = { release: () => {} };
    await saved('run-1', ['Hero'], [[0]]);
    stream().emit('gen:section', { runId: 'run-2', target: target(), index: 0, slot: 0, node: node('Second') });
    // Run 2 saves too (version 3) before version 2 was adopted.
    stream().emit('gen:done', { runId: 'run-2', status: 'saved', version: server.version + 1, insertedIds: ['later'], drawnAs: [[0]] });
    expect(draft().target?.requestKey).toBe('agent:run-1');
    const release = holdFetch.release;
    holdFetch = undefined;
    release();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
    expect(draft().target?.requestKey).toBe('agent:run-2');
    expect(draft().sections).toHaveLength(1);
    stop();
  });

  it('signing out drops the draft', () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    stream().emit('auth:expired', {});
    expect(draft().target).toBeUndefined();
    stop();
  });

  /** The server makes a new page from the run's draft and saves it: gen:done, then site:version. Answers the new page's id. */
  async function newPageSaved(runId: string): Promise<string> {
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const page = model.createPage('Menu');
    const versionBefore = server.version;
    const outcome = await applyOperations(model, [{ op: 'insertNodes', pageId: page.id, nodes: [{ type: 'section', label: 'Hero' }] }]);
    if (!outcome.ok) throw new Error('refused');
    server = { version: versionBefore + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    const inserted = (server.snapshot.pages[page.id].appComponentTree.children as Array<{ id: string }>).map((c) => c.id);
    stream().emit('gen:done', { runId, status: 'saved', version: server.version, insertedIds: inserted, drawnAs: [[]] });
    stream().emit('site:version', { origin: 'generate', version: server.version, versionBefore });
    await settle();
    return page.id;
  }

  /** A canvas and one draft frame in the document, the frame inside the canvas's box or outside it. */
  function drawFrame(visible: boolean): () => void {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const ground = document.createElement('div');
    ground.setAttribute('data-ground', '');
    ground.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    const frame = document.createElement('div');
    frame.setAttribute('data-pagegen-draft-frame', 'bp');
    frame.getBoundingClientRect = () => (visible ? rect(600, 100, 800, 600) : rect(2400, 100, 800, 600));
    document.body.append(ground, frame);
    return () => {
      ground.remove();
      frame.remove();
    };
  }

  it('a new page whose draft frames are in view is shown once adopted, though the person moved the camera', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    store.editorUI.livePresence.setFollow(false);
    const remove = drawFrame(true);
    const pageId = await newPageSaved('run-1');
    remove();
    expect(draft().target).toBeUndefined();
    expect(store.editorUI.currentPage?.id).toBe(pageId);
    stop();
  });

  it('a new page drafted out of view while the person looks elsewhere waits in the Pages panel', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    store.editorUI.livePresence.setFollow(false);
    const remove = drawFrame(false);
    const pageId = await newPageSaved('run-1');
    remove();
    expect(draft().target).toBeUndefined();
    expect(project().getPage(pageId)).toBeDefined();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    stop();
  });

  it('a new page whose frames are in view stays in the Pages panel when the tab is hidden', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    store.editorUI.livePresence.setFollow(false);
    const remove = drawFrame(true);
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await newPageSaved('run-1');
    state.mockRestore();
    remove();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    stop();
  });

  it('a new page whose frames are in view stays in the Pages panel while the Preview covers the canvas', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    store.editorUI.livePresence.setFollow(false);
    const remove = drawFrame(true);
    store.editorUI.setPreviewOpen(true);
    await newPageSaved('run-1');
    remove();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    stop();
  });

  it('ignores malformed events and a target this copy does not have', () => {
    const stop = start();
    stream().emit('gen:section', { runId: '../x', target: target(), index: 0, slot: 0, node: node('A') });
    stream().emit('gen:section', { runId: 'run-1', target: { kind: 'replace', pageId: homeId(), nodeId: 'not-here' }, index: 0, slot: 0, node: node('A') });
    stream().emit('gen:outline', { runId: 'run-2', target: { kind: 'insert', pageId: homeId() }, outline: [] });
    expect(draft().target).toBeUndefined();
    stop();
  });
});


// ---- hardening (review of 2026-11-09: stateflow F1 to F7, UX H1 and H2) --------------

/** The server's copy after any change by another writer, announced on the stream (or not). */
async function serverWrites(change: (model: ProjectModelType) => void | Promise<void>, event: Partial<SiteVersionEvent> | null = {}): Promise<void> {
  const model = ProjectModel.create(server.snapshot) as ProjectModelType;
  await change(model);
  const versionBefore = server.version;
  server = { version: versionBefore + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
  if (event) stream().emit('site:version', { origin: 'mcp', actor: { kind: 'key', label: 'Claude' }, version: server.version, versionBefore, ...event });
  await settle();
}

/** An open draft (the canvas's inline editor, a panel field) whose dirtiness the test controls. */
function openDraft(onCommit: () => void = () => {}) {
  let dirty = true;
  const unregister = registerOpenDraft({ isDirty: () => dirty, commit: () => onCommit() });
  return {
    commitAndClose: () => {
      onCommit();
      dirty = false;
      unregister();
    },
    cancel: () => {
      dirty = false;
      unregister();
    },
  };
}

describe('liveSync: an agent writes while the person types (F1)', () => {
  it('forward: an open text draft holds the copy without the dialog; once the draft closes clean, the copy is adopted', async () => {
    start();
    const draft = openDraft();
    await agentWrites('agent');
    expect(knownServerVersion(SITE)).toBe(1);
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ version: 2, whileEditing: true });
    // Nothing unsaved yet: no dialog, autosave untouched.
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    draft.cancel();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
    expect(working()).toEqual(server.snapshot);
    expect(liveSyncFor(SITE)?.heldVersion).toBeUndefined();
  });

  it('backtrack: the draft commits a site setting (not a node value it can replay on top), so the dialog opens, nothing merged', async () => {
    start();
    const draft = openDraft(() => project().updateMetadata({ description: 'typed' }));
    await agentWrites('agent');
    draft.commitAndClose();
    await settle();
    expect(working().metadata.description).toBe('typed');
    expect(knownServerVersion(SITE)).toBe(1);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', currentVersion: 2, dialogOpen: true });
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ version: 2 });
    expect(liveSyncFor(SITE)?.heldVersion?.whileEditing).toBeUndefined();
  });

  it('the page being typed on is deleted by the agent: the typing lands, the dialog names the page keeping mine restores', async () => {
    // A second page, saved on the server and adopted.
    start();
    let aboutId = '';
    await serverWrites((m) => {
      aboutId = m.createPage('About').id;
    });
    expect(project().getPage(aboutId)).toBeDefined();
    store.editorUI.setCurrentPage(project().getPage(aboutId)!);
    const draft = openDraft(() => project().getPage(aboutId)!.updateMetadata?.({ description: 'typed on About' }));
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'deletePage', pageId: aboutId }]);
      if (!outcome.ok) throw new Error('refused');
    });
    // Held: the page is still on screen with the draft in it.
    expect(project().getPage(aboutId)).toBeDefined();
    expect(store.editorUI.currentPage?.id).toBe(aboutId);
    draft.commitAndClose();
    await settle();
    const sync = liveSyncFor(SITE)!;
    expect(autosaveFor(SITE).getState().phase).toBe('conflict');
    expect(pagesRemovedBy(sync.heldVersion, working(), knownServerPageIds(SITE))).toEqual(['About']);
    expect(restoredPagesSentence(pagesRemovedBy(sync.heldVersion, working(), knownServerPageIds(SITE)), heldWriter(sync.heldVersion), 'save')).toBe(
      'Saving yours restores the page ‘About’ that Claude deleted.',
    );
    // Load the newer version: the page goes and another one is shown.
    await loadNewerVersion(SITE);
    expect(project().getPage(aboutId)).toBeUndefined();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
  });

  it("a text edit open on the canvas holds the copy; ending it adopts at once (no wait for the fallback)", async () => {
    start();
    const node = project().getPage(homeId())!.appComponentTree;
    store.editorUI.beginTextEdit(node);
    await agentWrites('agent');
    expect(knownServerVersion(SITE)).toBe(1);
    store.editorUI.endTextEdit();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
  });

  it('a drag (a batched gesture) or a resize holds the copy until it ends', async () => {
    start();
    const history = getHistoryStore()!;
    history.startBatch('Move');
    await agentWrites('during drag');
    expect(knownServerVersion(SITE)).toBe(1);
    history.commitBatch();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);

    store.editorUI.startResize({} as never);
    await agentWrites('during resize');
    expect(knownServerVersion(SITE)).toBe(2);
    store.editorUI.endResize();
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
  });

  it('a draft whose owner never announces it settled is looked at again by the fallback', async () => {
    start();
    let dirty = true;
    registerOpenDraft({ isDirty: () => dirty, commit: () => {} });
    await agentWrites('agent');
    expect(knownServerVersion(SITE)).toBe(1);
    dirty = false; // reverted without a word
    await vi.advanceTimersByTimeAsync(EDITING_RECHECK_MS);
    expect(knownServerVersion(SITE)).toBe(2);
  });

  it('a newer write while held replaces the held copy, still without the dialog', async () => {
    start();
    const draft = openDraft();
    await agentWrites('one');
    await agentWrites('two');
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ version: 3, whileEditing: true });
    draft.cancel();
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
  });

  it('resume: a held copy does not survive stopping; the next run fetches again and holds again while the typing goes on', async () => {
    const stop = start();
    const draft = openDraft();
    await agentWrites('agent');
    stop();
    expect(liveSyncFor(SITE)).toBeUndefined();
    start();
    await settle();
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ version: 2, whileEditing: true });
    draft.cancel();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
  });

  it('re-entry: after one held copy was adopted, the next write while typing is held again', async () => {
    start();
    const first = openDraft();
    await agentWrites('one');
    first.cancel();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
    const second = openDraft();
    await agentWrites('two');
    expect(knownServerVersion(SITE)).toBe(2);
    second.cancel();
    await settle();
    expect(knownServerVersion(SITE)).toBe(3);
  });
});

describe('liveSync: a settled edit goes on top of the agent\'s copy (review of PR #353)', () => {
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void; props: { children?: unknown } };

  it('typing committed on a node the agent left alone: no dialog, both changes kept, saved on the agent\'s version', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second'); // held while the person types
    expect(knownServerVersion(SITE)).toBe(2);
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('typed by the person');
    expect(JSON.stringify(working())).toContain('second');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    // One save, based on the agent's version 3; the server is at 4 with both changes.
    expect(saves.map((save) => save.expectedVersion)).toEqual([3]);
    expect(knownServerVersion(SITE)).toBe(4);
    expect(JSON.stringify(server.snapshot)).toContain('typed by the person');
    expect(JSON.stringify(server.snapshot)).toContain('second');
    // Undo takes the person's edit back, then the agent's write: two steps, in that order.
    getHistoryStore()!.undo();
    expect(JSON.stringify(working())).not.toContain('typed by the person');
    expect(JSON.stringify(working())).toContain('second');
  });

  it('the merged copy is saved at once on the agent\'s version; another agent write right after it is adopted, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle();
    // Saved without waiting for the debounce, on version 3 (the agent's), never on 2.
    expect(saves.map((save) => save.expectedVersion)).toEqual([3]);
    expect(knownServerVersion(SITE)).toBe(4);
    await agentWrites('third');
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(knownServerVersion(SITE)).toBe(5);
    const text = JSON.stringify(working());
    for (const part of ['typed by the person', 'second', 'third']) expect(text).toContain(part);
  });

  it('a replay that fails on its second node is taken back whole: the agent\'s copy exactly, nothing saved, a notice, no half step', async () => {
    start();
    await agentWrites('one');
    await agentWrites('two');
    const [a, b] = [homeChild(0), homeChild(1)];
    // One edit of two nodes, one undo step (as a gesture batches it).
    const draft = openDraft(() => {
      const history = getHistoryStore()!;
      history.startBatch('Edit');
      a.setTextContent('person A');
      b.setTextContent('person B');
      history.commitBatch();
    });
    await agentWrites('three');
    let calls = 0;
    setReplayApplyForTests((node, field, value) => {
      calls++;
      if (calls === 2) throw new Error('injected');
      // The real write for the first node.
      applyPatch(node, { op: 'replace', path: `/${field}`, value });
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const historyBefore = getHistoryStore()!.history.length;
    try {
      draft.commitAndClose();
      await settle();
    } finally {
      setReplayApplyForTests(undefined);
    }
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalled();
    // Exactly the agent's copy: neither person edit kept.
    expect(working()).toEqual(server.snapshot);
    expect(knownServerVersion(SITE)).toBe(server.version);
    // The person's step gave way to the held write's adoption: exactly one new step, the agent's, and no half step of the replay.
    const history = getHistoryStore()!;
    expect(history.history.length).toBe(historyBefore + 1);
    expect(history.undoIdx).toBe(history.history.length);
    expect(history.canRedo).toBe(false);
    expect(history.labelFor(history.history[history.history.length - 1])).toContain('Claude');
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saves).toEqual([]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
  });

  it('a resize writing on every move, with the agent saving mid-gesture: no dialog under the cursor, the resize replayed on top', async () => {
    start();
    await agentWrites('one');
    await agentWrites('two');
    const node = homeChild(0);
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('move 1'); // the copy differs from the saved one from the first move on
    await agentWrites('during the gesture');
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    node.setTextContent('move 2'); // the same value written again
    node.setTextContent('final size');
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    const text = JSON.stringify(working());
    expect(text).toContain('final size');
    expect(text).toContain('during the gesture');
    expect(text).not.toContain('move 1');
  });

  it('an edit of two nodes is replayed as one undo step under its own name; the next undo takes back the agent\'s write', async () => {
    start();
    await agentWrites('one');
    await agentWrites('two');
    const [a, b] = [homeChild(0), homeChild(1)];
    const history = getHistoryStore()!;
    const draft = openDraft(() => {
      history.startBatch('Edit text');
      a.setTextContent('person A');
      b.setTextContent('person B');
      history.commitBatch();
    });
    await agentWrites('three');
    draft.commitAndClose();
    await settle();
    const last = history.history[history.history.length - 1];
    expect(history.labelFor(last)).toContain('Edit text');
    expect(last.remote).toBe(false);
    history.undo();
    expect(JSON.stringify(working())).not.toContain('person A');
    expect(JSON.stringify(working())).not.toContain('person B');
    expect(JSON.stringify(working())).toContain('three');
    history.undo();
    expect(JSON.stringify(working())).not.toContain('three');
  });

  it('still editing when the look again comes (one edit committed, the next draft already open): nothing replayed or adopted under the cursor', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const first = openDraft(() => node.setTextContent('first edit'));
    await agentWrites('agent');
    // The first edit commits and the person is already typing the next one, in the same moment.
    first.commitAndClose();
    const second = openDraft();
    noteWriteInFlight(SITE, true);
    noteWriteInFlight(SITE, false); // a write of this tab settling asks for a look too
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    expect(JSON.stringify(working())).not.toContain('"agent"');
    second.cancel();
    await settle();
    // Settled now: the first edit goes on top of the agent's copy.
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('first edit');
    expect(knownServerVersion(SITE)).toBeGreaterThanOrEqual(3);
  });

  /** Saves wait at a gate the test opens; a save on an old version is refused (409). */
  function gatedSaves() {
    const gates: Array<() => void> = [];
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => gates.push(resolve));
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    return { release: () => gates.shift()?.() };
  }

  it('the merged save refused before the agent\'s newer copy arrives (the usual order): the edit is replayed again once it does, no dialog left', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const gate = gatedSaves();
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle(); // replayed on 3, its save waits at the gate
    // The agent writes again; the refusal comes back before the event (one round trip against two).
    const event = await agentWrites('third', false);
    const opened: boolean[] = [];
    const stopWatching = autosaveFor(SITE).subscribe(() => {
      const state = autosaveFor(SITE).getState();
      opened.push(state.phase === 'conflict' && state.dialogOpen);
    });
    gate.release();
    await settle();
    await settle();
    // The refusal names the newer version, fetched at once: the edit is replayed (or about to be), the dialog held meanwhile.
    expect(autosaveFor(SITE).getState()).not.toMatchObject({ phase: 'conflict', dialogOpen: true });
    stream().emit('site:version', event); // late: its version is held already
    await settle();
    gate.release();
    await settle();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    const text = JSON.stringify(server.snapshot);
    for (const part of ['typed by the person', 'second', 'third']) expect(text).toContain(part);
    stopWatching();
    // The dialog never stood open in between.
    expect(opened).not.toContain(true);
  });

  it('the same with the stream down: the poll brings the newer copy, and the edit is replayed again', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const gate = gatedSaves();
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle();
    stream().fail(true); // refused: polling from now on
    await agentWrites('third', false);
    gate.release();
    await settle();
    await settle();
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    gate.release();
    await settle();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('typed by the person');
    expect(JSON.stringify(server.snapshot)).toContain('third');
  });

  it('Cmd+S right after typing, with an agent write held for it: replayed on top, then one save on the agent\'s version, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let dirty = true;
    registerOpenDraft({
      isDirty: () => dirty,
      commit: () => {
        node.setTextContent('typed then saved');
        dirty = false;
      },
    });
    await agentWrites('agent');
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    const key = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true });
    expect(handleSaveShortcut(key, store.editorUI)).toBe(true);
    await settle();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    const text = JSON.stringify(server.snapshot);
    expect(text).toContain('typed then saved');
    expect(text).toContain('agent');
  });

  it('the merged save refused because the agent wrote again first: the edit is replayed once more, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let gate: (() => void) | undefined;
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle(); // replayed on 3, its save is out
    const opened: boolean[] = [];
    const watch = setInterval(() => opened.push(autosaveFor(SITE).getState().phase === 'conflict'), 1);
    await agentWrites('third'); // lands first: the save will be refused
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    gate!();
    await settle();
    await settle();
    // Refused on 3, replayed on 4, saved there.
    gate?.();
    await settle();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    clearInterval(watch);
    // The refusal was met by the replay in the same moment: the dialog never stood open in between.
    expect(autosaveFor(SITE).getState()).not.toMatchObject({ dialogOpen: true });
    const text = JSON.stringify(server.snapshot);
    for (const part of ['typed by the person', 'second', 'third']) expect(text).toContain(part);
  });

  it('a replay that would push a reusable component over its size limit is never tried: the dialog asks, nothing undone', async () => {
    type TextNode = { id: string; props: { children?: unknown }; children?: TextNode[]; setTextContent(t: string): void };
    /** The node of a component definition whose text is `text`. */
    const inDefinition = (m: ProjectModelType, text: string): TextNode => {
      const visit = (node: TextNode): TextNode | undefined =>
        node.props?.children === text ? node : (node.children ?? []).map(visit).find(Boolean);
      for (const def of m.components.values()) {
        const found = visit((def as unknown as { page: { appComponentTree: TextNode } }).page.appComponentTree);
        if (found) return found;
      }
      throw new Error(`no node with ${text}`);
    };
    start();
    // A component of two text nodes, saved and adopted.
    await serverWrites(async (m) => {
      const home = m.pagesArray.find((page) => page.slug === '')!;
      const outcome = await applyOperations(m, [{ op: 'insertNodes', pageId: home.id, nodes: [{ type: 'div', children: [{ type: 'p', props: { children: 'A' } }, { type: 'p', props: { children: 'B' } }] }] }]);
      if (!outcome.ok) throw new Error('refused');
      const made = m.createComponentFromSelection(home.id, [(home.appComponentTree.children[0] as { id: string }).id], 'Block');
      if (!made.ok) throw new Error('component');
    });
    const a = inDefinition(project(), 'A');
    const big = 'x'.repeat(150 * 1024);
    // The agent grows B, the person grows A: each fine alone, too big together.
    const draft = openDraft(() => a.setTextContent(big));
    await serverWrites((m) => inDefinition(m, 'B').setTextContent(big));
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    const historyBefore = getHistoryStore()!.history.length;
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).toBe('conflict');
    // Nothing undone: the person's edit stands, as its own step.
    expect(inDefinition(project(), big).id).toBe(a.id);
    expect(getHistoryStore()!.history.length).toBe(historyBefore + 1);
  });

  it('the agent changed the same text: a real conflict, the dialog asks', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node.id, text: 'rewritten by the agent' }]);
      if (!outcome.ok) throw new Error('refused');
    });
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', currentVersion: 3 });
    expect(JSON.stringify(working())).toContain('typed by the person');
  });

  it('the agent deleted the node being typed in: the dialog asks', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'removeNode', nodeId: node.id }]);
      if (!outcome.ok) throw new Error('refused');
    });
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).toBe('conflict');
  });

  it('a page made here and not saved yet is never named as deleted by the agent', async () => {
    start();
    project().createPage('Pricing'); // unsaved, the agent never saw it
    await agentWrites('elsewhere');
    const sync = liveSyncFor(SITE)!;
    expect(autosaveFor(SITE).getState().phase).toBe('conflict');
    expect(pagesRemovedBy(sync.heldVersion, working(), knownServerPageIds(SITE))).toEqual([]);
  });
});

describe('liveSync: replay edge cases (third review of PR #353)', () => {
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void };

  it('a refused merged save comes back while the person types again: nothing replayed or adopted under the cursor, then it settles', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let gate: (() => void) | undefined;
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    const first = openDraft(() => node.setTextContent('typed'));
    await agentWrites('second');
    first.commitAndClose();
    await settle(); // replayed on 3, its save out
    await agentWrites('third'); // lands first: the save will be refused
    const typing = openDraft();
    gate!();
    await settle();
    await settle();
    // Still typing: held for it, nothing adopted.
    expect(knownServerVersion(SITE)).toBe(3);
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ version: 4, whileEditing: true });
    expect(JSON.stringify(working())).not.toContain('"third"');
    typing.cancel();
    await settle();
    // Settled: the edit replayed on 4, saved there.
    gate!();
    await settle();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    const text = JSON.stringify(server.snapshot);
    for (const part of ['typed', 'second', 'third']) expect(text).toContain(part);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
  });

  it('an edit made after an undo (a redo tail dropped) still replays', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    node.setTextContent('earlier');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    getHistoryStore()!.undo(); // a redo step now waits
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    const draft = openDraft(() => node.setTextContent('after undo'));
    await agentWrites('agent');
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('after undo');
    expect(JSON.stringify(working())).toContain('agent');
  });

  it('an edit made with the history at its limit (the oldest entry trimmed) still replays', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    for (let i = 0; i < 505; i++) project().updateMetadata({ description: `d${i}` });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(getHistoryStore()!.history.length).toBe(500);
    const draft = openDraft(() => node.setTextContent('at the limit'));
    await agentWrites('agent');
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('at the limit');
    expect(JSON.stringify(working())).toContain('agent');
  });

  it('an edit committed while the announced copy is still being fetched replays, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('committed during the fetch'));
    holdFetch = { release: () => {} };
    await agentWrites('agent'); // announced, its fetch held
    draft.commitAndClose();
    await settle();
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('committed during the fetch');
    expect(JSON.stringify(working())).toContain('agent');
  });

  it('after the merged save landed, an ordinary unsaved edit meeting an agent write opens the dialog at once', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('typed'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3]); // the merged save landed
    // An ordinary save out when the agent writes: the usual dialog, not a replay hold.
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'later' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('third');
    // Held as any unsaved work is (not as a replay's), and the refusal opens the dialog as it always did.
    expect(liveSyncFor(SITE)?.heldVersion).toBeDefined();
    expect(liveSyncFor(SITE)?.heldVersion?.afterReplay).toBeUndefined();
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(JSON.stringify(working())).toContain('later');
  });

  it('an edit inside a reusable component replays on top of the agent\'s copy', async () => {
    type TextNode = { id: string; props: { children?: unknown }; children?: TextNode[]; setTextContent(t: string): void };
    const inDefinitions = (m: ProjectModelType, text: string): TextNode => {
      const visit = (node: TextNode): TextNode | undefined => (node.props?.children === text ? node : (node.children ?? []).map(visit).find(Boolean));
      for (const def of m.components.values()) {
        const found = visit((def as unknown as { page: { appComponentTree: TextNode } }).page.appComponentTree);
        if (found) return found;
      }
      throw new Error(`no node with ${text}`);
    };
    start();
    await serverWrites(async (m) => {
      const home = m.pagesArray.find((page) => page.slug === '')!;
      const outcome = await applyOperations(m, [
        { op: 'insertNodes', pageId: home.id, nodes: [{ type: 'div', children: [{ type: 'p', props: { children: 'Inside' } }] }, { type: 'div', children: [{ type: 'p', props: { children: 'huge-text-marker' } }] }] },
      ]);
      if (!outcome.ok) throw new Error('refused');
      const [one, two] = home.appComponentTree.children as unknown as Array<{ id: string }>;
      if (!m.createComponentFromSelection(home.id, [one.id], 'Small').ok) throw new Error('component');
      if (!m.createComponentFromSelection(home.id, [m.pagesArray.find((p) => p.slug === '')!.appComponentTree.children[1].id], 'Huge').ok) throw new Error('component');
      void two;
    });
    const inside = inDefinitions(project(), 'Inside');
    const draft = openDraft(() => inside.setTextContent('edited inside'));
    await agentWrites('agent elsewhere');
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('edited inside');
    expect(JSON.stringify(working())).toContain('agent elsewhere');
  });
});

describe('liveSync: an edit settles after an agent write was held for it', () => {

  it('still editing when a write of this tab settles: the copy keeps waiting, nothing adopted under the cursor', async () => {
    start();
    const draft = openDraft();
    await agentWrites('agent');
    noteWriteInFlight(SITE, true);
    noteWriteInFlight(SITE, false);
    await settle();
    expect(knownServerVersion(SITE)).toBe(1);
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    draft.cancel();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
  });


  it('unsaved work from before an open edit: asked once the edit settles, never during it', async () => {
    start();
    await agentWrites('first');
    project().updateMetadata({ description: 'unsaved before' });
    const draft = openDraft();
    // Held for the open edit, though the copy was already unsaved: the dialog waits for it.
    await agentWrites('agent');
    draft.cancel();
    await settle();
    expect(autosaveFor(SITE).getState().phase).toBe('conflict');
  });

});

describe('liveSync: a refused save\'s dialog waits while the person is mid-edit or a replay is pending', () => {
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void };
  /** A save goes out mid-resize, the agent writes, and the save is refused. */
  async function refusedMidResize(edit: 'text' | 'site setting' = 'text') {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const pending: Array<(result: ProjectWriteResult) => void> = [];
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          pending.push(resolve);
        }),
    });
    const finish = (result: ProjectWriteResult) => pending.shift()?.(result);
    autosaveFor(SITE).attach(project());
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    if (edit === 'text') node.setTextContent('moving');
    else project().updateMetadata({ description: 'a setting no replay carries' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS); // the save goes out mid-gesture
    await agentWrites('agent', false);
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    const end = () => {
      history.commitBatch();
      store.editorUI.endResize();
    };
    return { end };
  }

  afterEach(async () => {
    // No save of this block stays out for the next test (a write in flight is module state).
    while (hasWriteInFlight(SITE)) {
      noteWriteInFlight(SITE, false);
    }
    await settle();
  });

  it('refused mid-gesture: no dialog under the cursor; it opens once the gesture ended (an edit no replay carries)', async () => {
    const { end } = await refusedMidResize('site setting');
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS * 3);
    expect(autosaveFor(SITE).getState()).toMatchObject({ dialogOpen: false });
    end();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
  });

  it('never held longer than the limit, even while a gesture stays open', async () => {
    const { end } = await refusedMidResize('site setting');
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_MAX_MS - HELD_DIALOG_CHECK_MS * 2);
    expect(autosaveFor(SITE).getState()).toMatchObject({ dialogOpen: false });
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS * 3);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    end();
  });

  it('the agent writing again while the dialog waits moves its version and does not end the wait', async () => {
    const { end } = await refusedMidResize('site setting');
    stream().emit('site:version', { origin: 'mcp', version: server.version, versionBefore: server.version - 1 });
    await settle();
    await agentWrites('agent again');
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, currentVersion: server.version });
    end();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true, currentVersion: server.version });
  });

  it('a resize refused mid-gesture that the replay can carry: once it ends, replayed on the agent\'s copy, no dialog at all', async () => {
    const { end } = await refusedMidResize();
    stream().emit('site:version', { origin: 'mcp', version: server.version, versionBefore: server.version - 1 });
    await settle();
    end();
    await settle();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS * 2);
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('moving');
    expect(JSON.stringify(working())).toContain('agent');
  });

  it('"Keep editing" is the person\'s answer: the held dialog does not come back by itself', async () => {
    const { end } = await refusedMidResize('site setting');
    autosaveFor(SITE).openConflict(); // from the status...
    autosaveFor(SITE).dismissConflict(); // ...and Keep editing
    end();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_MAX_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
  });

  it('a replay that turns out impossible (the agent changed the same text) opens the held dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const gates: Array<() => void> = [];
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => gates.push(resolve));
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle(); // replayed on 3, its save waits
    // The agent rewrites the very text; the refusal comes first.
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node.id, text: 'the agent\'s text' }]);
      if (!outcome.ok) throw new Error('refused');
    }, null);
    gates.shift()!();
    await settle();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    stream().emit('site:version', { origin: 'mcp', version: server.version, versionBefore: server.version - 1 });
    await settle();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(JSON.stringify(working())).toContain('typed by the person');
  });

  it('a stopped sync removes only its own hold: a newer sync\'s hold stands (two syncs overlapping)', async () => {
    const older = new LiveSync(SITE, store, deps);
    const newer = new LiveSync(SITE, store, deps);
    older.start();
    newer.start(); // installs its own hold over the older one's
    older.stop(); // must not take the newer one's hold away
    const draft = openDraft(); // mid-edit
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent', false);
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    draft.cancel();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ dialogOpen: true });
    newer.stop();
  });
});

describe('liveSync: a save refused mid-edit still gets the replay (review of PR #358)', () => {
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void };
  /** Every state autosave passed through: whether its dialog ever stood open. */
  function watchDialog() {
    const opened: boolean[] = [];
    const stop = autosaveFor(SITE).subscribe(() => {
      const state = autosaveFor(SITE).getState();
      opened.push(state.phase === 'conflict' && state.dialogOpen);
    });
    return { everOpened: () => opened.includes(true), stop };
  }

  it('Cmd+S while the announced copy is still being fetched: refused, then replayed on the copy, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let dirty = true;
    registerOpenDraft({
      isDirty: () => dirty,
      commit: () => {
        node.setTextContent('typed then saved');
        dirty = false;
      },
    });
    const dialog = watchDialog();
    holdFetch = { release: () => {} };
    await agentWrites('agent'); // announced while typing; its copy is on the way
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    await settle(); // the save on the old version is refused
    expect(saves.map((save) => save.expectedVersion)).toEqual([2]);
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await settle();
    expect(saves.map((save) => save.expectedVersion)).toEqual([2, 3]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('typed then saved');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    dialog.stop();
    expect(dialog.everOpened()).toBe(false);
  });

  it('a resize refused mid-gesture, the agent\'s version announced during it and its copy arriving after: replayed, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const history = getHistoryStore()!;
    const dialog = watchDialog();
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('resized');
    holdFetch = { release: () => {} };
    await agentWrites('agent'); // announced mid-gesture; its copy is on the way
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS); // the save goes out and is refused
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('resized');
    expect(JSON.stringify(working())).toContain('agent');
    dialog.stop();
    expect(dialog.everOpened()).toBe(false);
  });

  it('a resize refused mid-gesture with no version announced yet: the copy that comes after replays it, no dialog', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const history = getHistoryStore()!;
    const dialog = watchDialog();
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('resized');
    const event = await agentWrites('agent', false); // the agent wrote; no event yet
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS); // the save is refused mid-gesture
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    history.commitBatch();
    store.editorUI.endResize();
    stream().emit('site:version', event); // the event right after the gesture
    await settle();
    await settle();
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    expect(JSON.stringify(working())).toContain('resized');
    expect(JSON.stringify(working())).toContain('agent');
    dialog.stop();
    expect(dialog.everOpened()).toBe(false);
  });

  it('Cmd+S while a refused replay waits for the agent\'s copy keeps the dialog held; the replay resolves it', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const gates: Array<() => void> = [];
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => gates.push(resolve));
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    draft.commitAndClose();
    await settle(); // replayed on 3, its save waits
    const event = await agentWrites('third', false);
    const dialog = watchDialog();
    holdFetch = { release: () => {} }; // the newer copy is slow to come
    gates.shift()!(); // refused before the copy comes
    await settle();
    await settle();
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    stream().emit('site:version', event);
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await settle();
    gates.shift()!();
    await settle();
    await settle();
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    dialog.stop();
    expect(dialog.everOpened()).toBe(false);
  });
});

describe('liveSync: a replay never lands over other unsaved work (narrow review of PR #358)', () => {
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void };
  /** A text edit committed while an agent write was announced, its save refused; answers the pending-save resolver. */
  async function refusedEdit() {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const gates: Array<() => void> = [];
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => gates.push(resolve));
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    return { node, release: () => gates.shift()?.() };
  }
  afterEach(async () => {
    while (hasWriteInFlight(SITE)) noteWriteInFlight(SITE, false);
    await settle();
  });

  it('a second edit after the refused save: no replay, both edits kept, the dialog asks', async () => {
    const { node, release } = await refusedEdit();
    holdFetch = { release: () => {} };
    const draft = openDraft(() => node.setTextContent('first edit'));
    await agentWrites('agent');
    draft.commitAndClose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    release(); // refused
    await settle();
    project().updateMetadata({ description: 'second edit' }); // another edit before the copy comes
    holdFetch.release();
    holdFetch = undefined;
    await settle();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(JSON.stringify(working())).toContain('first edit');
    expect(working().metadata.description).toBe('second edit');
    expect(JSON.stringify(working())).not.toContain('"agent"');
  });

  it('unsaved work from before the gesture: no replay, both kept, the dialog asks', async () => {
    const { node, release } = await refusedEdit();
    project().updateMetadata({ description: 'from before' });
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('resized');
    await agentWrites('agent', false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
    release(); // refused mid-gesture
    await settle();
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(working().metadata.description).toBe('from before');
    expect(JSON.stringify(working())).toContain('resized');
  });

  it('typing in a field plus a direct edit, both unsaved: no replay, both kept, the dialog asks', async () => {
    const { node, release } = await refusedEdit();
    project().updateMetadata({ description: 'direct edit' });
    const draft = openDraft(() => node.setTextContent('typed'));
    await agentWrites('agent');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    release(); // the direct edit's save is refused
    await settle();
    draft.commitAndClose();
    await settle();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(working().metadata.description).toBe('direct edit');
    expect(JSON.stringify(working())).toContain('typed');
  });

  it('a copy whose fetch hangs holds the dialog at most LIVE_HELD_FETCH_MS; then Cmd+S and the hold open it', async () => {
    const { node, release } = await refusedEdit();
    const draft = openDraft(() => node.setTextContent('typed'));
    holdFetch = { release: () => {} }; // the copy never comes
    await agentWrites('agent');
    draft.commitAndClose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    release(); // refused
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    await vi.advanceTimersByTimeAsync(LIVE_HELD_FETCH_MS + HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    holdFetch.release();
    holdFetch = undefined;
  });

  it('a tab that only polls: a save refused mid-gesture fetches the newer copy at once, the replay comes, the dialog never opens', async () => {
    const { node, release } = await refusedEdit();
    stream().fail(true); // polling from now on
    const opened: boolean[] = [];
    const stopWatching = autosaveFor(SITE).subscribe(() => {
      const state = autosaveFor(SITE).getState();
      opened.push(state.phase === 'conflict' && state.dialogOpen);
    });
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('resized');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS); // the save goes out (the polls so far found nothing new)
    await agentWrites('agent', false); // the agent writes while it is out; the next poll is seconds away
    release(); // refused mid-gesture
    await settle();
    await settle();
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    release(); // the replayed edit's save
    await settle();
    await settle();
    stopWatching();
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(opened).not.toContain(true);
    expect(JSON.stringify(server.snapshot)).toContain('resized');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
  });
});

describe('liveSync: a settled edit whose save was waiting or out when the agent wrote (production proof of 2026-11-12)', () => {
  // The edit is committed (Enter), so nothing marks it; its save is in the 1.5 s
  // debounce or out when the agent writes another node. It is replayed on top of
  // the agent's copy when undoing the person's steps since the last saved copy
  // gives exactly that saved copy; anything else still opens the dialog.
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void };
  const text = () => JSON.stringify(working());

  /** Two agent nodes adopted (version 3); from now on every save waits for `release`. */
  async function gatedSaves() {
    start();
    await agentWrites('first');
    await agentWrites('second');
    const gates: Array<() => void> = [];
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        await new Promise<void>((resolve) => gates.push(resolve));
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        if (expectedVersion !== server.version) return { kind: 'conflict', currentVersion: server.version };
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        return { kind: 'ok', payload: {}, version: server.version };
      },
    });
    autosaveFor(SITE).attach(project());
    return {
      release: async () => {
        gates.shift()?.();
        await settle();
        await settle();
      },
      out: () => gates.length,
    };
  }

  /** Two agent nodes adopted (version 3); saves answer at once. */
  async function twoNodes() {
    start();
    await agentWrites('first');
    await agentWrites('second');
  }

  /** Every state autosave passes through: whether its dialog ever opened, or the status ever showed the conflict. */
  function watch() {
    const states: AutosaveState[] = [];
    const stop = autosaveFor(SITE).subscribe(() => states.push(autosaveFor(SITE).getState()));
    return {
      dialogOpened: () => states.some((state) => state.phase === 'conflict' && state.dialogOpen),
      conflictShown: () => states.some((state) => state.phase === 'conflict' && !state.held),
      stop,
    };
  }

  afterEach(async () => {
    while (hasWriteInFlight(SITE)) noteWriteInFlight(SITE, false);
    await settle();
  });

  it('forward, the save in flight: the agent\'s copy comes, the save is refused, the edit is replayed and saved on the agent\'s version; no dialog, no conflict wording', async () => {
    const { release } = await gatedSaves();
    const seen = watch();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); // its save goes out on 3
    await agentWrites('agent'); // version 4, announced while the save is out: held
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(4);
    await release(); // refused; the replay follows and saves at once
    expect(autosaveFor(SITE).getState().phase).toBe('saving');
    await release();
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('typed by the person');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    expect(seen.dialogOpened()).toBe(false);
    expect(seen.conflictShown()).toBe(false);
    // Undo after the replay takes back only the person's edit; the agent's write stays.
    const history = getHistoryStore()!;
    expect(history.history[history.history.length - 1].remote).toBe(false);
    history.undo();
    expect(text()).not.toContain('typed by the person');
    expect(text()).toContain('agent');
    history.undo();
    expect(text()).not.toContain('"agent"');
  });

  it('the refusal before the agent\'s copy: held, the copy it names is fetched, the edit replayed; no dialog, no conflict wording', async () => {
    const { release } = await gatedSaves();
    const seen = watch();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent', false); // written while the save is out; no event yet
    const before = fetches.length;
    await release(); // refused first
    expect(fetches.length).toBeGreaterThan(before); // the refusal's version is fetched at once
    await release();
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('typed by the person');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    expect(seen.dialogOpened()).toBe(false);
    expect(seen.conflictShown()).toBe(false);
  });

  it('the 1.5 s wait: the agent\'s copy comes before the save went out; replayed and saved at once on the agent\'s version, no dialog', async () => {
    await twoNodes();
    const seen = watch();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS / 2);
    await agentWrites('agent');
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([4]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('typed by the person');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    expect(seen.dialogOpened()).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saves).toHaveLength(1); // nothing left for the old debounce to send
  });

  it('two edits in one autosave window: both replayed, each its own undo step under its own name, in order', async () => {
    await twoNodes();
    const [a, b] = [homeChild(0), homeChild(1)];
    a.setTextContent('person A');
    b.setTextContent('person B');
    const names = getHistoryStore()!.history.slice(-2).map((entry) => getHistoryStore()!.labelFor(entry));
    await agentWrites('agent');
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(saves.map((save) => save.expectedVersion)).toEqual([4]);
    for (const part of ['person A', 'person B', 'agent']) expect(JSON.stringify(server.snapshot)).toContain(part);
    const history = getHistoryStore()!;
    const [first, second] = history.history.slice(-2);
    expect([first.remote, second.remote]).toEqual([false, false]);
    expect([history.labelFor(first), history.labelFor(second)]).toEqual(names);
    history.undo();
    expect(text()).toContain('person A');
    expect(text()).not.toContain('person B');
    expect(text()).toContain('agent');
    history.undo();
    expect(text()).not.toContain('person A');
    expect(text()).toContain('agent');
    history.undo();
    expect(text()).not.toContain('"agent"');
  });

  it('a second edit while the first one\'s save is out: the refusal replays both on the agent\'s copy', async () => {
    const { release } = await gatedSaves();
    const seen = watch();
    homeChild(0).setTextContent('person A');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); // A's save goes out
    homeChild(1).setTextContent('person B'); // during the flight
    await agentWrites('agent');
    await release(); // A's save refused
    await release(); // the replayed save of A and B
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    for (const part of ['person A', 'person B', 'agent']) expect(JSON.stringify(server.snapshot)).toContain(part);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(seen.dialogOpened()).toBe(false);
  });

  it('the agent wrote the same text: the refused save\'s dialog opens (held only for the try), the person\'s text kept', async () => {
    const { release } = await gatedSaves();
    const node = homeChild(0);
    node.setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node.id, text: 'the agent\'s text' }]);
      if (!outcome.ok) throw new Error('refused');
    });
    await release(); // refused; the replay is tried on the held copy and cannot be
    // Held for that try (the status not yet showing the conflict), and only until the next check.
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, held: true });
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(autosaveFor(SITE).getState()).not.toHaveProperty('held');
    expect(text()).toContain('typed by the person');
    expect(saves).toHaveLength(1);
  });

  it('the agent wrote the same text during the 1.5 s wait: the dialog opens at once, the person\'s text kept', async () => {
    await twoNodes();
    const node = homeChild(0);
    node.setTextContent('typed by the person');
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node.id, text: 'the agent\'s text' }]);
      if (!outcome.ok) throw new Error('refused');
    });
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('typed by the person');
    expect(saves).toEqual([]);
  });

  it('Cmd+S during the window: the save goes out at once on the old version, is refused, and the edit is replayed; no dialog', async () => {
    const { release } = await gatedSaves();
    const seen = watch();
    homeChild(0).setTextContent('typed then saved');
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    await settle(); // out at once, before any debounce
    await agentWrites('agent');
    await release(); // refused
    await release(); // the replayed save
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(JSON.stringify(server.snapshot)).toContain('typed then saved');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    expect(seen.dialogOpened()).toBe(false);
    expect(seen.conflictShown()).toBe(false);
  });

  it('a tab that only polls: the refusal fetches the newer copy itself and the edit is replayed; no dialog, no conflict wording', async () => {
    const { release } = await gatedSaves();
    stream().fail(true); // polling from now on
    const seen = watch();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent', false); // no stream to announce it; the next poll is seconds away
    await release(); // refused
    await release(); // the replayed save
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(JSON.stringify(server.snapshot)).toContain('typed by the person');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    expect(seen.dialogOpened()).toBe(false);
    expect(seen.conflictShown()).toBe(false);
  });

  it('a newer copy that never comes holds the refusal at most LIVE_HELD_FETCH_MS; then the dialog opens', async () => {
    const { release } = await gatedSaves();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    holdFetch = { release: () => {} }; // the copy never comes
    await agentWrites('agent', false);
    await release(); // refused
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, held: true });
    await vi.advanceTimersByTimeAsync(LIVE_HELD_FETCH_MS + HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    holdFetch.release();
    holdFetch = undefined;
  });

  it('a copy that comes once the dialog stands open (its fetch outlasted the hold) changes nothing under the person: the dialog stays, nothing replayed', async () => {
    const { release } = await gatedSaves();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    holdFetch = { release: () => {} };
    await agentWrites('agent', false);
    await release(); // refused
    await vi.advanceTimersByTimeAsync(LIVE_HELD_FETCH_MS + HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    holdFetch.release(); // the copy arrives while the person reads the dialog
    holdFetch = undefined;
    await settle();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('typed by the person');
    expect(text()).not.toContain('"agent"');
    expect(saves).toHaveLength(1);
  });

  /** A committed edit whose save was refused while the agent's copy is still on the way (it arrives when `arrive` is called). */
  async function refusedWhileCopyComes(agent: () => Promise<unknown> = () => agentWrites('agent', false)) {
    const gated = await gatedSaves();
    homeChild(0).setTextContent('typed by the person');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    holdFetch = { release: () => {} };
    await agent();
    await gated.release(); // refused, held for the copy
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, held: true });
    return {
      ...gated,
      arrive: async () => {
        holdFetch!.release();
        holdFetch = undefined;
        await settle();
        await settle();
      },
    };
  }

  it('the agent\'s version announced while typing, the edit committed with Cmd+S before the copy came: the stale mark does not stop the replay', async () => {
    const { release } = await gatedSaves();
    const seen = watch();
    const draft = openDraft(() => homeChild(0).setTextContent('typed then saved'));
    holdFetch = { release: () => {} };
    await agentWrites('agent'); // announced mid-typing: marks the edit; its copy is on the way
    draft.commitAndClose();
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    await settle(); // the save on 3 goes out
    holdFetch.release(); // the copy lands while the save is out: held
    holdFetch = undefined;
    await settle();
    await release(); // refused: held, and the held copy replays the edit
    await release(); // the replayed save
    seen.stop();
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
    expect(JSON.stringify(server.snapshot)).toContain('typed then saved');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
    expect(seen.dialogOpened()).toBe(false);
  });

  it('Cmd+S while the refusal waits for the copy: still held; the copy replays the edit, no dialog', async () => {
    const { arrive, release } = await refusedWhileCopyComes();
    const seen = watch();
    handleSaveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }), store.editorUI);
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, held: true });
    await arrive();
    await release();
    seen.stop();
    expect(seen.dialogOpened()).toBe(false);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(saves.map((save) => save.expectedVersion)).toEqual([3, 4]);
  });

  it('a Publish that changes nothing while the refusal waits: the wait comes back with its timer, and a failed replay still opens the dialog', async () => {
    const node = () => homeChild(0);
    const { arrive } = await refusedWhileCopyComes(() =>
      serverWrites(async (m) => {
        const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node().id, text: 'the agent\'s text' }]);
        if (!outcome.ok) throw new Error('refused');
      }, null),
    );
    await autosaveFor(SITE).exclusive(async () => ({ kind: 'error' as const })); // a Publish that failed: no version moved
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, held: true });
    await arrive(); // the agent changed the same text: the replay cannot be
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(autosaveFor(SITE).getState()).not.toHaveProperty('held');
    expect(text()).toContain('typed by the person');
  });

  it('backtrack while the refusal waits: the edit undone back to the saved copy, the copy that comes is simply adopted, no dialog', async () => {
    const { arrive } = await refusedWhileCopyComes();
    const seen = watch();
    getHistoryStore()!.undo();
    await arrive();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS * 2);
    seen.stop();
    expect(seen.dialogOpened()).toBe(false);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(knownServerVersion(SITE)).toBe(4);
    expect(text()).toContain('agent');
    expect(text()).not.toContain('typed by the person');
    expect(saves).toHaveLength(1);
  });

  it('resume: the live sync stopped and started while the refusal waits: its hold goes with it and the dialog asks, the edit kept', async () => {
    await refusedWhileCopyComes();
    liveSyncFor(SITE)!.stop();
    start();
    await vi.advanceTimersByTimeAsync(HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('typed by the person');
    holdFetch?.release();
    holdFetch = undefined;
    await settle();
    // The copy coming now changes nothing under the open dialog.
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('typed by the person');
  });

  it('a refused "Save mine over it" reopens the dialog at once; it is never held as a replay', async () => {
    const { release } = await gatedSaves();
    const node = homeChild(0);
    node.setTextContent('mine');
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node.id, text: 'theirs' }]);
      if (!outcome.ok) throw new Error('refused');
    });
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    const states: AutosaveState[] = [];
    const stop = autosaveFor(SITE).subscribe(() => states.push(autosaveFor(SITE).getState()));
    const state = autosaveFor(SITE).getState();
    void autosaveFor(SITE).saveOver(state.phase === 'conflict' ? state.currentVersion : 0);
    await settle();
    await agentWrites('agent', false); // another write meanwhile: the save over it is refused
    await release();
    stop();
    expect(states.some((s) => s.phase === 'conflict' && s.held)).toBe(false);
    expect(states.some((s) => s.phase === 'conflict' && !s.dialogOpen && !s.retrying)).toBe(false);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
  });

  it('the step limit: ten edits in one window are replayed, eleven ask', async () => {
    await twoNodes();
    for (let i = 0; i < 10; i++) homeChild(i % 2).setTextContent(`edit ${i}`);
    await agentWrites('agent');
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('edit 9');
    expect(JSON.stringify(server.snapshot)).toContain('"agent"');
    for (let i = 0; i < 11; i++) homeChild(i % 2).setTextContent(`more ${i}`);
    await agentWrites('agent again');
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('more 10');
  });

  it('a replay of two steps failing on its second: taken back whole, the agent\'s copy exactly, the notice names both edits', async () => {
    await twoNodes();
    homeChild(0).setTextContent('person A');
    homeChild(1).setTextContent('person B');
    let calls = 0;
    setReplayApplyForTests((node, field, value) => {
      calls++;
      if (calls === 2) throw new Error('injected');
      applyPatch(node, { op: 'replace', path: `/${field}`, value });
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = getHistoryStore()!.history.length;
    try {
      await agentWrites('agent');
    } finally {
      setReplayApplyForTests(undefined);
    }
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalled();
    expect(working()).toEqual(server.snapshot);
    const history = getHistoryStore()!;
    // The two steps gave way to the agent's adoption; no half step of the replay.
    expect(history.history.length).toBe(before - 2 + 1);
    expect(history.history[history.history.length - 1].remote).toBe(true);
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused', message: expect.stringContaining('last 2 edits') });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saves).toEqual([]);
  });

  it('a marked edit of two steps (a direct edit while typing, then the typing committed): both replayed, no dialog', async () => {
    await twoNodes();
    const draft = openDraft(() => homeChild(0).setTextContent('typed'));
    await agentWrites('agent'); // held for the typing: marks where the history stood
    homeChild(1).setTextContent('direct'); // a second step while the draft is open
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    for (const part of ['typed', 'direct', 'agent']) expect(JSON.stringify(server.snapshot)).toContain(part);
    const history = getHistoryStore()!;
    expect(history.history.slice(-2).map((entry) => entry.remote)).toEqual([false, false]);
  });

  it('a replayed save refused while the newer copy never comes: the dialog opens after the held-fetch limit, and a refused "Save mine over it" then reopens it at once', async () => {
    const { release } = await gatedSaves();
    homeChild(0).setTextContent('typed by the person');
    await agentWrites('agent'); // the 1.5 s wait: replayed on 4, its save out
    holdFetch = { release: () => {} }; // the next copy never comes
    await agentWrites('agent again', false);
    await release(); // the replayed save refused
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    await vi.advanceTimersByTimeAsync(LIVE_HELD_FETCH_MS + HELD_DIALOG_CHECK_MS);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    const states: AutosaveState[] = [];
    const stop = autosaveFor(SITE).subscribe(() => states.push(autosaveFor(SITE).getState()));
    const state = autosaveFor(SITE).getState();
    void autosaveFor(SITE).saveOver(state.phase === 'conflict' ? state.currentVersion : 0);
    await settle();
    await agentWrites('and again', false);
    await release(); // the save over it refused
    stop();
    expect(states.some((s) => s.phase === 'conflict' && !s.dialogOpen && !s.retrying)).toBe(false);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('typed by the person');
    holdFetch.release();
    holdFetch = undefined;
  });

  it('every step boundary must fit a reusable component\'s size limit: a first step too big with the agent\'s write is never replayed, though the last step fits', async () => {
    type TextNode = { id: string; props: { children?: unknown }; children?: TextNode[]; setTextContent(t: string): void };
    const inDefinition = (m: ProjectModelType, text: string): TextNode => {
      const visit = (node: TextNode): TextNode | undefined => (node.props?.children === text ? node : (node.children ?? []).map(visit).find(Boolean));
      for (const def of m.components.values()) {
        const found = visit((def as unknown as { page: { appComponentTree: TextNode } }).page.appComponentTree);
        if (found) return found;
      }
      throw new Error(`no node with ${text}`);
    };
    start();
    await serverWrites(async (m) => {
      const home = m.pagesArray.find((page) => page.slug === '')!;
      const outcome = await applyOperations(m, [{ op: 'insertNodes', pageId: home.id, nodes: [{ type: 'div', children: [{ type: 'p', props: { children: 'A' } }, { type: 'p', props: { children: 'B' } }] }] }]);
      if (!outcome.ok) throw new Error('refused');
      if (!m.createComponentFromSelection(home.id, [(home.appComponentTree.children[0] as { id: string }).id], 'Block').ok) throw new Error('component');
    });
    const a = inDefinition(project(), 'A');
    const big = 'x'.repeat(150 * 1024);
    a.setTextContent(big); // step 1: fine alone, too big with the agent's B
    a.setTextContent('small again'); // step 2: fits with anything
    await serverWrites((m) => inDefinition(m, 'B').setTextContent(big)); // the agent grows B during the wait
    // Undo after a replay would bring back step 1 on top of the agent's B: so no replay, the dialog asks.
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(inDefinition(project(), 'small again').id).toBe(a.id);
    expect(saves).toEqual([]);
  });

  it('backtrack and revise: the same text edited twice in one window is replayed with the revised value (compared by its first old value)', async () => {
    await twoNodes();
    const node = homeChild(0);
    node.setTextContent('first try');
    node.setTextContent('revised');
    await agentWrites('agent');
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('revised');
    expect(JSON.stringify(server.snapshot)).not.toContain('first try');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
  });

  it('backtrack: an edit undone back to the saved copy inside the window: the agent\'s copy is simply adopted, nothing replayed or saved', async () => {
    await twoNodes();
    homeChild(0).setTextContent('typed then undone');
    getHistoryStore()!.undo();
    await agentWrites('agent');
    expect(knownServerVersion(SITE)).toBe(4);
    expect(text()).not.toContain('typed then undone');
    expect(text()).toContain('agent');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saves).toEqual([]);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
  });

  it('resume: the editor reopened (the live sync restarted) with the edit still waiting: the next agent copy replays it', async () => {
    await twoNodes();
    homeChild(0).setTextContent('typed before the restart');
    liveSyncFor(SITE)!.stop();
    start();
    await agentWrites('agent');
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(JSON.stringify(server.snapshot)).toContain('typed before the restart');
    expect(JSON.stringify(server.snapshot)).toContain('agent');
  });

  it('resume from a load: unsaved work with no history behind it (a reload\'s fresh history) is never replayed; the dialog asks, the work kept', async () => {
    const { release } = await gatedSaves();
    homeChild(0).setTextContent('kept over the load');
    getHistoryStore()!.clear();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent');
    await release(); // refused: nothing the history can replay, so the dialog opens at once
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(text()).toContain('kept over the load');
    expect(saves).toHaveLength(1);
  });

  it('re-entry after a failed replay: taken back whole with a notice; the next edit and agent write replay again', async () => {
    await twoNodes();
    homeChild(0).setTextContent('lost edit');
    setReplayApplyForTests(() => {
      throw new Error('injected');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await agentWrites('agent one');
    } finally {
      setReplayApplyForTests(undefined);
    }
    expect(error).toHaveBeenCalled();
    expect(working()).toEqual(server.snapshot);
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused' });
    expect(saves).toEqual([]);
    store.editorUI.setEditorNotice(undefined);
    homeChild(1).setTextContent('made again');
    await agentWrites('agent two');
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    expect(saves.map((save) => save.expectedVersion)).toEqual([5]);
    for (const part of ['made again', 'agent one', 'agent two']) expect(JSON.stringify(server.snapshot)).toContain(part);
  });

  it('re-entry after a real conflict: "Load the newer version", then the next edit and agent write replay without a dialog', async () => {
    await twoNodes();
    const node = homeChild(0);
    node.setTextContent('mine');
    await serverWrites(async (m) => {
      const outcome = await applyOperations(m, [{ op: 'updateText', nodeId: node.id, text: 'theirs' }]);
      if (!outcome.ok) throw new Error('refused');
    });
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    await loadNewerVersion(SITE);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    const seen = watch();
    homeChild(1).setTextContent('after the choice');
    await agentWrites('agent');
    seen.stop();
    expect(seen.dialogOpened()).toBe(false);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
    for (const part of ['after the choice', 'theirs', 'agent']) expect(JSON.stringify(server.snapshot)).toContain(part);
  });
});

describe('liveSync: the new page notice and other notices (review of PR #353)', () => {
  async function newPageSaved(runId: string): Promise<string> {
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const page = model.createPage('Menu');
    const versionBefore = server.version;
    const outcome = await applyOperations(model, [{ op: 'insertNodes', pageId: page.id, nodes: [{ type: 'section', label: 'Hero' }] }]);
    if (!outcome.ok) throw new Error('refused');
    server = { version: versionBefore + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    const inserted = (server.snapshot.pages[page.id].appComponentTree.children as Array<{ id: string }>).map((c) => c.id);
    stream().emit('gen:done', { runId, status: 'saved', version: server.version, insertedIds: inserted, drawnAs: [[]] });
    stream().emit('site:version', { origin: 'generate', version: server.version, versionBefore });
    await settle();
    return page.id;
  }

  it('never replaces a state preview badge (the way out of the preview)', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    store.editorUI.setEditorNotice({ kind: 'previewState', message: 'Previewing Hover' });
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    const pageId = await newPageSaved('run-1');
    expect(project().getPage(pageId)).toBeDefined();
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'previewState' });
    stop();
  });

  it('never replaces a notice the person may not have read yet (a refusal)', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    store.editorUI.setEditorNotice({ kind: 'refused', message: 'That edit was refused.' });
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    await newPageSaved('run-1');
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'refused' });
    stop();
  });

  it('goes once the new page is shown by any route (the Pages panel too)', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    const pageId = await newPageSaved('run-1');
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'newPage', pageId });
    store.editorUI.setCurrentPage(project().getPage(pageId)!);
    expect(store.editorUI.editorNotice).toBeUndefined();
    stop();
  });
});

describe('liveSync: a failed fetch while the stream is live (F2)', () => {
  it('a drop and a reconnect start the back-off over: the next failure is retried after 2 s', async () => {
    start();
    server.status = 500;
    stream().emit('site:version', { origin: 'mcp', version: 2, versionBefore: 1 });
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(5_000); // two retries spent
    const spent = fetches.length;
    stream().fail(false);
    server.status = undefined;
    await reconnect();
    server.status = 500;
    stream().emit('site:version', { origin: 'mcp', version: 3, versionBefore: 2 });
    await settle();
    const afterFailure = fetches.length;
    expect(afterFailure).toBeGreaterThan(spent);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetches.length).toBe(afterFailure + 1);
    server.status = undefined;
  });

  it('is tried again after 2 s; the copy is catch-up (no reveal) and adopted', async () => {
    start();
    failFetch = true;
    await agentWrites('agent');
    expect(knownServerVersion(SITE)).toBe(1);
    expect(fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_FETCH_RETRY_MS[0]);
    expect(fetches).toHaveLength(2);
    expect(knownServerVersion(SITE)).toBe(2);
    expect(store.editorUI.liveReveal.size).toBe(0);
  });

  it('backs off: 2 s, then 5 s, then every 15 s, and starts over after a success', async () => {
    start();
    const event = await agentWrites('agent', false);
    server.status = 500;
    stream().emit('site:version', event);
    await settle();
    expect(fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetches).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetches).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetches).toHaveLength(5);
    server.status = undefined;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(knownServerVersion(SITE)).toBe(2);
    // The next failure starts at 2 s again.
    const again = await agentWrites('again', false);
    server.status = 500;
    stream().emit('site:version', again);
    await settle();
    const count = fetches.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetches).toHaveLength(count + 1);
  });

  it('stopping clears the retry: nothing is fetched afterwards', async () => {
    const stop = start();
    failFetch = true;
    await agentWrites('agent');
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches).toHaveLength(1);
  });

  it('the stream going down hands the retry to polling (no double fetch)', async () => {
    start();
    failFetch = true;
    await agentWrites('agent');
    stream().fail(true);
    await vi.advanceTimersByTimeAsync(LIVE_FETCH_RETRY_MS[0]);
    expect(fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(knownServerVersion(SITE)).toBe(2);
  });
});

describe('liveSync: a silent stream and a tab shown again (F3)', () => {
  it('a stream that sent pings and then nothing for 2.5 heartbeats is reopened, polling meanwhile', async () => {
    start();
    const first = stream();
    first.emit(LIVE_PING_EVENT, {});
    await vi.advanceTimersByTimeAsync(LIVE_WATCHDOG_MS - 1);
    expect(streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    expect(liveSyncFor(SITE)?.phase).toBe('polling');
    // Reopened on the same jittered back-off as any ended stream.
    expect(streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    expect(streams).toHaveLength(2);
    stream().open();
    expect(liveSyncFor(SITE)?.phase).toBe('live');
  });

  it('every event keeps a pinging stream alive', async () => {
    start();
    stream().emit(LIVE_PING_EVENT, {});
    await vi.advanceTimersByTimeAsync(LIVE_WATCHDOG_MS - 1_000);
    stream().emit('agent:activity', { agentId: 'a', label: 'Claude', tool: 'x', at: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(LIVE_WATCHDOG_MS - 1_000);
    expect(streams).toHaveLength(1);
  });

  it('an older server that sends no ping arms no watchdog', async () => {
    start();
    await vi.advanceTimersByTimeAsync(LIVE_WATCHDOG_MS * 4);
    expect(streams).toHaveLength(1);
    expect(liveSyncFor(SITE)?.phase).toBe('live');
  });

  it('a tab shown again while live asks once for the newest copy', async () => {
    start();
    await agentWrites('missed while hidden', false);
    expect(knownServerVersion(SITE)).toBe(1);
    for (const listener of visibilityListeners) listener();
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
  });
});

describe('liveSync: the server simply closes the stream (a re-check timeout, an auth outage, a slow reader)', () => {
  it('closed by the server: polls the document route meanwhile, reopens on its own jittered back-off (never the browser\'s fixed retry)', async () => {
    const random = vi.fn(() => 0.5);
    setLiveSyncDepsForTests({ ...deps, random });
    start();
    stream().emit(LIVE_PING_EVENT, {});
    const first = stream();
    first.fail(false); // the server ended it, no auth:expired
    const sync = liveSyncFor(SITE)!;
    expect(sync.phase).toBe('polling');
    expect(sync.wasLive).toBe(true);
    expect(first.closed).toBe(true); // the browser's own reconnect is not left to run
    expect(autosaveFor(SITE).getState().phase).toBe('saved'); // not signed out
    // 2 s plus half again at random: 3 s.
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 1.5 - 1);
    expect(streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(2);
    await agentWrites('while closed', false);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(knownServerVersion(SITE)).toBe(2);
    // It ends again before opening: the next wait doubles (6 s).
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 3 - 1);
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(3);
    stream().open();
    expect(sync.phase).toBe('live');
    // Ended again right after opening (a server that accepts and drops): the wait keeps doubling (12 s).
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 6 - 1);
    expect(streams).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(4);
    // This one keeps going (its pings come): the next end starts at the short wait once more.
    stream().open();
    stream().emit(LIVE_PING_EVENT, {});
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    stream().emit(LIVE_PING_EVENT, {});
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 1.5);
    expect(streams).toHaveLength(5);
  });

  it('a stream that pings once and stalls keeps backing off (a ping alone does not start the wait over)', async () => {
    start();
    const waits: number[] = [];
    for (let round = 0; round < 3; round++) {
      stream().open();
      // As the server does: the first ping a heartbeat after the stream opened, then nothing.
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
      stream().emit(LIVE_PING_EVENT, {});
      const count = streams.length;
      await vi.advanceTimersByTimeAsync(LIVE_WATCHDOG_MS); // silent: reopened after the back-off
      const at = Date.now();
      while (streams.length === count) await vi.advanceTimersByTimeAsync(100);
      waits.push(Date.now() - at);
    }
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
  });

  it('from a server that sends no ping, staying up 2.5 heartbeats starts the back-off over', async () => {
    start();
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    stream().fail(false); // ended before opening: the next wait would be 4 s
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 2);
    stream().open();
    await vi.advanceTimersByTimeAsync(LIVE_WATCHDOG_MS);
    const count = streams.length;
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    expect(streams).toHaveLength(count + 1);
  });

  it('many editors closed at once come back spread out, by their random share', async () => {
    const waits: number[] = [];
    for (const r of [0, 0.25, 0.5, 0.99]) {
      setLiveSyncDepsForTests({ ...deps, random: () => r });
      streams = [];
      const stop = start();
      stream().fail(false);
      const at = Date.now();
      while (streams.length < 2) await vi.advanceTimersByTimeAsync(100);
      waits.push(Date.now() - at);
      stop();
    }
    expect(new Set(waits).size).toBe(4);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(LIVE_RECONNECT_MS);
    expect(Math.max(...waits)).toBeLessThanOrEqual(LIVE_RECONNECT_MS * 2 + 100);
  });

  it('the reconnect refused (closed for good): polling goes on and a new stream is tried after the back-off', async () => {
    start();
    stream().fail(true);
    expect(liveSyncFor(SITE)?.phase).toBe('polling');
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS);
    expect(streams).toHaveLength(count + 1);
    stream().open();
    expect(liveSyncFor(SITE)?.phase).toBe('live');
  });
});

describe('liveSync: a refusal timer never outlives a sign-out', () => {
  it('refused, signed out, back and live: the next drop reconnects after the short wait, not the old refusal\'s', async () => {
    start();
    stream().fail(true); // refused: a retry a minute away
    server.status = 401;
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS); // the poll is told: signed out
    expect(liveSyncFor(SITE)?.phase).toBe('signed-out');
    server.status = undefined;
    for (const listener of visibilityListeners) listener();
    await settle();
    stream().open();
    expect(liveSyncFor(SITE)?.phase).toBe('live');
    const count = streams.length;
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    expect(streams).toHaveLength(count + 1);
  });
});

describe('liveSync: a stream closed for good is asked why (network or refusal)', () => {
  type Answer = 'network' | 'throw' | { status: number; contentType: string };
  let probeAnswer: Answer;
  let probes: Array<{ url: string; signal: AbortSignal }>;
  let releaseProbe: (() => void) | undefined;
  const stream200 = { status: 200, contentType: 'text/event-stream; charset=utf-8' };
  const probing = (hold = false): LiveSyncDeps => ({
    ...deps,
    probeStream: async (url, signal) => {
      probes.push({ url, signal });
      if (hold) await new Promise<void>((resolve) => (releaseProbe = resolve));
      if (probeAnswer === 'throw') throw new Error('probe');
      return probeAnswer;
    },
  });
  beforeEach(() => {
    probes = [];
    releaseProbe = undefined;
  });
  /** The stream closes for good and the probe (after its random wait, 0 here) answers. */
  async function closedForGood() {
    stream().fail(true);
    await settle();
  }

  it('no answer (the network is down, the request blocked): the quick reconnect, 2 s', async () => {
    probeAnswer = 'network';
    setLiveSyncDepsForTests(probing());
    start();
    await closedForGood();
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toContain('/events?tab=');
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS - 1);
    expect(streams).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(count + 1);
    stream().open();
    expect(liveSyncFor(SITE)?.phase).toBe('live');
  });

  it('a probe that throws counts as no answer', async () => {
    probeAnswer = 'throw';
    setLiveSyncDepsForTests(probing());
    start();
    await closedForGood();
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    expect(streams).toHaveLength(count + 1);
  });

  it('a real stream answer (200, text/event-stream): the quick reconnect', async () => {
    probeAnswer = stream200;
    setLiveSyncDepsForTests(probing());
    start();
    await closedForGood();
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    expect(streams).toHaveLength(count + 1);
  });

  for (const answer of [
    { status: 429, contentType: 'application/json' },
    { status: 503, contentType: 'application/json' },
    { status: 403, contentType: 'application/json' },
    { status: 401, contentType: 'application/json' },
    { status: 404, contentType: 'application/json' },
    { status: 204, contentType: '' },
    { status: 200, contentType: 'text/html' }, // a captive portal or a proxy page
  ]) {
    it(`${answer.status} ${answer.contentType || '(no body)'}: the long wait, a minute, polling meanwhile`, async () => {
      probeAnswer = answer;
      setLiveSyncDepsForTests(probing());
      start();
      await closedForGood();
      expect(['polling', 'signed-out', 'gone']).toContain(liveSyncFor(SITE)?.phase);
      const count = streams.length;
      await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 4);
      expect(streams).toHaveLength(count);
    });
  }

  it('refusals in a row are not probed again (a probe costs the server what a stream does)', async () => {
    probeAnswer = { status: 503, contentType: 'application/json' };
    setLiveSyncDepsForTests(probing());
    start();
    await closedForGood();
    expect(probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS); // the retry: another refusal
    stream().fail(true);
    await settle();
    expect(probes).toHaveLength(1);
  });

  it('stopping aborts a probe out and ignores its answer', async () => {
    probeAnswer = 'network';
    setLiveSyncDepsForTests(probing(true));
    const stop = start();
    await closedForGood();
    expect(probes[0].signal.aborted).toBe(false);
    stop();
    expect(probes[0].signal.aborted).toBe(true);
    const count = streams.length;
    releaseProbe!();
    await settle();
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS * 2);
    expect(streams).toHaveLength(count);
  });

  it('signed out while a probe is out: aborted, and its answer starts nothing', async () => {
    probeAnswer = 'network';
    setLiveSyncDepsForTests(probing(true));
    start();
    await closedForGood();
    server.status = 401;
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS); // the poll is told: signed out
    expect(liveSyncFor(SITE)?.phase).toBe('signed-out');
    expect(probes[0].signal.aborted).toBe(true);
    const count = streams.length;
    releaseProbe!();
    await settle();
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 4);
    expect(streams).toHaveLength(count);
    server.status = undefined;
  });

  it('a self-reconnecting stream (not closed for good) is not probed', async () => {
    probeAnswer = { status: 429, contentType: '' };
    setLiveSyncDepsForTests(probing());
    start();
    stream().fail(false);
    await settle();
    expect(probes).toEqual([]);
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    expect(streams).toHaveLength(count + 1);
  });
});

describe('probeStreamWith (the browser probe)', () => {
  it('answers the status and content type, and aborts the request once they arrived', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response('', { status: 429, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const answer = await probeStreamWith(fetchImpl, '/api/projects/x/events', new AbortController().signal);
    expect(answer).toEqual({ status: 429, contentType: 'application/json' });
    expect(seen?.aborted).toBe(true);
  });

  it('no answer within the timeout, or a failed request, is a network failure', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const pending = probeStreamWith(hanging, '/e', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(LIVE_PROBE_TIMEOUT_MS);
    expect(await pending).toBe('network');
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await probeStreamWith(failing, '/e', new AbortController().signal)).toBe('network');
  });

  it('the caller aborting ends the request', async () => {
    const caller = new AbortController();
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const pending = probeStreamWith(hanging, '/e', caller.signal);
    caller.abort();
    expect(await pending).toBe('network');
  });
});

describe('liveSync: stream refusals back off with jitter (F7)', () => {
  it('waits 1, then 2 minutes, plus the random share', async () => {
    const random = vi.fn(() => 0.5);
    setLiveSyncDepsForTests({ ...deps, random });
    start();
    stream().fail(true);
    const count = streams.length;
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS * 1.125 - 1);
    expect(streams).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(count + 1);
    stream().fail(true);
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS * 2 * 1.125 - 1);
    expect(streams).toHaveLength(count + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(count + 2);
    // Open: the next refusal waits a minute again.
    stream().open();
    stream().fail(true);
    await vi.advanceTimersByTimeAsync(LIVE_STREAM_RETRY_MS * 1.125);
    expect(streams).toHaveLength(count + 3);
  });
});

describe('liveSync: skeletons and drafts while the stream is down (F5, H1)', () => {
  const plan = (expiresAt: string) => ({
    planId: 'plan-1',
    agentId: 'agent-a',
    label: 'Claude',
    pageId: homeId(),
    sections: [{ ref: 'hero', title: 'Hero', kind: 'hero' }],
    expiresAt,
  });

  it('a plan past its deadline goes at the next poll while the stream is down', async () => {
    startLiveSync(SITE, store);
    stream().open();
    stream().emit('state', { version: server.version, plans: [plan(new Date(Date.now() + 10_000).toISOString())], agents: [], feed: [] });
    expect(store.editorUI.livePlans.plans.size).toBe(1);
    stream().fail(true);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(store.editorUI.livePlans.plans.size).toBe(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 2);
    expect(store.editorUI.livePlans.plans.size).toBe(0);
  });

  it('signing out drops the skeletons', () => {
    startLiveSync(SITE, store);
    stream().open();
    stream().emit('state', { version: server.version, plans: [plan('')], agents: [], feed: [] });
    expect(store.editorUI.livePlans.plans.size).toBe(1);
    stream().emit('auth:expired', {});
    expect(store.editorUI.livePlans.plans.size).toBe(0);
  });

  it('wasLive tells a lost connection from a browser that only polls; a draft dropped while down is reported until the stream is back', async () => {
    start();
    const sync = liveSyncFor(SITE)!;
    expect(sync.wasLive).toBe(true);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'insert', pageId: homeId(), parentId: server.snapshot.pages[homeId()].appComponentTree.id }, outline: [{ title: 'Hero', kind: 'hero' }] });
    expect(store.editorUI.pageGenDraft.target).toBeDefined();
    const heard = vi.fn();
    sync.subscribe(heard);
    stream().fail(false);
    expect(sync.draftLost).toBe(false);
    await vi.advanceTimersByTimeAsync(GEN_DRAFT_LIMITS.unsyncedMs);
    expect(store.editorUI.pageGenDraft.target).toBeUndefined();
    expect(sync.draftLost).toBe(true);
    expect(heard).toHaveBeenCalled();
    stream().open();
    expect(sync.draftLost).toBe(false);
  });
});

describe('liveSync: Load the newer version while a write of this tab is out (F6)', () => {
  it('waits for the write; when the write settled and the held copy was adopted meanwhile, nothing reloads', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    start();
    let finish!: () => void;
    resetAutosaveForTests({
      write: async (snapshot, expectedVersion): Promise<ProjectWriteResult> => {
        saves.push({ expectedVersion, snapshot: snapshot as ProjectSnapshotOut });
        server = { version: server.version + 1, snapshot: snapshot as ProjectSnapshotOut };
        const version = server.version;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { kind: 'ok', payload: {}, version };
      },
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('on top');
    expect(liveSyncFor(SITE)?.heldVersion?.version).toBe(3);
    const loading = loadNewerVersion(SITE);
    finish();
    await settle();
    await loading;
    expect(reload).not.toHaveBeenCalled();
    expect(knownServerVersion(SITE)).toBe(3);
    expect(working()).toEqual(server.snapshot);
    vi.unstubAllGlobals();
  });

  it('a write that never settles: after the wait it reloads as before', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    start();
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    project().updateMetadata({ description: 'mine' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent');
    const loading = loadNewerVersion(SITE);
    await vi.advanceTimersByTimeAsync(LOAD_NEWER_WRITE_WAIT_MS);
    await loading;
    expect(reload).toHaveBeenCalled();
    // The write answers at last (no write of this tab stays out for the next test).
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    vi.unstubAllGlobals();
  });
});

describe('liveSync: an agent\'s new page while the person works (H2)', () => {
  /** The server makes a new page from the run's draft and saves it. */
  async function newPage(runId: string): Promise<string> {
    const model = ProjectModel.create(server.snapshot) as ProjectModelType;
    const page = model.createPage('Menu');
    const versionBefore = server.version;
    const outcome = await applyOperations(model, [{ op: 'insertNodes', pageId: page.id, nodes: [{ type: 'section', label: 'Hero' }] }]);
    if (!outcome.ok) throw new Error('refused');
    server = { version: versionBefore + 1, snapshot: getSnapshot(model) as ProjectSnapshotOut };
    const inserted = (server.snapshot.pages[page.id].appComponentTree.children as Array<{ id: string }>).map((c) => c.id);
    stream().emit('gen:done', { runId, status: 'saved', version: server.version, insertedIds: inserted, drawnAs: [[]] });
    stream().emit('site:version', { origin: 'generate', version: server.version, versionBefore });
    await settle();
    return page.id;
  }

  function frameInView(): () => void {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const ground = document.createElement('div');
    ground.setAttribute('data-ground', '');
    ground.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    const frame = document.createElement('div');
    frame.setAttribute('data-pagegen-draft-frame', 'bp');
    frame.getBoundingClientRect = () => rect(100, 100, 800, 600);
    document.body.append(ground, frame);
    return () => {
      ground.remove();
      frame.remove();
    };
  }

  it('frames in view but a marquee is being drawn: the page stays, a notice offers the new page, and Open it is the person\'s', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    const remove = frameInView();
    store.editorUI.setMarqueeActive(true);
    const pageId = await newPage('run-1');
    store.editorUI.setMarqueeActive(false);
    remove();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    expect(store.editorUI.editorNotice).toMatchObject({ kind: 'newPage', pageId });
    stop();
  });

  it('frames in view but the focus is in a field: the page stays', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    const remove = frameInView();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await newPage('run-1');
    input.remove();
    remove();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    expect(store.editorUI.editorNotice?.kind).toBe('newPage');
    stop();
  });

  it('a draft open when the result comes: the adoption waits for it, and then the page is not switched under the person', async () => {
    const stop = start();
    store.editorUI.setCurrentPage(project().getPage(homeId())!);
    stream().emit('gen:outline', { runId: 'run-1', target: { kind: 'newPage', title: 'Menu' }, outline: [{ title: 'Hero', kind: 'hero' }] });
    const remove = frameInView();
    const draft = openDraft();
    const pageId = await newPage('run-1');
    expect(project().getPage(pageId)).toBeUndefined();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus(); // still in the field the draft was typed in
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    draft.cancel();
    await settle();
    expect(project().getPage(pageId)).toBeDefined();
    expect(store.editorUI.currentPage?.id).toBe(homeId());
    input.remove();
    remove();
    stop();
  });
});

describe('heldStepSentence: when the newer copy is a whole step of site branches', () => {
  const held = (origin: string) => ({ version: 2, snapshot: {} as never, label: 'x', event: { origin } as never });

  it('names a merge, and what saving over it does', () => {
    expect(heldStepSentence(held('merge'), 'save')).toMatch(/is a merged branch\. Saving yours over it takes that branch’s work off the site again, and the branch is already closed/);
    expect(heldStepSentence(held('merge'), 'publish')).toMatch(/^The newer version is a merged branch\. Publishing yours/);
  });

  it('names an update from main, and that a later merge would take those changes out of main', () => {
    expect(heldStepSentence(held('update'), 'save')).toMatch(/brought in the changes made to main\. Saving yours over it takes them out of this branch again, and merging the branch later would then take them out of main too/);
  });

  it('says nothing for any other copy, or none', () => {
    for (const origin of ['editor', 'mcp', 'publish', 'erasure']) expect(heldStepSentence(held(origin), 'save')).toBe('');
    expect(heldStepSentence(undefined, 'save')).toBe('');
    expect(heldStepSentence({ version: 2, snapshot: {} as never, label: 'x' }, 'save')).toBe('');
  });
});
