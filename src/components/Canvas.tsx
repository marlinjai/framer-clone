// src/components/Canvas.tsx - High-performance infinite canvas with optimized zoom and pan
'use client';
import React, { useRef, useCallback, useEffect } from 'react';
import ResponsivePageRenderer from './ResponsivePageRenderer';
import Toolbar from './Toolbar';
import { EditorTool } from '../stores/EditorUIStore';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';

interface CanvasState {
  zoom: number;
  panX: number;
  panY: number;
}


const Canvas = observer(() => {
  // Performance-optimized refs for direct DOM manipulation
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const rootStore = useStore();

  // Current transform state (for direct DOM updates)
  const transformState = useRef<CanvasState>({
    zoom: 1,
    panX: 0,
    panY: 0,
  });

  // Fastest possible approach - direct string interpolation
  const applyTransform = useCallback(() => {
    if (contentRef.current) {
      const { zoom, panX, panY } = transformState.current;
      
      // Direct string creation - fastest approach
      contentRef.current.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }
  }, []);

  // Handle mouse wheel - pan by default, zoom with Command key
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    
    if (!canvasRef.current) return;
    
    // Check if Command key is pressed (metaKey on Mac, ctrlKey on Windows/Linux)
    const isZoomModifier = e.metaKey || e.ctrlKey;
    
    if (isZoomModifier) {
      // ZOOM MODE: Stack Overflow proven cursor-centered zoom algorithm
      const rect = canvasRef.current.getBoundingClientRect();
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
      transformState.current = {
        zoom: newZoom,
        panX: newPanX,
        panY: newPanY,
      };
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
  }, [applyTransform]);

  // Handle mouse down - start dragging (only for GRAB tool)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only handle canvas dragging for GRAB tool
    if (rootStore.editorUI.selectedTool !== EditorTool.GRAB) {
      return;
    }
    
    isDragging.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    
    // Change cursor to grabbing
    if (canvasRef.current) {
      canvasRef.current.style.cursor = 'grabbing';
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
  }, [applyTransform]); 

  // Handle mouse up - stop dragging
  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    
    // Reset cursor based on current tool
    if (canvasRef.current) {
      const cursor = rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : 'default';
      canvasRef.current.style.cursor = cursor;
    }
  }, [rootStore.editorUI.selectedTool]);

  // Setup native event listeners and cleanup on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    
    const handleGlobalMouseUp = () => {
      isDragging.current = false;
      if (canvasRef.current) {
        const cursor = rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : 'default';
        canvasRef.current.style.cursor = cursor;
      }
    };

    // Add native wheel event listener with non-passive option
    if (canvas) {
      canvas.addEventListener('wheel', handleWheel, { passive: false });
    }

    document.addEventListener('mouseup', handleGlobalMouseUp);
    
    return () => {
      // Cleanup event listeners
      if (canvas) {
        canvas.removeEventListener('wheel', handleWheel);
      }
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [handleWheel, rootStore.editorUI.selectedTool]);

  // Update cursor when tool changes
  useEffect(() => {
    if (canvasRef.current) {
      const cursor = rootStore.editorUI.selectedTool === EditorTool.GRAB ? 'grab' : 'default';
      canvasRef.current.style.cursor = cursor;
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
          ref={canvasRef}
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
          
          {/* Transformed canvas content - anchored at top-left to avoid pivot drift */}
          <div
            ref={contentRef}
            className="w-0 h-0 origin-top-left"
            style={{
              transform: `translate(${transformState.current.panX}px, ${transformState.current.panY}px) scale(${transformState.current.zoom})`,
              willChange: 'transform',
            }}
          >
            <ResponsivePageRenderer 
              page={rootStore.editorUI.currentPage}
            />
          </div>
        </div>
        
        {/* Canvas controls info */}
        <div className="absolute top-24 left-24 bg-white rounded-lg shadow-md p-3 text-sm text-gray-600">
          <div className="text-xs text-gray-400">
            Scroll: pan | ⌘+Scroll: zoom | Drag: pan
          </div>
        </div>
        
        {/* Primary selection overlay 
        <SelectionOverlay 
          selectedComponent={rootStore.editorUI.selectedComponent}
          isVisible={rootStore.editorUI.selectedTool === EditorTool.SELECT && !!rootStore.editorUI.selectedComponent}
        />
        */}
        {/* Secondary (faded) overlays in other breakpoints 
        <SecondarySelectionOverlays
          isVisible={rootStore.editorUI.selectedTool === EditorTool.SELECT && !!rootStore.editorUI.selectedComponent}
        />
        */} 
        {/* Toolbar */}
        <Toolbar editorUI={rootStore.editorUI} />
      </div>
    </main>
  );
});

export default Canvas;
