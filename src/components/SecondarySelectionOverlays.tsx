// src/components/SecondarySelectionOverlays.tsx
// Lightweight highlight overlays for the same selected component in OTHER breakpoints
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { BreakpointType } from '@/models/BreakpointModel';
import { useStore } from '@/hooks/useStore';

interface SecondarySelectionOverlaysProps {
  isVisible: boolean;
}

interface Box {
  left: number; top: number; width: number; height: number; breakpoint: BreakpointType;
}

const SecondarySelectionOverlays = observer(({ isVisible }: SecondarySelectionOverlaysProps) => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const rafRef = useRef<number>(0);
  const rootStore = useStore();
  const primaryBreakpoint = rootStore.editorUI.currentBreakpoint; // may be undefined
  const breakpointMap = rootStore.editorUI.currentProject?.breakpoints; // MST map
  const selectedComponent = rootStore.editorUI.selectedComponent;

  useEffect(() => {
    if (!selectedComponent || !isVisible) {
      setBoxes([]);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

  if (!breakpointMap || !primaryBreakpoint) return;

  // Convert MST map to array of breakpoint instances
  const allBreakpoints: BreakpointType[] = Array.from(breakpointMap.values());
  // Exclude the primary breakpoint (compare by id)
  const secondary: BreakpointType[] = allBreakpoints.filter(bp => bp.id !== primaryBreakpoint.id);
  if (secondary.length === 0) return;

    const update = () => {
      const next: Box[] = [];
      for (const bp of secondary) {
        const domId = `${bp.id}-${selectedComponent.id}`;
        const el = document.querySelector<HTMLElement>(`[data-component-id="${domId}"]`);
        if (el) {
          const rect = el.getBoundingClientRect();
          next.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, breakpoint: bp });
        }
      }
      setBoxes(next);
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [selectedComponent, primaryBreakpoint, breakpointMap, isVisible]);

  if (!isVisible || !selectedComponent) return null;

  return (
    <>
      {boxes.map(box => (
        <div
          key={box.breakpoint.id}
          className="absolute pointer-events-none z-40"
          style={{
            left: box.left - 1,
            top: box.top - 1,
            width: box.width + 2,
            height: box.height + 2,
            border: '2px solid rgba(59,130,246,0.3)',
            borderRadius: 4,
          }}
        >
        </div>
      ))}
    </>
  );
});

SecondarySelectionOverlays.displayName = 'SecondarySelectionOverlays';
export default SecondarySelectionOverlays;
