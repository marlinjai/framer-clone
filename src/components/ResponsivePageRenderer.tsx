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
import type { ComponentInstance } from '@/models/ComponentModel';
import ComponentRenderer from './ComponentRenderer';
import GroundWrapper from './GroundWrapper';
import { useStore } from '@/hooks/useStore';
import { useDragSource } from '@/lib/drag';

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

  // Use first viewport as primary (largest minWidth).
  const primaryViewport = viewportNodes[0];

  return (
    <>
      {/* 1. Viewport frames */}
      {viewportNodes.map(viewport => (
        <ViewportFrame
          key={viewport.id}
          viewport={viewport}
          appComponentTree={appComponentTree}
          breakpoints={breakpoints}
          primaryBreakpointId={primaryViewport?.breakpointId || viewport.breakpointId!}
        />
      ))}

      {/* 2. Floating elements */}
      {page.floatingElements.map(element => (
        <FloatingElement
          key={element.id}
          element={element}
          breakpoints={breakpoints}
          primaryBreakpointId={primaryViewport?.breakpointId || 'default'}
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
  primaryBreakpointId: string;
}

const ViewportFrame = observer(({
  viewport,
  appComponentTree,
  breakpoints,
  primaryBreakpointId,
}: ViewportFrameProps) => {
  const { editorUI } = useStore();
  const { onPointerDown } = useDragSource(
    { kind: 'moveNode', nodeId: viewport.id },
    viewport,
  );

  return (
    <GroundWrapper
      id={viewport.id}
      x={viewport.canvasX!}
      y={viewport.canvasY!}
      visible={viewport.canvasVisible}
      className="viewport-node cursor-grab hover:cursor-grab"
      onClick={(e) => {
        e.stopPropagation();
        editorUI.setSelectedViewportNode(viewport);
      }}
      onPointerDown={onPointerDown}
    >
      <div
        className="relative bg-white shadow-lg rounded-lg transition-shadow"
        style={{
          width: `${viewport.viewportWidth}px`,
          height: `${viewport.viewportHeight}px`,
        }}
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
          <div className="flex items-center gap-2">
            <div className="text-gray-600">{viewport.label}</div>
            <div className="px-2 py-0.5 bg-gray-200 rounded text-xs">
              {viewport.breakpointMinWidth}px
            </div>
            <div className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
              {viewport.viewportWidth}×{viewport.viewportHeight}
            </div>
          </div>
        </div>

        {/* Render the same app tree with this viewport's breakpoint resolution */}
        <div className="w-full h-full overflow-auto">
          {appComponentTree && (
            <ComponentRenderer
              component={appComponentTree}
              breakpointId={viewport.breakpointId!}
              allBreakpoints={breakpoints}
              primaryId={primaryBreakpointId}
            />
          )}
        </div>
      </div>
    </GroundWrapper>
  );
});

// --- FloatingElement -----------------------------------------------------

interface FloatingElementProps {
  element: ComponentInstance;
  breakpoints: { id: string; minWidth: number; label?: string }[];
  primaryBreakpointId: string;
}

const FloatingElement = observer(({
  element,
  breakpoints,
  primaryBreakpointId,
}: FloatingElementProps) => {
  const { editorUI } = useStore();
  const { onPointerDown } = useDragSource(
    { kind: 'moveNode', nodeId: element.id },
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
      className="floating-element cursor-grab hover:cursor-grab"
      onClick={(e) => {
        e.stopPropagation();
        editorUI.selectComponent(element);
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
          primaryId={primaryBreakpointId}
        />
      </div>
    </GroundWrapper>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';
ViewportFrame.displayName = 'ViewportFrame';
FloatingElement.displayName = 'FloatingElement';
export default ResponsivePageRenderer;
