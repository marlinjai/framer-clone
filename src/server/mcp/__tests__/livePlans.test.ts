// @vitest-environment node
//
// The skeleton plans store (src/server/mcp/livePlans.ts) on its own: expiry
// (idle and the hard cap, refreshed by any call of the key), the scope a
// stream reads with, the anchor check against a real stored page shape (a
// ProjectModel through projectToPersisted), the feed line an agent that stopped
// leaves, and the bound on sites held. The tools that drive it are covered in
// mcp.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectModel from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { projectToPersisted } from '@/server/sites/snapshot';
import { resetLiveBusForTests, subscribeSite } from '@/server/sites/liveBus';
import { presenceSnapshot, resetLivePresenceForTests } from '@/server/sites/livePresence';
import { LIVE_EVENTS, PLAN_LIMITS, stoppedPlanLineId, type PlanUpdateEvent } from '@/lib/projects/liveEvents';
import {
  announcePlan,
  checkPlanAnchors,
  fulfilFromBatch,
  hasPlans,
  noteSiteWrite,
  PLAN_SITES_MAX,
  PLAN_SITES_PER_COMPANY,
  WRITTEN_VERSIONS_MAX,
  plansSnapshot,
  resetLivePlansForTests,
  sweepLivePlansForTests,
  topLevelSectionIds,
  touchPlans,
  type AnnounceInput,
} from '../livePlans';

const SCOPE = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };
const OTHER = { workspaceId: 'ws_b', tenantGroupId: 'tg_b' };
const T0 = Date.parse('2026-11-08T12:00:00Z');

function input(over: Partial<AnnounceInput> = {}): AnnounceInput {
  return {
    siteId: 'site-1',
    scope: SCOPE,
    agentId: 'agent-a',
    label: 'Claude',
    pageId: 'home',
    sections: [
      { ref: 'hero', title: 'Hero', kind: 'hero' },
      { ref: 'faq', title: 'Questions', kind: 'faq' },
    ],
    ...over,
  };
}

function announced(over: Partial<AnnounceInput> = {}, now = T0) {
  const outcome = announcePlan(input(over), now);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.plan;
}

function heard(siteId = 'site-1'): PlanUpdateEvent[] {
  const out: PlanUpdateEvent[] = [];
  subscribeSite(siteId, (event, data) => {
    if (event === LIVE_EVENTS.planUpdate) out.push(data as PlanUpdateEvent);
  });
  return out;
}

beforeEach(() => {
  resetLivePlansForTests();
  resetLiveBusForTests();
  resetLivePresenceForTests();
});
afterEach(() => {
  resetLivePlansForTests();
});

