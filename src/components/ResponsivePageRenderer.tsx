// src/components/ResponsivePageRenderer.tsx
// Renders all canvas nodes using Framer-style unified approach.
//
// Drag behavior is owned entirely by the unified DragManager:
//   - Viewport and floating wrappers attach `onPointerDown` via useDragSource;
//     DragManager decides if the gesture engages (past threshold), updates
//     canvasX/Y live during drag, and on release either reparents into a
//     tree target or commits the new floating coords.
//   - Drop targets inside viewports and floating subtrees are discovered via
//     `data-viewport-id` / `data-floating-root-id` / `data-inner-component-id`,
//     which the resolver walks up to find.
//
// No HTML5 drag handlers, no elementFromPoint-in-render, no per-viewport
// hover highlight state. The DropIndicatorLayer (mounted in EditorApp)
// paints the single shared indicator each frame.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { isAlive } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import ComponentRenderer from './ComponentRenderer';
import PageFontFaces from '@/lib/fonts/PageFontFaces';
import GroundWrapper from './GroundWrapper';
import { useStore } from '@/hooks/useStore';
import { useDragSource } from '@/lib/drag';
import {
  viewportFrameContentStyle,
  viewportFrameLabel,
} from '@/lib/canvas/viewportFrame';
import {
  createScope,
  pushPageFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';

// Parse a CSS length into pixels for GroundWrapper sizing. Accepts a raw
// number or a `<n>px` string. Anything else (e.g. '100%', 'auto',
// 'fit-content') returns `undefined` so callers can fall back. GroundWrapper
// needs concrete pixel dimensions because it's position: fixed and transforms
// to track the cursor; percentage widths would resolve against the window.
function parsePxDim(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
    if (match) return parseFloat(match[1]);
  }
  return undefined;
}

// Fallback canvas size for floating elements whose style uses fluid units
// (`100%`, `auto`, etc.). Chosen to match the previous Container default so
// a floating Container with the new fluid styles still appears as a
// reasonable box on empty canvas. User resize writes back concrete px via
// updateResponsiveStyle, so this is only the initial-mount default.
const FLOATING_FALLBACK_WIDTH = 240;
const FLOATING_FALLBACK_HEIGHT = 160;

const ResponsivePageRenderer = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const page = rootStore.editorUI.currentPage;
  if (!project || !page) return null;

  const { appComponentTree } = page;
  const viewportNodes = page.sortedViewportNodes;

  const breakpoints = viewportNodes.map(viewport => ({
    id: viewport.breakpointId!,
    minWidth: viewport.breakpointMinWidth!,
    label: viewport.label!,
  }));


  // Root binding scope: a page frame carrying route params. The editor canvas
  // has no concrete route params yet, so this is an empty params bag; a bound
  // RecordView therefore resolves `{{page.params.id}}` to undefined and shows
  // its empty state until preview/publish supplies real params.
  const rootScope: BindingScope = pushPageFrame(createScope(), {});

  return (
    <>
      {/* The self-hosted web fonts the page uses (src/lib/fonts/registry.ts). */}
      <PageFontFaces roots={[appComponentTree, ...page.floatingElements]} />
      {/* 1. Viewport frames */}
      {viewportNodes.map(viewport => (
        <ViewportFrame
          key={viewport.id}
          viewport={viewport}
          appComponentTree={appComponentTree}
          breakpoints={breakpoints}
          scope={rootScope}
        />
      ))}

      {/* 2. Floating elements */}
      {page.floatingElements.map(element => (
        <FloatingElement
          key={element.id}
          element={element}
          breakpoints={breakpoints}
          scope={rootScope}
        />
      ))}
    </>
  );
});

// --- ViewportFrame -------------------------------------------------------

interface ViewportFrameProps {
  viewport: ComponentInstance;
  appComponentTree: ComponentInstance;
  breakpoints: { id: string; minWidth: number; label?: string }[];
  scope: BindingScope;
}

