// src/components/sidebars/right/RightSidebarHeader.tsx
// Header component for the right sidebar with collapse toggle
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';

/**
 * RightSidebarHeader - Header with title and collapse toggle
 * 
 * Features:
 * - Dynamic title based on current selection
 * - Collapse/expand toggle
 * - Context-aware labeling
 * 
 * Uses EditorUIStore directly - no prop drilling
 */
const RightSidebarHeader = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.rightSidebarCollapsed;
  const selectedViewportNode = editorUI.selectedViewportNode;
  const selectedComponent = editorUI.selectedComponent;

  // Determine header title based on current selection
  const getHeaderTitle = () => {
    if (selectedViewportNode) {
      return `${selectedViewportNode.label} Properties`;
    }
    if (selectedComponent?.isFloatingElement) {
      return 'Position & Size';
    }
    if (selectedComponent) {
      return 'Component Properties';
    }
    return 'Properties';
  };

  return (
    <div className="h-16 flex items-center justify-between px-3 border-b border-gray-200">
      {/* Collapse Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => editorUI.toggleRightSidebar()}
        className="p-1 hover:bg-gray-100"
      >
        {isCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </Button>
      
      {/* Title and Icon */}
      {!isCollapsed && (
        <div className="flex items-center space-x-2">
          <span className="font-medium text-gray-900">
            {getHeaderTitle()}
          </span>
          <Settings size={20} className="text-gray-600" />
        </div>
      )}
    </div>
  );
});

RightSidebarHeader.displayName = 'RightSidebarHeader';

export default RightSidebarHeader;

