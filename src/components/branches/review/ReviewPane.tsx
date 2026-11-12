'use client';

// src/components/branches/review/ReviewPane.tsx
//
// One side of the review (docs/plans/2026-11-10-site-branches.md, section 3 "A reviewer", slice S5): a page of main
// or of the branch, drawn as the preview draws it, with the changed elements outlined.
//
// Each pane lives in its own shadow root. The preview's sheets are written for one page per document: the theme
// sheet matches every `[data-fc-theme=frame]`, and the page's rule sheet matches node ids under any
// `[data-preview-frame]`, and main and the branch share their node ids. In one document each pane would take the
// other's theme and styles; in its own root each keeps its own. The app's stylesheets are copied in, so the frame
// looks as it does in the preview.
//
// The page is drawn at desktop width and scaled to the pane: the preview picks the breakpoint from the width, so a
// half-wide pane would silently show the tablet layout. The transform also holds a `position: fixed` element (a
// sticky call to action) inside its pane.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import PreviewFrame from '@/components/preview/PreviewFrame';
import type { PageModelType } from '@/models/PageModel';
import type { SiteSettings } from '@/lib/site/siteSettings';
import { escapeId } from './reviewText';

/** The width every pane draws its page at: the desktop breakpoint. */
export const REVIEW_FRAME_WIDTH = 1280;

const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const isSheet = (node: Node) =>
  node.nodeName === 'STYLE' || (node.nodeName === 'LINK' && (node as HTMLLinkElement).rel === 'stylesheet');

/** The font sheets the panes raise into the document: not copied back into a pane (a face there is ignored). */
const HOISTED = new WeakSet<Node>();

/**
 * Copy the document's stylesheets into a shadow root ahead of `before` (the pane's own content), in the document's
 * order, so the app's reset and utilities come first and the page's own sheets, inside `before`, after them as
 * they do in the preview. A sheet added later is copied into its place, one removed is removed, and one whose text
 * or address changes (development replaces sheets in place) is copied again.
 */
function mirrorStyles(root: ShadowRoot, before: Node): () => void {
  const copies = new Map<Node, Node>();
  const place = (node: Node, clone: Node) => {
    // Before the copy of the next sheet in the document, so the order holds for a sheet added in between.
    let next: Node | null = node.nextSibling;
    while (next && !copies.has(next)) next = next.nextSibling;
    root.insertBefore(clone, next ? copies.get(next)! : before);
  };
  const copy = (node: Node) => {
    if (copies.has(node) || !isSheet(node) || HOISTED.has(node)) return;
    const clone = node.cloneNode(true);
    copies.set(node, clone);
    place(node, clone);
  };
  const recopy = (node: Node) => {
    const old = copies.get(node);
    if (!old) return;
    const clone = node.cloneNode(true);
    copies.set(node, clone);
    old.parentNode?.replaceChild(clone, old);
  };
  // In reverse, so each one finds the copy of the sheet after it already in place.
  Array.from(document.head.childNodes).reverse().forEach(copy);
  const watcher = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target === document.head && r.type === 'childList') {
        r.addedNodes.forEach(copy);
        r.removedNodes.forEach((n) => {
          const clone = copies.get(n);
          clone?.parentNode?.removeChild(clone);
          copies.delete(n);
        });
        continue;
      }
      // A change inside a sheet (its text) or to a sheet (its address).
      let sheet: Node | null = r.target;
      while (sheet && sheet.parentNode !== document.head) sheet = sheet.parentNode;
      if (sheet) recopy(sheet);
    }
  });
  watcher.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
  return () => {
    watcher.disconnect();
    copies.forEach((c) => c.parentNode?.removeChild(c));
  };
}

/**
 * The page's `@font-face` rules, raised into the document: Chromium does not take a face declared inside a shadow
 * root, so the pane would fall back and hide a font change. Faces come only from the font registry, the same text
 * for the same family, so the two panes' copies cannot conflict.
 */
function hoistFontFaces(container: HTMLElement, side: string): () => void {
  const sheet = document.createElement('style');
  // Named, so a person (or the browser proof) can tell it from the app's own sheets.
  sheet.id = `review-fonts-${side}`;
  HOISTED.add(sheet);
  document.head.appendChild(sheet);
  const sync = () => {
    const text = Array.from(container.querySelectorAll('style[data-fc-fonts]'), (el) => el.textContent ?? '').join('');
    if (sheet.textContent !== text) sheet.textContent = text;
  };
  sync();
  const watcher = new MutationObserver(sync);
  watcher.observe(container, { childList: true, subtree: true, characterData: true });
  return () => {
    watcher.disconnect();
    sheet.remove();
  };
}

