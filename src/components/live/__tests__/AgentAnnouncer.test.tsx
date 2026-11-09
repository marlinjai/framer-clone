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

import AgentAnnouncer, { noteFollowToggledByPerson } from '../AgentAnnouncer';

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

  it('says nothing finished when a sign-out clears the agents and the feed', () => {
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
