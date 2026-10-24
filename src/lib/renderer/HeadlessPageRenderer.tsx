// Render a page's app component tree at a single chosen breakpoint, with no
// editor chrome. Mounted by the preview shell (and reusable for any future
// surface: iframe embed, static export, screenshot worker).
//
// Floating elements live on the editor canvas, not in the published app, so
// they are intentionally not rendered here. Only `page.appComponentTree`.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer, { StickyCtaPreviewContext } from './HeadlessComponentRenderer';
import { isStickyCta, STICKY_CTA_Z_INDEX } from '@/lib/stickyCta/stickyCta';

/** The first sticky call to action in the tree (depth first), or null. */
function firstStickyCta(node: ComponentInstance): ComponentInstance | null {
  if (isStickyCta(node.props)) return node;
  for (const child of node.children as ComponentInstance[]) {
    const found = firstStickyCta(child);
    if (found) return found;
  }
  return null;
}
import PageFontFaces from '@/lib/fonts/PageFontFaces';

export interface HeadlessPageRendererProps {
  page: PageModelType;
  breakpointId: string;
}

const HeadlessPageRenderer = observer(({ page, breakpointId }: HeadlessPageRendererProps) => {
  const { appComponentTree } = page;
  const viewportNodes = page.sortedViewportNodes;

  if (!appComponentTree) return null;
  if (viewportNodes.length === 0) return null;

  const allBreakpoints = viewportNodes.map((v: ComponentInstance) => ({
    id: v.breakpointId!,
    minWidth: v.breakpointMinWidth!,
    label: v.label!,
  }));

  // The sticky call to action (src/lib/stickyCta): the page's first bar, on
  // the smallest breakpoint only (the published page hides it on larger ones).
  const smallest = [...allBreakpoints].sort((a, b) => a.minWidth - b.minWidth)[0];
  const stickyBar = isStickyCta(appComponentTree.props) ? null : firstStickyCta(appComponentTree);
  const pinned = stickyBar !== null && smallest?.id === breakpointId;

  return (
    <>
      {/* The self-hosted web fonts the page uses (src/lib/fonts/registry.ts). */}
      <PageFontFaces roots={[appComponentTree]} />
      <StickyCtaPreviewContext.Provider value={true}>
        <HeadlessComponentRenderer
          component={appComponentTree}
          breakpointId={breakpointId}
          allBreakpoints={allBreakpoints}
        />
        {pinned && stickyBar ? (
          // After the page root, as a child of the preview frame (the scroll
          // container): sticky keeps it at the frame's bottom whatever the
          // root's overflow, where fixed would pin it to the browser window.
          <div data-fc-sticky-cta-preview="" style={{ position: 'sticky', bottom: 0, zIndex: STICKY_CTA_Z_INDEX }}>
            <HeadlessComponentRenderer
              component={stickyBar}
              breakpointId={breakpointId}
              allBreakpoints={allBreakpoints}
              hoisted
            />
          </div>
        ) : null}
      </StickyCtaPreviewContext.Provider>
    </>
  );
});

HeadlessPageRenderer.displayName = 'HeadlessPageRenderer';
export default HeadlessPageRenderer;
