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
import HeadlessComponentRenderer from './HeadlessComponentRenderer';

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
  const primaryId = viewportNodes[0]?.breakpointId ?? breakpointId;

  return (
    <HeadlessComponentRenderer
      component={appComponentTree}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      primaryId={primaryId}
    />
  );
});

HeadlessPageRenderer.displayName = 'HeadlessPageRenderer';
export default HeadlessPageRenderer;
