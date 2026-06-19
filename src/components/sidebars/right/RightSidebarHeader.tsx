// src/components/sidebars/right/RightSidebarHeader.tsx
// Header component for the right sidebar with component type tile + name + settings icon.
// 42px tall, sticky to the top of the panel.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Settings2, Type, Square, ImageIcon } from 'lucide-react';
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
 * RightSidebarHeader - 42px header with type tile (brand/12) + element name + settings icon.
 * MST wiring: reads editorUI.selectedComponent / editorUI.selectedViewportNode (observer).
 */
const RightSidebarHeader = observer(() => {
  const { editorUI } = useStore();
  const selectedComponent = editorUI.selectedComponent;
  const selectedViewportNode = editorUI.selectedViewportNode;

  const target = selectedComponent || selectedViewportNode;
  const title = target ? target.displayName : 'Properties';

  return (
    <div className="h-[42px] flex items-center justify-between px-3 border-b border-border shrink-0 sticky top-0 bg-background z-10">
      {/* Left: type tile + element name */}
      <div className="flex items-center gap-2 min-w-0">
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

      {/* Right: settings icon */}
      <button
        className="w-[28px] h-[28px] rounded-[6px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground flex-none"
        title="Settings"
      >
        <Settings2 size={15} />
      </button>
    </div>
  );
});

RightSidebarHeader.displayName = 'RightSidebarHeader';

export default RightSidebarHeader;
