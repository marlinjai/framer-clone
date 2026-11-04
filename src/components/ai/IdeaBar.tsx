// src/components/ai/IdeaBar.tsx
//
// The idea row of the Generate dialog (plan
// docs/plans/2026-11-04-page-generator-ideas-and-streaming.md, pull request
// 1): chips to start from, above the brief.
//
// A curated static set (src/lib/ai/brief/staticIdeas.ts) shows the moment the
// dialog opens. A Haiku call with the site's context (POST /api/ai/page-ideas)
// then replaces it with six ideas for this site, but only while the row is
// untouched: once it was hovered or focused, the tailored set waits behind
// "More ideas" so chips never move under the pointer. "More ideas" fetches a
// fresh set (excluding the titles shown). The latest tailored set is cached
// per project, target and selection for the browser session, so reopening
// the dialog costs nothing.
//
// Keyboard: the chips are one tab stop (a toolbar with a roving tabindex),
// arrow keys and Home / End move between them, Enter or Space picks. Each
// chip's brief is its tooltip and its accessible description. A failed
// tailored load leaves the static set working and says why; a failed "More
// ideas" is an alert with the reason (a 429 with its wait time).

'use client';

import React from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describeBriefError, type BriefApi } from '@/lib/ai/brief/client';
import { pickStaticIdeas } from '@/lib/ai/brief/staticIdeas';
import type { BriefTargetKind, IdeasRequest, PageIdea } from '@/lib/ai/brief/schema';

// ---------- the session cache ----------

const ideaCache = new Map<string, PageIdea[]>();

/** Test-only: forget every cached tailored set. */
export function __resetIdeaCacheForTests(): void {
  ideaCache.clear();
}

// ---------- the hook ----------

interface IdeasState {
  key: string;
  ideas: PageIdea[];
  source: 'static' | 'ai';
  /** A tailored set that arrived after the row was touched. */
  pending: PageIdea[] | null;
  loading: boolean;
  /** Why the tailored set did not load (the static set still works). */
  note: string | null;
  /** Why "More ideas" failed. */
  error: string | null;
}

export interface UsePageIdeasOptions {
  /** Fetch only while true (the dialog is open on the form). */
  open: boolean;
  /** The cache key: project, target kind and selected component. Empty: no project, static ideas only. */
  cacheKey: string;
  targetKind: BriefTargetKind;
  request: () => Omit<IdeasRequest, 'exclude'>;
  api: BriefApi;
}

export interface PageIdeas extends IdeasState {
  more: () => void;
  touch: () => void;
}

function staticState(key: string, kind: BriefTargetKind): IdeasState {
  return { key, ideas: pickStaticIdeas(kind), source: 'static', pending: null, loading: false, note: null, error: null };
}

export function usePageIdeas({ open, cacheKey, targetKind, request, api }: UsePageIdeasOptions): PageIdeas {
  const [state, setState] = React.useState<IdeasState>(() => staticState(cacheKey, targetKind));
  const touchedRef = React.useRef(false);
  const controllerRef = React.useRef<AbortController | null>(null);
  const requestRef = React.useRef(request);
  requestRef.current = request;
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const load = React.useCallback(
    async (key: string, initial: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const exclude = initial ? undefined : stateRef.current.ideas.map((i) => i.title);
      setState((s) => (s.key === key ? { ...s, loading: true, error: null } : s));
      const result = await api.fetchIdeas({ ...requestRef.current(), ...(exclude ? { exclude } : {}) }, controller.signal);
      if (controllerRef.current !== controller) return; // superseded, closed or another key
      controllerRef.current = null;
      if (result.ok) {
        ideaCache.set(key, result.value);
        setState((s) => {
          if (s.key !== key) return s;
          // Never move chips under someone who is already looking at them.
          if (initial && touchedRef.current) return { ...s, loading: false, pending: result.value, note: null };
          return { ...s, ideas: result.value, source: 'ai', pending: null, loading: false, note: null, error: null };
        });
        return;
      }
      if (result.error.code === 'aborted' && controller.signal.aborted) return;
      const reason = describeBriefError(result.error, 'ideas');
      setState((s) => {
        if (s.key !== key) return s;
        return initial
          ? { ...s, loading: false, note: `Showing general ideas: ideas for this site could not load. ${reason}` }
          : { ...s, loading: false, error: reason };
      });
    },
    [api],
  );

  // A new open, project, target or selection: the cached tailored set, or the
  // static set at once and the tailored one behind it.
  React.useEffect(() => {
    if (!open) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      return;
    }
    touchedRef.current = false;
    const cached = cacheKey ? ideaCache.get(cacheKey) : undefined;
    if (cached) {
      setState({ ...staticState(cacheKey, targetKind), ideas: cached, source: 'ai' });
      return;
    }
    setState(staticState(cacheKey, targetKind));
    if (cacheKey) void load(cacheKey, true);
    // `request` is read through a ref: only the key decides a reload.
  }, [open, cacheKey, targetKind, load]);

  React.useEffect(() => () => controllerRef.current?.abort(), []);

  const more = () => {
    const s = stateRef.current;
    if (s.loading || !s.key) return;
    if (s.pending) {
      setState({ ...s, ideas: s.pending, source: 'ai', pending: null, error: null });
      return;
    }
    void load(s.key, false);
  };
  const touch = () => {
    touchedRef.current = true;
  };

  return { ...state, more, touch };
}

