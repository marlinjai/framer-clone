// src/components/HudSurface.tsx
// High-performance component selection overlay using TransformContext subscription
'use client';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useTransformContext } from '@/contexts/TransformContext';
import { EditorTool } from '../stores/EditorUIStore';

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

  // Single overlay ref
  const overlayRef = useRef<HTMLDivElement>(null);

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

  // Direct DOM overlay update function (called by subscription)
  const updateOverlayPosition = useCallback(() => {
    if (!overlayRef.current || !canvasContainerRect) {
      console.log('⚠️ HudSurface: Missing overlay ref or container rect');
      return;
    }

    const overlay = overlayRef.current;
    const { panX, panY, zoom } = transformState.current;

    console.log('🔄 HudSurface: updateOverlayPosition called', {
      transformState: { panX: panX.toFixed(2), panY: panY.toFixed(2), zoom: zoom.toFixed(3) },
      canvasContainerRect: {
        left: canvasContainerRect.left.toFixed(2),
        top: canvasContainerRect.top.toFixed(2),
        width: canvasContainerRect.width.toFixed(2),
        height: canvasContainerRect.height.toFixed(2)
      },
      selectedTool: editorUI.selectedTool
    });

    // Hide overlay if not in select mode
    if (editorUI.selectedTool !== EditorTool.SELECT) {
      overlay.style.display = 'none';
      return;
    }

    // === Case 1: Selected component (real DOM element) ===
    if (editorUI.selectedComponent && editorUI.selectedBreakpoint) {
      const breakpointComponentId = `${editorUI.selectedBreakpoint.id}-${editorUI.selectedComponent.id}`;
      const element = document.querySelector(
        `[data-component-id="${breakpointComponentId}"]`
      ) as HTMLElement;

      if (element) {
        const rect = element.getBoundingClientRect();

        console.log('📍 HudSurface: Component Element Found', {
          breakpointComponentId,
          elementRect: {
            left: rect.left.toFixed(2),
            top: rect.top.toFixed(2),
            width: rect.width.toFixed(2),
            height: rect.height.toFixed(2)
          },
          canvasContainerRect: {
            left: canvasContainerRect.left.toFixed(2),
            top: canvasContainerRect.top.toFixed(2)
          }
        });

        // HudSurface uses fixed positioning, so we need screen coordinates
        const x = rect.left - 2;
        const y = rect.top - 2;

        console.log('🎯 HudSurface: Component Overlay Position', {
          calculatedX: x.toFixed(2),
          calculatedY: y.toFixed(2),
          overlayTransform: `translate(${x}px, ${y}px)`
        });

        overlay.style.display = 'block';
        overlay.style.transform = `translate(${x}px, ${y}px)`;
        overlay.style.width = `${rect.width + 4}px`;
        overlay.style.height = `${rect.height + 4}px`;
        overlay.className =
          'absolute pointer-events-none border-2 border-blue-500 bg-blue-500/10 z-50';
        return;
      } else {
        console.log('❌ HudSurface: Component element not found:', breakpointComponentId);
      }
    }

    // === Case 2: Root canvas component (virtual model, no DOM node) ===
    if (editorUI.selectedRootCanvasComponent?.isRootCanvasComponent) {
      const bounds = editorUI.selectedRootCanvasComponent.canvasBounds;
      if (bounds) {
        console.log('🟢 HudSurface: Root Canvas Component Selected', {
          componentId: editorUI.selectedRootCanvasComponent.id,
          canvasBounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
          },
          transformState: { panX: panX.toFixed(2), panY: panY.toFixed(2), zoom: zoom.toFixed(3) }
        });

        // Transform from canvas coordinates to screen coordinates
        // Formula: screenPos = (canvasPos * zoom) + pan + containerOffset
        const screenX = (bounds.x * zoom) + panX + canvasContainerRect.left;
        const screenY = (bounds.y * zoom) + panY + canvasContainerRect.top;
        
        const x = screenX - 2; // Overlay border offset
        const y = screenY - 2; // Overlay border offset
        
        const scaledWidth = bounds.width * zoom;
        const scaledHeight = bounds.height * zoom;

        console.log('🎯 HudSurface: Root Canvas Overlay Position', {
          canvasCoords: { x: bounds.x, y: bounds.y },
          screenCoords: { x: screenX.toFixed(2), y: screenY.toFixed(2) },
          finalOverlayPos: { x: x.toFixed(2), y: y.toFixed(2) },
          scaledSize: { width: scaledWidth.toFixed(2), height: scaledHeight.toFixed(2) },
          overlayTransform: `translate(${x}px, ${y}px)`
        });

        overlay.style.display = 'block';
        overlay.style.transform = `translate(${x}px, ${y}px)`;
        overlay.style.width = `${scaledWidth + 4}px`;
        overlay.style.height = `${scaledHeight + 4}px`;
        overlay.className =
          'absolute pointer-events-none border-2 border-green-500 bg-green-500/10 z-50';
        return;
      }
    }

    // No valid selection - hide overlay
    console.log('👻 HudSurface: No valid selection found, hiding overlay');
    overlay.style.display = 'none';
  }, [
    editorUI.selectedTool,
    editorUI.selectedComponent,
    editorUI.selectedBreakpoint,
    editorUI.selectedRootCanvasComponent,
    canvasContainerRect,
    transformState,
  ]);

  // Subscribe to transform updates (high-performance, no React re-renders)
  useEffect(() => {
    console.log('🔗 HudSurface: Subscribing to transform updates');
    
    const unsubscribe = subscribe(() => {
      console.log('📡 HudSurface: Transform update received via subscription');
      updateOverlayPosition(); // Direct DOM update on transform change
    });

    return () => {
      console.log('🔌 HudSurface: Unsubscribing from transform updates');
      unsubscribe();
    };
  }, [subscribe, updateOverlayPosition]);

  // React-based updates (only when selection changes)
  useEffect(() => {
    updateOverlayPosition();
  }, [updateOverlayPosition]);

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 1000 }}>
      {/* Single unified selection overlay */}
      <div
        ref={overlayRef}
        className="absolute pointer-events-none"
        style={{ display: 'none' }}
        data-testid="selection-overlay"
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
    </div>
  );
});

HudSurface.displayName = 'HudSurface';

export default HudSurface;