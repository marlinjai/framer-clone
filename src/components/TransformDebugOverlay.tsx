// src/components/TransformDebugOverlay.tsx
// Debug overlay to verify transform subscription is working
'use client';
import React, { useRef, useEffect } from 'react';
import { useTransformContext } from '@/contexts/TransformContext';

const TransformDebugOverlay: React.FC = () => {
  const { state: transformState, subscribe } = useTransformContext();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    console.log('🧪 TransformDebugOverlay: Setting up subscription');
    
    const updateDebugOverlay = () => {
      if (overlayRef.current) {
        const { panX, panY, zoom } = transformState.current;
        console.log('🧪 TransformDebugOverlay: Transform update', { panX, panY, zoom });
        
        // Simple overlay that follows pan (but not zoom for readability)
        overlayRef.current.style.transform = `translate(${panX + 100}px, ${panY + 100}px)`;
        overlayRef.current.innerHTML = `
          <div style="background: rgba(255,0,0,0.8); color: white; padding: 8px; border-radius: 4px; font-size: 12px;">
            Pan: ${panX.toFixed(1)}, ${panY.toFixed(1)}<br/>
            Zoom: ${zoom.toFixed(2)}
          </div>
        `;
      }
    };

    // Initial update
    updateDebugOverlay();

    // Subscribe to changes
    const unsubscribe = subscribe(updateDebugOverlay);

    return unsubscribe;
  }, [subscribe, transformState]);

  return (
    <div 
      ref={overlayRef}
      className="fixed top-0 left-0 pointer-events-none z-[9999]"
      style={{ transform: 'translate(100px, 100px)' }}
    />
  );
};

export default TransformDebugOverlay;
