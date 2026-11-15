// src/components/sidebars/right/RightSidebarHeader.tsx
// Header for the right properties panel. 42px tall, sticky.
//
// Two rendering modes:
//   Expanded: leading collapse chevron + type tile + element name + settings icon.
//             The tile's icon is the one the node's Layers row shows
//             (src/components/sidebars/layerIcon.ts). The page's root reads as
//             "Page" with its breakpoint, as the breakpoint row in Layers does.
//   Collapsed: only the expand chevron (centered in the 48px strip), matching the
//              left sidebar pattern so the user always has a way back.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Settings2, Square, ChevronRight, ChevronLeft } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FX_BACKGROUND_ICON, breakpointRefsOf, fxLayerIconOf, isPageBody, layerIconOf, viewportIconOf, type LayerIconBreakpoint } from '../layerIcon';
import { fxLayerKind } from '@/lib/fxScene/edit';
import { fxPickLabel } from '@/lib/layers/fxRows';

/**
 * RightSidebarHeader
 *
 * Expanded (rightSidebarCollapsed = false):
 *   [<] [tile + name]                  [settings]
 *
 * Collapsed (rightSidebarCollapsed = true):
 *   [>]   (full-height strip, centered, re-expands the panel)
 *
 * MST wiring: reads editorUI.rightSidebarCollapsed, selectedComponent,
 * selectedViewportNode; calls editorUI.toggleRightSidebar().
 */
const RightSidebarHeader = observer(({ variant = 'docked' }: { variant?: 'docked' | 'sheet' }) => {
  const { editorUI } = useStore();
  const isSheet = variant === 'sheet';
  // In a phone sheet the panel is always expanded and the sheet has its own close button.
  const isCollapsed = isSheet ? false : editorUI.rightSidebarCollapsed;
  const selectedComponent = editorUI.selectedComponent;
  const selectedViewportNode = editorUI.selectedViewportNode;

  const target: ComponentInstance | undefined = selectedComponent || selectedViewportNode || undefined;
  const page = editorUI.currentPage;
  const pageBody = isPageBody(selectedComponent ?? undefined, page, editorUI.inComponent);
  const title = pageBody ? 'Page' : target ? target.displayName : 'Properties';
  // The page body is styled per breakpoint: say which one the panel edits.
  const breakpointName = pageBody ? selectedViewportNode?.label : undefined;
  const at: LayerIconBreakpoint | undefined = selectedViewportNode?.breakpointId && page
    ? {
        breakpointId: selectedViewportNode.breakpointId,
        breakpoints: breakpointRefsOf(page),
      }
    : undefined;
  // A layer (or the Background row) of an FX scene is picked: the header names it, the crumb in the FX section leads back to the box.
  const fxPick = editorUI.fxLayerPick;
  const fxLabel = fxPick && target && fxPick.componentId === target.id ? fxPickLabel(target, fxPick) : null;
  const TileIcon = fxLabel
    ? (fxLabel.type ? fxLayerIconOf(fxLabel.type, fxLayerKind(fxLabel.type)) : FX_BACKGROUND_ICON)
    : pageBody
    ? viewportIconOf(selectedViewportNode?.label)
    : target ? layerIconOf(target, at) : Square;

  // Collapsed: render just the expand button so the user is never dead-ended.
  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center py-2 border-b border-border shrink-0">
        <button
          aria-label="Expand properties"
          onClick={() => editorUI.toggleRightSidebar()}
          className="w-[28px] h-[28px] rounded-[6px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <ChevronLeft size={16} />
        </button>
      </div>
    );
  }

  // Expanded: 42px header with collapse chevron + type tile + name + settings.
  return (
    <div className="h-[42px] flex items-center gap-1.5 px-2 border-b border-border shrink-0 sticky top-0 bg-background z-10">
      {/* Collapse toggle (docked only) */}
      {!isSheet && (
        <button
          aria-label="Collapse properties"
          onClick={() => editorUI.toggleRightSidebar()}
          className="w-[28px] h-[28px] rounded-[6px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand flex-none"
        >
          <ChevronRight size={16} />
        </button>
      )}

      {/* Type tile + element name (min-w-0 so name can truncate) */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {/* Type tile: 22x22, bg-brand/12, text-brand, radius 6 */}
        <span
          className="w-[22px] h-[22px] rounded-[6px] bg-brand/12 text-brand flex items-center justify-center flex-none"
        >
          <TileIcon size={13} />
        </span>

        {/* Element name: 13px, weight 600, truncate */}
        <span
          className="text-foreground truncate"
          style={{ fontSize: '13px', fontWeight: 600 }}
        >
          {fxLabel ? fxLabel.name : title}
        </span>
        {fxLabel && (
          <span className="text-muted-foreground truncate flex-none" style={{ fontSize: '12px' }}>
            {fxLabel.kind}
          </span>
        )}
        {!fxLabel && breakpointName && (
          <span className="text-muted-foreground truncate flex-none" style={{ fontSize: '12px' }}>
            {breakpointName}
          </span>
        )}
      </div>

      {/* Settings icon */}
      <button
        className="w-[28px] h-[28px] rounded-[6px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand flex-none"
        title="Settings"
      >
        <Settings2 size={15} />
      </button>
    </div>
  );
});

RightSidebarHeader.displayName = 'RightSidebarHeader';

export default RightSidebarHeader;
