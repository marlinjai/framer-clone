// plansStore.ts: the skeleton plans an open editor draws. Covers the four
// stateful-flow paths (knowledge-base standards/stateful-flow-testing.md) for
// skeletons: forward (announce, fulfil section by section by version), backtrack
// (a replace with the same and with different sections), resume (a `state`
// after a reload brings live plans only) and re-entry (a plan that ended leaves
// nothing behind, the next run starts clean), plus the input checks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { autorun } from 'mobx';
import { FULFILLED_SETTLE_MAX_MS, LivePlansStore, PLAN_FADE_MS, PLAN_HELD_MAX_MS, readPlan } from '../plansStore';
import { stoppedPlanLineId, type LivePlan } from '@/lib/projects/liveEvents';
import { createRootStore } from '@/stores/RootStore';

function plan(over: Partial<LivePlan> = {}): LivePlan {
  return {
    planId: 'plan-1',
    agentId: 'agent-a',
    label: 'Claude',
    pageId: 'home',
    sections: [
      { ref: 'hero', title: 'Hero', kind: 'hero' },
      { ref: 'faq', title: 'Questions', kind: 'faq' },
    ],
    expiresAt: '2026-11-08T12:03:00.000Z',
    ...over,
  };
}

const refs = (store: LivePlansStore, pageId = 'home') => store.onPage(pageId).flatMap((p) => p.sections.map((s) => s.ref));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('forward', () => {
  it('draws an announced plan, and each section goes once the tab holds the version that created it', () => {
    const store = new LivePlansStore();
    store.applyState([], 3);
    store.applyUpdate({ plan: plan() });
    expect(refs(store)).toEqual(['hero', 'faq']);
    // The batch committed at 4: the event comes before the copy is adopted, and the skeleton stays.
    store.applyUpdate({ plan: plan({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero', fulfilledAt: 4, nodeId: 'n1' }, plan().sections[1]] }) });
    expect(refs(store)).toEqual(['hero', 'faq']);
    // Adopted: gone in the same action.
    store.noteVersion(4);
    expect(refs(store)).toEqual(['faq']);
  });

  it('a plan that ended fulfilled stays until the tab holds its last section, then leaves nothing', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 3);
    const done = plan({ sections: plan().sections.map((s, i) => ({ ...s, fulfilledAt: 4 + i, nodeId: `n${i}` })) });
    store.applyUpdate({ plan: done, ended: 'fulfilled' });
    store.noteVersion(4);
    expect(refs(store)).toEqual(['faq']);
    store.noteVersion(5);
    expect(refs(store)).toEqual([]);
    expect(store.plans.size).toBe(0);
  });

  it('a fulfilled plan the tab never catches up with (a held copy) is dropped after a while', () => {
    const store = new LivePlansStore();
    store.applyState([], 3);
    store.applyUpdate({ plan: plan({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero', fulfilledAt: 9 }] }), ended: 'fulfilled' });
    expect(refs(store)).toEqual(['hero']);
    vi.advanceTimersByTime(FULFILLED_SETTLE_MAX_MS);
    expect(store.plans.size).toBe(0);
  });

  it('a new page shows in its ghost frame until the tab holds the page its batch created', () => {
    const store = new LivePlansStore();
    store.applyState([], 3);
    const planned = plan({ pageId: undefined, newPage: { ref: 'pricing-page', title: 'Pricing' } });
    store.applyUpdate({ plan: planned });
    expect(store.ghostPlans.map((g) => g.plan.newPage?.title)).toEqual(['Pricing']);
    store.applyUpdate({ plan: { ...planned, pageId: 'p9', pageAt: 4 } });
    expect(store.ghostPlans).toHaveLength(1);
    expect(store.onPage('p9')).toEqual([]);
    store.noteVersion(4);
    expect(store.ghostPlans).toHaveLength(0);
    expect(refs(store, 'p9')).toEqual(['hero', 'faq']);
  });

  it('tells which skeleton an agent fills, while it is drawn', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 3);
    expect(store.skeletonOf('agent-a', 'faq')?.section.title).toBe('Questions');
    expect(store.skeletonOf('agent-b', 'faq')).toBeUndefined();
    expect(store.skeletonOf('agent-a', undefined)).toBeUndefined();
  });
});

describe('backtrack and revise', () => {
  it('a replace keeping the same refs swaps the plan in one step: the skeletons never disappear in between', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 3);
    const seen: string[][] = [];
    const stop = autorun(() => seen.push(refs(store)));
    store.applyUpdate({ plan: plan({ planId: 'plan-2' }), replaces: 'plan-1' });
    stop();
    expect(seen).toEqual([['hero', 'faq'], ['hero', 'faq']]);
    expect([...store.plans.keys()]).toEqual(['plan-2']);
  });

  it('a replace with different sections replaces every skeleton of the old plan', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 3);
    store.applyUpdate({ plan: plan({ planId: 'plan-2', sections: [{ ref: 'team', title: 'Team', kind: 'generic' }] }), replaces: 'plan-1' });
    expect(refs(store)).toEqual(['team']);
  });

  it('cleared, evicted or its anchor gone: the plan leaves at once', () => {
    for (const ended of ['cleared', 'evicted', 'anchor_removed'] as const) {
      const store = new LivePlansStore();
      store.applyState([plan()], 3);
      expect(store.applyUpdate({ plan: plan(), ended })).toBeUndefined();
      expect(store.plans.size).toBe(0);
    }
  });
});

