// The editor's presence store (src/lib/live/presenceStore.ts), over the four
// stateful-flow paths of knowledge-base standards/stateful-flow-testing.md:
// forward, backtrack and revise, resume, re-entry after completion or failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ACTIVE_MS, AGENT_FRAME_LINGER_MS, LIVE_FEED_MAX, OPEN_CALL_MAX_MS, type AgentActivity, type LiveFeedLine } from '@/lib/projects/liveEvents';
import { LivePresenceStore } from '../presenceStore';

const T0 = Date.parse('2026-11-08T12:00:00Z');

function act(over: Partial<AgentActivity> = {}): AgentActivity {
  return {
    callId: 'c1',
    agentId: 'a1',
    label: 'Claude',
    tool: 'apply_batch',
    phase: 'start',
    pageId: 'home',
    nodeIds: ['hero-title'],
    at: new Date(Date.now()).toISOString(),
    ...over,
  };
}

const end = (over: Partial<AgentActivity> = {}) => act({ phase: 'end', outcome: 'ok', at: new Date(Date.now()).toISOString(), ...over });

let store: LivePresenceStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store = new LivePresenceStore();
});
afterEach(() => {
  store.reset();
  vi.useRealTimers();
});

describe('forward', () => {
  it('a start frames the call; its end lingers AGENT_FRAME_LINGER_MS, then fades; the agent leaves after AGENT_ACTIVE_MS', () => {
    store.applyActivity(act());
    expect(store.framed.map((a) => a.focus.nodeIds)).toEqual([['hero-title']]);
    expect(store.anyActive).toBe(true);
    expect(store.leadAgentId).toBe('a1');

    store.applyActivity(end({ nodeIds: ['hero-title', 'new-1'], changes: 2 }));
    // The end's answer names the created nodes too.
    expect(store.agents.get('a1')!.focus.nodeIds).toEqual(['hero-title', 'new-1']);
    expect(store.feed).toEqual([expect.objectContaining({ id: 'c1', tool: 'apply_batch', outcome: 'ok', changes: 2 })]);
    vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS - 1);
    expect(store.framed).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.framed).toHaveLength(0);
    // Still editing (the top bar says so) between calls.
    expect(store.anyActive).toBe(true);
    vi.advanceTimersByTime(AGENT_ACTIVE_MS - AGENT_FRAME_LINGER_MS);
    expect(store.anyActive).toBe(false);
    expect(store.feed).toHaveLength(1);
  });

  it('the next call moves the frame and cancels the fade', () => {
    store.applyActivity(act());
    store.applyActivity(end());
    vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS - 100);
    store.applyActivity(act({ callId: 'c2', nodeIds: ['plan-a'] }));
    vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS);
    expect(store.framed.map((a) => a.focus)).toEqual([expect.objectContaining({ callId: 'c2', nodeIds: ['plan-a'] })]);
  });

  it('applies an activity heard twice (state and stream) once', () => {
    store.applyActivity(act());
    store.applyActivity(end());
    store.applyActivity(end());
    store.applyActivity(act());
    expect(store.feed).toHaveLength(1);
    expect(store.agents.get('a1')!.openCalls).toEqual([]);
  });

  it('keeps the frame while another call of the agent still runs', () => {
    store.applyActivity(act({ callId: 'c1' }));
    store.applyActivity(act({ callId: 'c2', tool: 'get_page', nodeIds: [] }));
    store.applyActivity(end({ callId: 'c2', tool: 'get_page', nodeIds: [] }));
    vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS * 2);
    expect(store.framed).toHaveLength(1);
    expect(store.agents.get('a1')!.openCalls).toEqual(['c1']);
  });

  it('keeps LIVE_FEED_MAX lines, newest first', () => {
    for (let i = 0; i < LIVE_FEED_MAX + 3; i += 1) {
      store.applyActivity(act({ callId: `c${i}` }));
      store.applyActivity(end({ callId: `c${i}` }));
    }
    expect(store.feed).toHaveLength(LIVE_FEED_MAX);
    expect(store.feed[0].id).toBe(`c${LIVE_FEED_MAX + 2}`);
  });

  it('opens the panel by itself the first time an agent becomes active in the session, and never again', () => {
    expect(store.panelOpen).toBe(false);
    store.applyActivity(act());
    expect(store.panelOpen).toBe(true);
    store.setPanelOpen(false);
    store.applyActivity(end());
    vi.advanceTimersByTime(AGENT_ACTIVE_MS);
    store.applyActivity(act({ callId: 'c2' }));
    expect(store.panelOpen).toBe(false);
  });
});

