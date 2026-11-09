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
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { ACTIVITY_MODE_RANK, activityMode, editingNote, type ActivityMode, feedLineAnnouncement, followOffAnnouncement, needsAttention, runSummary } from '@/lib/live/activityText';
import { rememberPageTitles } from '@/lib/live/pageTitleMemory';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import type { LiveFeedLine } from '@/lib/projects/liveEvents';

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
    let state = presence.stateApplied;
    let resets = presence.resets;
    let wasActive = presence.anyActive;
    let runLines: LiveFeedLine[] = [];
    // What the run's note announced: nothing yet, or the mode it said.
    let announced: ActivityMode | 'none' = 'none';

    const disposers = [
      // One reaction for the feed and the run, so a run that ends with a reconnect counts the
      // gap's lines before its summary is spoken.
      reaction(
        () => ({ feed: presence.feed, active: presence.anyActive, states: presence.stateApplied, resets: presence.resets }),
        ({ feed, active }) => {
          const reset = presence.resets !== resets;
          resets = presence.resets;
          const fromState = presence.stateApplied !== state;
          state = presence.stateApplied;
          if (reset) {
            // A sign-out or another site: nothing finished, nothing carries over.
            runLines = [];
            announced = 'none';
            seen.clear();
          } else {
            const history = fromState && presence.statesSinceReset === 1;
            const fresh = history ? [] : feed.filter((l) => !seen.has(l.id)).reverse();
            for (const line of fresh) {
              // Only the agents' own lines count in their run (a person's save is not theirs).
              if ((wasActive || active) && line.actorKind === 'key') runLines.push(line);
              if (needsAttention(line)) say(feedLineAnnouncement(line));
            }
          }
          see(feed);
          if (wasActive && !active && !reset) {
            const summary = runSummary(runLines);
            runLines = [];
            announced = 'none';
            if (summary) say(summary);
          }
          wasActive = active;
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
    return () => disposers.forEach((d) => d());
  }, [presence, say]);

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
