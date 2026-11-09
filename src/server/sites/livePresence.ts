import 'server-only';

// src/server/sites/livePresence.ts
//
// Who is working on a site right now (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 2). The MCP endpoint (src/server/mcp/presence.ts) reports every tool
// call on a site here, at its start and at its end; this module keeps what a
// newly opened editor needs and forwards each report to the site's open
// streams as `agent:activity` (src/server/sites/liveBus.ts).
//
// Kept per site, in process memory (one container, like the bus and the MCP
// approvals; the plan's section 7 says what moves with more than one):
//   - each agent's latest activity and the calls it has running, so the `state`
//     event can draw the frame again after a reload; an agent not seen within
//     AGENT_ACTIVE_MS is left out, so one that left is never reattached;
//   - the last LIVE_FEED_MAX feed lines that leave no audit row (reads, refused
//     and failed calls). A write that committed is in site_operation_audits, and
//     the `state` event reads it from there (src/server/siteOps/audit.ts).
//
// Bounded: LIVE_PRESENCE_LIMITS.sites sites in the process (the least recently
// touched goes first), LIVE_PRESENCE_LIMITS.sitesPerCompany sites of one company
// (its tenant group; past it that company's own least recently touched site goes,
// never another company's), LIVE_PRESENCE_LIMITS.agentsPerSite agents per site, LIVE_FEED_MAX lines per site, and a
// running call older than OPEN_CALL_MAX_MS counts as ended. Kept on globalThis
// so a development hot reload does not split reporters and readers.

import { AGENT_ACTIVE_MS, LIVE_EVENTS, LIVE_FEED_MAX, OPEN_CALL_MAX_MS, type AgentActivity, type LiveFeedLine } from '@/lib/projects/liveEvents';
import { publishSiteEvent } from './liveBus';

export const LIVE_PRESENCE_LIMITS = { sites: 2000, sitesPerCompany: 200, agentsPerSite: 20, callsPerAgent: 10 } as const;
export { OPEN_CALL_MAX_MS };
/** A site nobody reported on for this long is forgotten, its live lines with it. */
export const SITE_IDLE_MS = 6 * 60 * 60_000;

interface AgentEntry {
  last: AgentActivity;
  /** Running calls: call id to its start (in the order they started). */
  open: Map<string, { startedAt: number; activity: AgentActivity }>;
  seenAt: number;
}

interface SiteEntry {
  /** The company (tenant group id) whose MCP key reported on the site first: its share holds the entry. */
  company: string;
  agents: Map<string, AgentEntry>;
  /** Newest first. */
  feed: LiveFeedLine[];
  touchedAt: number;
}

interface PresenceState {
  sites: Map<string, SiteEntry>;
  /** Sites held per company, for its share. */
  perCompany: Map<string, number>;
}

const KEY = Symbol.for('lumitra.livePresence');

function state(): PresenceState {
  const g = globalThis as unknown as Record<symbol, PresenceState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { sites: new Map(), perCompany: new Map() };
    g[KEY] = s;
  }
  return s;
}

function forgetSite(siteId: string): void {
  const s = state();
  const entry = s.sites.get(siteId);
  if (!entry) return;
  s.sites.delete(siteId);
  const left = (s.perCompany.get(entry.company) ?? 1) - 1;
  if (left > 0) s.perCompany.set(entry.company, left);
  else s.perCompany.delete(entry.company);
}

function siteEntry(siteId: string, company: string, now: number): SiteEntry {
  const s = state();
  const { sites } = s;
  let entry = sites.get(siteId);
  if (entry) {
    // Most recently touched last, so the first key is the one to evict.
    sites.delete(siteId);
  } else {
    entry = { company, agents: new Map(), feed: [], touchedAt: now };
    s.perCompany.set(company, (s.perCompany.get(company) ?? 0) + 1);
  }
  entry.touchedAt = now;
  sites.set(siteId, entry);
  // The company's own share first: its least recently touched site goes, never another company's.
  if ((s.perCompany.get(entry.company) ?? 0) > LIVE_PRESENCE_LIMITS.sitesPerCompany) {
    for (const [id, other] of sites) {
      if (id !== siteId && other.company === entry.company) {
        forgetSite(id);
        break;
      }
    }
  }
  while (sites.size > LIVE_PRESENCE_LIMITS.sites) {
    forgetSite(sites.keys().next().value as string);
  }
  return entry;
}

