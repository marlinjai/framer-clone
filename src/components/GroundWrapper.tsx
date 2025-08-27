// src/components/GroundWrapper.tsx
// Individual positioning wrapper for canvas elements (mimics Framer's groundNodeWrapper)
'use client';
import React, { forwardRef } from 'react';
import { observer } from 'mobx-react-lite';

interface GroundWrapperProps {
  // Unique identifier for the wrapper
  id: string;
  
  // Position in canvas space
  x: number;
  y: number;
  
  // Scale factor (1.0 = normal)
  scale?: number;
  
  // Rotation in degrees
  rotation?: number;
  
  // Z-index for layering
  zIndex?: number;
  
  // Dimensions (for optimization)
  width?: number;
  height?: number;
  
  // Additional CSS classes
  className?: string;
  
  // Children to render inside the wrapper
  children: React.ReactNode;
  
  // Click handler
  onClick?: (e: React.MouseEvent) => void;
  
  // Mouse down handler for drag operations
  onMouseDown?: (e: React.MouseEvent) => void;
  
  // Visibility
  visible?: boolean;
}

/**
 * GroundWrapper - Individual positioning wrapper for canvas elements
 * 
 * This component replicates Framer's groundNodeWrapper approach where each
 * element on the canvas has its own positioning wrapper with independent
 * transform state, rather than using a single camera transform.
 * 
 * Key features:
 * - Independent positioning via CSS transforms
 * - GPU-optimized with will-change and isolation
 * - Supports position, scale, rotation, and z-index
 * - Optimized for performance with direct style application
 */
const GroundWrapper = observer(forwardRef<HTMLDivElement, GroundWrapperProps>(function GroundWrapper({
  id,
  x,
  y,
  scale = 1,
  rotation = 0,
  zIndex = 0,
  width = 100,
  height = 100,
  className = '',
  children,
  onClick,
  onMouseDown,
  visible = true,
}, ref) {
  // Build CSS transform string
  const transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`;
  
  // Build inline styles for maximum performance
  const style: React.CSSProperties = {
    position: 'fixed', // Absolute positioning within camera space
    top: 0,
    left: 0,
    transform,
    transformOrigin: 'left top',
    willChange: 'transform', // GPU optimization
    isolation: 'isolate', // Create stacking context
    contain: 'layout style', // Performance optimization
    zIndex,
    display: visible ? 'block' : 'none',
    // Explicit dimensions - critical for proper sizing (like Framer)
    width: width ? `${width}px` : 'auto',
    height: height ? `${height}px` : 'auto',
    // Prevent default drag behaviors on images and other elements
    userSelect: 'none',
    WebkitUserSelect: 'none',
    MozUserSelect: 'none',
    msUserSelect: 'none',
  };

  return (
    <div
      ref={ref}
      id={`ground-wrapper-${id}`}
      className={`ground-wrapper ${className}`}
      style={style}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onDragStart={(e) => e.preventDefault()} // Prevent default image drag
      data-ground-wrapper-id={id}
    >
      {/* Inner container with potential scaling compensation */}
      <div
        id={`ground-inner-${id}`}
        className="ground-inner"
        style={{
          transformOrigin: 'left top',
          // Apply inverse scale for text/content if needed
          // transform: scale !== 1 ? `scale(${1 / scale})` : undefined,
          width: '100%',
          height: '100%',
          overflow: 'visible', // Ensure content isn't clipped
          // Prevent default behaviors on all child elements
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
        }}
        onDragStart={(e) => e.preventDefault()} // Prevent default drag on child elements
      >
        {children}
      </div>
    </div>
  );
}));

export default GroundWrapper;
