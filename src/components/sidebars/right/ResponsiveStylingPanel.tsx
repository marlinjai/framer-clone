// src/components/sidebars/right/ResponsiveStylingPanel.tsx
// Responsive styling controls with breakpoint awareness
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Palette } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStore } from '@/hooks/useStore';

/**
 * ResponsiveStylingPanel - Breakpoint-aware styling controls
 * 
 * Handles:
 * - Background color with responsive breakpoint maps
 * - Text color with responsive breakpoint maps  
 * - Visual breakpoint context indicators
 * 
 * Uses EditorUIStore directly - no prop drilling
 * Works for both floating elements and viewport components
 */
const ResponsiveStylingPanel = observer(() => {
  const { editorUI } = useStore();
  const selectedComponent = editorUI.selectedComponent;
  const selectedViewportNode = editorUI.selectedViewportNode;

  // Early return if no component selected
  if (!selectedComponent) return null;

  // Get current breakpoint context
  // For components inside viewports, use the viewport context
  // For floating elements, only show styling if a viewport is also selected for context
  const currentBreakpointId = selectedViewportNode?.breakpointId;
  const breakpointLabel = selectedViewportNode?.label;
  
  // Show styling panel if:
  // 1. Component is selected AND has viewport context (component inside viewport)
  // 2. Component is floating AND a viewport is selected for context
  // 3. Just a component is selected (global styling)
  const shouldShowStyling = selectedComponent && (
    selectedViewportNode || // Has viewport context
    selectedComponent.isFloatingElement // Or is floating (can be styled globally)
  );

  // Early return if styling shouldn't be shown
  if (!shouldShowStyling) return null;

  return (
    <div>
      <div className="flex items-center space-x-2 mb-3">
        <Palette size={16} className="text-gray-600" />
        <h3 className="text-sm font-medium text-gray-900">Styling</h3>
        {breakpointLabel && (
          <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
            {breakpointLabel}
          </div>
        )}
      </div>
      
      <div className="space-y-3">
        {/* Background Color Control - Breakpoint Aware */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs text-gray-500">Background Color</Label>
            {breakpointLabel && (
              <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
                {breakpointLabel}
              </div>
            )}
          </div>
          <Input 
            type="color"
            value={selectedComponent.getResponsiveStyleValue(
              'backgroundColor', 
              currentBreakpointId
            ) || '#ffffff'}
            onChange={(e) => {
              const newColor = e.target.value;
              selectedComponent.updateResponsiveStyle(
                'backgroundColor',
                newColor,
                currentBreakpointId
              );
            }}
            className="h-8 w-full" 
          />
          <div className="text-xs text-gray-400 mt-1">
            {breakpointLabel 
              ? `Setting for ${breakpointLabel} breakpoint`
              : 'Setting global value'
            }
          </div>
        </div>
        
        {/* Text Color Control - Breakpoint Aware */}
        {selectedComponent.type !== 'img' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs text-gray-500">Text Color</Label>
              {breakpointLabel && (
                <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
                  {breakpointLabel}
                </div>
              )}
            </div>
            <Input 
              type="color"
              value={selectedComponent.getResponsiveStyleValue(
                'color', 
                currentBreakpointId
              ) || '#000000'}
              onChange={(e) => {
                const newColor = e.target.value;
                selectedComponent.updateResponsiveStyle(
                  'color',
                  newColor,
                  currentBreakpointId
                );
              }}
              className="h-8 w-full" 
            />
            <div className="text-xs text-gray-400 mt-1">
              {breakpointLabel 
                ? `Setting for ${breakpointLabel} breakpoint`
                : 'Setting global value'
              }
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

ResponsiveStylingPanel.displayName = 'ResponsiveStylingPanel';

export default ResponsiveStylingPanel;