describe('backtrack and revise', () => {
  it('keeps the node ids a call named whatever the open copy holds (the layer resolves them when it draws), and a new call re-keys the frame', () => {
    store.applyActivity(act({ nodeIds: ['new-1', 'new-2'] }));
    // An activity about nodes this tab has not adopted yet keeps them: the copy may catch up.
    expect(store.framed[0].focus.nodeIds).toEqual(['new-1', 'new-2']);
    store.applyActivity(act({ callId: 'c2', nodeIds: ['hero-title'] }));
    expect(store.framed[0].focus).toEqual(expect.objectContaining({ callId: 'c2', nodeIds: ['hero-title'] }));
  });

  it('an end heard without its start (missed across a reconnect) begins a run all the same', () => {
    store.setPanelOpen(false);
    store.setFollow(false);
    store.applyActivity(end({ callId: 'lost' }));
    expect(store.everActive).toBe(true);
    expect(store.panelOpen).toBe(true);
    expect(store.follow).toBe(true);
    expect(store.run).toBe(1);
    expect(store.feed.map((l) => l.id)).toEqual(['lost']);
  });
});

describe('resume', () => {
  it("a reload's state draws a running call's frame again and backfills the feed, replacing what was held", () => {
    store.applyActivity(act({ callId: 'old' }));
    store.applyActivity(end({ callId: 'old' }));
    const feed: LiveFeedLine[] = [
      { id: 'row-1', agentId: 'a1', label: 'Claude', actorKind: 'key', tool: 'apply_batch', outcome: 'ok', changes: 3, at: new Date(T0 - 5_000).toISOString() },
    ];
    store.applyState({ agents: [act({ callId: 'c9', nodeIds: ['plan-a'] })], feed });
    expect(store.framed.map((a) => a.focus.callId)).toEqual(['c9']);
    expect(store.feed.map((l) => l.id)).toEqual(['row-1']);
    expect(store.leadAgentId).toBe('a1');
    // The running call's end arrives on the stream later.
    store.applyActivity(end({ callId: 'c9', nodeIds: ['plan-a'] }));
    expect(store.feed.map((l) => l.id)).toEqual(['c9', 'row-1']);
  });

  it('an agent that ended a moment ago lingers only for what is left; one that ended long ago is not reattached', () => {
    store.applyState({
      agents: [
        end({ agentId: 'recent', callId: 'r', at: new Date(T0 - 1_000).toISOString() }),
        end({ agentId: 'faded', callId: 'f', at: new Date(T0 - AGENT_FRAME_LINGER_MS - 1).toISOString() }),
        end({ agentId: 'gone', callId: 'g', at: new Date(T0 - AGENT_ACTIVE_MS - 1).toISOString() }),
        end({ agentId: 'refused', callId: 'x', outcome: 'site_changed' }),
      ],
      feed: [],
    });
    expect(store.framed.map((a) => a.agentId)).toEqual(['recent']);
    expect([...store.agents.keys()].sort()).toEqual(['faded', 'recent', 'refused']);
    vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS - 1_000);
    expect(store.framed).toHaveLength(0);
  });

  it('ignores malformed state entries', () => {
    store.applyState({ agents: [null as unknown as AgentActivity, { phase: 'start' } as AgentActivity], feed: [null as unknown as LiveFeedLine] });
    expect(store.anyActive).toBe(false);
    expect(store.feed).toEqual([]);
  });
});

describe('re-entry after completion or failure', () => {
  it('a refused or failed call ends the frame at once and leaves the line', () => {
    store.applyActivity(act());
    store.applyActivity(end({ outcome: 'site_changed' }));
    expect(store.framed).toHaveLength(0);
    expect(store.agents.get('a1')!.failed).toBe(true);
    expect(store.feed[0]).toMatchObject({ outcome: 'site_changed' });
  });

  it('a new run after the agent left starts clean, and the camera follows again', () => {
    store.applyActivity(act());
    store.setFollow(false);
    store.applyActivity(end());
    vi.advanceTimersByTime(AGENT_ACTIVE_MS);
    expect(store.anyActive).toBe(false);
    store.applyActivity(act({ callId: 'c2', nodeIds: ['footer'] }));
    expect(store.follow).toBe(true);
    expect(store.framed.map((a) => a.focus)).toEqual([expect.objectContaining({ callId: 'c2', nodeIds: ['footer'] })]);
    expect(store.agents.get('a1')!.failed).toBe(false);
  });

  it('a person who turned Follow off keeps it off while the same run goes on', () => {
    store.applyActivity(act());
    store.setFollow(false);
    store.applyActivity(end());
    store.applyActivity(act({ callId: 'c2' }));
    expect(store.follow).toBe(false);
  });

  it('reset forgets everything of the site (another site opened)', () => {
    store.applyActivity(act());
    store.reset();
    expect(store.anyActive).toBe(false);
    expect(store.feed).toEqual([]);
    // The same call heard again after a reset applies (nothing remembered).
    store.applyActivity(act());
    expect(store.anyActive).toBe(true);
  });
});

