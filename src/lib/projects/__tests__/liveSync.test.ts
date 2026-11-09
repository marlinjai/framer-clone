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
import { knownServerPageIds, knownServerVersion, noteWriteInFlight, openProject } from '@/stores/openProject';
import { autosaveFor, resetAutosaveForTests, AUTOSAVE_DEBOUNCE_MS } from '../autosave';
import type { ProjectWriteResult } from '../projectWrite';
import { editorTabId } from '../tabId';
import {
  adoptionLabel,
  heldWriter,
  LIVE_FETCH_RETRY_MS,
  LIVE_RECONNECT_MS,
  LIVE_HEARTBEAT_MS,
  LIVE_WATCHDOG_MS,
  LOAD_NEWER_WRITE_WAIT_MS,
  LIVE_EDIT_HOLD_IDLE_MS,
  pagesRemovedBy,
  restoredPagesSentence,
  LIVE_POLL_HIDDEN_MS,
  LIVE_POLL_VISIBLE_MS,
  LIVE_STREAM_RETRY_MS,
  loadNewerVersion,
  revealsOnAdoption,
  liveSyncFor,
  setLiveSyncDepsForTests,
  startLiveSync,
  type DocumentAnswer,
  type LiveEventSource,
  type LiveSyncDeps,
} from '../liveSync';
import { LIVE_PING_EVENT, type SiteVersionEvent } from '../liveEvents';
import { registerOpenDraft } from '../openDrafts';
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

describe('liveSync: an edit settles after an agent write was held for it', () => {
  const homeChild = (i: number) => project().getPage(homeId())!.appComponentTree.children[i] as unknown as { id: string; setTextContent(text: string): void };

  it('typing committed while the copy was held: the dialog opens once it settled (never while typing), nothing merged; Load the newer version adopts', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const draft = openDraft(() => node.setTextContent('typed by the person'));
    await agentWrites('second');
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict'); // still typing
    draft.commitAndClose();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', currentVersion: 3, dialogOpen: true });
    expect(JSON.stringify(working())).toContain('typed by the person');
    expect(JSON.stringify(working())).not.toContain('"second"');
    await loadNewerVersion(SITE);
    expect(knownServerVersion(SITE)).toBe(3);
    expect(JSON.stringify(working())).toContain('second');
  });

  it('a resize writing on every move, past the autosave maximum wait, with an agent write held: nothing saved and no dialog mid-gesture, the dialog once it ends', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('moving');
    await agentWrites('agent');
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    for (let i = 0; i < 15; i++) {
      node.setTextContent(`moving ${i}`);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(saves).toEqual([]);
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(saves).toEqual([]);
  });

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

  it('a save already out when a gesture holds a copy: its refusal keeps the dialog closed until the gesture ends', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('moving');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); // a save goes out on version 2
    await agentWrites('agent'); // held for the gesture
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
  });

  it('a second agent write mid-gesture, after a refusal: the dialog still waits for the gesture', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('moving');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent one');
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    await agentWrites('agent two');
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false, currentVersion: server.version });
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true, currentVersion: server.version });
  });

  it('a refusal that comes back mid-gesture before the agent\'s copy is held: the dialog waits for the gesture too', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    node.setTextContent('before the gesture');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); // the save goes out
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    await agentWrites('agent', false); // the agent wrote; no event yet
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
    history.commitBatch();
    store.editorUI.endResize();
    await vi.advanceTimersByTimeAsync(600);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
  });

  it('"Keep editing" during a hold is the person\'s answer: the dialog does not come back when the gesture ends', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    let finish!: (result: ProjectWriteResult) => void;
    resetAutosaveForTests({
      write: () =>
        new Promise<ProjectWriteResult>((resolve) => {
          finish = resolve;
        }),
    });
    autosaveFor(SITE).attach(project());
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('moving');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await agentWrites('agent');
    finish({ kind: 'conflict', currentVersion: server.version });
    await settle();
    autosaveFor(SITE).openConflict(); // the person opens it from the status...
    autosaveFor(SITE).dismissConflict(); // ...and keeps editing
    history.commitBatch();
    store.editorUI.endResize();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: false });
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

  it('a held edit with earlier unsaved work, idle past the limit: asked then', async () => {
    start();
    await agentWrites('first');
    const node = homeChild(0);
    const history = getHistoryStore()!;
    store.editorUI.startResize({} as never);
    history.startBatch('Resize');
    node.setTextContent('moved once');
    await agentWrites('agent');
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(LIVE_EDIT_HOLD_IDLE_MS - 2_000);
    expect(autosaveFor(SITE).getState().phase).not.toBe('conflict');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(autosaveFor(SITE).getState()).toMatchObject({ phase: 'conflict', dialogOpen: true });
    expect(warn).toHaveBeenCalled();
    history.commitBatch();
    store.editorUI.endResize();
  });

  it('stopping while a copy is held for editing gives autosave back: the next run saves edits again', async () => {
    const stop = start();
    const draft = openDraft();
    await agentWrites('agent');
    expect(liveSyncFor(SITE)?.heldVersion).toMatchObject({ whileEditing: true });
    stop();
    draft.cancel();
    start();
    await settle();
    project().updateMetadata({ description: 'after the restart' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(1);
    expect(autosaveFor(SITE).getState().phase).toBe('saved');
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

  it('from a server that sends no ping, staying up a heartbeat starts the back-off over', async () => {
    start();
    stream().fail(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS);
    stream().fail(false); // ended before opening: the next wait would be 4 s
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MS * 2);
    stream().open();
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
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
