// src/components/ai/useBriefAssist.ts
//
// The brief helpers' state for the Generate dialog: picking an idea and
// Enhance (plan docs/plans/2026-11-04-page-generator-ideas-and-streaming.md,
// pull request 1). Kept out of GeneratePageDialog.tsx so the dialog only
// wires it.
//
//   - pickIdea: fills the brief. When the brief already has text, the pick
//     replaces it and offers Undo (never overwrites typed text silently).
//   - enhance: streams the rewrite into the brief (the textarea is read-only
//     meanwhile). On success "Undo enhance" restores the original. On any
//     failure (an error event, the network, a stream cut off midway, Stop)
//     the original is put back and the reason is shown.
//
// One undo copy at a time, in memory only, and only valid while the brief is
// exactly what the pick or the rewrite left: the next edit drops it. During a
// stream the partial text is never persisted, so a reload mid-stream finds
// the original brief in the saved draft; the finished rewrite is persisted.

import React from 'react';
import { describeBriefError, type BriefApi } from '@/lib/ai/brief/client';
import type { EnhanceRequest, PageIdea } from '@/lib/ai/brief/schema';

export interface BriefUndo {
  kind: 'idea' | 'enhance';
  /** The brief before the change. */
  previous: string;
  /** The brief the change left; the undo is valid only while the brief equals it. */
  applied: string;
  /** The idea's title, for the notice. */
  title?: string;
}

/** A message tied to the brief it was shown for: an edit makes it stale. */
interface BriefMessage {
  text: string;
  tone: 'error' | 'info';
  brief: string;
}

export interface BriefAssistOptions {
  brief: string;
  /** Sets the brief; `persist: false` while a rewrite is streaming. */
  setBrief: (text: string, opts: { persist: boolean }) => void;
  api: BriefApi;
  /** The site context of the request (the brief is added here). */
  siteInput: () => Omit<EnhanceRequest, 'brief'>;
  /** False when the dialog closed or left the form: a running Enhance stops. */
  active: boolean;
}

export interface BriefAssist {
  enhancing: boolean;
  /** The undo on offer, or null. */
  undo: BriefUndo | null;
  message: { text: string; tone: 'error' | 'info' } | null;
  pickIdea: (idea: PageIdea) => void;
  enhance: () => Promise<void>;
  stop: () => void;
  undoLast: () => void;
}

export function useBriefAssist({ brief, setBrief, api, siteInput, active }: BriefAssistOptions): BriefAssist {
  const [undo, setUndo] = React.useState<BriefUndo | null>(null);
  const [message, setMessage] = React.useState<BriefMessage | null>(null);
  const [enhancing, setEnhancing] = React.useState(false);
  const runRef = React.useRef<{ controller: AbortController; original: string; stopped: boolean } | null>(null);
  const briefRef = React.useRef(brief);
  briefRef.current = brief;
  const setBriefRef = React.useRef(setBrief);
  setBriefRef.current = setBrief;

  // The undo and a message are about one exact brief; any other text drops them.
  const liveUndo = undo && !enhancing && brief === undo.applied ? undo : null;
  const liveMessage = message && !enhancing && brief === message.brief ? message : null;
  React.useEffect(() => {
    if (enhancing) return;
    if (undo && brief !== undo.applied) setUndo(null);
    if (message && brief !== message.brief) setMessage(null);
  }, [brief, enhancing, undo, message]);

  const stop = React.useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.stopped = true;
    run.controller.abort();
  }, []);

  // Closing the dialog (or a generation taking over the form) stops a rewrite.
  React.useEffect(() => {
    if (!active) stop();
  }, [active, stop]);
  React.useEffect(() => () => runRef.current?.controller.abort(), []);

  const pickIdea = (idea: PageIdea) => {
    if (enhancing) return;
    const current = briefRef.current;
    if (current === idea.brief) return;
    setBrief(idea.brief, { persist: true });
    setMessage(null);
    setUndo(current.trim() ? { kind: 'idea', previous: current, applied: idea.brief, title: idea.title } : null);
  };

  const enhance = async () => {
    const original = briefRef.current;
    if (enhancing || !original.trim()) return;
    const controller = new AbortController();
    const run = { controller, original, stopped: false };
    runRef.current = run;
    setEnhancing(true);
    setUndo(null);
    setMessage(null);
    let streamed = '';
    let first = true;
    const result = await api.enhance(
      { ...siteInput(), brief: original.trim() },
      (delta) => {
        if (runRef.current !== run) return;
        // The textarea empties on the first delta and fills as the text arrives.
        streamed = first ? delta.trimStart() : streamed + delta;
        first = false;
        setBriefRef.current(streamed, { persist: false });
      },
      controller.signal,
    );
    if (runRef.current !== run) return; // superseded or unmounted
    runRef.current = null;
    if (result.ok) {
      setBriefRef.current(result.value, { persist: true });
      setUndo({ kind: 'enhance', previous: original, applied: result.value });
    } else {
      // Every failure puts the original back, persisted (the draft never held the partial text).
      setBriefRef.current(original, { persist: true });
      setMessage({
        text: run.stopped
          ? 'Enhance stopped. Your brief is unchanged.'
          : `${describeBriefError(result.error, 'enhance')} Your brief is unchanged.`,
        tone: run.stopped ? 'info' : 'error',
        brief: original,
      });
    }
    setEnhancing(false);
  };

  const undoLast = () => {
    if (!liveUndo) return;
    setBrief(liveUndo.previous, { persist: true });
    setUndo(null);
  };

  return {
    enhancing,
    undo: liveUndo,
    message: liveMessage ? { text: liveMessage.text, tone: liveMessage.tone } : null,
    pickIdea,
    enhance,
    stop,
    undoLast,
  };
}
