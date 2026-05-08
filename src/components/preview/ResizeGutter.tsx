// Draggable gutter on either side of the preview frame. Reports width deltas
// up to PreviewShell, which clamps and applies them. ESC mid-drag rolls back
// to the start width.
'use client';
import React, { useCallback, useRef } from 'react';

export interface ResizeGutterProps {
  side: 'left' | 'right';
  // Called with the *target* width as the user drags. The shell is responsible
  // for clamping and committing.
  onResize: (nextWidth: number) => void;
  // The width at the moment the gesture begins. Captured by the gutter so a
  // single mouse-down + many moves don't accumulate floating-point drift.
  getStartWidth: () => number;
}

const SIDE_DELTA_SIGN = { left: -1, right: 1 } as const;

export default function ResizeGutter({ side, onResize, getStartWidth }: ResizeGutterProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startWidth = getStartWidth();
      dragRef.current = { startX: event.clientX, startWidth };

      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = 'ew-resize';
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';

      const handleMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const next = drag.startWidth + SIDE_DELTA_SIGN[side] * dx;
        onResize(next);
      };

      const cleanup = (revert: boolean) => {
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('keydown', handleKey);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        if (revert) {
          const drag = dragRef.current;
          if (drag) onResize(drag.startWidth);
        }
        dragRef.current = null;
      };

      const handleUp = () => cleanup(false);
      const handleKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup(true);
      };

      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleUp);
      document.addEventListener('keydown', handleKey);
    },
    [side, onResize, getStartWidth],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      data-resize-gutter={side}
      onMouseDown={onMouseDown}
      className="absolute top-0 bottom-0 w-1 bg-gray-700 hover:bg-blue-500 transition-colors cursor-ew-resize"
      style={{
        [side === 'left' ? 'right' : 'left']: '100%',
      }}
    />
  );
}
