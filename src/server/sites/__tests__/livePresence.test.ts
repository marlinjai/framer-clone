// @vitest-environment node
//
// The server's memory of who works on a site (src/server/sites/livePresence.ts):
// what a newly opened editor's `state` event gets, and the bounds.

import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ACTIVE_MS, LIVE_FEED_MAX, type AgentActivity, type LiveFeedLine } from '@/lib/projects/liveEvents';
import { resetLiveBusForTests, subscribeSite } from '../liveBus';
import { LIVE_PRESENCE_LIMITS, OPEN_CALL_MAX_MS, presenceSnapshot, reportAgentActivity, resetLivePresenceForTests, SITE_IDLE_MS } from '../livePresence';

const T0 = Date.parse('2026-11-08T12:00:00Z');

function act(over: Partial<AgentActivity> = {}): AgentActivity {
  return { callId: 'c1', agentId: 'a1', label: 'Claude', tool: 'get_page', phase: 'start', at: new Date(T0).toISOString(), ...over };
}

function line(id: string, at = T0): LiveFeedLine {
  return { id, agentId: 'a1', label: 'Claude', actorKind: 'key', tool: 'get_page', outcome: 'ok', at: new Date(at).toISOString() };
}

beforeEach(() => {
  resetLivePresenceForTests();
  resetLiveBusForTests();
});