describe('expiry', () => {
  it(`ends a plan ${PLAN_LIMITS.idleMs / 60_000} minutes after the agent's last call, with a feed line saying the agent stopped`, () => {
    const events = heard();
    const plan = announced();
    expect(plan.expiresAt).toBe(new Date(T0 + PLAN_LIMITS.idleMs).toISOString());
    sweepLivePlansForTests(T0 + PLAN_LIMITS.idleMs - 1);
    expect(plansSnapshot('site-1', SCOPE, T0 + PLAN_LIMITS.idleMs - 1)).toHaveLength(1);
    sweepLivePlansForTests(T0 + PLAN_LIMITS.idleMs);
    expect(events.at(-1)).toMatchObject({ ended: 'expired', plan: { planId: plan.planId } });
    expect(hasPlans('site-1')).toBe(false);
    const feed = presenceSnapshot('site-1', T0 + PLAN_LIMITS.idleMs).feed;
    expect(feed[0]).toMatchObject({ id: stoppedPlanLineId(plan.planId), tool: 'sections_stopped', agentId: 'agent-a', label: 'Claude', pageId: 'home' });
  });

  it('any call of the same key refreshes it, a call naming no site refreshes it on every site, another key never does', () => {
    announced();
    announced({ siteId: 'site-2' });
    const later = T0 + PLAN_LIMITS.idleMs - 1000;
    touchPlans('site-1', 'agent-b', later);
    touchPlans('site-1', 'agent-a', later);
    touchPlans('site-3', 'agent-a', later);
    // A reconnecting editor is never handed a plan whose time ran out (the read sweeps first).
    expect(plansSnapshot('site-2', SCOPE, T0 + PLAN_LIMITS.idleMs)).toHaveLength(0);
    expect(plansSnapshot('site-1', SCOPE, T0 + PLAN_LIMITS.idleMs)).toHaveLength(1);
    announced({ siteId: 'site-2' }, later);
    touchPlans(undefined, 'agent-a', later + 60_000);
    expect(plansSnapshot('site-2', SCOPE, later + PLAN_LIMITS.idleMs + 30_000)).toHaveLength(1);
  });

  it(`never lives past ${PLAN_LIMITS.maxMs / 60_000} minutes, however often the agent calls`, () => {
    announced();
    for (let t = T0; t < T0 + PLAN_LIMITS.maxMs; t += 60_000) touchPlans('site-1', 'agent-a', t);
    const [plan] = plansSnapshot('site-1', SCOPE, T0 + PLAN_LIMITS.maxMs - 1);
    expect(plan.expiresAt).toBe(new Date(T0 + PLAN_LIMITS.maxMs).toISOString());
    expect(plansSnapshot('site-1', SCOPE, T0 + PLAN_LIMITS.maxMs)).toHaveLength(0);
  });

  it('a touch never revives a plan whose time already ran out', () => {
    announced();
    touchPlans('site-1', 'agent-a', T0 + PLAN_LIMITS.idleMs + 1);
    expect(plansSnapshot('site-1', SCOPE, T0 + PLAN_LIMITS.idleMs + 2)).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('a stream reads only the plans announced under its own scope', () => {
    announced();
    expect(plansSnapshot('site-1', OTHER, T0)).toEqual([]);
    expect(plansSnapshot('site-1', SCOPE, T0)).toHaveLength(1);
  });

  it("a replace must name the same key's plan under the same scope", () => {
    const plan = announced();
    expect(announcePlan(input({ agentId: 'agent-b', replaces: plan.planId }), T0)).toMatchObject({ ok: false, code: 'plan_not_found' });
    expect(announcePlan(input({ scope: OTHER, replaces: plan.planId }), T0)).toMatchObject({ ok: false, code: 'plan_not_found' });
  });

  it("fulfils only from the announcing key's own batches", () => {
    announced();
    fulfilFromBatch('site-1', 'agent-b', { hero: 'n1' }, 5, { hero: 'home' }, [], T0);
    expect(plansSnapshot('site-1', SCOPE, T0)[0].sections[0].fulfilledAt).toBeUndefined();
    fulfilFromBatch('site-1', 'agent-a', { hero: 'n1', unrelated: 'n2' }, 5, { hero: 'home', unrelated: 'home' }, [], T0);
    expect(plansSnapshot('site-1', SCOPE, T0)[0].sections[0]).toMatchObject({ fulfilledAt: 5, nodeId: 'n1' });
  });
});

describe('anchors', () => {
  function persistedPages(children: Array<{ id: string; children?: Array<{ id: string }> }>, pages: string[] = ['home']) {
    const project = ProjectModel.create({
      id: 'site-1',
      metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
      pages: Object.fromEntries(
        pages.map((pageId) => [
          pageId,
          {
            id: pageId,
            slug: pageId === 'home' ? '' : pageId,
            metadata: { title: pageId, description: '' },
            appComponentTree: {
              id: `root-${pageId}`,
              type: 'div',
              componentType: 'host',
              props: {},
              children: children.map((c) => ({
                id: c.id,
                type: 'section',
                componentType: 'host',
                parentId: `root-${pageId}`,
                props: {},
                children: (c.children ?? []).map((g) => ({ id: g.id, type: 'div', componentType: 'host', parentId: c.id, props: {}, children: [] })),
              })),
            },
            canvasNodes: defaultViewportSnapshots(),
          },
        ]),
      ),
    });
    return projectToPersisted(project).pages;
  }

  it('reads the top-level sections from a stored page snapshot', () => {
    const [page] = persistedPages([{ id: 'title' }, { id: 'about', children: [{ id: 'deep' }] }]);
    expect([...topLevelSectionIds(page.snapshot)]).toEqual(['title', 'about']);
  });

  it('a plan ends when its after section is deleted or moved under another section, not when it moves among its siblings', () => {
    const events = heard();
    const plan = announced({ after: 'title' });
    checkPlanAnchors('site-1', persistedPages([{ id: 'about' }, { id: 'title' }]), T0);
    expect(hasPlans('site-1')).toBe(true);
    checkPlanAnchors('site-1', persistedPages([{ id: 'about', children: [{ id: 'title' }] }]), T0);
    expect(events.at(-1)).toMatchObject({ ended: 'anchor_removed', plan: { planId: plan.planId } });
    expect(hasPlans('site-1')).toBe(false);
    announced({ after: 'title' });
    checkPlanAnchors('site-1', persistedPages([{ id: 'about' }]), T0);
    expect(hasPlans('site-1')).toBe(false);
  });

  it('a plan ends when its page is deleted; a new page without its page yet is left alone, then follows its page', () => {
    announced();
    const pending = announced({ pageId: undefined, newPage: { ref: 'p', title: 'Pricing' } });
    checkPlanAnchors('site-1', persistedPages([{ id: 'title' }], ['about']), T0);
    expect(plansSnapshot('site-1', SCOPE, T0).map((p) => p.planId)).toEqual([pending.planId]);
    fulfilFromBatch('site-1', 'agent-a', { p: 'pricing' }, 7, {}, ['pricing'], T0);
    expect(plansSnapshot('site-1', SCOPE, T0)[0]).toMatchObject({ pageId: 'pricing', pageAt: 7 });
    checkPlanAnchors('site-1', persistedPages([{ id: 'title' }], ['about']), T0);
    expect(hasPlans('site-1')).toBe(false);
  });
});

describe('review fixes', () => {
  it('a ref created on another page, or a page ref that was no createPage, fulfils nothing', () => {
    announced();
    announced({ pageId: undefined, newPage: { ref: 'p', title: 'Pricing' } });
    fulfilFromBatch('site-1', 'agent-a', { hero: 'n1', p: 'n2' }, 5, { hero: 'about', p: 'home' }, [], T0);
    const [onHome, onNew] = plansSnapshot('site-1', SCOPE, T0);
    expect(onHome.sections[0].fulfilledAt).toBeUndefined();
    expect(onNew.pageId).toBeUndefined();
  });

  it('replacing a new-page plan after its page exists keeps that page (no ghost frame again) and keeps its start', () => {
    const plan = announced({ pageId: undefined, newPage: { ref: 'p', title: 'Pricing' } });
    fulfilFromBatch('site-1', 'agent-a', { p: 'pricing' }, 7, {}, ['pricing'], T0);
    const again = announcePlan(input({ pageId: undefined, newPage: { ref: 'p', title: 'Pricing' }, replaces: plan.planId }), T0 + 60_000);
    expect(again.ok && again.plan).toMatchObject({ pageId: 'pricing', pageAt: 7 });
    // The 20 minute cap counts from the first announcement, however often it is replaced.
    for (let t = T0; t < T0 + PLAN_LIMITS.maxMs; t += 60_000) touchPlans('site-1', 'agent-a', t);
    expect(plansSnapshot('site-1', SCOPE, T0 + PLAN_LIMITS.maxMs)).toHaveLength(0);
  });

  it(`one key holds at most ${PLAN_LIMITS.plansPerKeyPerSite} plans on a site, leaving room for other agents`, () => {
    for (let i = 0; i < PLAN_LIMITS.plansPerKeyPerSite; i += 1) announced();
    expect(announcePlan(input(), T0)).toMatchObject({ ok: false, code: 'too_many_plans' });
    expect(announcePlan(input({ agentId: 'agent-b' }), T0).ok).toBe(true);
  });

  it('refuses an announcement checked against a version a write has since passed', () => {
    noteSiteWrite('site-1', 8);
    expect(announcePlan(input({ checkedVersion: 7 }), T0)).toMatchObject({ ok: false, code: 'site_changed', currentVersion: 8 });
    expect(announcePlan(input({ checkedVersion: 8 }), T0).ok).toBe(true);
  });

  it('with the site\'s written version forgotten (the map is bounded), a read older than the newest forgotten write is refused', () => {
    noteSiteWrite('site-1', 3, T0);
    for (let i = 0; i < WRITTEN_VERSIONS_MAX; i += 1) noteSiteWrite(`other-${i}`, 1, T0 + 10);
    expect(announcePlan(input({ checkedVersion: 2, checkedAt: T0 + 5 }), T0 + 20)).toMatchObject({ ok: false, code: 'site_changed' });
    expect(announcePlan(input({ checkedVersion: 2, checkedAt: T0 + 11 }), T0 + 20).ok).toBe(true);
  });

  it(`one company holds plans on at most ${PLAN_SITES_PER_COMPANY} sites and never pushes out another company's`, () => {
    announced({ siteId: 'theirs', scope: OTHER });
    for (let i = 0; i <= PLAN_SITES_PER_COMPANY; i += 1) announced({ siteId: `mine-${i}` });
    expect(hasPlans('mine-0')).toBe(false);
    expect(hasPlans(`mine-${PLAN_SITES_PER_COMPANY}`)).toBe(true);
    expect(hasPlans('theirs')).toBe(true);
  });

  it('re-entry: a new plan may use the refs of a plan that already ended fulfilled, and starts unfulfilled', () => {
    announced({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero' }] });
    fulfilFromBatch('site-1', 'agent-a', { hero: 'n1' }, 5, { hero: 'home' }, [], T0);
    expect(hasPlans('site-1')).toBe(false);
    const fresh = announced({ sections: [{ ref: 'hero', title: 'Hero', kind: 'hero' }] });
    expect(fresh.sections[0].fulfilledAt).toBeUndefined();
  });

  it('the label a plan carries is cleaned on the server too', () => {
    expect(announced({ label: 'Cl\u202eaude' }).label).toBe('Cl aude');
  });
});

describe('bounds', () => {
  it('a plan whose every section was created already ends at once', () => {
    const events = heard();
    const plan = announced();
    fulfilFromBatch('site-1', 'agent-a', { hero: 'n1' }, 5, { hero: 'home' }, [], T0);
    const again = announcePlan(input({ replaces: plan.planId, sections: [{ ref: 'hero', title: 'Hero', kind: 'hero' }] }), T0);
    expect(again.ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ ended: 'fulfilled' });
    expect(hasPlans('site-1')).toBe(false);
  });

  it(`holds plans of at most ${PLAN_SITES_MAX} sites: the least recently touched one's plans end`, () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = heard('site-0');
    for (let i = 0; i <= PLAN_SITES_MAX; i += 1) announced({ siteId: `site-${i}`, scope: { workspaceId: `ws_${i}`, tenantGroupId: `tg_${i}` } });
    expect(first.at(-1)).toMatchObject({ ended: 'evicted' });
    expect(hasPlans('site-0')).toBe(false);
    expect(hasPlans(`site-${PLAN_SITES_MAX}`)).toBe(true);
  });
});
