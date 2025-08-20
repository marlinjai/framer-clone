// src/components/Canvas.tsx - High-performance infinite canvas with optimized zoom and pan
'use client';
import React, { useRef, useCallback, useEffect, useState } from 'react';

interface CanvasState {
  zoom: number;
  panX: number;
  panY: number;
}

export default function Canvas() {
  // Performance-optimized refs for direct DOM manipulation
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const animationRef = useRef<number>(0);
  
  // Current transform state (for direct DOM updates)
  const transformState = useRef<CanvasState>({
    zoom: 1,
    panX: 0,
    panY: 0,
  });

  // React state for UI updates only (throttled)
  const [displayState, setDisplayState] = useState<CanvasState>({
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

  // Throttled state update for UI display
  const updateDisplayState = useCallback(() => {
    if (animationRef.current) return;
    
    animationRef.current = requestAnimationFrame(() => {
      setDisplayState({ ...transformState.current });
      animationRef.current = 0;
    });
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
    updateDisplayState();
  }, [applyTransform, updateDisplayState]);

  // Handle mouse down - start dragging
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    
    // Change cursor to grabbing
    if (canvasRef.current) {
      canvasRef.current.style.cursor = 'grabbing';
    }
  }, []);

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
    updateDisplayState();

    lastMousePos.current = { x: e.clientX, y: e.clientY };
  }, [applyTransform, updateDisplayState]);

  // Handle mouse up - stop dragging
  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    
    // Reset cursor
    if (canvasRef.current) {
      canvasRef.current.style.cursor = 'grab';
    }
  }, []);

  // Setup native event listeners and cleanup on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    
    const handleGlobalMouseUp = () => {
      isDragging.current = false;
      if (canvasRef.current) {
        canvasRef.current.style.cursor = 'grab';
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
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [handleWheel]);

  return (
    <main className="flex-1 p-8 flex items-center justify-center">
      <div className="w-full h-full bg-white border-2 border-dashed border-gray-400 rounded-lg overflow-hidden relative">
        {/* Canvas viewport */}
        <div
          ref={canvasRef}
          className="w-full h-full cursor-grab select-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {/* Transformed canvas content - anchored at top-left to avoid pivot drift */}
          <div
            ref={contentRef}
            className="w-full h-full origin-top-left"
            style={{
              transform: `translate(${transformState.current.panX}px, ${transformState.current.panY}px) scale(${transformState.current.zoom})`,
              willChange: 'transform',
            }}
          >
            {/* Grid background for infinite canvas feel */}
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage: `
                  linear-gradient(to right, #e5e7eb 1px, transparent 1px),
                  linear-gradient(to bottom, #e5e7eb 1px, transparent 1px)
                `,
                backgroundSize: '20px 20px',
              }}
            />
            
            {/* Responsive Breakpoint Frames - Framer style */}
            
            {/* Mobile Frame - iPhone 14 Pro (393x852) */}
            <div className="absolute" style={{ left: '200px', top: '100px' }}>
              <div className="relative">
                {/* Frame Label */}
                <div className="absolute -top-8 left-0 text-sm font-medium text-gray-600">
                  Mobile • 393×852
                </div>
                {/* Device Frame */}
                <div className="bg-gray-900 rounded-[2.5rem] p-2 shadow-2xl">
                  <div className="bg-white rounded-[2rem] overflow-hidden" style={{ width: '393px', height: '852px' }}>
                    {/* Status Bar */}
                    <div className="bg-gray-50 h-12 flex items-center justify-between px-6 text-sm">
                      <span className="font-medium">9:41</span>
                      <div className="flex space-x-1">
                        <div className="w-4 h-2 bg-gray-300 rounded-sm"></div>
                        <div className="w-6 h-2 bg-green-500 rounded-sm"></div>
                      </div>
                    </div>
                    {/* Content Area */}
                    <div className="p-6 bg-gradient-to-b from-blue-50 to-white h-full">
                      <div className="space-y-4">
                        <div className="h-8 bg-gray-200 rounded w-48"></div>
                        <div className="h-4 bg-gray-100 rounded w-32"></div>
                        <div className="h-32 bg-gray-100 rounded"></div>
                        <div className="space-y-2">
                          <div className="h-3 bg-gray-100 rounded w-full"></div>
                          <div className="h-3 bg-gray-100 rounded w-3/4"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Tablet Frame - iPad (768x1024) */}
            <div className="absolute" style={{ left: '700px', top: '50px' }}>
              <div className="relative">
                {/* Frame Label */}
                <div className="absolute -top-8 left-0 text-sm font-medium text-gray-600">
                  Tablet • 768×1024
                </div>
                {/* Device Frame */}
                <div className="bg-gray-800 rounded-3xl p-4 shadow-2xl">
                  <div className="bg-white rounded-2xl overflow-hidden" style={{ width: '768px', height: '1024px' }}>
                    {/* Header */}
                    <div className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-8">
                      <div className="h-6 bg-gray-200 rounded w-32"></div>
                      <div className="flex space-x-4">
                        <div className="h-6 bg-gray-100 rounded w-16"></div>
                        <div className="h-6 bg-blue-500 rounded w-20"></div>
                      </div>
                    </div>
                    {/* Content Grid */}
                    <div className="p-8 bg-gray-50 h-full">
                      <div className="grid grid-cols-2 gap-6 h-full">
                        <div className="space-y-6">
                          <div className="h-12 bg-white rounded-lg shadow-sm"></div>
                          <div className="h-48 bg-white rounded-lg shadow-sm"></div>
                          <div className="h-32 bg-white rounded-lg shadow-sm"></div>
                        </div>
                        <div className="space-y-6">
                          <div className="h-32 bg-white rounded-lg shadow-sm"></div>
                          <div className="h-48 bg-white rounded-lg shadow-sm"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Desktop Frame - Large Desktop (1440x900) */}
            <div className="absolute" style={{ left: '1600px', top: '200px' }}>
              <div className="relative">
                {/* Frame Label */}
                <div className="absolute -top-8 left-0 text-sm font-medium text-gray-600">
                  Desktop • 1440×900
                </div>
                {/* Browser Frame */}
                <div className="bg-gray-200 rounded-t-lg shadow-2xl" style={{ width: '1440px' }}>
                  {/* Browser Chrome */}
                  <div className="bg-gray-100 rounded-t-lg p-3 border-b border-gray-300">
                    <div className="flex items-center space-x-2">
                      <div className="flex space-x-2">
                        <div className="w-3 h-3 bg-red-400 rounded-full"></div>
                        <div className="w-3 h-3 bg-yellow-400 rounded-full"></div>
                        <div className="w-3 h-3 bg-green-400 rounded-full"></div>
                      </div>
                      <div className="flex-1 mx-4">
                        <div className="bg-white rounded border px-3 py-1 text-xs text-gray-500">
                          https://myapp.com
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Content */}
                  <div className="bg-white overflow-hidden" style={{ height: '900px' }}>
                    {/* Navigation */}
                    <div className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-12">
                      <div className="h-8 bg-gray-200 rounded w-48"></div>
                      <div className="flex space-x-6">
                        <div className="h-6 bg-gray-100 rounded w-16"></div>
                        <div className="h-6 bg-gray-100 rounded w-16"></div>
                        <div className="h-6 bg-gray-100 rounded w-16"></div>
                        <div className="h-6 bg-blue-500 rounded w-24"></div>
                      </div>
                    </div>
                    {/* Hero Section */}
                    <div className="bg-gradient-to-r from-blue-50 to-purple-50 px-12 py-16">
                      <div className="max-w-4xl">
                        <div className="h-16 bg-gray-200 rounded w-96 mb-6"></div>
                        <div className="space-y-3 mb-8">
                          <div className="h-4 bg-gray-100 rounded w-full"></div>
                          <div className="h-4 bg-gray-100 rounded w-5/6"></div>
                          <div className="h-4 bg-gray-100 rounded w-4/6"></div>
                        </div>
                        <div className="flex space-x-4">
                          <div className="h-12 bg-blue-500 rounded w-32"></div>
                          <div className="h-12 bg-gray-200 rounded w-32"></div>
                        </div>
                      </div>
                    </div>
                    {/* Content Sections */}
                    <div className="px-12 py-16 space-y-16">
                      <div className="grid grid-cols-3 gap-8">
                        <div className="h-64 bg-gray-100 rounded-lg"></div>
                        <div className="h-64 bg-gray-100 rounded-lg"></div>
                        <div className="h-64 bg-gray-100 rounded-lg"></div>
                      </div>
                      <div className="grid grid-cols-2 gap-12">
                        <div className="space-y-4">
                          <div className="h-8 bg-gray-200 rounded w-48"></div>
                          <div className="space-y-2">
                            <div className="h-4 bg-gray-100 rounded"></div>
                            <div className="h-4 bg-gray-100 rounded w-5/6"></div>
                            <div className="h-4 bg-gray-100 rounded w-4/6"></div>
                          </div>
                        </div>
                        <div className="h-48 bg-gray-100 rounded-lg"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Canvas controls overlay - uses throttled display state */}
        <div className="absolute top-4 left-4 bg-white rounded-lg shadow-md p-3 text-sm text-gray-600">
          <div>Zoom: {(displayState.zoom * 100).toFixed(0)}%</div>
          <div>Pan: {displayState.panX.toFixed(0)}, {displayState.panY.toFixed(0)}</div>
          <div className="text-xs text-gray-400 mt-1">
            Scroll: pan | ⌘+Scroll: zoom | Drag: pan
          </div>
        </div>
      </div>
    </main>
  );
}