describe('reportAgentActivity and presenceSnapshot', () => {
  it('publishes each activity on the site bus', () => {
    const heard: unknown[] = [];
    subscribeSite('s1', (event, data) => heard.push([event, data]));
    reportAgentActivity('s1', 'g1', act(), undefined, T0);
    expect(heard).toEqual([['agent:activity', act()]]);
  });

  it('shows a running call, then its end; the latest running call wins over an ended one', () => {
    reportAgentActivity('s1', 'g1', act({ callId: 'c1' }), undefined, T0);
    reportAgentActivity('s1', 'g1', act({ callId: 'c2', tool: 'apply_batch' }), undefined, T0 + 1);
    reportAgentActivity('s1', 'g1', act({ callId: 'c2', tool: 'apply_batch', phase: 'end', outcome: 'ok' }), undefined, T0 + 2);
    expect(presenceSnapshot('s1', T0 + 3).agents).toEqual([act({ callId: 'c1' })]);
    reportAgentActivity('s1', 'g1', act({ callId: 'c1', phase: 'end', outcome: 'ok' }), undefined, T0 + 4);
    expect(presenceSnapshot('s1', T0 + 5).agents).toEqual([act({ callId: 'c1', phase: 'end', outcome: 'ok' })]);
  });

  it('leaves out an agent not seen within the active window, and a call open past its limit', () => {
    reportAgentActivity('s1', 'g1', act({ phase: 'end', outcome: 'ok' }), undefined, T0);
    expect(presenceSnapshot('s1', T0 + AGENT_ACTIVE_MS + 1).agents).toEqual([]);
    reportAgentActivity('s2', 'g1', act(), undefined, T0);
    expect(presenceSnapshot('s2', T0 + OPEN_CALL_MAX_MS - 1).agents).toHaveLength(1);
    expect(presenceSnapshot('s2', T0 + OPEN_CALL_MAX_MS + 1).agents).toEqual([]);
  });

  it('keeps the last live lines newest first, each once, at most LIVE_FEED_MAX', () => {
    for (let i = 0; i < LIVE_FEED_MAX + 5; i += 1) reportAgentActivity('s1', 'g1', act({ callId: `c${i}`, phase: 'end' }), line(`c${i}`), T0 + i);
    reportAgentActivity('s1', 'g1', act({ callId: 'c34', phase: 'end' }), line('c34'), T0 + 99);
    const feed = presenceSnapshot('s1', T0 + 100).feed;
    expect(feed).toHaveLength(LIVE_FEED_MAX);
    expect(feed[0].id).toBe('c34');
    expect(new Set(feed.map((l) => l.id)).size).toBe(LIVE_FEED_MAX);
  });

  it('is bounded: agents per site and sites, the least recently touched going first; idle sites are forgotten', () => {
    for (let i = 0; i <= LIVE_PRESENCE_LIMITS.agentsPerSite; i += 1) reportAgentActivity('s1', 'g1', act({ agentId: `a${i}`, callId: `c${i}` }), undefined, T0);
    const agents = presenceSnapshot('s1', T0).agents.map((a) => a.agentId);
    expect(agents).toHaveLength(LIVE_PRESENCE_LIMITS.agentsPerSite);
    expect(agents).not.toContain('a0');

    // Spread over companies, so the process bound is the one reached.
    for (let i = 0; i <= LIVE_PRESENCE_LIMITS.sites; i += 1) reportAgentActivity(`site-${i}`, `g${i % 20}`, act(), undefined, T0);
    expect(presenceSnapshot('site-0', T0).agents).toEqual([]);
    expect(presenceSnapshot(`site-${LIVE_PRESENCE_LIMITS.sites}`, T0).agents).toHaveLength(1);

    reportAgentActivity('old', 'g1', act(), line('x'), T0);
    reportAgentActivity('other', 'g1', act(), undefined, T0 + SITE_IDLE_MS + 1);
    expect(presenceSnapshot('old', T0 + SITE_IDLE_MS + 1)).toEqual({ agents: [], feed: [] });
    // Read before anything else swept it: an idle site is dropped by the read itself.
    reportAgentActivity('quiet', 'g1', act(), line('y'), T0);
    expect(presenceSnapshot('quiet', T0 + SITE_IDLE_MS + 1)).toEqual({ agents: [], feed: [] });
    expect(presenceSnapshot('quiet', T0 + 1).feed).toEqual([]);
  });

  it("bounds one company's share of sites: its own least recently touched goes, never another company's", () => {
    reportAgentActivity('theirs', 'other', act(), line('kept'), T0);
    for (let i = 0; i <= LIVE_PRESENCE_LIMITS.sitesPerCompany; i += 1) reportAgentActivity(`busy-${i}`, 'busy', act(), undefined, T0 + 1 + i);
    expect(presenceSnapshot('busy-0', T0 + 500).agents).toEqual([]);
    expect(presenceSnapshot(`busy-${LIVE_PRESENCE_LIMITS.sitesPerCompany}`, T0 + 500).agents).toHaveLength(1);
    expect(presenceSnapshot('theirs', T0 + 500).feed.map((l) => l.id)).toEqual(['kept']);
    // A site touched again moves to the back of its company's line.
    reportAgentActivity('busy-1', 'busy', act(), undefined, T0 + 600);
    reportAgentActivity('busy-new', 'busy', act(), undefined, T0 + 601);
    expect(presenceSnapshot('busy-1', T0 + 700).agents).toHaveLength(1);
    expect(presenceSnapshot('busy-2', T0 + 700).agents).toEqual([]);
  });

  it('a newly opened stream gets every running call of an agent, in the order they started', () => {
    reportAgentActivity('s1', 'g1', act({ callId: 'gen', tool: 'generate_page' }), undefined, T0);
    reportAgentActivity('s1', 'g1', act({ callId: 'read' }), undefined, T0 + 1);
    expect(presenceSnapshot('s1', T0 + 2).agents.map((a) => a.callId)).toEqual(['gen', 'read']);
    reportAgentActivity('s1', 'g1', act({ callId: 'read', phase: 'end', outcome: 'ok' }), undefined, T0 + 3);
    expect(presenceSnapshot('s1', T0 + 4).agents.map((a) => a.callId)).toEqual(['gen']);
    reportAgentActivity('s1', 'g1', act({ callId: 'gen', phase: 'end', outcome: 'ok' }), undefined, T0 + 5);
    expect(presenceSnapshot('s1', T0 + 6).agents.map((a) => `${a.callId}:${a.phase}`)).toEqual(['gen:end']);
  });

  it('keeps at most callsPerAgent running calls of one agent', () => {
    for (let i = 0; i <= LIVE_PRESENCE_LIMITS.callsPerAgent; i += 1) reportAgentActivity('s1', 'g1', act({ callId: `c${i}` }), undefined, T0 + i);
    const ids = presenceSnapshot('s1', T0 + 100).agents.map((a) => a.callId);
    expect(ids).toHaveLength(LIVE_PRESENCE_LIMITS.callsPerAgent);
    expect(ids).not.toContain('c0');
  });

  it('applies an activity heard twice once for the running calls', () => {
    reportAgentActivity('s1', 'g1', act(), undefined, T0);
    reportAgentActivity('s1', 'g1', act(), undefined, T0);
    reportAgentActivity('s1', 'g1', act({ phase: 'end', outcome: 'ok' }), undefined, T0 + 1);
    expect(presenceSnapshot('s1', T0 + 2).agents[0].phase).toBe('end');
  });
});