describe('resume', () => {
  it('a reload while a fulfilment is pending: the skeleton stays until the version that created it arrives', () => {
    const store = new LivePlansStore();
    store.applyState([plan({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero', fulfilledAt: 6 }] })], 5);
    expect(refs(store)).toEqual(['hero']);
    store.noteVersion(6);
    expect(store.plans.size).toBe(0);
  });

  it('a fulfilment heard after its version was adopted draws nothing at all', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 6);
    store.applyUpdate({ plan: plan({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero', fulfilledAt: 6 }, plan().sections[1]] }) });
    expect(refs(store)).toEqual(['faq']);
  });

  it('a state after a reload brings the live plans, replacing what was held, with the tab version', () => {
    const store = new LivePlansStore();
    store.applyState([plan({ planId: 'old' })], 3);
    store.applyState([plan({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero', fulfilledAt: 5 }, plan().sections[1]] })], 5);
    expect([...store.plans.keys()]).toEqual(['plan-1']);
    // The reloaded copy (version 5) already holds the hero: only the faq is drawn.
    expect(refs(store)).toEqual(['faq']);
  });

  it('a plan whose end never arrives is dropped after its longest possible life', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 3);
    vi.advanceTimersByTime(PLAN_HELD_MAX_MS);
    expect(store.plans.size).toBe(0);
  });
});

describe('re-entry after completion or failure', () => {
  it('an agent that stopped: its plan fades, leaves a feed line, and nothing is left for the next run', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 3);
    const line = store.applyUpdate({ plan: plan(), ended: 'expired' });
    expect(line).toMatchObject({ id: stoppedPlanLineId('plan-1'), tool: 'sections_stopped', agentId: 'agent-a', label: 'Claude', pageId: 'home' });
    expect(store.onPage('home')[0].leaving).toBe(true);
    vi.advanceTimersByTime(PLAN_FADE_MS);
    expect(store.plans.size).toBe(0);
    expect(store.applyUpdate({ plan: plan({ planId: 'plan-9' }), ended: 'session_ended' })?.id).toBe(stoppedPlanLineId('plan-9'));
    store.applyUpdate({ plan: plan({ planId: 'plan-3', sections: [{ ref: 'cta', title: 'Call', kind: 'cta' }] }) });
    expect(refs(store)).toEqual(['cta']);
  });

  it('reset forgets every plan, its timers and the version', () => {
    const store = new LivePlansStore();
    store.applyState([plan()], 8);
    store.applyUpdate({ plan: plan(), ended: 'expired' });
    store.reset();
    expect(store.plans.size).toBe(0);
    expect(store.version).toBe(0);
    vi.advanceTimersByTime(PLAN_HELD_MAX_MS);
  });
});

describe('what the stream may send', () => {
  it('drops malformed plans and cleans titles again', () => {
    expect(readPlan(null)).toBeUndefined();
    expect(readPlan({ planId: 'has space', agentId: 'a', sections: [] })).toBeUndefined();
    const read = readPlan({
      planId: 'p',
      agentId: 'a',
      label: 'C‮laude',
      after: 'bad id with spaces',
      sections: [
        { ref: 'ok', title: 'Pri\u0000cing', kind: 'not-a-kind' },
        { ref: 'bad ref', title: 'X' },
      ],
    });
    expect(read).toMatchObject({ label: 'C laude', sections: [{ ref: 'ok', title: 'Pri cing', kind: 'generic' }] });
    expect(read?.after).toBeUndefined();
  });

  it('lives on the editor UI store as volatile state: never in its snapshot', () => {
    const root = createRootStore();
    root.editorUI.livePlans.applyState([plan()], 1);
    expect(JSON.stringify(getSnapshot(root.editorUI))).not.toContain('livePlans');
    expect(JSON.stringify(getSnapshot(root))).not.toContain('Questions');
  });
});
