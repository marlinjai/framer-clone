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
//
// A link to a path of the site (`/contact`) never navigates the app: it is
// handed to `onSitePath`, which switches the preview to that page when one
// matches. Anchors and outside links behave as in a browser.
//
// Stored behaviour runs here as on the published page: the behaviour pass over the
// page's expansion (src/lib/behaviour/surfaceBehaviour.ts) writes the first values and
// the marks, the sheet reads its conditions, and the runtime, fetched only when the page
// has a trigger, runs on this frame with real pointer and focus. There is no gate: the
// frame is drawn by script, so it never has a no-JavaScript form to show. An edit gives
// a new program, and the runtime starts again from the first values.
'use client';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import { FX_ATTR } from '@/lib/effects/effects';
import { EffectsStyles } from '@/lib/effects/EffectsStyles';
import { PreviewRuleStyles } from '@/lib/rules/CanvasRuleStyles';
import { PREVIEW_ROOT } from '@/lib/rules/surfaces';
import { PageBaseStyles } from '@/lib/site/PageBaseStyles';
import { DEFAULT_PAGE_BASE, type PageBase } from '@/lib/site/pageBase';
import { prefersReducedMotion, startEffects } from '@/lib/effects/runtime';
import { startSmoothScroll } from '@/lib/effects/smoothScroll';
import { pickBreakpointForWidth } from '@/lib/renderer/pickBreakpoint';
import type { SurfaceNode } from '@/lib/rules/surfaceSheet';
import type { PageModelType } from '@/models/PageModel';
import { surfaceBehaviour } from '@/lib/behaviour/surfaceBehaviour';
import { SurfaceDomContext, useStableSurfaceDom } from '@/lib/behaviour/surfaceDom';
import type { BehaviourProgram } from '@/lib/behaviour/program';

export interface PreviewFrameProps {
  page: PageModelType;
  width: number;
  height: number;
  // When true, the frame fills its parent (100% × 100%) and drops the device-frame
  // chrome (shadow, fixed width/height). Used by fullscreen mode.
  fill?: boolean;
  /** The site's smooth scrolling setting: Lenis scrolls the frame. */
  smoothScroll?: boolean;
  /** The site's page base, as the published page has it. */
  pageBase?: PageBase;
  /** A click on a link to a path of the site (`/contact`), with that path. */
  onSitePath?: (path: string) => void;
}

/** The site path a click lands on (`/contact` from `<a href="/contact#x">`), or null for anchors and outside links. */
export function sitePathOfClick(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const href = target.closest('a[href]')?.getAttribute('href') ?? '';
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  return href.split(/[?#]/)[0];
}

// useLayoutEffect warns during server rendering; this module only renders in
// the browser (PreviewShell is loaded without SSR), but stay safe.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const PREVIEW_ROOTS = [PREVIEW_ROOT];

/**
 * Runs the program on the frame, with the chunks it needs fetched together, as
 * BehaviourIsland does on the published page. A chunk that does not arrive leaves the
 * page at its first values, which is what the frame already shows, and says so.
 */
function usePreviewRuntime(frame: React.RefObject<HTMLDivElement | null>, program: BehaviourProgram | null): void {
  useEffect(() => {
    const container = frame.current;
    if (!container || !program) return;
    let stop: (() => void) | undefined;
    let left = false;
    Promise.all([
      import('@/lib/behaviour/runtime'),
      program.verbs ? import('@/lib/behaviour/verbs') : undefined,
      program.rove ? import('@/lib/behaviour/rove') : undefined,
    ]).then(
      ([{ startBehaviour }, verbs, rove]) => {
        if (!left) stop = startBehaviour({ container, program, surface: 'preview', verbs: verbs?.createVerbs, extras: verbs, rove: rove?.createRover });
      },
      (error: unknown) => console.error('Page behaviour did not load in the preview: it shows the first values.', error),
    );
    return () => {
      left = true;
      stop?.();
    };
  }, [frame, program]);
}

const PreviewFrame = observer(({ page, width, height, fill = false, smoothScroll = false, pageBase = DEFAULT_PAGE_BASE, onSitePath }: PreviewFrameProps) => {
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
  const behaviour = surfaceBehaviour(page.expansion.root);
  const dom = useStableSurfaceDom([behaviour.dom]);
  usePreviewRuntime(frameRef, hasFrame ? behaviour.program : null);

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
          ? 'bg-white overflow-auto w-full h-full outline-none'
          : 'bg-white shadow-2xl overflow-auto outline-none'
      }
      style={fill ? undefined : { width, height }}
      // Focusable from script, so Space, the arrows and Page Down scroll the
      // page (the shell focuses it when the preview opens).
      tabIndex={-1}
      data-preview-frame=""
      data-preview-breakpoint={breakpointId}
      data-preview-fill={fill ? '' : undefined}
      onClickCapture={(e) => {
        const path = sitePathOfClick(e.target);
        if (path === null) return;
        e.preventDefault();
        onSitePath?.(path);
      }}
    >
      <EffectsStyles startScope={`[${FX_ATTR.scope}] `} smoothScroll={smoothScroll} />
      <PageBaseStyles base={pageBase} roots={PREVIEW_ROOTS} />
      <PreviewRuleStyles
        tree={behaviour.root as SurfaceNode}
        definitionTree={page.isDefinitionPage}
        frame={{ breakpointId, width, height }}
        breakpoints={viewportNodes.map(v => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth! }))}
        problems={behaviour.problems}
      />
      <SurfaceDomContext.Provider value={dom}>
        <HeadlessPageRenderer page={page} breakpointId={breakpointId} />
      </SurfaceDomContext.Provider>
    </div>
  );
});

PreviewFrame.displayName = 'PreviewFrame';
export default PreviewFrame;
