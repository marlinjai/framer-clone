// src/components/sidebars/right/ComponentPropertiesPanel.tsx
// Properties panel for component settings (position, styling, etc.)
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Layout } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStore } from '@/hooks/useStore';

/**
 * ComponentPropertiesPanel - Controls for component properties
 * 
 * Handles:
 * - Position controls (for floating elements)
 * - Image URL (for img elements)
 * - Responsive styling controls
 * 
 * Uses EditorUIStore directly - no prop drilling
 */
const ComponentPropertiesPanel = observer(() => {
  const { editorUI } = useStore();
  const selectedComponent = editorUI.selectedComponent;

  // Early return if no component selected or it's a viewport
  if (!selectedComponent || selectedComponent.id.startsWith('viewport-')) return null;

  return (
    <div>
      <div className="flex items-center space-x-2 mb-3">
        <Layout size={16} className="text-gray-600" />
        <h3 className="text-sm font-medium text-gray-900">
          {selectedComponent.isFloatingElement ? 'Position & Size' : 'Component Properties'}
        </h3>
      </div>
      
      <div className="space-y-3">
        {/* Position Controls (for floating elements only) */}
        {selectedComponent.isFloatingElement && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-gray-500">Width</Label>
                <Input 
                  value={selectedComponent.props?.width || '200'} 
                  onChange={(e) => {
                    const newWidth = e.target.value;
                    const currentProps = selectedComponent.props || {};
                    // Replace entire props object (MST requirement)
                    selectedComponent.props = {
                      ...currentProps,
                      width: newWidth
                    };
                  }}
                  className="h-8 text-sm" 
                />
              </div>
              <div>
                <Label className="text-xs text-gray-500">Height</Label>
                <Input 
                  value={selectedComponent.props?.height || '100'} 
                  onChange={(e) => {
                    const newHeight = e.target.value;
                    const currentProps = selectedComponent.props || {};
                    // Replace entire props object (MST requirement)
                    selectedComponent.props = {
                      ...currentProps,
                      height: newHeight
                    };
                  }}
                  className="h-8 text-sm" 
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-gray-500">X Position</Label>
                <Input 
                  value={selectedComponent.canvasX || 0} 
                  onChange={(e) => {
                    const newX = parseInt(e.target.value) || 0;
                    selectedComponent.updateCanvasTransform({ x: newX });
                  }}
                  className="h-8 text-sm" 
                />
              </div>
              <div>
                <Label className="text-xs text-gray-500">Y Position</Label>
                <Input 
                  value={selectedComponent.canvasY || 0} 
                  onChange={(e) => {
                    const newY = parseInt(e.target.value) || 0;
                    selectedComponent.updateCanvasTransform({ y: newY });
                  }}
                  className="h-8 text-sm" 
                />
              </div>
            </div>
          </>
        )}
        
        {/* Image URL Control */}
        {selectedComponent.type === 'img' && (
          <div>
            <Label className="text-xs text-gray-500">Image URL</Label>
            <Input 
              value={selectedComponent.props?.src || ''} 
              onChange={(e) => {
                const newSrc = e.target.value;
                const currentProps = selectedComponent.props || {};
                // Replace entire props object (MST requirement)
                selectedComponent.props = {
                  ...currentProps,
                  src: newSrc
                };
              }}
              className="h-8 text-sm" 
              placeholder="https://example.com/image.jpg"
            />
          </div>
        )}
      </div>
    </div>
  );
});

ComponentPropertiesPanel.displayName = 'ComponentPropertiesPanel';

export default ComponentPropertiesPanel;