// ---------- the row ----------

export interface IdeaBarProps {
  ideas: PageIdeas;
  disabled?: boolean;
  onPick: (idea: PageIdea) => void;
}

export function IdeaBar({ ideas, disabled = false, onPick }: IdeaBarProps) {
  const baseId = React.useId();
  const [active, setActive] = React.useState(0);
  const chipRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const list = ideas.ideas;
  const activeIndex = Math.min(active, Math.max(0, list.length - 1));
  // A new set (static to tailored, More ideas) gets its own key so it fades in.
  const setKey = `${ideas.source}:${list.map((i) => i.title).join('|')}`;

  React.useEffect(() => setActive(0), [setKey]);

  const move = (to: number) => {
    const next = (to + list.length) % list.length;
    setActive(next);
    chipRefs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(i + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(list.length - 1);
    }
  };

  const loadingTailored = ideas.loading && ideas.source === 'static' && !ideas.pending;
  const moreLabel = ideas.pending ? 'Show ideas for this site' : 'More ideas';

  return (
    <div className="grid gap-1.5" onPointerEnter={ideas.touch} onFocusCapture={ideas.touch} data-testid="pagegen-ideas">
      <div className="flex items-center justify-between gap-2">
        <span id={`${baseId}-label`} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Lightbulb className="size-3.5" aria-hidden="true" />
          {ideas.source === 'ai' ? 'Ideas for this site' : 'Ideas'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={ideas.more}
          disabled={disabled || ideas.loading || !ideas.key}
          aria-busy={ideas.loading && !loadingTailored}
        >
          <RefreshCw className={`size-3.5 ${ideas.loading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
          {moreLabel}
        </Button>
      </div>
      <div
        key={setKey}
        role="toolbar"
        aria-labelledby={`${baseId}-label`}
        aria-busy={ideas.loading}
        className="flex flex-wrap gap-1.5 duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
      >
        {list.map((idea, i) => (
          <button
            key={idea.title}
            ref={(el) => {
              chipRefs.current[i] = el;
            }}
            type="button"
            tabIndex={i === activeIndex ? 0 : -1}
            title={idea.brief}
            aria-describedby={`${baseId}-d${i}`}
            disabled={disabled}
            onFocus={() => setActive(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => onPick(idea)}
            className="rounded-full border border-input bg-background px-2.5 py-1 text-xs transition-colors duration-150 ease-out hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
          >
            {idea.title}
          </button>
        ))}
        {loadingTailored && (
          // A quiet placeholder for the tailored set: a static tint, no shimmer.
          <span aria-hidden="true" className="h-[26px] w-20 rounded-full bg-muted" data-testid="pagegen-ideas-skeleton" />
        )}
      </div>
      <div className="sr-only">
        {list.map((idea, i) => (
          <span key={idea.title} id={`${baseId}-d${i}`}>
            {idea.brief}
          </span>
        ))}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {loadingTailored ? 'Loading ideas for this site.' : ideas.source === 'ai' ? 'Ideas for this site loaded.' : ''}
      </p>
      {ideas.note && <p className="text-[11px] text-muted-foreground">{ideas.note}</p>}
      {ideas.error && (
        <p role="alert" className="text-[11px] text-destructive">
          {ideas.error}
        </p>
      )}
    </div>
  );
}
