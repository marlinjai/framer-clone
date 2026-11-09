// What a screen reader hears of the live agent canvas (../AgentAnnouncer.tsx).

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { AgentActivity, LiveFeedLine } from '@/lib/projects/liveEvents';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import AgentAnnouncer, { ANNOUNCE_KEEP_MS, GAP_ALLOWANCE_MS, noteFollowToggledByPerson } from '../AgentAnnouncer';

const presence = () => store.editorUI.livePresence as LivePresenceStore;
const heard = () => Array.from(document.querySelectorAll('[data-agent-announcer] p')).map((p) => p.textContent);

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return { callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'get_site', phase: 'start', at: new Date().toISOString(), ...over };
}

function line(over: Partial<LiveFeedLine>): LiveFeedLine {
  return { id: 'l1', agentId: 'a1', label: 'Claude', actorKind: 'key', tool: 'apply_batch', outcome: 'ok', at: new Date().toISOString(), ...over };
}

/** The stream's first state, on connect. */
function connect(feed: LiveFeedLine[] = []) {
  act(() => presence().applyState({ agents: [], feed }));
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

  it('speaks the note when agents become active and each step up, and each line that needs attention', () => {
    render(<AgentAnnouncer />);
    connect();
    act(() => presence().applyActivity(activity()));
    expect(heard()).toEqual(['Claude is reading this site']);
    act(() => presence().applyActivity(activity({ phase: 'end', outcome: 'ok' })));
    act(() => presence().applyActivity(activity({ callId: 'c2', tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ callId: 'c2', tool: 'apply_batch', phase: 'end', outcome: 'rejected', changes: 2 })));
    act(() => presence().applyActivity(activity({ callId: 'c3', tool: 'apply_batch' })));
    act(() => presence().applyActivity(activity({ callId: 'c3', tool: 'apply_batch', phase: 'end', outcome: 'ok', changes: 3 })));
    // Back to reading: not announced again. Successful steps are not announced one by one.
    act(() => presence().applyActivity(activity({ callId: 'c4', tool: 'get_page' })));
    act(() => presence().applyActivity(activity({ callId: 'c4', tool: 'get_page', phase: 'end', outcome: 'ok' })));
    expect(heard()).toEqual(['Claude is reading this site', 'Claude is editing this site', 'Claude: Changes refused, nothing written']);
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

  it('lets each message leave the region after a while, so no stale text stays in the top bar', () => {
    render(<AgentAnnouncer />);
    act(() => presence().applyActivity(activity()));
    expect(heard()).toEqual(['Claude is reading this site']);
    act(() => vi.advanceTimersByTime(ANNOUNCE_KEEP_MS + 1));
    expect(heard()).toEqual([]);
  });

  it('holds what needs attention while a modal dialog hides the region, and speaks it once the dialog closes', async () => {
    const { container } = render(<AgentAnnouncer />);
    // A modal dialog hides everything outside it from assistive technology.
    container.setAttribute('aria-hidden', 'true');
    act(() => presence().addLine(line({ id: 'x', outcome: 'awaiting_approval', tool: 'publish' })));
    expect(heard()).toEqual([]);
    await act(async () => {
      container.removeAttribute('aria-hidden');
      await Promise.resolve();
    });
    expect(heard()).toEqual(['Claude: Publishing needs your approval']);
  });
});

describe('history and news', () => {
  it('never announces the backfill of a reload, which arrives after it mounted', () => {
    render(<AgentAnnouncer />);
    connect([line({ id: 'old', outcome: 'failed' }), line({ id: 'older', outcome: 'awaiting_approval', tool: 'publish' })]);
    expect(heard()).toEqual([]);
    // A line that arrives afterwards is news.
    act(() => presence().addLine(line({ id: 'new', outcome: 'failed', tool: 'publish' })));
    expect(heard()).toEqual(['Claude: Publishing failed']);
  });

  it('never announces the history of another site opened after a reset', () => {
    render(<AgentAnnouncer />);
    act(() => presence().reset());
    connect([line({ id: 'other-site', outcome: 'failed' })]);
    expect(heard()).toEqual([]);
  });

  it('announces what needs attention from a reconnect, which happened during the gap', () => {
    render(<AgentAnnouncer />);
    const old = line({ id: 'old', outcome: 'failed' });
    connect([old]);
    act(() => vi.advanceTimersByTime(5_000));
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'gap', outcome: 'awaiting_approval', tool: 'publish' }), old] }));
    expect(heard()).toEqual(['Claude: Publishing needs your approval']);
  });

  it('treats a reconnect as news also when it mounted after the first state', () => {
    const old = line({ id: 'old', outcome: 'failed' });
    connect([old]);
    render(<AgentAnnouncer />);
    act(() => vi.advanceTimersByTime(5_000));
    act(() => presence().applyState({ agents: [], feed: [line({ id: 'gap', outcome: 'declined', tool: 'publish' }), old] }));
    expect(heard()).toEqual(['Claude: Publishing declined, nothing changed']);
  });

  it('never reads out an old line a reconnect brings that this tab never held (after a server restart)', () => {
    render(<AgentAnnouncer />);
    const oldRefusal = line({ id: 'old-refusal', outcome: 'failed', tool: 'publish' });
    act(() => vi.advanceTimersByTime(GAP_ALLOWANCE_MS + 60_000));
    const seen = line({ id: 'seen', outcome: 'ok', tool: 'get_site' });
    connect([seen]);
    act(() => vi.advanceTimersByTime(5_000));
    act(() => presence().applyState({ agents: [], feed: [seen, oldRefusal] }));
    expect(heard()).toEqual([]);
  });
});

describe('Follow', () => {
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

  it('says nothing about Follow when no agent works (a pan in an empty session)', () => {
    render(<AgentAnnouncer />);
    act(() => presence().setFollow(false));
    expect(heard()).toEqual([]);
  });
});
