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

/** Copy the document's stylesheets into a shadow root, and keep copying the ones added later (development). */
function mirrorStyles(root: ShadowRoot): () => void {
  const copies = new Map<Node, Node>();
  const copy = (node: Node) => {
    if (copies.has(node)) return;
    const el = node as Element;
    const isSheet = el.nodeName === 'STYLE' || (el.nodeName === 'LINK' && (el as HTMLLinkElement).rel === 'stylesheet');
    if (!isSheet) return;
    const clone = el.cloneNode(true);
    copies.set(node, clone);
    root.insertBefore(clone, root.firstChild?.nextSibling ?? null);
  };
  document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(copy);
  const watcher = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach(copy);
      r.removedNodes.forEach((n) => {
        copies.get(n)?.parentNode?.removeChild(copies.get(n)!);
        copies.delete(n);
      });
    }
  });
  watcher.observe(document.head, { childList: true });
  return () => {
    watcher.disconnect();
    copies.forEach((c) => c.parentNode?.removeChild(c));
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
  height: number;
}

export const ReviewPane = observer(function ReviewPane({ side, title, page, site, emptyText, outlines, focusId, height }: ReviewPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);

  useBeforePaint(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    root.appendChild(container);
    const stop = mirrorStyles(root);
    setMount(container);
    return () => {
      stop();
      container.remove();
      setMount(null);
    };
  }, [side]);

  useBeforePaint(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setScale(Math.max(0.1, host.clientWidth / REVIEW_FRAME_WIDTH));
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

  const frameHeight = Math.round(height / scale);

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-1" aria-label={title}>
      <h3 className="truncate text-xs font-medium text-muted-foreground">{title}</h3>
      <div
        ref={hostRef}
        data-review-side={side}
        className="relative overflow-hidden rounded-md border border-border bg-muted"
        style={{ height }}
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
