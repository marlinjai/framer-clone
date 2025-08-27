// src/components/sidebars/RightSidebar.tsx
// Refactored modular right sidebar with clean component separation
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import RightSidebarHeader from './right/RightSidebarHeader';
import BreakpointPropertiesPanel from './right/BreakpointPropertiesPanel';
import ComponentPropertiesPanel from './right/ComponentPropertiesPanel';
import ResponsiveStylingPanel from './right/ResponsiveStylingPanel';

/**
 * RightSidebar - Modular properties sidebar
 * 
 * Architecture:
 * - Clean component separation with dedicated panels
 * - No prop drilling - each component uses EditorUIStore directly
 * - Responsive design with collapse functionality
 * - Context-aware panel display based on current selection
 * 
 * Panels:
 * - BreakpointPropertiesPanel: Viewport node configuration
 * - ComponentPropertiesPanel: Component positioning and properties
 * - ResponsiveStylingPanel: Breakpoint-aware styling controls
 */
const RightSidebar = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.rightSidebarCollapsed;

  return (
    <div className={`
      bg-white border-l border-gray-200 flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)] 
      ${isCollapsed ? 'w-12' : 'w-64'}
    `}>
      {/* Header with collapse toggle and dynamic title */}
      <RightSidebarHeader />

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-3 space-y-6">
            {/* Breakpoint Properties Panel */}
            <BreakpointPropertiesPanel />
            
            {/* Component Properties Panel */}
            <ComponentPropertiesPanel />
            
            {/* Responsive Styling Panel */}
            <ResponsiveStylingPanel />
            
            {/* Empty State */}
            {!editorUI.selectedViewportNode && !editorUI.selectedComponent && (
              <div>
                <div className="flex items-center space-x-2 mb-3">
                  <span className="text-sm text-gray-500">Select an element to edit properties</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

RightSidebar.displayName = 'RightSidebar';

export default RightSidebar;

