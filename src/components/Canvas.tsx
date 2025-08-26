// src/components/Canvas.tsx - High-performance infinite canvas with optimized zoom and pan
'use client';
import React, { useRef, useCallback, useEffect } from 'react';
import ResponsivePageRenderer from './ResponsivePageRenderer';
import CanvasDebugPanel from './CanvasDebugPanel';
import Toolbar from './Toolbar';
import { useTransformContext, useTransformNotifier } from '@/contexts/TransformContext';
// HudSurface is now imported in EditorApp
import { EditorTool } from '../stores/EditorUIStore';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';

// Interface removed - now using TransformContext


// Inner Canvas component that uses TransformContext
const CanvasInner = observer(() => {
  // Performance-optimized refs for direct DOM manipulation
  // ground wrapper (fills viewport, hosts grid & overlays, NOT transformed)
  const groundRef = useRef<HTMLDivElement>(null);
  // camera wrapper (only transformed element containing page trees)
  const cameraRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const rootStore = useStore();

  // Get transform state and notifier from context
  const { state: transformState } = useTransformContext();
  const notifySubscribers = useTransformNotifier();

  /**
   * Apply transform to canvas camera element and notify subscribers
   * 
   * This is the core function that:
   * 1. Reads current transform state from context ref
   * 2. Applies CSS transform directly to DOM (bypassing React)
   * 3. Updates data attribute for external debugging
   * 4. Notifies all subscribers (HudSurface, etc.) via context
   * 
   * Performance optimizations:
   * - Direct DOM manipulation (no React re-render)
   * - String interpolation (faster than template literals in loops)
   * - Single transform application (not separate translate/scale)
   * - Cached callback with stable dependencies
   */
  const applyTransform = useCallback(() => {
    if (cameraRef.current) {
      const { zoom, panX, panY } = transformState.current;
      
      // Direct CSS transform application - fastest approach for real-time updates
      // Format: translate(x, y) scale(z) - order matters for proper transformation
      const transformString = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      cameraRef.current.style.transform = transformString;
      
      // Update data attribute for external debugging and HudSurface compatibility
      cameraRef.current.setAttribute('data-camera-transform', `${panX},${panY},${zoom}`);
      
      // Debug logging for transform state (disabled for production performance)
      // console.log('🎯 Canvas Transform Applied:', {
      //   panX: panX.toFixed(2),
      //   panY: panY.toFixed(2), 
      //   zoom: zoom.toFixed(3),
      //   transformString,
      //   cameraElement: cameraRef.current,
      //   cameraRect: cameraRef.current.getBoundingClientRect()
      // });
      
      // Notify all subscribers (HudSurface, debug overlays, etc.)
      // This triggers direct DOM updates in subscribed components
      notifySubscribers();
    }
  }, [notifySubscribers, transformState]);

  // Handle mouse wheel - pan by default, zoom with Command key
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    
  if (!groundRef.current) return;
    
    // Check if Command key is pressed (metaKey on Mac, ctrlKey on Windows/Linux)
    const isZoomModifier = e.metaKey || e.ctrlKey;
    
    if (isZoomModifier) {
      // ZOOM MODE: Stack Overflow proven cursor-centered zoom algorithm
  const rect = groundRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      // Zoom factor (like the Stack Overflow example)
      const scaleFactor = 1.1;
      const zoomDirection = e.deltaY > 0 ? -1 : 1;
      const factor = Math.pow(scaleFactor, zoomDirection);
      const newZoom = Math.max(0.1, Math.min(5, transformState.current.zoom * factor));
      
      // Get current state
      const { zoom: currentZoom, panX: currentPanX, panY: currentPanY } = transformState.current;
      
      // Stack Overflow algorithm: translate → scale → translate back
      // Step 1: Convert mouse position to world coordinates
      const worldX = (mouseX - currentPanX) / currentZoom;
      const worldY = (mouseY - currentPanY) / currentZoom;
      
      // Step 2: Apply the zoom transformation around the world point
      // This is equivalent to: translate(worldX, worldY) → scale(factor) → translate(-worldX, -worldY)
      const newPanX = mouseX - worldX * newZoom;
      const newPanY = mouseY - worldY * newZoom;
      
      // Update transform state
      transformState.current.zoom = newZoom;
      transformState.current.panX = newPanX;
      transformState.current.panY = newPanY;
    } else {
      // PAN MODE: Regular scroll = pan canvas
      const panFactor = 1.0;
      const deltaX = e.deltaX * panFactor;
      const deltaY = e.deltaY * panFactor;
      
      // Update pan position directly
      transformState.current.panX -= deltaX;
      transformState.current.panY -= deltaY;
    }
    
    // Apply transform immediately
    applyTransform();
    
    // Note: UI elements that need transform state will read directly from transformState.current
  }, [applyTransform, transformState]);

  // Handle mouse down - start dragging (only for GRAB tool)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only handle canvas dragging for GRAB tool
    if (rootStore.editorUI.selectedTool !== EditorTool.GRAB) {
      return;
    }
    
    isDragging.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    
    // Change cursor to grabbing
    if (groundRef.current) {
      groundRef.current.style.cursor = 'grabbing';
    }
  }, [rootStore.editorUI.selectedTool]);

  // High-performance mouse move with direct DOM updates
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;

    const deltaX = e.clientX - lastMousePos.current.x;
    const deltaY = e.clientY - lastMousePos.current.y;

    // Update transform state directly (no React re-render)
    transformState.current.panX += deltaX;
    transformState.current.panY += deltaY;

    // Apply transform immediately
    applyTransform();

    lastMousePos.current = { x: e.clientX, y: e.clientY };
  }, [applyTransform, transformState]); 

  // Handle mouse up - stop dragging
  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    
    // Reset cursor based on current tool
    if (groundRef.current) {
      const cursor = rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : 'default';
      groundRef.current.style.cursor = cursor;
    }
  }, [rootStore.editorUI.selectedTool]);

  // Setup native event listeners and cleanup on unmount
  useEffect(() => {
  const ground = groundRef.current;
    
    const handleGlobalMouseUp = () => {
      isDragging.current = false;
      if (groundRef.current) {
        const cursor = rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : 'default';
        groundRef.current.style.cursor = cursor;
      }
    };

    // Add native wheel event listener with non-passive option
    if (ground) {
      ground.addEventListener('wheel', handleWheel, { passive: false });
    }

    document.addEventListener('mouseup', handleGlobalMouseUp);
    
    return () => {
      // Cleanup event listeners
      if (ground) {
        ground.removeEventListener('wheel', handleWheel);
      }
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [handleWheel, rootStore.editorUI.selectedTool]);

  // Update cursor when tool changes
  useEffect(() => {
    if (groundRef.current) {
      const cursor = rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : 'default';
      groundRef.current.style.cursor = cursor;
    }
  }, [rootStore.editorUI.selectedTool]);



  // Don't render if no page is selected
  if (!rootStore.editorUI.currentPage) {
    return (
      <main className="flex-1 p-8 flex items-center justify-center">
        <div className="text-gray-500 text-center">
          <div className="text-lg font-medium">No page selected</div>
          <div className="text-sm">Create a project to start designing</div>
        </div>
      </main>
    );
  }

  return (
    <main className="w-screen h-screen bg-gray-100 relative">
      <div className="w-full h-full bg-gray-100 overflow-hidden relative">
        {/* Canvas viewport */}
        <div
          ref={groundRef}
          className={`w-full h-full select-none ${rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'cursor-grab' : 'cursor-default'} relative overflow-hidden`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {/* Fixed grid background - stays in viewport, doesn't transform */}
          <div
            className="absolute inset-0 opacity-40 pointer-events-none"
            style={{
              backgroundImage: `
                linear-gradient(to right, #e5e7eb 1px, transparent 1px),
                linear-gradient(to bottom, #e5e7eb 1px, transparent 1px)
              `,
              backgroundSize: '20px 20px',
            }}
          />
          
          {/* Camera (transform wrapper) only element that pans/zooms */}
          <div
            ref={cameraRef}
            className="absolute top-0 left-0 w-0 h-0 origin-top-left will-change-transform"
            style={{ transform: `translate(${transformState.current.panX}px, ${transformState.current.panY}px) scale(${transformState.current.zoom})` }}
            data-camera-transform={`${transformState.current.panX},${transformState.current.panY},${transformState.current.zoom}`}
          >
            {/* Page root(s) */}
            <ResponsivePageRenderer  />
          </div>

          {/* Note: Overlays now handled by HudSurface outside this container */}
        </div>
        
        {/* Canvas controls info */}
        <div className="absolute top-24 left-24 bg-white rounded-lg shadow-md p-3 text-sm text-gray-600">
          <div className="text-xs text-gray-400">
            Scroll: pan | ⌘+Scroll: zoom | Drag: pan
          </div>
        </div>

        {/* Debug panel */}
        {/* <CanvasDebugPanel /> */}
        
        {/* Toolbar */}
        <Toolbar editorUI={rootStore.editorUI} />
      </div>
    </main>
  );
});

// Main Canvas component (TransformProvider now in EditorApp)
const Canvas = observer(() => {
  return <CanvasInner />;
});

Canvas.displayName = 'Canvas';

export default Canvas;
