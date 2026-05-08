// useDragSource: turn any element into a drag source by attaching a pointerdown
// handler that hands off to DragManager.begin.
//
// Usage:
//   const { onPointerDown } = useDragSource(
//     { kind: 'moveNode', nodeId: component.id },
//     component
//   );
//   <div onPointerDown={onPointerDown}>...</div>
//
// `source === null` returns a no-op handler, so callers can toggle without
// branching on the element.
//
// Phase A note: no entry point calls this hook yet. Phase B replaces HTML5
// drag + mouse-based drag call sites with it.

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { getDragManager } from '@/stores/RootStore';
import type { DragSource } from './types';

export interface UseDragSourceResult {
  onPointerDown: (event: React.PointerEvent) => void;
}

export function useDragSource(
  source: DragSource | null,
  sourceNode?: ComponentInstance,
): UseDragSourceResult {
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent) => {
      if (!source) return;
      const manager = getDragManager();
      if (!manager) return;
      manager.begin(source, event, sourceNode);
    },
    [source, sourceNode],
  );
  return { onPointerDown };
}
