// src/lib/live/presenceStore.ts
//
// The editor's picture of the agents working on the open site (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2), fed by the live
// stream (src/lib/projects/liveSync.ts): the `state` event on connect and every
// `agent:activity`. Drawn by the presence layer (src/components/live/AgentPresenceLayer.tsx),
// the activity feed (src/components/live/AgentActivityPanel.tsx), the Pages
// panel's dot and the top bar's note. Never part of the project: never saved,
// never in the history.
//
// Per agent (keyed by its agentId, a hash of its key id):
//   - `focus`: the call it works on, keyed to that call's id and node ids;
//   - `frameShown`: on while a call runs, off AGENT_FRAME_LINGER_MS after the
//     last one ended, at once when a call failed or was refused;
//   - kept as active (the top bar's note) until AGENT_ACTIVE_MS after the last
//     call ended, then forgotten.
// The feed holds the last LIVE_FEED_MAX lines, newest first. A `state` event
// REPLACES it (a reconnect sends `state` again; merging would show a live line
// and its audit row twice).
//
// The four stateful-flow paths (knowledge-base standards/stateful-flow-testing.md),
// covered by presenceStore.test.ts:
//   1. forward: start, end, the next call moves the frame, the fade;
//   2. backtrack and revise: a frame is keyed to the call's node ids, and the
//      layer resolves them against the open copy each time it draws
//      (src/lib/live/presenceTarget.ts): nodes the person deleted or undid draw
//      no frame, and come back framed if a redo brings them back. Nothing is
//      pruned here, because the open copy can be older than the activity (a held
//      version, a reload during a write); a new call re-keys the frame;
//   3. resume: a reload's `state` draws the active agents again and backfills
//      the feed; an agent that left is not in `state`;
//   4. re-entry: after the agent finished, a new run starts with no frame left
//      over, and the camera follows again.

import { action, makeObservable, observable } from 'mobx';
import {
  AGENT_ACTIVE_MS,
  AGENT_FRAME_LINGER_MS,
  LIVE_FEED_MAX,
  OPEN_CALL_MAX_MS,
  type AgentActivity,
  type LiveFeedLine,
  type SiteStateEvent,
} from '@/lib/projects/liveEvents';

/** What an agent works on now. */
export interface AgentFocus {
  callId: string;
  tool: string;
  pageId?: string;
  nodeIds: readonly string[];
  /** The skeleton ref the call fulfils (slice 4). */
  sectionRef?: string;
}

export interface AgentPresence {
  agentId: string;
  label: string;
  focus: AgentFocus;
  /** Calls of this agent still running. */
  openCalls: readonly string[];
  frameShown: boolean;
  /** The last call failed or was refused (the frame left at once). */
  failed: boolean;
}

/** Remembered (callId, phase) pairs, so an activity heard twice (state and stream) applies once. */
const SEEN_MAX = 500;

/** A call of an agent still running: what it works on, and the timer that gives up on it if its end never comes. */
type OpenCall = { focus: AgentFocus; expiry: ReturnType<typeof setTimeout> };

type Timers = { frame?: ReturnType<typeof setTimeout>; active?: ReturnType<typeof setTimeout> };

function focusOf(a: AgentActivity): AgentFocus {
  return {
    callId: a.callId,
    tool: a.tool,
    ...(a.pageId ? { pageId: a.pageId } : {}),
    nodeIds: a.nodeIds ?? [],
    ...(a.sectionRef ? { sectionRef: a.sectionRef } : {}),
  };
}

/** The feed line an ended call leaves (live; after a reload its audit row stands in for a write). */
export function feedLineOf(a: AgentActivity): LiveFeedLine {
  return {
    id: a.callId,
    agentId: a.agentId,
    label: a.label,
    actorKind: 'key',
    tool: a.tool,
    outcome: a.outcome ?? 'ok',
    ...(a.pageId ? { pageId: a.pageId } : {}),
    ...(a.nodeIds?.length ? { nodeIds: a.nodeIds } : {}),
    ...(a.changes !== undefined ? { changes: a.changes } : {}),
    at: a.at,
  };
}

