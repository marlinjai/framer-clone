// src/app/projects/books/composer/usePreview.ts
//
// The composer's live preview (visual template composer plan, decision 12):
// the unsaved layout rendered by the server's real engine, refreshed 350 ms
// after the last change. A newer request aborts the older one
// (AbortController), and every request carries a change counter, so an answer
// that arrives after a newer change is dropped even if it could not be
// aborted in time. While a refresh is waiting, the previous pages stay
// visible (the canvas dims them), so the page never flashes empty.
//
// A change that leaves the document as it was produces the same object
// (Immer), so it starts no request. The end-to-end time (change to new pages
// drawn) is measured here for the 800 ms browser target: `markDrawn` is called
// by the canvas once the pages of an answer are on screen.

import { useCallback, useEffect, useRef, useState } from 'react';

import { booksApi, type PreviewSubject, type TemplatePreview } from '@/lib/books/api';

import { errorText } from '../ui';

export const PREVIEW_DEBOUNCE_MS = 350;

export interface PreviewState {
  /** The newest answer that belongs to the current document, or the last one while a newer one is on its way. */
  result: (TemplatePreview & { counter: number }) | null;
  /** True from a change until its answer arrives. */
  pending: boolean;
  /** Why the newest request failed (the previous pages stay visible). */
  error: string | null;
  /** Change to pages drawn, in ms, for the newest answer that was drawn. */
  endToEndMs: number | null;
}

export function usePreview(
  document: unknown,
  subject: PreviewSubject,
  options: { enabled: boolean; debounceMs?: number } = { enabled: true },
): PreviewState & { markDrawn: (counter: number) => void; retry: () => void } {
  const debounceMs = options.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  const [state, setState] = useState<PreviewState>({ result: null, pending: false, error: null, endToEndMs: null });
  const counter = useRef(0);
  const changedAt = useRef(new Map<number, number>());
  const controller = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const subjectKey = JSON.stringify(subject);

  useEffect(() => {
    if (!options.enabled) return;
    const mine = ++counter.current;
    changedAt.current.set(mine, performance.now());
    setState((s) => ({ ...s, pending: true }));
    const timer = setTimeout(() => {
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;
      booksApi
        .previewTemplate({ document, subject: JSON.parse(subjectKey) as PreviewSubject }, ctrl.signal)
        .then((answer) => {
          // A newer change was made meanwhile: this answer is for an abandoned state.
          if (mine !== counter.current) return;
          setState((s) => ({ ...s, result: { ...answer, counter: mine }, pending: false, error: null }));
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || mine !== counter.current) return;
          setState((s) => ({ ...s, pending: false, error: errorText(err) }));
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [document, subjectKey, options.enabled, debounceMs, attempt]);

  // An unmounted composer sends nothing more.
  useEffect(() => () => controller.current?.abort(), []);

  const markDrawn = useCallback((drawn: number) => {
    const started = changedAt.current.get(drawn);
    for (const key of changedAt.current.keys()) if (key <= drawn) changedAt.current.delete(key);
    if (started === undefined) return;
    setState((s) => ({ ...s, endToEndMs: Math.round(performance.now() - started) }));
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, markDrawn, retry };
}
