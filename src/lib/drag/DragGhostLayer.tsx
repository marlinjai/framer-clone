// Ghost overlay. Renders a small pill with the source's label following the
// cursor while a ghost-mode gesture is active. Live-mode gestures (floating /
// viewport position drag) don't paint a ghost: the source element itself
// follows the cursor.
//
// v1 is deliberately plain: border + label. A later polish pass can upgrade to
// a DOM clone or rendered thumbnail of the source component. The manager
// exposes only a label string in its `ghost` view; upgrading won't require
// changing any consumer.

'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { getDragManager } from '@/stores/RootStore';

const OFFSET_X = 12;
const OFFSET_Y = 12;

const DragGhostLayer = observer(() => {
  const manager = getDragManager();
  if (!manager) return null;
  const ghost = manager.ghost;
  const pointer = manager.currentPointer;
  if (!ghost || !pointer) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 10001,
        left: pointer.x + OFFSET_X,
        top: pointer.y + OFFSET_Y,
        background: 'rgba(255,255,255,0.95)',
        border: '1px solid #d1d5db',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontFamily: 'Inter, system-ui, sans-serif',
        color: '#111827',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        whiteSpace: 'nowrap',
      }}
    >
      {ghost.label}
    </div>
  );
});

DragGhostLayer.displayName = 'DragGhostLayer';

export default DragGhostLayer;
