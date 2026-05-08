// Width/height-controlled wrapper that mounts HeadlessPageRenderer for a
// single page. The active breakpoint is derived from `width` via
// pickBreakpointForWidth, so dragging the gutter (or typing in the W input)
// causes the renderer to re-resolve responsive styles live.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import { pickBreakpointForWidth } from '@/lib/renderer/pickBreakpoint';
import type { PageModelType } from '@/models/PageModel';

export interface PreviewFrameProps {
  page: PageModelType;
  width: number;
  height: number;
  // When true, the frame fills its parent (100% × 100%) and drops the device-frame
  // chrome (shadow, fixed width/height). Used by fullscreen mode.
  fill?: boolean;
}

const PreviewFrame = observer(({ page, width, height, fill = false }: PreviewFrameProps) => {
  const viewportNodes = page.sortedViewportNodes;
  const breakpointId = pickBreakpointForWidth(
    viewportNodes.map(v => ({
      breakpointId: v.breakpointId,
      breakpointMinWidth: v.breakpointMinWidth,
    })),
    width,
  );

  if (!breakpointId) {
    return (
      <div
        className={
          fill
            ? 'w-full h-full flex items-center justify-center bg-white text-sm text-gray-400'
            : 'flex items-center justify-center bg-white text-sm text-gray-400'
        }
        style={fill ? undefined : { width, height }}
      >
        This page has no viewports defined.
      </div>
    );
  }

  return (
    <div
      className={
        fill
          ? 'bg-white overflow-auto w-full h-full'
          : 'bg-white shadow-2xl overflow-auto'
      }
      style={fill ? undefined : { width, height }}
      data-preview-frame=""
      data-preview-breakpoint={breakpointId}
      data-preview-fill={fill ? '' : undefined}
    >
      <HeadlessPageRenderer page={page} breakpointId={breakpointId} />
    </div>
  );
});

PreviewFrame.displayName = 'PreviewFrame';
export default PreviewFrame;
