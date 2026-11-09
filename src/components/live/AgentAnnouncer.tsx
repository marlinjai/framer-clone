// src/components/live/AgentAnnouncer.tsx
//
// What a screen reader hears of the live agent canvas (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2), from one polite live
// region that is always mounted (in the top bar), so nothing is lost while the
// activity panel is collapsed or the sidebar is closed:
//
// - once when an agent run begins, the top bar's note ("Claude is reading this
//   site"), and once more each time the run steps up to planning or to editing
//   (the moment a conflict may follow). Never again within the run.
// - each refusal, approval needed and failure as it arrives ("Claude: Publishing
//   needs your approval"). Successful steps are not announced one by one.
// - at most one summary when the run ends ("Claude finished: wrote 6 changes").
// - the camera no longer following the agent because the person moved it.
//   Turning Follow off with the toggle is not announced: its pressed state is.
//
// Lines already in the feed when it mounts (the backfill after a reload, the
// state event of a reconnect) are never announced. Being always mounted, it
// also keeps the project's page titles (src/lib/live/pageTitleMemory.ts) while
// the activity panel is not drawn, so the feed can still name a page an agent
// deletes.
'use client';

import React from 'react';
import { observable, reaction, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { ACTIVITY_MODE_RANK, activityMode, editingNote, type ActivityMode, feedLineAnnouncement, followOffAnnouncement, needsAttention, runSummary } from '@/lib/live/activityText';
import { rememberPageTitles } from '@/lib/live/pageTitleMemory';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import type { LiveFeedLine } from '@/lib/projects/liveEvents';
import { liveSyncFor, type LiveSync } from '@/lib/projects/liveSync';

/** How long a message stays in the region: long enough to be spoken, gone before it is stale text in the top bar. */
export const ANNOUNCE_KEEP_MS = 10_000;

/**
 * The presence stores whose Follow the person just changed with the toggle (that change is not
 * announced: the toggle's pressed state is). A one-shot flag between two components, not state
 * of the canvas, so it stays out of the presence store.
 */
const toggledByPerson = new WeakSet<object>();

/** Called by the Follow toggle before it changes Follow, so the change is not announced a second time. */
export function noteFollowToggledByPerson(presence: object): void {
  toggledByPerson.add(presence);
}

/** How many line ids the announcer remembers (the feed holds LIVE_FEED_MAX). */
const SEEN_MAX = 500;

/**
 * How far before the newest line seen a reconnect's unseen line may be and still count as the
 * gap's: a write that committed just before another agent's line this tab already showed.
 */
export const GAP_ALLOWANCE_MS = 2 * 60_000;

/** A line's time in milliseconds, or -Infinity when unreadable. */
function atOf(line: Pick<LiveFeedLine, 'at'>): number {
  const t = Date.parse(line.at);
  return Number.isFinite(t) ? t : -Infinity;
}

/** The newest time among these lines. */
function newestOf(lines: ReadonlyArray<Pick<LiveFeedLine, 'at'>>): number {
  return lines.reduce((max, l) => Math.max(max, atOf(l)), -Infinity);
}

interface PageLike {
  id: string;
  metadata?: { title?: string };
}

interface ProjectLike {
  id: string;
  pages: { values(): Iterable<PageLike> };
}

const AgentAnnouncer = observer(function AgentAnnouncer() {
  const { editorUI } = useStore();
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const project = editorUI.currentProject as unknown as ProjectLike | undefined;
  const [messages, setMessages] = React.useState<Array<{ id: number; text: string }>>([]);
  const counter = React.useRef(0);

  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  const say = React.useCallback((text: string) => {
    counter.current += 1;
    const id = counter.current;
    setMessages((prev) => [...prev, { id, text }]);
    // Each message leaves after a while, so a screen reader browsing the top bar later never meets old news.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }, ANNOUNCE_KEEP_MS);
    timers.current.add(timer);
  }, []);
  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  // The project's page titles, kept while the titles change, so a page deleted later can be named.
  React.useEffect(() => {
    if (!project) return;
    return reaction(
      () => Array.from(project.pages.values()).map((p) => [p.id, p.metadata?.title] as const),
      () => rememberPageTitles(project, project.pages.values()),
      { fireImmediately: true },
    );
  }, [project]);

  React.useEffect(() => {
    if (!presence) return;
    // Lines there already are history, not news; so is every line the first `state` event since
    // the last reset brings (the backfill after a reload or after another site opened), which comes
    // after this mounts. A later `state` is a reconnect: its lines never seen before happened
    // during the gap, and are news. Every id seen is kept (capped well above the feed's size), so a
    // line that scrolled out of the capped feed is not news when a reconnect brings it back.
    const seen = new Set<string>();
    const see = (lines: readonly LiveFeedLine[]) => {
      for (const l of lines) {
        seen.delete(l.id);
        seen.add(l.id);
      }
      while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
    };
    see(presence.feed);
    // The newest line time seen (server times), and when the current run began.
    let newestAt = newestOf(presence.feed);
    let runStartAt = -Infinity;
    let state = presence.stateApplied;
    let resets = presence.resets;
    let wasActive = presence.anyActive;

    // Whether the live stream is up. While it is down (a dropped connection, an expired session),
    // the store's timers still let the agents lapse, which is not the end of their run: the run is
    // held open, and the next `state` decides (no agent active then: the run ended in the gap, and
    // its summary counts the gap's lines). Without a live sync (tests, the demo) it counts as up.
    const streamUp = observable.box(true);
    // Back up after being down: the stream opens before its first `state`, which is what tells.
    let awaitingState = false;
    let wasUp = true;
    let sync: LiveSync | undefined;
    let unsubscribe: (() => void) | undefined;
    const attach = () => {
      const current = liveSyncFor(project?.id);
      if (current !== sync) {
        unsubscribe?.();
        sync = current;
        unsubscribe = sync?.subscribe(() => runInAction(() => streamUp.set(!sync || sync.phase === 'live')));
      }
      runInAction(() => streamUp.set(!sync || sync.phase === 'live'));
    };
    attach();
    let runLines: LiveFeedLine[] = [];
    // What the run's note announced: nothing yet, or the mode it said.
    let announced: ActivityMode | 'none' = 'none';

    const disposers = [
      // One reaction for the feed and the run, so a run that ends with a reconnect counts the
      // gap's lines before its summary is spoken.
      reaction(
        () => ({ feed: presence.feed, active: presence.anyActive, states: presence.stateApplied, resets: presence.resets, up: streamUp.get() }),
        ({ feed, active }) => {
          // The sync may have started (or restarted, also for the same site) after this mounted:
          // whether the stream is up is read from the current one.
          attach();
          const up = streamUp.get();
          if (!up || !wasUp) awaitingState = true;
          wasUp = up;
          const reset = presence.resets !== resets;
          resets = presence.resets;
          const fromState = presence.stateApplied !== state;
          state = presence.stateApplied;
          if (fromState && up) awaitingState = false;
          if (reset) {
            // The live sync stopped (another site opened, the editor left): nothing finished, nothing carries over.
            runLines = [];
            announced = 'none';
            seen.clear();
            newestAt = -Infinity;
          } else {
            const history = fromState && presence.statesSinceReset === 1;
            // A reconnect's `state` can carry old lines this tab never held (the feed it had was
            // capped, or a server restart dropped the in-memory lines that pushed them out): only an
            // unseen line from around the gap or later is news, and only one from this run counts in it.
            const gapFrom = newestAt - GAP_ALLOWANCE_MS;
            const runFrom = runStartAt - GAP_ALLOWANCE_MS;
            const fresh = history ? [] : feed.filter((l) => !seen.has(l.id) && (!fromState || atOf(l) >= gapFrom)).reverse();
            for (const line of fresh) {
              // Only the agents' own lines count in their run (a person's save is not theirs).
              const inRun = !fromState || atOf(line) >= runFrom;
              if ((wasActive || active) && line.actorKind === 'key' && inRun) runLines.push(line);
              if (needsAttention(line)) say(feedLineAnnouncement(line));
            }
          }
          see(feed);
          newestAt = Math.max(newestAt, newestOf(feed));
          // A run begins: lines from before it never count in it (this clock against the server's,
          // within the allowance).
          if (active && !wasActive) runStartAt = Date.now();
          const settled = up && !awaitingState;
          if (wasActive && !active && !reset && settled) {
            const summary = runSummary(runLines);
            runLines = [];
            announced = 'none';
            if (summary) say(summary);
            wasActive = false;
          } else {
            // A run whose agents lapsed while the stream is down stays open.
            wasActive = active || (wasActive && !settled && !reset);
          }
        },
      ),
      reaction(
        () => {
          const agents = presence.active.map((a) => ({ label: a.label, tool: a.focus.tool }));
          return { mode: activityMode(agents, presence.runEdited), note: editingNote(agents, presence.runEdited) };
        },
        ({ mode, note }) => {
          if (!mode || !note) return;
          // Once when the run begins, once more each time it steps up (to planning, to editing); never back down.
          if (announced !== 'none' && ACTIVITY_MODE_RANK[mode] <= ACTIVITY_MODE_RANK[announced]) return;
          announced = mode;
          say(note);
        },
        { fireImmediately: true, equals: (a, b) => a.note === b.note },
      ),
      reaction(
        () => presence.follow,
        (follow) => {
          const byPerson = toggledByPerson.delete(presence);
          // Only while an agent works: with none, there is nothing the camera was following.
          if (follow || byPerson || !presence.anyActive) return;
          const lead = presence.leadAgentId ? presence.agents.get(presence.leadAgentId) : undefined;
          say(followOffAnnouncement(lead?.label));
        },
      ),
    ];
    return () => {
      disposers.forEach((d) => d());
      unsubscribe?.();
    };
  }, [presence, project?.id, say]);

  return (
    <div aria-live="polite" className="sr-only" data-agent-announcer="">
      {messages.map((m) => (
        <p key={m.id}>{m.text}</p>
      ))}
    </div>
  );
});

AgentAnnouncer.displayName = 'AgentAnnouncer';
export default AgentAnnouncer;
