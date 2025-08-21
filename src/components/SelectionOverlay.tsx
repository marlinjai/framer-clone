// src/components/SelectionOverlay.tsx
// Visual selection indicator for selected components
'use client';
import React, { useRef, useEffect, useState } from 'react';
import { ComponentInstance } from '../models/ComponentModel';

interface SelectionOverlayProps {
  selectedComponent?: ComponentInstance;
  zoom: number;
  isVisible: boolean;
}

export default function SelectionOverlay({ 
  selectedComponent, 
  zoom, 
  isVisible 
}: SelectionOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);

  // Update overlay position when selection changes
  useEffect(() => {
    if (!selectedComponent || !isVisible) {
      setBounds(null);
      return;
    }

    // Find the DOM element for the selected component
    const element = document.querySelector(`[data-component-id="${selectedComponent.id}"]`) as HTMLElement;
    
    if (element) {
      const rect = element.getBoundingClientRect();
      setBounds(rect);
    }
  }, [selectedComponent, zoom, isVisible]);

  // Don't render if no selection or not visible
  if (!bounds || !selectedComponent || !isVisible) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      className="fixed pointer-events-none z-50"
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
}
