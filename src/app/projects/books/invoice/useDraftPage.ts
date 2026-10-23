// src/app/projects/books/invoice/useDraftPage.ts
//
// The invoice page's drawing (WYSIWYG invoice editor plan, decisions 2 and 3):
// the draft's render input from the server, drawn by the layout engine in the
// browser's worker (phase 1), the same bytes the draft PDF route draws.
//
// - After every saved change (the draft's version moves) the render input is
//   read again, so every figure on the page is the server's.
// - While a text field is typed in, the page redraws from the local input with
//   the typed text written in (`redrawWith`), 150 ms after the last keystroke;
//   a newer redraw cancels an older one, and a late answer is dropped.
// - Every redraw carries a counter, so the canvas knows which answer it shows.
//
// The fonts the inline editors type in are the same pinned files the engine
// embeds, registered once per family as CSS font faces (`books-<family>`), so
// the text in an editor sits exactly where it prints.

import { useCallback, useEffect, useRef, useState } from 'react';

import { BrowserRenderError, fetchRenderInput, renderDraftInBrowser, type RenderInputPayload } from '@/lib/books/engine';
import type { LayoutMap } from '@/server/books/render/engine';
import { FONT_FILES } from '@/server/books/render/fontPins';
import type { FontFamily } from '@/server/books/template/schema';

export const LOCAL_REDRAW_MS = 150;

export interface DrawnPage {
  bytes: Uint8Array;
  layout: LayoutMap;
  counter: number;
  renderMs: number;
}

export interface DraftPageState {
  payload: RenderInputPayload | null;
  drawn: DrawnPage | null;
  /** True from a change until its page is drawn. */
  pending: boolean;
  error: string | null;
  /** Redraw from the local input with a typed value written in (text fields only). */
  redrawWith: (next: RenderInputPayload) => void;
  /** Read the render input again (after a saved change, or to retry). */
  reload: () => void;
}

/** The CSS font family name the inline editors use for a template family. */
export function cssFontFamily(family: FontFamily): string {
  return `books-${family}`;
}

const registered = new Set<string>();

/** Register a family's two faces as CSS font faces (once per page load); a failure leaves the system font. */
async function registerFonts(family: FontFamily): Promise<void> {
  if (registered.has(family) || typeof FontFace === 'undefined' || typeof document === 'undefined') return;
  registered.add(family);
  const pins = FONT_FILES[family];
  await Promise.all(
    (['regular', 'bold'] as const).map(async (face) => {
      const res = await fetch(`/api/books/fonts/${pins[face].sha256}`);
      if (!res.ok) throw new Error(`font ${res.status}`);
      const font = new FontFace(cssFontFamily(family), await res.arrayBuffer(), { weight: face === 'bold' ? '700' : '400' });
      await font.load();
      document.fonts.add(font);
    }),
  ).catch(() => {
    // The editors fall back to the system font; the page itself is the engine's and unaffected.
    registered.delete(family);
  });
}

function messageOf(err: unknown): string {
  if (err instanceof BrowserRenderError) {
    if (err.code === 'worker_unsupported') return 'This browser cannot draw the invoice page. Use the form below.';
    if (err.code === 'font_fetch_failed' || err.code === 'logo_fetch_failed' || err.code === 'render_input_failed') {
      return 'The invoice page could not be loaded. Check the connection and try again.';
    }
    return `The invoice page could not be drawn (${err.code}).`;
  }
  return 'The invoice page could not be drawn.';
}

export function useDraftPage(documentId: string, version: number): DraftPageState {
  const [payload, setPayload] = useState<RenderInputPayload | null>(null);
  const [drawn, setDrawn] = useState<DrawnPage | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const counter = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const draw = useCallback(async (input: RenderInputPayload) => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const mine = ++counter.current;
    setPending(true);
    try {
      const out = await renderDraftInBrowser(input, { signal: ctrl.signal });
      if (mine !== counter.current) return;
      setDrawn({ bytes: out.bytes, layout: out.layout, counter: mine, renderMs: out.renderMs });
      setError(null);
      setPending(false);
    } catch (err) {
      if (ctrl.signal.aborted || mine !== counter.current) return;
      setError(messageOf(err));
      setPending(false);
    }
  }, []);

  // The server's input, read again whenever the draft's version moves (a saved change) or on retry.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    // A local redraw still waiting from typing would draw over the server's answer.
    clearTimeout(timer.current);
    setPending(true);
    fetchRenderInput(documentId, { signal: ctrl.signal })
      .then((input) => {
        if (cancelled) return;
        setPayload(input);
        void registerFonts(input.fontFamily);
        void draw(input);
      })
      .catch((err: unknown) => {
        if (cancelled || ctrl.signal.aborted) return;
        setError(messageOf(err));
        setPending(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [documentId, version, attempt, draw]);

  const redrawWith = useCallback(
    (next: RenderInputPayload) => {
      clearTimeout(timer.current);
      setPending(true);
      timer.current = setTimeout(() => void draw(next), LOCAL_REDRAW_MS);
    },
    [draw],
  );

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      controller.current?.abort();
    },
    [],
  );

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { payload, drawn, pending, error, redrawWith, reload };
}
