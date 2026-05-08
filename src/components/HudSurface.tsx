// src/components/HudSurface.tsx
// High-performance component selection overlay using TransformContext subscription
'use client';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useTransformContext } from '@/contexts/TransformContext';
import { EditorTool } from '../stores/EditorUIStore';
import { getHistoryStore, getDragManager } from '../stores/RootStore';
import type { ComponentInstance } from '../models/ComponentModel';
import {
  createCrossViewportSelection,
  hasMultipleViewportAppearances,
  getPrimaryRenderInstance,
  getSecondaryRenderInstances,
  HIGHLIGHT_STYLES,
  type CrossViewportSelection
} from '@/utils/crossViewportHighlighting';

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLE_DIRECTIONS: { dir: ResizeDirection; className: string; cursor: string }[] = [
  { dir: 'nw', className: '-top-1 -left-1',                             cursor: 'nwse-resize' },
  { dir: 'n',  className: '-top-1 left-1/2 transform -translate-x-1/2', cursor: 'ns-resize' },
  { dir: 'ne', className: '-top-1 -right-1',                            cursor: 'nesw-resize' },
  { dir: 'w',  className: 'top-1/2 -left-1 transform -translate-y-1/2', cursor: 'ew-resize' },
  { dir: 'e',  className: 'top-1/2 -right-1 transform -translate-y-1/2',cursor: 'ew-resize' },
  { dir: 'sw', className: '-bottom-1 -left-1',                          cursor: 'nesw-resize' },
  { dir: 's',  className: '-bottom-1 left-1/2 transform -translate-x-1/2', cursor: 'ns-resize' },
  { dir: 'se', className: '-bottom-1 -right-1',                         cursor: 'nwse-resize' },
];

// Border-radius corner handles (Framer-style inner dots). Fixed 10px inset from
// each corner; dragging inward along the diagonal grows the radius. Alt-drag
// isolates the gesture to that single corner.
type RadiusCorner = 'tl' | 'tr' | 'bl' | 'br';
const RADIUS_CORNERS: { id: RadiusCorner; className: string; cursor: string }[] = [
  { id: 'tl', className: 'top-2.5 left-2.5',     cursor: 'nwse-resize' },
  { id: 'tr', className: 'top-2.5 right-2.5',    cursor: 'nesw-resize' },
  { id: 'bl', className: 'bottom-2.5 left-2.5',  cursor: 'nesw-resize' },
  { id: 'br', className: 'bottom-2.5 right-2.5', cursor: 'nwse-resize' },
];
const CORNER_TO_RADIUS_PROP: Record<RadiusCorner, string> = {
  tl: 'borderTopLeftRadius',
  tr: 'borderTopRightRadius',
  bl: 'borderBottomLeftRadius',
  br: 'borderBottomRightRadius',
};
const INDIVIDUAL_CORNER_PROPS = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
] as const;
const CORNER_INWARD: Record<RadiusCorner, { x: 1 | -1; y: 1 | -1 }> = {
  tl: { x:  1, y:  1 },
  tr: { x: -1, y:  1 },
  bl: { x:  1, y: -1 },
  br: { x: -1, y: -1 },
};
const RADIUS_MIN_OVERLAY_PX = 40; // hide dots if overlay is smaller than this