export interface ReviewPaneProps {
  side: 'main' | 'branch';
  /** The pane's heading: "Bakery (main)", "Spring menu (branch)". */
  title: string;
  page: PageModelType | undefined;
  site: SiteSettings;
  /** Why no page is drawn (a page added on the branch has none on main). */
  emptyText: string;
  /** The outline sheet (reviewText.outlineSheet). */
  outlines: string;
  /** An element to bring into view. */
  focusId: string | null;
}

/** What the keyboard could otherwise stop on inside a drawn page. */
const TABBABLE = 'a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable], [tabindex]';

export const ReviewPane = observer(function ReviewPane({ side, title, page, site, emptyText, outlines, focusId }: ReviewPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ scale: 0.5, height: 560 });

  useBeforePaint(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    root.appendChild(container);
    // A picture, not a page to use: a link never takes the review away, a form never sends.
    const stopLink = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('a[href], area[href]')) e.preventDefault();
    };
    const stopSubmit = (e: Event) => e.preventDefault();
    container.addEventListener('click', stopLink, true);
    container.addEventListener('submit', stopSubmit, true);
    // And not a page to tab through: every link, button and field of the drawn page leaves the tab order, or a
    // keyboard user would walk two whole pages on every review. The pane itself takes focus and scrolls (below).
    const quiet = () => {
      for (const el of container.querySelectorAll<HTMLElement>(TABBABLE)) {
        if (el.getAttribute('tabindex') !== '-1') el.setAttribute('tabindex', '-1');
      }
    };
    const quieter = new MutationObserver(quiet);
    quieter.observe(container, { childList: true, subtree: true });
    const stop = mirrorStyles(root, container);
    const stopFonts = hoistFontFaces(container, side);
    setMount(container);
    return () => {
      quieter.disconnect();
      stop();
      stopFonts();
      container.remove();
      setMount(null);
    };
  }, [side]);

  useBeforePaint(() => {
    const host = hostRef.current;
    if (!host) return;
    // The page at desktop width, scaled to the pane's width; the frame as tall as the pane at that scale.
    const measure = () => {
      const scale = Math.max(0.1, host.clientWidth / REVIEW_FRAME_WIDTH);
      setBox({ scale, height: Math.max(120, host.clientHeight) });
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(host);
    return () => watcher.disconnect();
  }, []);

  // Bring the chosen element into view inside the frame, which is the scroll root.
  useEffect(() => {
    if (!mount || !focusId) return;
    const el = mount.querySelector(`[data-inner-component-id="${escapeId(focusId)}"]`);
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [mount, focusId, page]);

  const { scale } = box;
  const frameHeight = Math.round(box.height / scale);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-1" aria-label={title}>
      <h2 className="truncate text-xs font-medium text-muted-foreground">{title}</h2>
      <div
        ref={hostRef}
        data-review-side={side}
        // One stop in the tab order per pane: a picture of the page that the keyboard can scroll.
        tabIndex={0}
        role="group"
        aria-label={`${title}. A picture of the page: the arrow keys, Page Up, Page Down, Home and End scroll it.`}
        onKeyDown={(event) => {
          const frame = mount?.querySelector<HTMLElement>('[data-preview-frame]');
          if (!frame) return;
          const page = Math.round(frame.clientHeight * 0.8);
          const by: Record<string, number> = { ArrowDown: 80, ArrowUp: -80, PageDown: page, PageUp: -page, Home: -frame.scrollHeight, End: frame.scrollHeight };
          const delta = by[event.key];
          if (delta === undefined) return;
          event.preventDefault();
          frame.scrollBy({ top: delta });
        }}
        className="relative min-h-[120px] flex-1 overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {mount
        ? createPortal(
            page ? (
              <div style={{ width: REVIEW_FRAME_WIDTH, height: frameHeight, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
                {outlines ? <style data-review-outlines={side}>{outlines}</style> : null}
                <PreviewFrame
                  page={page}
                  width={REVIEW_FRAME_WIDTH}
                  height={frameHeight}
                  smoothScroll={false}
                  pageBase={site.pageBase}
                  theme={site.theme}
                />
              </div>
            ) : (
              <p style={{ padding: 16, font: '14px system-ui, sans-serif', color: '#6b7280' }}>{emptyText}</p>
            ),
            mount,
          )
        : null}
    </section>
  );
});