function ageOf(at: string, now: number): number {
  const t = Date.parse(at);
  // An unreadable time or a server clock ahead of this one: treat it as just now.
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

export class LivePresenceStore {
  agents = new Map<string, AgentPresence>();
  /** Newest first, at most LIVE_FEED_MAX. */
  feed: readonly LiveFeedLine[] = [];
  /** The camera follows the frame; off once the person moves the camera, on again with the Follow toggle. */
  follow = true;
  /** The feed panel is open. It opens by itself the first time an agent becomes active in this session. */
  panelOpen = false;
  /** An agent was active at some point in this session (the panel stays available afterwards). */
  everActive = false;
  /** The agent that started a call most recently: the one the camera follows. */
  leadAgentId: string | undefined = undefined;
  /** Counts the runs (an agent becoming active while none was): the camera's "moved by the person" starts over with each. */
  run = 0;

  private timers = new Map<string, Timers>();
  /** Per agent, its running calls in the order they started (the last is the most recent). */
  private calls = new Map<string, Map<string, OpenCall>>();
  private seen = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    makeObservable<LivePresenceStore, 'expire' | 'hideFrame' | 'expireCall'>(this, {
      agents: observable.shallow,
      feed: observable.ref,
      follow: observable,
      panelOpen: observable,
      everActive: observable,
      leadAgentId: observable,
      run: observable,
      applyState: action,
      applyActivity: action,
      setFollow: action,
      setPanelOpen: action,
      reset: action,
      expire: action,
      hideFrame: action,
      expireCall: action,
    });
  }

  /** The agents active now (a call running, or one ended within AGENT_ACTIVE_MS). */
  get active(): AgentPresence[] {
    return [...this.agents.values()];
  }

  /** The agents whose frame shows (or fades out). */
  get framed(): AgentPresence[] {
    return [...this.agents.values()].filter((a) => a.frameShown);
  }

  /** Whether any agent is working on the site (the top bar's note). */
  get anyActive(): boolean {
    return this.agents.size > 0;
  }

  private markSeen(a: AgentActivity): boolean {
    const key = `${a.callId}:${a.phase}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private clearTimers(agentId: string) {
    const t = this.timers.get(agentId);
    if (t?.frame) clearTimeout(t.frame);
    if (t?.active) clearTimeout(t.active);
    this.timers.delete(agentId);
  }

  /** Remembers a running call, and gives up on it OPEN_CALL_MAX_MS after it started (`ageMs` ago). */
  private openCall(agentId: string, callId: string, focus: AgentFocus, ageMs: number) {
    let calls = this.calls.get(agentId);
    if (!calls) this.calls.set(agentId, (calls = new Map()));
    const prev = calls.get(callId);
    if (prev) clearTimeout(prev.expiry);
    calls.delete(callId);
    calls.set(callId, { focus, expiry: setTimeout(() => this.expireCall(agentId, callId), Math.max(0, OPEN_CALL_MAX_MS - ageMs)) });
  }

  /** Forgets a running call (it ended, or timed out); the calls that remain stay. */
  private closeCall(agentId: string, callId: string) {
    const calls = this.calls.get(agentId);
    const call = calls?.get(callId);
    if (!calls || !call) return;
    clearTimeout(call.expiry);
    calls.delete(callId);
    if (calls.size === 0) this.calls.delete(agentId);
  }

  private clearCalls() {
    for (const calls of this.calls.values()) for (const call of calls.values()) clearTimeout(call.expiry);
    this.calls.clear();
  }

  /** The end of a call never came: this call alone is given up on, the agent's other running calls go on. */
  private expireCall(agentId: string, callId: string) {
    this.closeCall(agentId, callId);
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const openCalls = agent.openCalls.filter((c) => c !== callId);
    const remaining = [...(this.calls.get(agentId)?.values() ?? [])].at(-1);
    if (remaining) {
      this.agents.set(agentId, { ...agent, openCalls, focus: remaining.focus });
      return;
    }
    // Nothing runs any more: no frame, and the agent is no longer active.
    this.agents.set(agentId, { ...agent, openCalls: [], frameShown: false });
    this.expire(agentId);
  }

  private hideFrame(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent && agent.openCalls.length === 0) this.agents.set(agentId, { ...agent, frameShown: false });
  }

  private expire(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.openCalls.length > 0) return;
    this.agents.delete(agentId);
    this.clearTimers(agentId);
    if (this.leadAgentId === agentId) this.leadAgentId = undefined;
  }

  /** After a call ended (`ageMs` ago): the frame fades after the linger, the agent leaves after the active window. */
  private scheduleEnd(agentId: string, ageMs: number, failed: boolean) {
    this.clearTimers(agentId);
    const timers: Timers = {};
    if (failed || ageMs >= AGENT_FRAME_LINGER_MS) this.hideFrame(agentId);
    else timers.frame = setTimeout(() => this.hideFrame(agentId), AGENT_FRAME_LINGER_MS - ageMs);
    timers.active = setTimeout(() => this.expire(agentId), Math.max(0, AGENT_ACTIVE_MS - ageMs));
    this.timers.set(agentId, timers);
  }

  private becameActive() {
    // A run starts while nobody worked on the site: the camera follows again,
    // and the panel opens by itself the first time in this session.
    if (this.agents.size === 0) {
      this.follow = true;
      this.run += 1;
    }
    if (!this.everActive) {
      this.everActive = true;
      this.panelOpen = true;
    }
  }

  /** The `state` event of a (re)connect: the active agents and the feed, replacing what was held. */
  applyState(state: Pick<SiteStateEvent, 'agents' | 'feed'>): void {
    const now = this.now();
    for (const id of [...this.timers.keys()]) this.clearTimers(id);
    this.clearCalls();
    this.agents.clear();
    this.leadAgentId = undefined;
    const agents = Array.isArray(state.agents) ? state.agents : [];
    for (const a of agents) {
      if (!a || typeof a.agentId !== 'string' || typeof a.callId !== 'string') continue;
      const age = ageOf(a.at, now);
      if (a.phase === 'end' && age >= AGENT_ACTIVE_MS) continue;
      // A call the stream already reported as ended is not running, whatever this snapshot says.
      if (a.phase === 'start' && this.seen.has(`${a.callId}:end`)) continue;
      if (a.phase === 'start' && age >= OPEN_CALL_MAX_MS) continue;
      if (this.agents.size === 0) this.becameActive();
      this.markSeen(a);
      const running = a.phase === 'start';
      const failed = a.phase === 'end' && a.outcome !== undefined && a.outcome !== 'ok';
      this.agents.set(a.agentId, {
        agentId: a.agentId,
        label: a.label,
        focus: focusOf(a),
        openCalls: running ? [a.callId] : [],
        frameShown: running || (!failed && age < AGENT_FRAME_LINGER_MS),
        failed,
      });
      if (running) {
        this.openCall(a.agentId, a.callId, focusOf(a), age);
        this.leadAgentId = a.agentId;
      } else this.scheduleEnd(a.agentId, age, failed);
    }
    const feed = Array.isArray(state.feed) ? state.feed : [];
    this.feed = feed.filter((l) => l && typeof l.id === 'string').slice(0, LIVE_FEED_MAX);
  }

  /** One `agent:activity` from the stream. Applied once per call and phase. */
  applyActivity(a: AgentActivity): void {
    if (!a || typeof a.agentId !== 'string' || typeof a.callId !== 'string') return;
    if (a.phase !== 'start' && a.phase !== 'end') return;
    // A start arriving after its own end (both happened while the first read of the site's version
    // was under way, the snapshot already holds the end) would leave a frame nothing ever clears.
    if (a.phase === 'start' && this.seen.has(`${a.callId}:end`)) return;
    if (!this.markSeen(a)) return;
    const prev = this.agents.get(a.agentId);
    // A first sight of the agent (its start may have been missed across a reconnect) begins a run either way.
    if (!prev) this.becameActive();
    if (a.phase === 'start') {
      this.clearTimers(a.agentId);
      this.openCall(a.agentId, a.callId, focusOf(a), ageOf(a.at, this.now()));
      this.agents.set(a.agentId, {
        agentId: a.agentId,
        label: a.label,
        focus: focusOf(a),
        openCalls: [...(prev?.openCalls ?? []).filter((c) => c !== a.callId), a.callId],
        frameShown: true,
        failed: false,
      });
      this.leadAgentId = a.agentId;
      return;
    }
    // The end of a call: its feed line, then the frame.
    if (!this.feed.some((l) => l.id === a.callId)) this.feed = [feedLineOf(a), ...this.feed].slice(0, LIVE_FEED_MAX);
    this.closeCall(a.agentId, a.callId);
    const openCalls = (prev?.openCalls ?? []).filter((c) => c !== a.callId);
    const failed = a.outcome !== undefined && a.outcome !== 'ok';
    // A call still running keeps the frame: the most recent of them, not the one that just ended.
    // Otherwise the ended call is the one framed (or none was known): its answer names the created nodes too.
    const remaining = [...(this.calls.get(a.agentId)?.values() ?? [])].at(-1);
    const focus = remaining ? remaining.focus : !prev || prev.focus.callId === a.callId ? focusOf(a) : prev.focus;
    this.agents.set(a.agentId, {
      agentId: a.agentId,
      label: a.label,
      focus,
      openCalls,
      frameShown: openCalls.length > 0 || (prev?.frameShown ?? true),
      failed,
    });
    if (openCalls.length === 0) this.scheduleEnd(a.agentId, ageOf(a.at, this.now()), failed);
  }

  setFollow(follow: boolean): void {
    this.follow = follow;
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
  }

  /** The editor closed the site (or opened another): nothing carries over. */
  reset(): void {
    for (const id of [...this.timers.keys()]) this.clearTimers(id);
    this.clearCalls();
    this.agents.clear();
    this.feed = [];
    this.seen.clear();
    this.follow = true;
    this.leadAgentId = undefined;
  }
}