describe('calls that overlap, arrive late or never end', () => {
  it('when a newer call ends while an older one runs, the frame goes back to the older call', () => {
    store.applyActivity(act({ callId: 'old', nodeIds: ['hero-title'], tool: 'generate_page' }));
    store.applyActivity(act({ callId: 'new', nodeIds: ['plan-a'], tool: 'apply_batch' }));
    expect(store.agents.get('a1')!.focus.callId).toBe('new');
    store.applyActivity(end({ callId: 'new', nodeIds: ['plan-a'] }));
    const agent = store.agents.get('a1')!;
    expect(agent.focus).toMatchObject({ callId: 'old', tool: 'generate_page', nodeIds: ['hero-title'] });
    expect(agent.openCalls).toEqual(['old']);
    expect(agent.frameShown).toBe(true);
    store.applyActivity(end({ callId: 'old' }));
    expect(store.agents.get('a1')!.openCalls).toEqual([]);
  });

  it('ignores a start whose end the stream already delivered', () => {
    store.applyState({ agents: [], feed: [] });
    store.applyActivity(end({ callId: 'quick' }));
    store.applyActivity(act({ callId: 'quick' }));
    expect(store.agents.get('a1')!.openCalls).toEqual([]);
    vi.advanceTimersByTime(AGENT_FRAME_LINGER_MS);
    expect(store.framed).toHaveLength(0);
    vi.advanceTimersByTime(AGENT_ACTIVE_MS);
    expect(store.anyActive).toBe(false);
  });

  it('a snapshot start whose end was already heard is not shown as running', () => {
    store.applyActivity(act({ callId: 'c9' }));
    store.applyActivity(end({ callId: 'c9' }));
    store.applyState({ agents: [act({ callId: 'c9' })], feed: [] });
    expect(store.agents.get('a1')).toBeUndefined();
  });

  it('gives up on a call whose end never came after OPEN_CALL_MAX_MS, and only on that call', () => {
    store.applyActivity(act({ callId: 'lost', nodeIds: ['hero-title'] }));
    vi.advanceTimersByTime(OPEN_CALL_MAX_MS / 2);
    store.applyActivity(act({ callId: 'live', nodeIds: ['plan-a'] }));
    vi.advanceTimersByTime(OPEN_CALL_MAX_MS / 2);
    // 'lost' timed out; 'live' still runs and owns the frame.
    const agent = store.agents.get('a1')!;
    expect(agent.openCalls).toEqual(['live']);
    expect(agent.focus.callId).toBe('live');
    expect(agent.frameShown).toBe(true);
    vi.advanceTimersByTime(OPEN_CALL_MAX_MS / 2);
    expect(store.framed).toHaveLength(0);
    expect(store.anyActive).toBe(false);
  });

  it('expires a call restored from a snapshot by its age, and drops one already past the limit', () => {
    const startedAt = new Date(Date.now() - (OPEN_CALL_MAX_MS - 1000)).toISOString();
    store.applyState({ agents: [act({ at: startedAt })], feed: [] });
    expect(store.framed).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(store.framed).toHaveLength(0);
    expect(store.anyActive).toBe(false);
    store.applyState({ agents: [act({ at: new Date(Date.now() - OPEN_CALL_MAX_MS - 1).toISOString() })], feed: [] });
    expect(store.anyActive).toBe(false);
  });
});

describe('a reconnect that continues the run', () => {
  it('keeps the person\'s Follow choice and the run, and holds every running call of the snapshot', () => {
    store.applyActivity(act({ callId: 'gen', tool: 'generate_page' }));
    store.applyActivity(act({ callId: 'read', tool: 'get_page', nodeIds: ['plan-a'] }));
    const run = store.run;
    store.setFollow(false);
    store.applyState({
      agents: [act({ callId: 'gen', tool: 'generate_page' }), act({ callId: 'read', tool: 'get_page', nodeIds: ['plan-a'] })],
      feed: [],
    });
    expect(store.follow).toBe(false);
    expect(store.run).toBe(run);
    expect(store.agents.get('a1')!.openCalls).toEqual(['gen', 'read']);
    expect(store.agents.get('a1')!.focus.callId).toBe('read');
    // The read ends: the generation still runs, frame and note stay.
    store.applyActivity(end({ callId: 'read' }));
    expect(store.agents.get('a1')!.focus.callId).toBe('gen');
    expect(store.framed).toHaveLength(1);
  });

  it('a snapshot after everyone left is a new run', () => {
    store.setFollow(false);
    const run = store.run;
    store.applyState({ agents: [act()], feed: [] });
    expect(store.follow).toBe(true);
    expect(store.run).toBe(run + 1);
  });
});