function dropStaleCalls(agent: AgentEntry, now: number): void {
  for (const [callId, call] of agent.open) {
    if (now - call.startedAt > OPEN_CALL_MAX_MS) agent.open.delete(callId);
  }
}

function sweep(now: number): void {
  const { sites } = state();
  for (const [siteId, entry] of sites) {
    if (now - entry.touchedAt > SITE_IDLE_MS) forgetSite(siteId);
  }
}

/**
 * Report an activity of an MCP call on a site: remembered for the `state`
 * event and sent to every open stream of the site. `line` is the feed line of
 * a call that ended without an audit row (a read, a refusal, a failure); the
 * caller leaves it out for a write that committed. Never throws.
 */
export function reportAgentActivity(
  siteId: string,
  company: string,
  activity: AgentActivity,
  line?: LiveFeedLine,
  now: number = Date.now(),
): void {
  try {
    sweep(now);
    const site = siteEntry(siteId, company, now);
    let agent = site.agents.get(activity.agentId);
    if (agent) {
      site.agents.delete(activity.agentId);
    } else {
      agent = { last: activity, open: new Map(), seenAt: now };
    }
    site.agents.set(activity.agentId, agent);
    while (site.agents.size > LIVE_PRESENCE_LIMITS.agentsPerSite) {
      site.agents.delete(site.agents.keys().next().value as string);
    }
    agent.last = activity;
    agent.seenAt = now;
    if (activity.phase === 'start') {
      agent.open.set(activity.callId, { startedAt: now, activity });
      // Bounded: the oldest running call is given up on first.
      while (agent.open.size > LIVE_PRESENCE_LIMITS.callsPerAgent) agent.open.delete(agent.open.keys().next().value as string);
    } else {
      agent.open.delete(activity.callId);
    }
    dropStaleCalls(agent, now);
    if (line) {
      site.feed = [line, ...site.feed.filter((l) => l.id !== line.id)].slice(0, LIVE_FEED_MAX);
    }
  } catch (err) {
    console.error(`[live] presence of site ${siteId} could not be recorded`, err);
  }
  publishSiteEvent(siteId, LIVE_EVENTS.agentActivity, activity);
}

/**
 * Keep a feed line that no call's end carries (a skeleton plan that ended
 * because its agent stopped, src/server/mcp/livePlans.ts), for the `state`
 * event. The open editors compose the same line from the event they hear, with
 * the same id. Never throws.
 */
export function recordLiveFeedLine(siteId: string, company: string, line: LiveFeedLine, now: number = Date.now()): void {
  try {
    sweep(now);
    const site = siteEntry(siteId, company, now);
    site.feed = [line, ...site.feed.filter((l) => l.id !== line.id)].slice(0, LIVE_FEED_MAX);
  } catch (err) {
    console.error(`[live] a feed line of site ${siteId} could not be recorded`, err);
  }
}

/** What a newly opened stream of the site is told: the active agents (every running call, else the last one) and the live feed lines. */
export function presenceSnapshot(siteId: string, now: number = Date.now()): { agents: AgentActivity[]; feed: LiveFeedLine[] } {
  const sites = state().sites;
  const entry = sites.get(siteId);
  if (!entry) return { agents: [], feed: [] };
  // An idle site is forgotten before it is read, so a reconnect never gets its stale lines.
  if (now - entry.touchedAt > SITE_IDLE_MS) {
    forgetSite(siteId);
    return { agents: [], feed: [] };
  }
  const agents: AgentActivity[] = [];
  for (const agent of entry.agents.values()) {
    dropStaleCalls(agent, now);
    if (agent.open.size === 0 && now - agent.seenAt > AGENT_ACTIVE_MS) continue;
    // Every call still running travels (in the order they started, the latest last): the editor keeps
    // them all, so one ending does not take the frame or the editing note while another goes on.
    if (agent.open.size > 0) for (const call of agent.open.values()) agents.push(call.activity);
    else agents.push(agent.last);
  }
  return { agents, feed: [...entry.feed] };
}

/** Tests only: forget every site. */
export function resetLivePresenceForTests(): void {
  state().sites.clear();
  state().perCompany.clear();
}
