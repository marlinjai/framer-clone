// src/components/sidebars/right/RightSidebarHeader.tsx
// Header for the right properties panel. 42px tall, sticky.
//
// Two rendering modes:
//   Expanded: leading collapse chevron + type tile + element name + settings icon.
//   Collapsed: only the expand chevron (centered in the 48px strip), matching the
//              left sidebar pattern so the user always has a way back.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Settings2, Type, Square, ImageIcon, ChevronRight, ChevronLeft } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';

/** Pick an icon for the selected element's type. */
function ElementTypeIcon({ component }: { component: ComponentInstance }) {
  switch (component.type) {
    case 'img': return <ImageIcon size={13} />;
    case 'button': return <Square size={13} />;
    default: return <Type size={13} />;
  }
}

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
const RightSidebarHeader = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.rightSidebarCollapsed;
  const selectedComponent = editorUI.selectedComponent;
  const selectedViewportNode = editorUI.selectedViewportNode;

  const target = selectedComponent || selectedViewportNode;
  const title = target ? target.displayName : 'Properties';

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
      {/* Collapse toggle */}
      <button
        aria-label="Collapse properties"
        onClick={() => editorUI.toggleRightSidebar()}
        className="w-[28px] h-[28px] rounded-[6px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand flex-none"
      >
        <ChevronRight size={16} />
      </button>

      {/* Type tile + element name (min-w-0 so name can truncate) */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {/* Type tile: 22x22, bg-brand/12, text-brand, radius 6 */}
        <span
          className="w-[22px] h-[22px] rounded-[6px] bg-brand/12 text-brand flex items-center justify-center flex-none"
        >
          {target ? (
            <ElementTypeIcon component={target} />
          ) : (
            <Square size={13} />
          )}
        </span>

        {/* Element name: 13px, weight 600, truncate */}
        <span
          className="text-foreground truncate"
          style={{ fontSize: '13px', fontWeight: 600 }}
        >
          {title}
        </span>
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
