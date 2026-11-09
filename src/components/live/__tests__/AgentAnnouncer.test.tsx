// What a screen reader hears of the live agent canvas (../AgentAnnouncer.tsx).

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { AGENT_ACTIVE_MS, type AgentActivity, type LiveFeedLine } from '@/lib/projects/liveEvents';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

// The live sync of the open site, as the announcer sees it: its phase, and a way to hear it change.
class FakeSync {
  phase = 'live';
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setPhase(phase: string) {
    this.phase = phase;
    for (const l of [...this.listeners]) l();
  }
}
let sync: FakeSync | undefined;
vi.mock('@/lib/projects/liveSync', () => ({ liveSyncFor: () => sync }));

import AgentAnnouncer, { ANNOUNCE_KEEP_MS, noteFollowToggledByPerson } from '../AgentAnnouncer';

const presence = () => store.editorUI.livePresence as LivePresenceStore;
const heard = () => Array.from(document.querySelectorAll('[data-agent-announcer] p')).map((p) => p.textContent);

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return { callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'get_site', phase: 'start', at: new Date().toISOString(), ...over };
}

function line(over: Partial<LiveFeedLine>): LiveFeedLine {
  return { id: 'l1', agentId: 'a1', label: 'Claude', actorKind: 'key', tool: 'apply_batch', outcome: 'ok', at: new Date().toISOString(), ...over };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  const home = project.createPage('Home');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(home);
});

