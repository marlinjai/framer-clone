// src/components/sidebars/right/RightSidebarHeader.tsx
// Header component for the right sidebar with collapse toggle
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';

/**
 * RightSidebarHeader - Header with dynamic title from component displayName
 */
const RightSidebarHeader = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.rightSidebarCollapsed;
  const selectedComponent = editorUI.selectedComponent;
  const selectedViewportNode = editorUI.selectedViewportNode;

  const target = selectedComponent || selectedViewportNode;
  const title = target ? target.displayName : 'Properties';

  return (
    <div className="h-12 flex items-center justify-between px-3 border-b border-gray-200 shrink-0">
      {/* Collapse Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => editorUI.toggleRightSidebar()}
        className="p-1 hover:bg-gray-100"
      >
        {isCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </Button>

      {/* Title */}
      {!isCollapsed && (
        <div className="flex items-center space-x-2">
          <span className="font-medium text-gray-900 text-sm truncate max-w-[140px]">
            {title}
          </span>
          <Settings size={16} className="text-gray-400 shrink-0" />
        </div>
      )}
    </div>
  );
});

RightSidebarHeader.displayName = 'RightSidebarHeader';

export default RightSidebarHeader;
