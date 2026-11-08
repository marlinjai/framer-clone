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
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { applyOperations } from '@/lib/siteOps/applyOps';
import { knownServerVersion, openProject } from '@/stores/openProject';
import { autosaveFor, resetAutosaveForTests, AUTOSAVE_DEBOUNCE_MS } from '../autosave';
import type { ProjectWriteResult } from '../projectWrite';
import { editorTabId } from '../tabId';
import {
  adoptionLabel,
  LIVE_POLL_HIDDEN_MS,
  LIVE_POLL_VISIBLE_MS,
  LIVE_STREAM_RETRY_MS,
  loadNewerVersion,
  liveSyncFor,
  setLiveSyncDepsForTests,
  startLiveSync,
  type DocumentAnswer,
  type LiveEventSource,
  type LiveSyncDeps,
} from '../liveSync';
import type { SiteVersionEvent } from '../liveEvents';

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
let saves: Array<{ expectedVersion: number | undefined; snapshot: ProjectSnapshotOut }>;

const deps: LiveSyncDeps = {
  openStream: (url) => {
    const stream = new FakeStream(url);
    streams.push(stream);
    return stream;
  },
  fetchDocument: async (_url, knownVersion): Promise<DocumentAnswer> => {
    fetches.push(knownVersion);
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
    stream().fail(false); // reconnecting by itself
    stream().open();
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
