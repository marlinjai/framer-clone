// Width/height-controlled wrapper that mounts HeadlessPageRenderer for a
// single page. The active breakpoint is derived from `width` via
// pickBreakpointForWidth, so dragging the gutter (or typing in the W input)
// causes the renderer to re-resolve responsive styles live.
//
// Effects play here as on the published page: the frame is the scroll root
// for the appear and parallax runtime (src/lib/effects/runtime.ts), it gates
// the start-state rules with `data-fx-on` (set before the first paint, only
// when motion is allowed), and with the site's smooth scrolling on, Lenis
// scrolls the frame.
'use client';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import { FX_ATTR } from '@/lib/effects/effects';
import { EffectsStyles } from '@/lib/effects/EffectsStyles';
import { prefersReducedMotion, startEffects } from '@/lib/effects/runtime';
import { startSmoothScroll } from '@/lib/effects/smoothScroll';
import { pickBreakpointForWidth } from '@/lib/renderer/pickBreakpoint';
import type { PageModelType } from '@/models/PageModel';

export interface PreviewFrameProps {
  page: PageModelType;
  width: number;
  height: number;
  // When true, the frame fills its parent (100% × 100%) and drops the device-frame
  // chrome (shadow, fixed width/height). Used by fullscreen mode.
  fill?: boolean;
  /** The site's smooth scrolling setting: Lenis scrolls the frame. */
  smoothScroll?: boolean;
}

// useLayoutEffect warns during server rendering; this module only renders in
// the browser (PreviewShell is loaded without SSR), but stay safe.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const PreviewFrame = observer(({ page, width, height, fill = false, smoothScroll = false }: PreviewFrameProps) => {
  const frameRef = useRef<HTMLDivElement>(null);

  const viewportNodes = page.sortedViewportNodes;
  const breakpointId = pickBreakpointForWidth(
    viewportNodes.map(v => ({
      breakpointId: v.breakpointId,
      breakpointMinWidth: v.breakpointMinWidth,
    })),
    width,
  );

  const hasFrame = Boolean(breakpointId);

  // Before the first paint: turn the start-state rules on, so an appear
  // element in view never flashes visible, then hidden, then revealed.
  useBeforePaint(() => {
    const frame = frameRef.current;
    if (!frame || prefersReducedMotion()) return;
    frame.setAttribute(FX_ATTR.scope, '');
    return () => frame.removeAttribute(FX_ATTR.scope);
  }, [hasFrame]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    return startEffects({ container: frame, scrollRoot: frame });
  }, [hasFrame]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !smoothScroll) return;
    const content = Array.from(frame.children).find(c => c.tagName !== 'STYLE') as HTMLElement | undefined;
    return startSmoothScroll({ wrapper: frame, content });
  }, [hasFrame, smoothScroll]);

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
      ref={frameRef}
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
      <EffectsStyles startScope={`[${FX_ATTR.scope}] `} smoothScroll={smoothScroll} />
      <HeadlessPageRenderer page={page} breakpointId={breakpointId} />
    </div>
  );
});

PreviewFrame.displayName = 'PreviewFrame';
export default PreviewFrame;