export const ViewportFrame = observer(({
  viewport,
  appComponentTree,
  breakpoints,
  scope,
}: ViewportFrameProps) => {
  const { editorUI } = useStore();
  const { onPointerDown } = useDragSource(
    { kind: 'moveNode', nodeId: viewport.id },
    viewport,
  );
  const frameRef = useRenderedFrameHeight(viewport);

  const width = viewport.viewportWidth ?? 400;
  const minHeight = viewport.viewportHeight ?? 600;
  const label = viewportFrameLabel(width, minHeight, viewport.renderedViewportHeight);

  return (
    <GroundWrapper
      id={viewport.id}
      x={viewport.canvasX!}
      y={viewport.canvasY!}
      // The wrapper follows the frame: fixed width, height grows with content.
      width={width}
      height="auto"
      visible={viewport.canvasVisible}
      className="viewport-node cursor-grab hover:cursor-grab"
      onClick={(e) => {
        e.stopPropagation();
        editorUI.setSelectedViewportNode(viewport);
      }}
      onPointerDown={onPointerDown}
    >
      {/*
        Outer box: the frame's chrome (background, shadow, rounded corners),
        the drop / hit-test marker and the anchor for the label above it. It
        has no height of its own; it is exactly as tall as the clipping box
        below, which is at least viewportHeight and grows with the page.
      */}
      <div
        ref={frameRef}
        className="relative bg-white shadow-lg rounded-lg transition-shadow"
        style={{ width: `${width}px` }}
        data-viewport-id={viewport.id}
        data-breakpoint-id={viewport.breakpointId}
      >
        {/* Viewport label - clickable for viewport selection */}
        <div
          className="absolute -top-8 left-0 text-sm font-medium text-gray-600 cursor-pointer hover:bg-gray-100 rounded px-2 py-1 -mx-2 -my-1"
          onClick={(e) => {
            e.stopPropagation();
            editorUI.setSelectedViewportNode(viewport);
          }}
        >
          <div className="flex items-center gap-2 whitespace-nowrap">
            <div className="text-gray-600">{viewport.label}</div>
            <div className="px-2 py-0.5 bg-gray-200 rounded text-xs">
              {viewport.breakpointMinWidth}px
            </div>
            <div
              className="px-2 py-0.5 bg-brand/15 text-brand rounded text-xs"
              title={`Frame size on the canvas. Minimum height ${minHeight}px; the frame grows with the page content.`}
              data-testid="viewport-frame-size"
            >
              {label.size}
              {label.minNote && <span className="ml-1 opacity-70">({label.minNote})</span>}
            </div>
          </div>
        </div>

        {/*
          Clipping box for the page tree. See viewportFrameContentStyle: no
          inner scroller (the canvas owns the wheel, so one would be
          unreachable), grows with the content, and clips absolutely and
          fixed positioned descendants so nothing paints outside the frame.
        */}
        <div
          className="rounded-lg"
          style={viewportFrameContentStyle(minHeight)}
          data-viewport-content-id={viewport.id}
        >
          {appComponentTree && (
            <ComponentRenderer
              component={appComponentTree}
              breakpointId={viewport.breakpointId!}
              allBreakpoints={breakpoints}
              scope={scope}
            />
          )}
        </div>
      </div>
    </GroundWrapper>
  );
});

/**
 * Measures a viewport frame's rendered height and reports it to the model
 * (ComponentModel.renderedViewportHeight, volatile) so MobX-driven consumers
 * (the frame label, the HUD's frame selection overlay and resize handles) see
 * the frame's real height. Uses offsetHeight, which is layout px and ignores
 * the canvas zoom transform. Writing back is safe from loops: the measured
 * value only feeds overlays and the label, never the frame's own CSS height.
 */
function useRenderedFrameHeight(viewport: ComponentInstance) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!el) return;
    // A deleted viewport node is destroyed before React unmounts its frame;
    // never write to a dead MobX-State-Tree node.
    const report = () => {
      if (isAlive(viewport)) viewport.setRenderedViewportHeight(el.offsetHeight);
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, viewport]);

  // Forget the measurement when the frame unmounts (page switch), so a stale
  // height never outlives its DOM.
  React.useEffect(() => () => {
    if (isAlive(viewport)) viewport.setRenderedViewportHeight(undefined);
  }, [viewport]);

  return setEl;
}

// --- FloatingElement -----------------------------------------------------

interface FloatingElementProps {
  element: ComponentInstance;
  breakpoints: { id: string; minWidth: number; label?: string }[];
  scope: BindingScope;
}

const FloatingElement = observer(({
  element,
  breakpoints,
  scope,
}: FloatingElementProps) => {
  const { editorUI } = useStore();
  // Locked floating elements are not dragged from the canvas (the Layers
  // panel still moves them).
  const { onPointerDown } = useDragSource(
    element.canvasLocked ? null : { kind: 'moveNode', nodeId: element.id },
    element,
  );

  return (
    <GroundWrapper
      id={element.id}
      x={element.canvasX!}
      y={element.canvasY!}
      scale={element.canvasScale}
      rotation={element.canvasRotation}
      zIndex={element.canvasZIndex}
      width={parsePxDim(element.props?.style?.width) ?? FLOATING_FALLBACK_WIDTH}
      height={parsePxDim(element.props?.style?.height) ?? FLOATING_FALLBACK_HEIGHT}
      visible={element.canvasVisible}
      locked={element.canvasLocked}
      className="floating-element cursor-grab hover:cursor-grab"
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) editorUI.toggleInSelection(element);
        else editorUI.selectComponent(element);
      }}
      onPointerDown={onPointerDown}
    >
      {/*
        data-floating-root-id marks this subtree as a drop container. The
        resolver walks up from the pointer: if it hits a nested component's
        data-inner-component-id first, that's the drop target; otherwise it
        falls through to the floating root id.
      */}
      <div
        data-floating-root-id={element.id}
        style={{ width: '100%', height: '100%' }}
      >
        <ComponentRenderer
          component={element}
          breakpointId=""
          allBreakpoints={breakpoints}
          scope={scope}
        />
      </div>
    </GroundWrapper>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';
ViewportFrame.displayName = 'ViewportFrame';
FloatingElement.displayName = 'FloatingElement';
export default ResponsivePageRenderer;
