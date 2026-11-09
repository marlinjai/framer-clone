// src/components/live/AgentAnnouncer.tsx
//
// What a screen reader hears of the live agent canvas (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2), from one polite live
// region that is always mounted (in the top bar), so nothing is lost while the
// activity panel is collapsed or the sidebar is closed:
//
// - once when agents become active, the top bar's note ("Claude is reading this
//   site"), and once more each time it steps up (to planning or changing what
//   visitors see, then to editing: the moment a conflict may follow). Never back
//   down while the agents stay active.
// - each refusal, approval needed, decline and failure as it arrives ("Claude:
//   Publishing needs your approval"). Successful steps are not announced: the
//   feed lists them, and a summary of a run proved unreliable across reloads
//   and reconnects (decided in #351: announce what needs attention only).
// - the camera no longer following the agent because the person moved it.
//   Turning Follow off with the toggle is not announced: its pressed state is.
//
// Lines already in the feed when it mounts, and every line of the first `state`
// event since the last reset (the backfill after a reload, or after another
// site opened), are history and never announced. A later `state` is a
// reconnect: a line it brings is news only when this tab never saw it and it is
// from around the gap or later.
//
// While a modal dialog hides the rest of the page from assistive technology
// (aria-hidden on everything outside it), messages wait and are spoken once the
// region is exposed again, so nothing that needs attention is lost.
//
// Being always mounted, it also keeps the project's page titles
// (src/lib/live/pageTitleMemory.ts) while the activity panel is not drawn, so
// the feed can still name a page an agent deletes.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import {
  ACTIVITY_MODE_RANK,
  activityMode,
  editingNote,
  feedLineAnnouncement,
  followOffAnnouncement,
  needsAttention,
  type ActivityMode,
} from '@/lib/live/activityText';
import { rememberPageTitles } from '@/lib/live/pageTitleMemory';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import type { LiveFeedLine } from '@/lib/projects/liveEvents';

/** How long a message stays in the region: long enough to be spoken, gone before it is stale text in the top bar. */
export const ANNOUNCE_KEEP_MS = 10_000;

/** How many line ids the announcer remembers (the feed holds LIVE_FEED_MAX). */
const SEEN_MAX = 500;

/**
 * How far before the newest line seen a reconnect's unseen line may be and still count as the
 * gap's: a write that committed just before another agent's line this tab already showed. Older
 * unseen lines (the feed this tab held was capped, or a server restart dropped the in-memory lines
 * that pushed them out) are history.
 */
export const GAP_ALLOWANCE_MS = 2 * 60_000;

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

/** A line's time in milliseconds, or -Infinity when unreadable. */
function atOf(line: Pick<LiveFeedLine, 'at'>): number {
  const t = Date.parse(line.at);
  return Number.isFinite(t) ? t : -Infinity;
}

/** The newest time among these lines. */
function newestOf(lines: ReadonlyArray<Pick<LiveFeedLine, 'at'>>): number {
  return lines.reduce((max, l) => Math.max(max, atOf(l)), -Infinity);
}

/** Whether a modal dialog hides this element from assistive technology. */
function hiddenByModal(element: Element | null): boolean {
  return !!element?.closest('[aria-hidden="true"]');
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
  const regionRef = React.useRef<HTMLDivElement>(null);
  const [messages, setMessages] = React.useState<Array<{ id: number; text: string }>>([]);
  const counter = React.useRef(0);
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  // Messages that arrived while a modal dialog hid the region.
  const waiting = React.useRef<string[]>([]);

  const show = React.useCallback((text: string) => {
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

  const say = React.useCallback(
    (text: string) => {
      if (hiddenByModal(regionRef.current)) waiting.current.push(text);
      else show(text);
    },
    [show],
  );

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  // A modal dialog closed (its aria-hidden left the page): the messages that waited are spoken.
  React.useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (waiting.current.length === 0 || hiddenByModal(regionRef.current)) return;
      const texts = waiting.current;
      waiting.current = [];
      for (const text of texts) show(text);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-hidden'] });
    return () => observer.disconnect();
  }, [show]);

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
    // Every id seen is kept (capped well above the feed's size), so a line that scrolled out of the
    // capped feed is not news when a reconnect brings it back.
    const seen = new Set<string>();
    const see = (lines: readonly LiveFeedLine[]) => {
      for (const l of lines) {
        seen.delete(l.id);
        seen.add(l.id);
      }
      while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
    };
    see(presence.feed);
    // The newest line time seen (server times).
    let newestAt = newestOf(presence.feed);
    let state = presence.stateApplied;
    let resets = presence.resets;
    // What the note announced while the agents are active: nothing yet, or the mode it said.
    let announced: ActivityMode | 'none' = 'none';

    const disposers = [
      reaction(
        () => ({ feed: presence.feed, states: presence.stateApplied, resets: presence.resets }),
        ({ feed }) => {
          const reset = presence.resets !== resets;
          resets = presence.resets;
          const fromState = presence.stateApplied !== state;
          state = presence.stateApplied;
          if (reset) {
            // The live sync stopped (another site opened, the editor left): nothing carries over.
            seen.clear();
            newestAt = -Infinity;
            announced = 'none';
          } else {
            const history = fromState && presence.statesSinceReset === 1;
            const gapFrom = newestAt - GAP_ALLOWANCE_MS;
            const fresh = history ? [] : feed.filter((l) => !seen.has(l.id) && (!fromState || atOf(l) >= gapFrom)).reverse();
            for (const line of fresh) if (needsAttention(line)) say(feedLineAnnouncement(line));
          }
          see(feed);
          newestAt = Math.max(newestAt, newestOf(feed));
        },
      ),
      // The agents left: the next time they are active, the note is announced again.
      reaction(
        () => presence.anyActive,
        (active) => {
          if (!active) announced = 'none';
        },
      ),
      reaction(
        () => {
          const agents = presence.active.map((a) => ({ label: a.label, tool: a.focus.tool }));
          return { mode: activityMode(agents, presence.runEdited), note: editingNote(agents, presence.runEdited) };
        },
        ({ mode, note }) => {
          if (!mode || !note) return;
          // Once when they become active, once more each time it steps up; never back down.
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
    <div ref={regionRef} aria-live="polite" className="sr-only" data-agent-announcer="">
      {messages.map((m) => (
        <p key={m.id}>{m.text}</p>
      ))}
    </div>
  );
});

AgentAnnouncer.displayName = 'AgentAnnouncer';
export default AgentAnnouncer;
