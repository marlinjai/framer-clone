// src/components/HudSurface.tsx
// High-performance component selection overlay using TransformContext subscription
'use client';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useTransformContext } from '@/contexts/TransformContext';
import { EditorTool } from '../stores/EditorUIStore';
import { 
  createCrossViewportSelection, 
  hasMultipleViewportAppearances,
  getPrimaryRenderInstance,
  getSecondaryRenderInstances,
  HIGHLIGHT_STYLES,
  type CrossViewportSelection 
} from '@/utils/crossViewportHighlighting';

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

  // Canvas container rect (updated on resize)
  const [canvasContainerRect, setCanvasContainerRect] = useState<DOMRect | null>(null);

  // Cross-viewport selection state
  const [crossViewportSelection, setCrossViewportSelection] = useState<CrossViewportSelection | null>(null);

  // Primary overlay ref (for main selection)
  const primaryOverlayRef = useRef<HTMLDivElement>(null);
  
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
    const { panX, panY, zoom } = transformState.current;

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

    // Hide overlays if not in select mode (early return for performance)
    if (editorUI.selectedTool !== EditorTool.SELECT) {
      primaryOverlay.style.display = 'none';
      if (secondaryOverlaysContainer) {
        secondaryOverlaysContainer.style.display = 'none';
      }
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

        console.log('🎯 HudSurface: Primary highlight positioned for component:', primaryInstance.componentId, 'in breakpoint:', primaryInstance.breakpointId);
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

        // Hide secondary overlays for viewport selection
        if (secondaryOverlaysContainer) {
          secondaryOverlaysContainer.style.display = 'none';
        }

        console.log('🎯 HudSurface: Viewport node highlighted:', editorUI.selectedViewportNode.breakpointLabel);
        return;
      }
    }

    // === Case 3: Floating element (selectedComponent without selectedViewportNode) ===
    // This handles floating elements that exist as canvas components outside viewports
    // We need to manually transform their canvas coordinates to screen coordinates
    if (editorUI.selectedComponent && !editorUI.selectedViewportNode && editorUI.selectedComponent.isFloatingElement) {
      const bounds = editorUI.selectedComponent.canvasBounds;
      if (bounds) {
        // Transform from canvas coordinates to screen coordinates
        // Formula: screenPos = (canvasPos * zoom) + pan + containerOffset
        const screenX = (bounds.x * zoom) + panX + canvasContainerRect.left;
        const screenY = (bounds.y * zoom) + panY + canvasContainerRect.top;
        const screenWidth = bounds.width * zoom;
        const screenHeight = bounds.height * zoom;

        primaryOverlay.style.display = 'block';
        primaryOverlay.style.transform = `translate(${screenX - 2}px, ${screenY - 2}px)`;
        primaryOverlay.style.width = `${screenWidth + 4}px`;
        primaryOverlay.style.height = `${screenHeight + 4}px`;
        primaryOverlay.className = `absolute pointer-events-none ${HIGHLIGHT_STYLES.floating.border} ${HIGHLIGHT_STYLES.floating.background} ${HIGHLIGHT_STYLES.floating.zIndex}`;

        // Hide secondary overlays for floating element selection
        if (secondaryOverlaysContainer) {
          secondaryOverlaysContainer.style.display = 'none';
        }

        console.log('🎯 HudSurface: Floating element highlighted:', editorUI.selectedComponent.id);
        return;
      }
    }

    // No valid selection - hide all overlays
    // console.log('👻 HudSurface: No valid selection found, hiding overlays');
    primaryOverlay.style.display = 'none';
    if (secondaryOverlaysContainer) {
      secondaryOverlaysContainer.style.display = 'none';
    }
  }, [
    editorUI.selectedTool,
    editorUI.selectedComponent,
    editorUI.selectedViewportNode,
    canvasContainerRect,
    transformState,
    crossViewportSelection,
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

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      {/* Primary selection overlay */}
      <div
        ref={primaryOverlayRef}
        className="absolute pointer-events-none"
        style={{ display: 'none' }}
        data-testid="primary-selection-overlay"
      >
        {/* Selection handles */}
        <div className="absolute -top-1 -left-1 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute top-1/2 -left-1 transform -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute top-1/2 -right-1 transform -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute -bottom-1 -left-1 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
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