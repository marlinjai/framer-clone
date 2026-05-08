// Single painter for the drop indicator.
//
// Replaces the mix of today's `#__drop-indicator-bar` (painted by
// ComponentRenderer's mouse-drag) and `data-drop-hover` outline (painted by
// ResponsivePageRenderer's HTML5-drag). Subscribes to DragManager via the
// observer wrapper and renders one of:
//
//   - a 3px horizontal bar flush to the target's top or bottom edge (before / after)
//   - a 2px outline on the target's full bounding box (inside)
//   - nothing (no active gesture, or target resolves to `floating` / `null`)
//
// Mounted once at the editor root alongside HudSurface.

'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { getDragManager } from '@/stores/RootStore';

const BAR_THICKNESS = 3;
const OUTLINE_THICKNESS = 2;
const COLOR = '#3b82f6';

const DropIndicatorLayer = observer(() => {
  const manager = getDragManager();
  const indicator = manager?.indicator ?? null;
  if (!indicator) return null;

  const { rect, kind } = indicator;

  if (kind === 'inside') {
    return (
      <div
        aria-hidden
        style={{
          position: 'fixed',
          pointerEvents: 'none',
          zIndex: 10000,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          outline: `${OUTLINE_THICKNESS}px solid ${COLOR}`,
          outlineOffset: `-${OUTLINE_THICKNESS}px`,
          borderRadius: 2,
        }}
      />
    );
  }

  const y = kind === 'before'
    ? rect.top - BAR_THICKNESS / 2
    : rect.bottom - BAR_THICKNESS / 2;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 10000,
        left: rect.left,
        top: y,
        width: rect.width,
        height: BAR_THICKNESS,
        background: COLOR,
        borderRadius: BAR_THICKNESS / 2,
      }}
    />
  );
});

DropIndicatorLayer.displayName = 'DropIndicatorLayer';

export default DropIndicatorLayer;