function parseRadiusToPx(value: unknown, refDim: number): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const s = String(value).trim();
  if (!s) return 0;
  if (s.endsWith('%')) {
    const pct = parseFloat(s);
    return Number.isFinite(pct) ? (pct / 100) * refDim : 0;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * HudSurface - High-performance component selection overlay
 *
 * Uses TransformContext subscription for zero-React-render updates:
 * - Subscribes to canvas transform changes
 * - Updates overlay position via direct DOM manipulation
 * - Only re-renders React when selection changes
 */
const HudSurface = observer(() => {
  const rootStore = useStore();
  const { editorUI } = rootStore;
  const { state: transformState, subscribe } = useTransformContext();
  // Read the drag manager's engaged state reactively. HudSurface hides its
  // overlays while a drag is underway so the selection rectangle doesn't
  // flicker behind the ghost / indicator.
  const dragActive = getDragManager()?.isActive ?? false;

  // Canvas container rect (updated on resize)
  const [canvasContainerRect, setCanvasContainerRect] = useState<DOMRect | null>(null);

  // Cross-viewport selection state
  const [crossViewportSelection, setCrossViewportSelection] = useState<CrossViewportSelection | null>(null);

  // Primary overlay ref (for main selection)
  const primaryOverlayRef = useRef<HTMLDivElement>(null);

  // Border-radius handles wrapper ref (toggled via DOM to avoid React renders)
  const radiusHandlesRef = useRef<HTMLDivElement>(null);

  // Secondary overlays container ref (for cross-viewport highlights)
  const secondaryOverlaysRef = useRef<HTMLDivElement>(null);

  // Setup canvas container tracking
  useEffect(() => {
    // Find and cache canvas container
    const container = document.querySelector(
      '.w-full.h-full.bg-gray-100.overflow-hidden.relative'
    ) as HTMLElement;
    if (container) {
      setCanvasContainerRect(container.getBoundingClientRect());

      const updateContainerRect = () =>
        setCanvasContainerRect(container.getBoundingClientRect());
      window.addEventListener('resize', updateContainerRect);
      return () => window.removeEventListener('resize', updateContainerRect);
    }
  }, []);

  /**
   * Update overlay position via direct DOM manipulation
   * 
   * This function is called in two scenarios:
   * 1. Via subscription when canvas transform changes (pan/zoom)
   * 2. Via React useEffect when selection changes
   * 
   * Key features:
   * - No React re-renders (direct DOM updates only)
   * - Handles two coordinate systems:
   *   * Real DOM elements: Uses getBoundingClientRect() for screen coords
   *   * Virtual canvas elements: Transforms canvas coords to screen coords
   * - Uses fixed positioning for overlay (relative to viewport)
   * 
   * Coordinate transformation formula:
   * screenPos = (canvasPos * zoom) + pan + containerOffset
   */
  const updateOverlayPosition = useCallback(() => {
    if (!primaryOverlayRef.current || !canvasContainerRect) {
      // console.log('⚠️ HudSurface: Missing overlay ref or container rect');
      return;
    }

    const primaryOverlay = primaryOverlayRef.current;
    const secondaryOverlaysContainer = secondaryOverlaysRef.current;
    const radiusHandles = radiusHandlesRef.current;
    const { panX, panY, zoom } = transformState.current;

    // Default: radius handles hidden. Each show-overlay branch below decides
    // whether to enable them based on target kind and overlay size.
    const showRadiusHandlesIfLargeEnough = (overlayWidth: number, overlayHeight: number) => {
      if (!radiusHandles) return;
      // overlayWidth/height include the 4px padding; subtract to compare to the
      // target's actual rendered size.
      const inner = Math.min(overlayWidth, overlayHeight) - 4;
      radiusHandles.style.display = inner >= RADIUS_MIN_OVERLAY_PX ? 'block' : 'none';
    };
    const hideRadiusHandles = () => {
      if (radiusHandles) radiusHandles.style.display = 'none';
    };

    // Debug logging for transform state and container position (disabled for production)
    // console.log('🔄 HudSurface: updateOverlayPosition called', {
    //   transformState: { panX: panX.toFixed(2), panY: panY.toFixed(2), zoom: zoom.toFixed(3) },
    //   canvasContainerRect: {
    //     left: canvasContainerRect.left.toFixed(2),
    //     top: canvasContainerRect.top.toFixed(2),
    //     width: canvasContainerRect.width.toFixed(2),
    //     height: canvasContainerRect.height.toFixed(2)
    //   },
    //   selectedTool: editorUI.selectedTool
    // });

    // Hide overlays if not in select mode OR if currently dragging (Framer-style UX)
    if (editorUI.selectedTool !== EditorTool.SELECT || dragActive) {
      primaryOverlay.style.display = 'none';
      if (secondaryOverlaysContainer) {
        secondaryOverlaysContainer.style.display = 'none';
      }
      hideRadiusHandles();
      return;
    }

    // === Case 1: Selected component (cross-viewport highlighting) ===
    // This handles components that exist in the DOM (within breakpoint viewports)
    // We highlight the component in ALL viewports where it appears
    if (editorUI.selectedComponent && editorUI.selectedViewportNode && crossViewportSelection) {
      const primaryInstance = getPrimaryRenderInstance(crossViewportSelection);
      const secondaryInstances = getSecondaryRenderInstances(crossViewportSelection);

      // Primary highlight (where selection happened)
      if (primaryInstance?.domElement) {
        const rect = primaryInstance.domElement.getBoundingClientRect();
        const x = rect.left - 2;
        const y = rect.top - 2;

        primaryOverlay.style.display = 'block';
        primaryOverlay.style.transform = `translate(${x}px, ${y}px)`;
        primaryOverlay.style.width = `${rect.width + 4}px`;
        primaryOverlay.style.height = `${rect.height + 4}px`;
        primaryOverlay.className = `absolute pointer-events-none ${HIGHLIGHT_STYLES.primary.border} ${HIGHLIGHT_STYLES.primary.background} ${HIGHLIGHT_STYLES.primary.zIndex}`;
        showRadiusHandlesIfLargeEnough(rect.width + 4, rect.height + 4);

        console.log('🎯 HudSurface: Primary highlight positioned for component:', primaryInstance.componentId, 'in breakpoint:', primaryInstance.breakpointId);
      } else {
        hideRadiusHandles();
      }

      // Secondary highlights (same component in other viewports)
      if (secondaryOverlaysContainer && secondaryInstances.length > 0) {
        // Clear existing secondary overlays
        secondaryOverlaysContainer.innerHTML = '';
        secondaryOverlaysContainer.style.display = 'block';

        secondaryInstances.forEach((instance, index) => {
          if (!instance.domElement) return;

          const rect = instance.domElement.getBoundingClientRect();
          const x = rect.left - 2;
          const y = rect.top - 2;

          // Create secondary overlay element
          const secondaryOverlay = document.createElement('div');
          secondaryOverlay.className = `absolute pointer-events-none ${HIGHLIGHT_STYLES.secondary.border} ${HIGHLIGHT_STYLES.secondary.background} ${HIGHLIGHT_STYLES.secondary.zIndex} ${HIGHLIGHT_STYLES.secondary.animation}`;
          secondaryOverlay.style.transform = `translate(${x}px, ${y}px)`;
          secondaryOverlay.style.width = `${rect.width + 4}px`;
          secondaryOverlay.style.height = `${rect.height + 4}px`;
          
          secondaryOverlaysContainer.appendChild(secondaryOverlay);

          console.log(`🎯 HudSurface: Secondary highlight ${index + 1} positioned for component:`, instance.componentId, 'in breakpoint:', instance.breakpointId);
        });
      }

      return;
    }

    // Fallback: Single viewport component selection (no cross-viewport highlighting)
    if (editorUI.selectedComponent && editorUI.selectedViewportNode) {
      const primaryBreakpointId = editorUI.selectedViewportNode.breakpointId!;
      const primaryComponentId = `${primaryBreakpointId}-${editorUI.selectedComponent.id}`;
      const primaryElement = document.querySelector(
        `[data-component-id="${primaryComponentId}"]`
      ) as HTMLElement;

      if (primaryElement) {
        const rect = primaryElement.getBoundingClientRect();
        const x = rect.left - 2;
        const y = rect.top - 2;

        primaryOverlay.style.display = 'block';
        primaryOverlay.style.transform = `translate(${x}px, ${y}px)`;
        primaryOverlay.style.width = `${rect.width + 4}px`;
        primaryOverlay.style.height = `${rect.height + 4}px`;
        primaryOverlay.className = `absolute pointer-events-none ${HIGHLIGHT_STYLES.primary.border} ${HIGHLIGHT_STYLES.primary.background} ${HIGHLIGHT_STYLES.primary.zIndex}`;
        showRadiusHandlesIfLargeEnough(rect.width + 4, rect.height + 4);

        // Hide secondary overlays for single viewport selection
        if (secondaryOverlaysContainer) {
          secondaryOverlaysContainer.style.display = 'none';
        }

        return;
      }
    }

    // === Case 2: Selected viewport node (highlight viewport frame) ===
    // This handles when a viewport node itself is selected from the layers panel
    // We highlight the viewport frame on the canvas
    if (editorUI.selectedViewportNode && !editorUI.selectedComponent) {
      const viewportBounds = editorUI.selectedViewportNode.viewportBounds;
      if (viewportBounds) {
        // Transform viewport canvas coordinates to screen coordinates
        const screenX = (viewportBounds.x * zoom) + panX + canvasContainerRect.left;
        const screenY = (viewportBounds.y * zoom) + panY + canvasContainerRect.top;
        const screenWidth = viewportBounds.width * zoom;
        const screenHeight = viewportBounds.height * zoom;

        primaryOverlay.style.display = 'block';
        primaryOverlay.style.transform = `translate(${screenX - 2}px, ${screenY - 2}px)`;
        primaryOverlay.style.width = `${screenWidth + 4}px`;
        primaryOverlay.style.height = `${screenHeight + 4}px`;
        primaryOverlay.className = `absolute pointer-events-none ${HIGHLIGHT_STYLES.primary.border} ${HIGHLIGHT_STYLES.primary.background} ${HIGHLIGHT_STYLES.primary.zIndex}`;
        // Radius handles don't apply to viewport frames.
        hideRadiusHandles();

        // Hide secondary overlays for viewport selection
        if (secondaryOverlaysContainer) {
          secondaryOverlaysContainer.style.display = 'none';
        }

        console.log('🎯 HudSurface: Viewport node highlighted:', editorUI.selectedViewportNode.label);
        return;
      }
    }

    // === Case 3: Floating element (selectedComponent without selectedViewportNode) ===
    // This handles floating elements that exist as canvas components outside viewports
    // We need to find the actual DOM element and get its real bounds
    if (editorUI.selectedComponent && !editorUI.selectedViewportNode && editorUI.selectedComponent.isFloatingElement) {
      // Find the GroundWrapper element for floating elements (more reliable than inner component)
      const groundWrapperId = `ground-wrapper-${editorUI.selectedComponent.id}`;
      const floatingElement = document.getElementById(groundWrapperId) as HTMLElement;

      if (floatingElement) {
        // Use getBoundingClientRect() to get real screen coordinates (like viewport components)
        const rect = floatingElement.getBoundingClientRect();
        const x = rect.left - 2;
        const y = rect.top - 2;

        primaryOverlay.style.display = 'block';
        primaryOverlay.style.transform = `translate(${x}px, ${y}px)`;
        primaryOverlay.style.width = `${rect.width + 4}px`;
        primaryOverlay.style.height = `${rect.height + 4}px`;
        primaryOverlay.className = `absolute pointer-events-none ${HIGHLIGHT_STYLES.floating.border} ${HIGHLIGHT_STYLES.floating.background} ${HIGHLIGHT_STYLES.floating.zIndex}`;
        showRadiusHandlesIfLargeEnough(rect.width + 4, rect.height + 4);

        // Hide secondary overlays for floating element selection
        if (secondaryOverlaysContainer) {
          secondaryOverlaysContainer.style.display = 'none';
        }

        console.log('🎯 HudSurface: Floating element highlighted via GroundWrapper:', editorUI.selectedComponent.id);
        return;
      } else {
        console.warn('🚨 HudSurface: Could not find GroundWrapper for floating component:', editorUI.selectedComponent.id, 'with id:', groundWrapperId);
      }
    }

    // No valid selection - hide all overlays
    // console.log('👻 HudSurface: No valid selection found, hiding overlays');
    primaryOverlay.style.display = 'none';
    if (secondaryOverlaysContainer) {
      secondaryOverlaysContainer.style.display = 'none';
    }
    hideRadiusHandles();
  }, [
    editorUI.selectedTool,
    editorUI.selectedComponent,
    editorUI.selectedViewportNode,
    canvasContainerRect,
    transformState,
    crossViewportSelection,
    dragActive,
  ]);

  // Subscribe to transform updates (high-performance, no React re-renders)
  useEffect(() => {
    // console.log('🔗 HudSurface: Subscribing to transform updates');
    
    const unsubscribe = subscribe(() => {
      // console.log('📡 HudSurface: Transform update received via subscription');
      updateOverlayPosition(); // Direct DOM update on transform change
    });

    return () => {
      // console.log('🔌 HudSurface: Unsubscribing from transform updates');
      unsubscribe();
    };
  }, [subscribe, updateOverlayPosition]);

  // Update cross-viewport selection when component selection changes
  useEffect(() => {
    if (editorUI.selectedComponent && editorUI.selectedViewportNode && editorUI.currentPage) {
      const viewportNodes = editorUI.currentPage.viewportNodes;
      const primaryViewport = editorUI.selectedViewportNode;
      
      // Check if this component appears in multiple viewports
      if (primaryViewport && hasMultipleViewportAppearances(editorUI.selectedComponent, viewportNodes)) {
        const selection = createCrossViewportSelection(
          editorUI.selectedComponent,
          primaryViewport,
          viewportNodes
        );
        setCrossViewportSelection(selection);
        console.log('🎯 HudSurface: Cross-viewport selection created:', selection);
      } else {
        setCrossViewportSelection(null);
      }
    } else {
      setCrossViewportSelection(null);
    }
  }, [editorUI.selectedComponent, editorUI.selectedViewportNode, editorUI.currentPage]);

  // React-based updates (only when selection changes)
  useEffect(() => {
    updateOverlayPosition();
  }, [updateOverlayPosition]);

  // Re-position overlay when selected component's props change (layout might shift)
  // Read props here so MobX observer tracks the dependency
  const selectedProps = editorUI.selectedComponent?.props;
  const selectedVPProps = editorUI.selectedViewportNode?.props;
  useEffect(() => {
    // Wait one frame for ComponentRenderer to apply new styles to the DOM
    const rafId = requestAnimationFrame(() => updateOverlayPosition());
    return () => cancelAnimationFrame(rafId);
  }, [selectedProps, selectedVPProps, updateOverlayPosition]);

  // ===== Resize interaction =====
  //
  // Each handle stamps a `data-resize-direction` attribute. The mousedown below
  // reads it, captures starting dims from the rendered DOM rect (divided by the
  // current zoom so we write canvas-space px), and enters a resize loop that
  // writes through PageModel on every mousemove. ESC aborts and restores the
  // original dimensions / position.
  const onHandleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const dir = event.currentTarget.getAttribute('data-resize-direction') as ResizeDirection | null;
    if (!dir) return;

    // Figure out the active target: selected tree component, floating element, or viewport.
    const viewportNode = editorUI.selectedViewportNode;
    const selected = editorUI.selectedComponent;

    let target: ComponentInstance | undefined;
    let kind: 'tree' | 'floating' | 'viewport' | undefined;
    let breakpointId: string | undefined;

    if (selected && viewportNode) {
      target = selected;
      kind = 'tree';
      breakpointId = viewportNode.breakpointId;
    } else if (selected && selected.isFloatingElement) {
      target = selected;
      kind = 'floating';
    } else if (viewportNode && !selected) {
      target = viewportNode;
      kind = 'viewport';
    }

    if (!target || !kind) return;
    if (target.canvasLocked) return;

    event.preventDefault();
    event.stopPropagation();

    // Capture starting rect from the overlay (which was just painted to wrap the
    // target). The overlay adds 2px padding on every side, so subtract 4 to get
    // the target's actual screen size. Divide by zoom for canvas-space px.
    const overlay = primaryOverlayRef.current;
    const { zoom } = transformState.current;
    const overlayRect = overlay?.getBoundingClientRect();
    const startScreenWidth = Math.max(1, (overlayRect?.width ?? 0) - 4);
    const startScreenHeight = Math.max(1, (overlayRect?.height ?? 0) - 4);
    const startWidth = kind === 'viewport'
      ? (target.viewportWidth ?? startScreenWidth / zoom)
      : startScreenWidth / zoom;
    const startHeight = kind === 'viewport'
      ? (target.viewportHeight ?? startScreenHeight / zoom)
      : startScreenHeight / zoom;

    const startPos = { x: event.clientX, y: event.clientY };
    const startCanvasPos = { x: target.canvasX ?? 0, y: target.canvasY ?? 0 };

    editorUI.startResize({
      component: target,
      direction: dir,
      startPos,
      startDims: { width: startWidth, height: startHeight },
      startCanvasPos,
      kind,
      breakpointId,
    });
    // Each per-frame write is an MST action that would otherwise become its own
    // history entry. Batching collapses the whole gesture into one "Resize"
    // entry that undoes back to startDims in a single step.
    getHistoryStore()?.startBatch('Resize');

    const MIN = 8;
    const isLeft = dir === 'w' || dir === 'nw' || dir === 'sw';
    const isRight = dir === 'e' || dir === 'ne' || dir === 'se';
    const isTop = dir === 'n' || dir === 'nw' || dir === 'ne';
    const isBottom = dir === 's' || dir === 'sw' || dir === 'se';

    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = getComputedStyle(event.currentTarget).cursor;

    const handleMove = (ev: MouseEvent) => {
      // Screen deltas → canvas deltas.
      const { zoom: z } = transformState.current;
      const dxCanvas = (ev.clientX - startPos.x) / z;
      const dyCanvas = (ev.clientY - startPos.y) / z;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let newX = startCanvasPos.x;
      let newY = startCanvasPos.y;

      if (isRight) newWidth = Math.max(MIN, startWidth + dxCanvas);
      if (isLeft) {
        newWidth = Math.max(MIN, startWidth - dxCanvas);
        // Anchor opposite edge: floating elements (and viewports, which also
        // have canvasX/Y) keep their right edge put by shifting canvasX.
        const consumedDx = startWidth - newWidth; // positive if we shrank, negative if grew
        newX = startCanvasPos.x + consumedDx;
      }
      if (isBottom) newHeight = Math.max(MIN, startHeight + dyCanvas);
      if (isTop) {
        newHeight = Math.max(MIN, startHeight - dyCanvas);
        const consumedDy = startHeight - newHeight;
        newY = startCanvasPos.y + consumedDy;
      }

      const widthPx = Math.round(newWidth);
      const heightPx = Math.round(newHeight);

      if (kind === 'tree') {
        target!.updateResponsiveStyle('width', `${widthPx}px`, breakpointId);
        target!.updateResponsiveStyle('height', `${heightPx}px`, breakpointId);
      } else if (kind === 'floating') {
        target!.updateResponsiveStyle('width', `${widthPx}px`);
        target!.updateResponsiveStyle('height', `${heightPx}px`);
        if (isLeft || isTop) {
          target!.updateCanvasTransform({
            x: isLeft ? Math.round(newX) : undefined,
            y: isTop ? Math.round(newY) : undefined,
          });
        }
      } else if (kind === 'viewport') {
        target!.setViewportProperties({
          viewportWidth: widthPx,
          viewportHeight: heightPx,
        });
      }

      // Keep the overlay glued to the resized target without waiting for React.
      updateOverlayPosition();
    };

    const restoreOriginal = () => {
      if (kind === 'tree') {
        target!.updateResponsiveStyle('width', `${Math.round(startWidth)}px`, breakpointId);
        target!.updateResponsiveStyle('height', `${Math.round(startHeight)}px`, breakpointId);
      } else if (kind === 'floating') {
        target!.updateResponsiveStyle('width', `${Math.round(startWidth)}px`);
        target!.updateResponsiveStyle('height', `${Math.round(startHeight)}px`);
        target!.updateCanvasTransform({ x: startCanvasPos.x, y: startCanvasPos.y });
      } else if (kind === 'viewport') {
        target!.setViewportProperties({
          viewportWidth: Math.round(startWidth),
          viewportHeight: Math.round(startHeight),
        });
      }
      updateOverlayPosition();
    };

    const cleanup = (committed: boolean) => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.removeEventListener('keydown', handleKey);
      document.body.style.cursor = prevCursor;
      editorUI.endResize();
      const history = getHistoryStore();
      if (committed) {
        history?.commitBatch();
      } else {
        // ESC path: state already reverted by restoreOriginal; drop buffered
        // patches so nothing lands in history.
        history?.cancelBatch();
      }
    };

    const handleUp = () => cleanup(true);
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        restoreOriginal();
        cleanup(false);
      }
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.addEventListener('keydown', handleKey);
  }, [editorUI, transformState, updateOverlayPosition]);

  // ===== Border-radius interaction =====
  //
  // Each corner dot stamps a `data-radius-corner` attribute. Mousedown captures
  // the current radius (from borderRadius or the corner's individual prop) and
  // the overlay's canvas-space dimensions, then enters a drag loop that writes
  // the new radius on every mousemove. ESC aborts and restores originals.
  //
  // Holding Alt at mousedown isolates the gesture to that single corner and
  // writes only `borderTop(Left|Right)Radius` / `borderBottom(Left|Right)Radius`.
  // Without Alt, all four corners are unified via `borderRadius` and any
  // pre-existing individual-corner overrides are cleared.
  const onRadiusHandleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const corner = event.currentTarget.getAttribute('data-radius-corner') as RadiusCorner | null;
    if (!corner) return;

    const viewportNode = editorUI.selectedViewportNode;
    const selected = editorUI.selectedComponent;

    let target: ComponentInstance | undefined;
    let kind: 'tree' | 'floating' | undefined;
    let breakpointId: string | undefined;

    if (selected && viewportNode) {
      target = selected;
      kind = 'tree';
      breakpointId = viewportNode.breakpointId;
    } else if (selected && selected.isFloatingElement) {
      target = selected;
      kind = 'floating';
    }

    if (!target || !kind) return;
    if (target.canvasLocked) return;

    event.preventDefault();
    event.stopPropagation();

    const overlay = primaryOverlayRef.current;
    const { zoom } = transformState.current;
    const overlayRect = overlay?.getBoundingClientRect();
    const widthPx = Math.max(1, ((overlayRect?.width ?? 0) - 4) / zoom);
    const heightPx = Math.max(1, ((overlayRect?.height ?? 0) - 4) / zoom);
    const refDim = Math.min(widthPx, heightPx);
    const MAX = refDim / 2;

    const perCorner = event.altKey;
    const writeBp = kind === 'tree' ? breakpointId : undefined;
    const readProp = (p: string) => target!.getResponsiveStyleValue(p, writeBp);

    // Capture originals so ESC can fully restore state.
    const origBorderRadius = readProp('borderRadius') ?? '';
    const origCornerValues: Record<RadiusCorner, any> = {
      tl: readProp('borderTopLeftRadius') ?? '',
      tr: readProp('borderTopRightRadius') ?? '',
      bl: readProp('borderBottomLeftRadius') ?? '',
      br: readProp('borderBottomRightRadius') ?? '',
    };

    // Starting radius: for per-corner drag, prefer that corner's explicit value,
    // falling back to the unified borderRadius. For unified drag, prefer the
    // unified value, falling back to whichever individual corner is set.
    let startRadius: number;
    if (perCorner) {
      const cv = origCornerValues[corner];
      startRadius = parseRadiusToPx(cv !== '' ? cv : origBorderRadius, refDim);
    } else {
      startRadius = parseRadiusToPx(origBorderRadius, refDim);
      if (startRadius === 0) {
        for (const c of ['tl', 'tr', 'bl', 'br'] as RadiusCorner[]) {
          const v = origCornerValues[c];
          if (v !== '') { startRadius = parseRadiusToPx(v, refDim); break; }
        }
      }
    }

    getHistoryStore()?.startBatch(perCorner ? 'Corner radius' : 'Border radius');

    const startPos = { x: event.clientX, y: event.clientY };
    const inward = CORNER_INWARD[corner];
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = getComputedStyle(event.currentTarget).cursor;

    const handleMove = (ev: MouseEvent) => {
      const { zoom: z } = transformState.current;
      // Project pointer delta onto the inward diagonal of this corner.
      // Averaging x+y gives a diagonal-first feel: pure diagonal drag is ~1:1,
      // single-axis drag still produces motion but at half speed.
      const inX = ((ev.clientX - startPos.x) * inward.x) / z;
      const inY = ((ev.clientY - startPos.y) * inward.y) / z;
      const delta = (inX + inY) / 2;
      const newRadius = Math.max(0, Math.min(MAX, startRadius + delta));
      const px = `${Math.round(newRadius)}px`;

      if (perCorner) {
        target!.updateResponsiveStyle(CORNER_TO_RADIUS_PROP[corner], px, writeBp);
      } else {
        target!.updateResponsiveStyle('borderRadius', px, writeBp);
        // Clear any pre-existing per-corner overrides so the unified value wins.
        for (const p of INDIVIDUAL_CORNER_PROPS) {
          if (origCornerValues[({
            borderTopLeftRadius: 'tl',
            borderTopRightRadius: 'tr',
            borderBottomLeftRadius: 'bl',
            borderBottomRightRadius: 'br',
          } as const)[p]] !== '') {
            target!.updateResponsiveStyle(p, '', writeBp);
          }
        }
      }

      updateOverlayPosition();
    };

    const restoreOriginal = () => {
      if (perCorner) {
        target!.updateResponsiveStyle(
          CORNER_TO_RADIUS_PROP[corner],
          origCornerValues[corner],
          writeBp,
        );
      } else {
        target!.updateResponsiveStyle('borderRadius', origBorderRadius, writeBp);
        target!.updateResponsiveStyle('borderTopLeftRadius', origCornerValues.tl, writeBp);
        target!.updateResponsiveStyle('borderTopRightRadius', origCornerValues.tr, writeBp);
        target!.updateResponsiveStyle('borderBottomLeftRadius', origCornerValues.bl, writeBp);
        target!.updateResponsiveStyle('borderBottomRightRadius', origCornerValues.br, writeBp);
      }
      updateOverlayPosition();
    };

    const cleanup = (committed: boolean) => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.removeEventListener('keydown', handleKey);
      document.body.style.cursor = prevCursor;
      const history = getHistoryStore();
      if (committed) {
        history?.commitBatch();
      } else {
        history?.cancelBatch();
      }
    };

    const handleUp = () => cleanup(true);
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        restoreOriginal();
        cleanup(false);
      }
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.addEventListener('keydown', handleKey);
  }, [editorUI, transformState, updateOverlayPosition]);

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      {/* Primary selection overlay */}
      <div
        ref={primaryOverlayRef}
        className="absolute pointer-events-none"
        style={{ display: 'none' }}
        data-testid="primary-selection-overlay"
      >
        {/* Selection / resize handles. pointer-events: auto so they receive the
            mousedown even though the parent overlay is pointer-events-none. */}
        {HANDLE_DIRECTIONS.map(({ dir, className, cursor }) => (
          <div
            key={dir}
            data-resize-direction={dir}
            data-testid={`resize-handle-${dir}`}
            onMouseDown={onHandleMouseDown}
            className={`absolute w-2 h-2 bg-blue-500 rounded-full ${className}`}
            style={{ cursor, pointerEvents: 'auto' }}
          />
        ))}

        {/* Border-radius corner dots. Hidden by default; updateOverlayPosition
            toggles the wrapper's display based on selection kind and overlay size. */}
        <div
          ref={radiusHandlesRef}
          className="absolute inset-0 pointer-events-none"
          style={{ display: 'none' }}
          data-testid="radius-handles"
        >
          {RADIUS_CORNERS.map(({ id, className, cursor }) => (
            <div
              key={id}
              data-radius-corner={id}
              data-testid={`radius-handle-${id}`}
              onMouseDown={onRadiusHandleMouseDown}
              title="Drag to round corners. Hold Alt to round just this corner."
              className={`absolute w-2 h-2 bg-white border border-blue-500 rounded-full opacity-70 hover:opacity-100 transition-opacity ${className}`}
              style={{ cursor, pointerEvents: 'auto' }}
            />
          ))}
        </div>
      </div>
      
      {/* Secondary overlays container (for cross-viewport highlighting) */}
      <div
        ref={secondaryOverlaysRef}
        className="absolute pointer-events-none"
        style={{ display: 'none' }}
        data-testid="secondary-overlays-container"
      />
    </div>
  );
});

HudSurface.displayName = 'HudSurface';

export default HudSurface;