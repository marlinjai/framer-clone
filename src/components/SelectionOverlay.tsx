// src/components/SelectionOverlay.tsx
// Visual selection indicator for selected components
'use client';
import React, { useRef, useEffect, useState } from 'react';
import { ComponentInstance } from '../models/ComponentModel';
import { observer } from 'mobx-react-lite';

interface SelectionOverlayProps {
  selectedComponent?: ComponentInstance;
  zoom: number;
  isVisible: boolean;
}

export default observer(({ 
  selectedComponent, 
  zoom, 
  isVisible 
}: SelectionOverlayProps) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const animationRef = useRef<number>(0);

  // Framer-style real-time overlay synchronization
  useEffect(() => {
    if (!selectedComponent || !isVisible) {
      setBounds(null);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = 0;
      }
      return;
    }

    // Real-time position tracking using animation frames
    const updateOverlayPosition = () => {
      const element = document.querySelector(`[data-component-id="${selectedComponent.id}"]`) as HTMLElement;
      
      if (element) {
        // Since canvas now fills entire viewport, getBoundingClientRect() works perfectly with absolute positioning
        const rect = element.getBoundingClientRect();
        setBounds(rect);
      }
      
      // Continue the animation loop for smooth real-time sync
      animationRef.current = requestAnimationFrame(updateOverlayPosition);
    };

    // Start the real-time sync loop
    animationRef.current = requestAnimationFrame(updateOverlayPosition);

    // Cleanup animation frame on unmount or dependency change
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = 0;
      }
    };
  }, [selectedComponent, isVisible]); // Simple viewport positioning - canvas fills entire viewport

  // Don't render if no selection or not visible
  if (!bounds || !selectedComponent || !isVisible) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      className="absolute pointer-events-none z-50"
      style={{
        left: bounds.left - 2,
        top: bounds.top - 2,
        width: bounds.width + 4,
        height: bounds.height + 4,
        border: '2px solid #3b82f6',
        borderRadius: '4px',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        boxShadow: '0 0 0 1px rgba(59, 130, 246, 0.2)',
      }}
    >
      {/* Selection handles for resize (future feature) */}
      <div className="absolute -top-1 -left-1 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute top-1/2 -left-1 transform -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute top-1/2 -right-1 transform -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute -bottom-1 -left-1 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-blue-500 rounded-full"></div>
      <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-blue-500 rounded-full"></div>

      {/* Component info label */}
      <div className="absolute -top-6 left-0 bg-blue-500 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
        {selectedComponent.type}#{selectedComponent.id}
      </div>
    </div>
  );
});