afterEach(() => {
  sync = undefined;
  presence().reset();
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the agent announcer', () => {
  it('is a polite live region that is there before anything happens', () => {
    render(<AgentAnnouncer />);
    const region = document.querySelector('[data-agent-announcer]')!;
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('sr-only');
    expect(heard()).toEqual([]);
  });

  it('never announces the backfill of a reload, which arrives after it mounted', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'old', outcome: 'failed' }), line({ id: 'older', outcome: 'awaiting_approval', tool: 'publish' })] }));
    expect(heard()).toEqual([]);
    // A line that arrives afterwards is news.
    act(() => presence().addLine(line({ id: 'new', outcome: 'failed', tool: 'publish' })));
    expect(heard()).toEqual(['Claude: Publishing failed']);
  });

  it('a reload during a run counts only the lines that arrive afterwards in its summary', () => {
    render(<AgentAnnouncer />);
    const start = activity({ callId: 'c9', tool: 'apply_batch' });
    act(() => presence().applyState({ agents: [start], feed: [line({ id: 'old1', changes: 40 }), line({ id: 'old2', outcome: 'rejected' })] }));
    expect(heard()).toEqual(['Claude is editing this site']);
    act(() => presence().applyActivity({ ...start, phase: 'end', outcome: 'ok', changes: 2 }));
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard().at(-1)).toBe('Claude finished: wrote 2 changes');
  });

  it('announces what needs attention from a reconnect, which happened during the gap', () => {
    render(<AgentAnnouncer />);
    const old = line({ id: 'old', outcome: 'failed' });
    act(() => presence().applyState({ agents: [], feed: [old] }));
    act(() => vi.advanceTimersByTime(5_000));
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'gap', outcome: 'awaiting_approval', tool: 'publish' }), old] }));
    expect(heard()).toEqual(['Claude: Publishing needs your approval']);
  });

  it('treats a reconnect as news also when it mounted after the first state', () => {
    const old = line({ id: 'old', outcome: 'failed' });
    act(() => presence().applyState({ agents: [], feed: [old] }));
    render(<AgentAnnouncer />);
    act(() => vi.advanceTimersByTime(5_000));
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'gap', outcome: 'declined', tool: 'publish' }), old] }));
    expect(heard()).toEqual(['Claude: Publishing declined, nothing changed']);
  });

  it('a run that ends with a reconnect counts the gap before its summary, failures included', () => {
    render(<AgentAnnouncer />);
    // The stream's first state, on connect.
    act(() => presence().applyState({ agents: [], feed: [] }));
    act(() => presence().applyActivity(activity({ callId: 'w1', tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ callId: 'w1', tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 2 })));
    const before = [...presence().feed];
    act(() => vi.advanceTimersByTime(5_000));
    act(() =>
      presence().applyState({
        agents: [],
        feed: [line({ id: 'gap2', outcome: 'failed', tool: 'publish' }), line({ id: 'gap1', changes: 5 }), ...before],
      }),
    );
    expect(heard().slice(-2)).toEqual(['Claude: Publishing failed', 'Claude finished: wrote 7 changes and 1 step failed']);
  });

  it('a reconnect during a run never counts old lines or a person\'s save in the agent\'s summary', () => {
    render(<AgentAnnouncer />);
    const personOld = line({ id: 'person-old', actorKind: 'user', label: 'Someone', changes: 7 });
    // The stream's first state, on connect (the person's old save is history).
    act(() => presence().applyState({ agents: [], feed: [personOld] }));
    act(() => vi.advanceTimersByTime(60_000));
    const start = activity({ callId: 'w1', tool: 'apply_batch' });
    act(() => presence().applyActivity(start));
    act(() => presence().applyActivity({ ...start, phase: 'end', outcome: 'ok', changes: 2 }));
    act(() => vi.advanceTimersByTime(1_000));
    const personNew = line({ id: 'person-new', actorKind: 'user', label: 'Someone', changes: 3 });
    act(() => presence().applyState({ agents: [{ ...start, callId: 'w2' }], feed: [personNew, ...presence().feed, personOld] }));
    act(() => presence().applyActivity(activity({ callId: 'w2', tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 1 })));
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard().at(-1)).toBe('Claude finished: wrote 3 changes');
  });

  it('holds a run open while the stream is down, and sums it up with the gap once a reconnect shows it ended', () => {
    sync = new FakeSync();
    render(<AgentAnnouncer />);
    act(() => presence().applyState({ agents: [], feed: [] }));
    act(() => presence().applyActivity(activity({ callId: 'w1', tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ callId: 'w1', tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 2 })));
    act(() => sync!.setPhase('polling'));
    // The agents lapse in the store while the stream is down: not the end of the run.
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard().some((t) => t?.includes('finished'))).toBe(false);
    const before = [...presence().feed];
    // The stream opens first, then its state arrives (the order liveSync follows).
    act(() => sync!.setPhase('live'));
    expect(heard().some((t) => t?.includes('finished'))).toBe(false);
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'gap1', changes: 5 }), ...before] }));
    expect(heard().filter((t) => t?.includes('finished'))).toEqual(['Claude finished: wrote 7 changes']);
  });

  it('a reconnect that finds the agent still working goes on with the run, without announcing it again', () => {
    sync = new FakeSync();
    render(<AgentAnnouncer />);
    act(() => presence().applyState({ agents: [], feed: [] }));
    const start = activity({ callId: 'w1', tool: 'apply_batch' });
    act(() => presence().applyActivity(start));
    act(() => presence().applyActivity({ ...start, phase: 'end', outcome: 'ok', changes: 2 }));
    act(() => sync!.setPhase('connecting'));
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    // The stream opens before its first state: nothing is decided yet.
    act(() => sync!.setPhase('live'));
    expect(heard()).toEqual([]);
    act(() => presence().applyState({ agents: [{ ...start, callId: 'w2', at: new Date().toISOString() }], feed: [...presence().feed] }));
    // The run goes on: its note is not announced again.
    expect(heard()).toEqual([]);
    act(() => presence().applyActivity({ ...start, callId: 'w2', phase: 'end', outcome: 'ok', changes: 1, at: new Date().toISOString() }));
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard()).toEqual(['Claude finished: wrote 3 changes']);
  });

  it('says nothing finished after the session expired (signed out)', () => {
    sync = new FakeSync();
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity({ tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 2 })));
    act(() => sync!.setPhase('signed-out'));
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard().some((t) => t?.includes('finished'))).toBe(false);
  });

  it('lets each message leave the region after a while, so no stale text stays in the top bar', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity()));
    expect(heard()).toEqual(['Claude is reading this site']);
    act(() => vi.advanceTimersByTime(ANNOUNCE_KEEP_MS + 1));
    expect(heard()).toEqual([]);
  });

  it('steps up from reading to planning to editing, once each', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity()));
    act(() => presence().applyActivity(activity({ callId: 'p1', tool: 'announce_sections' })));
    act(() => presence().applyActivity(activity({ callId: 'p1', tool: 'announce_sections', phase: 'end', outcome: 'ok' })));
    act(() => presence().applyActivity(activity({ callId: 'w1', tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ callId: 'r2', tool: 'get_page' })));
    expect(heard()).toEqual(['Claude is reading this site', 'Claude is planning changes to this site', 'Claude is editing this site']);
  });

  it('never reads out "the site changed meanwhile": the agent recovers by itself', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity({ tool: 'apply_batch' })));
    const before = heard().length;
    act(() => presence().applyActivity(activity({ tool: 'apply_batch', phase: 'end', outcome: 'site_changed' })));
    expect(heard()).toHaveLength(before);
  });

  it('counts a call whose end is the first thing heard of its agent in the summary', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity({ callId: 'e1', tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 5 })));
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard().at(-1)).toBe('Claude finished: wrote 5 changes');
  });

  it('says nothing about Follow when no agent works (a pan in an empty session)', () => {
    render(<AgentAnnouncer />);
    act(() => presence().setFollow(false));
    expect(heard()).toEqual([]);
  });

  it('never announces the history of another site opened after a reset', () => {
    render(<AgentAnnouncer />);
    act(() => presence().reset());
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'other-site', outcome: 'failed' })] }));
    expect(heard()).toEqual([]);
  });

  it('speaks the note once per run (and once more when it starts editing), each refusal, and one summary', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity()));
    expect(heard()).toEqual(['Claude is reading this site']);
    act(() => presence().applyActivity(activity({ phase: 'end', outcome: 'ok' })));
    act(() => presence().applyActivity(activity({ callId: 'c2', tool: 'apply_batch' })));
    expect(heard().at(-1)).toBe('Claude is editing this site');
    act(() => presence().applyActivity(activity({ callId: 'c2', tool: 'apply_batch', phase: 'end', outcome: 'rejected', changes: 2 })));
    expect(heard().at(-1)).toBe('Claude: Changes refused, nothing written');
    act(() => presence().applyActivity(activity({ callId: 'c3', tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ callId: 'c3', tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 3 })));
    // Back to reading within the run: not announced again.
    act(() => presence().applyActivity(activity({ callId: 'c4', tool: 'get_page' })));
    act(() => presence().applyActivity(activity({ callId: 'c4', tool: 'get_page', phase: 'end', outcome: 'ok' })));
    expect(heard()).toEqual(['Claude is reading this site', 'Claude is editing this site', 'Claude: Changes refused, nothing written']);
    act(() => vi.advanceTimersByTime(AGENT_ACTIVE_MS + 1));
    expect(heard().at(-1)).toBe('Claude finished: wrote 3 changes');
    // A reconnect replays the same lines: none is announced twice, and no second summary.
    const before = heard().length;
    act(() => presence().applyState({ agents: [], feed: [...presence().feed] }));
    expect(heard()).toHaveLength(before);
  });

  it('says nothing finished when the live sync stops (another site opened) and clears the agents and the feed', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity({ tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 2 })));
    const before = heard().length;
    act(() => presence().reset());
    expect(heard()).toHaveLength(before);
  });

  it('says so when the camera stops following because the person moved it, not when they press Follow', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity()));
    act(() => presence().setFollow(false));
    expect(heard().at(-1)).toBe('Stopped following Claude. Turn Follow back on to follow again.');
    act(() => presence().setFollow(true));
    const before = heard().length;
    act(() => {
      noteFollowToggledByPerson(presence());
      presence().setFollow(false);
    });
    expect(heard()).toHaveLength(before);
  });
});
