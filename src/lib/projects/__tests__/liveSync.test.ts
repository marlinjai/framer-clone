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
  revealsOnAdoption,
  liveSyncFor,
  setLiveSyncDepsForTests,
  startLiveSync,
  type DocumentAnswer,
  type LiveEventSource,
  type LiveSyncDeps,
} from '../liveSync';
import type { SiteVersionEvent } from '../liveEvents';
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
    stream().open();
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

  it('a new page: draft frames beside whichever page is on screen, and the result is shown once adopted while the camera follows', async () => {
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
    expect(store.editorUI.currentPage?.id).toBe(page.id);
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

  it('the stream going down drops a running draft, so a poll that adopts the result never shows both', async () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    expect(draft().target).toBeDefined();
    stream().fail(false);
    expect(draft().target).toBeUndefined();
    // The run saved while the stream was away; the poll adopts it.
    await saved('run-1', ['Hero'], [[0]], { announce: false });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    await settle();
    expect(knownServerVersion(SITE)).toBe(2);
    expect(draft().target).toBeUndefined();
    // Reconnected while another run goes on: its state draws that one again.
    stream().open();
    stream().emit('state', { version: server.version, plans: [], agents: [], feed: [], generation: { runId: 'run-2', target: target(), outline: [], sections: [{ index: 0, slot: 0, node: node('Next') }] } });
    expect(draft().target?.requestKey).toBe('agent:run-2');
    stop();
  });

  it('signing out drops the draft', () => {
    const stop = start();
    stream().emit('gen:section', { runId: 'run-1', target: target(), index: 0, slot: 0, node: node('Hero') });
    stream().emit('auth:expired', {});
    expect(draft().target).toBeUndefined();
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
