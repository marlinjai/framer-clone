// src/components/sidebars/right/BreakpointPropertiesPanel.tsx
// Properties panel for viewport node (breakpoint) settings
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Layout } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStore } from '@/hooks/useStore';

/**
 * BreakpointPropertiesPanel - Controls for viewport node properties
 * 
 * Handles:
 * - Breakpoint min-width configuration
 * - Viewport frame dimensions
 * - Canvas positioning
 * 
 * Uses EditorUIStore directly - no prop drilling
 */
const BreakpointPropertiesPanel = observer(() => {
  const { editorUI } = useStore();
  const selectedViewportNode = editorUI.selectedViewportNode;

  // Early return if no viewport node selected
  if (!selectedViewportNode) return null;

  return (
    <div>
      <div className="flex items-center space-x-2 mb-3">
        <Layout size={16} className="text-gray-600" />
        <h3 className="text-sm font-medium text-gray-900">Breakpoint Layout</h3>
      </div>
      
      <div className="space-y-3">
        {/* Breakpoint Configuration */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-gray-500">Min Width (Breakpoint)</Label>
            <Input 
              value={selectedViewportNode.breakpointMinWidth || 320} 
              onChange={(e) => {
                const newMinWidth = parseInt(e.target.value) || 320;
                selectedViewportNode.setViewportProperties({ breakpointMinWidth: newMinWidth });
              }}
              className="h-8 text-sm" 
              placeholder="320"
            />
          </div>
          <div>
            <Label className="text-xs text-gray-500">Viewport Height</Label>
            <Input 
              value={selectedViewportNode.viewportHeight || 600} 
              onChange={(e) => {
                const newHeight = parseInt(e.target.value) || 600;
                selectedViewportNode.setViewportProperties({ viewportHeight: newHeight });
              }}
              className="h-8 text-sm" 
              placeholder="600"
            />
          </div>
        </div>
        
        {/* Canvas Position */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-gray-500">X Position</Label>
            <Input 
              value={selectedViewportNode.canvasX || 0} 
              onChange={(e) => {
                const newX = parseInt(e.target.value) || 0;
                selectedViewportNode.updateCanvasTransform({ x: newX });
              }}
              className="h-8 text-sm" 
            />
          </div>
          <div>
            <Label className="text-xs text-gray-500">Y Position</Label>
            <Input 
              value={selectedViewportNode.canvasY || 0} 
              onChange={(e) => {
                const newY = parseInt(e.target.value) || 0;
                selectedViewportNode.updateCanvasTransform({ y: newY });
              }}
              className="h-8 text-sm" 
            />
          </div>
        </div>
      </div>
    </div>
  );
});

BreakpointPropertiesPanel.displayName = 'BreakpointPropertiesPanel';

export default BreakpointPropertiesPanel;

