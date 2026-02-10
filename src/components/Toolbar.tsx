// src/components/Toolbar.tsx
// Simple bottom toolbar for tool selection and zoom controls
'use client';
import React, { useCallback, useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { PiCursorLight, PiHandGrabbingBold, PiPlus, PiMinus, PiHouse } from "react-icons/pi";
import { EditorTool, EditorUIType } from '../stores/EditorUIStore';
import { useTransformContext, useTransformNotifier } from '@/contexts/TransformContext';

// Tool configuration with React Icons
const TOOLS = {
  [EditorTool.GRAB]: {
    name: 'Grab',
    icon: PiHandGrabbingBold,
    description: 'Pan and navigate the canvas'
  },
  [EditorTool.SELECT]: {
    name: 'Select', 
    icon: PiCursorLight,
    description: 'Select and move components'
  }
};

interface ToolbarProps {
  editorUI: EditorUIType;
}

const Toolbar = observer(({ editorUI }: ToolbarProps) => {
  // Get transform state and notifier from context
  const { state: transformState, subscribe } = useTransformContext();
  const notifySubscribers = useTransformNotifier();
  
  // Local state for zoom percentage display (needed because transformState is a ref)
  const [zoomPercentage, setZoomPercentage] = useState(() => 
    Math.round(transformState.current.zoom * 100)
  );
  
  // Subscribe to transform changes to update zoom display
  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setZoomPercentage(Math.round(transformState.current.zoom * 100));
    });
    return unsubscribe;
  }, [subscribe, transformState]);

  /**
   * Apply transform to camera element and notify subscribers
   * This mirrors the applyTransform function from Canvas.tsx
   */
  const applyTransform = useCallback(() => {
    // Find camera element by data attribute
    const cameraElement = document.querySelector('[data-camera-transform]') as HTMLElement;
    if (!cameraElement) return;

    const { zoom, panX, panY } = transformState.current;
    
    // Apply CSS transform directly to DOM (bypassing React for performance)
    const transformString = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    cameraElement.style.transform = transformString;
    
    // Update data attribute for debugging and HudSurface compatibility
    cameraElement.setAttribute('data-camera-transform', `${panX},${panY},${zoom}`);
    
    // Notify all subscribers (HudSurface, etc.) to update overlay positions
    notifySubscribers();
  }, [transformState, notifySubscribers]);

  /**
   * Zoom function - increments or decrements zoom by 5% (0.05)
   * Uses viewport center as zoom point (similar to cursor-centered zoom)
   */
  const handleZoom = useCallback((direction: 'in' | 'out') => {
    // Find ground element (canvas container) to get viewport dimensions
    const groundElement = document.querySelector('.w-full.h-full.bg-gray-100.overflow-hidden.relative') as HTMLElement;
    if (!groundElement) return;

    const rect = groundElement.getBoundingClientRect();
    
    // Use viewport center as zoom point
    const viewportCenterX = rect.width / 2;
    const viewportCenterY = rect.height / 2;
    
    // Calculate zoom increment (5% = 0.05)
    const zoomIncrement = 0.05;
    const zoomDirection = direction === 'in' ? 1 : -1;
    const currentZoom = transformState.current.zoom;
    const newZoom = Math.max(0.1, Math.min(5, currentZoom + (zoomIncrement * zoomDirection)));
    
    // Get current transform state
    const { zoom: oldZoom, panX: currentPanX, panY: currentPanY } = transformState.current;
    
    // Apply cursor-centered zoom algorithm (from Canvas.tsx lines 97-110)
    // Step 1: Convert viewport center position to world coordinates
    const worldX = (viewportCenterX - currentPanX) / oldZoom;
    const worldY = (viewportCenterY - currentPanY) / oldZoom;
    
    // Step 2: Apply zoom transformation around the world point
    const newPanX = viewportCenterX - worldX * newZoom;
    const newPanY = viewportCenterY - worldY * newZoom;
    
    // Update transform state
    transformState.current.zoom = newZoom;
    transformState.current.panX = newPanX;
    transformState.current.panY = newPanY;
    
    // Apply transform and notify subscribers
    applyTransform();
  }, [transformState, applyTransform]);

  /**
   * Reset function - resets zoom to 100% and pan to origin (0, 0)
   */
  const handleReset = useCallback(() => {
    // Reset to default state
    transformState.current.zoom = 1.0;
    transformState.current.panX = 0;
    transformState.current.panY = 0;
    
    // Apply transform and notify subscribers
    applyTransform();
  }, [transformState, applyTransform]);

  return (
    <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
      <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200/50 p-2">
        <div className="flex items-center space-x-1">
          {/* Tool selection buttons */}
          {Object.entries(TOOLS).map(([toolType, toolInfo]) => {
            const isActive = editorUI.isToolSelected(toolType as EditorTool);
            const IconComponent = toolInfo.icon;
            
            return (
              <button
                key={toolType}
                onClick={() => editorUI.setSelectedTool(toolType as EditorTool)}
                className={`
                  flex items-center justify-center w-10 h-10 rounded-lg 
                  transition-all duration-200 group relative
                  ${isActive 
                    ? 'bg-blue-600 text-white shadow-sm scale-105' 
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100/50'
                  }
                `}
                title={`${toolInfo.name} - ${toolInfo.description}`}
              >
                <IconComponent size={20} />
                
                {/* Active indicator */}
                {isActive && (
                  <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2">
                    <div className="w-1 h-1 bg-white rounded-full"></div>
                  </div>
                )}
                
                {/* Tooltip */}
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
                  {toolInfo.name}
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                </div>
              </button>
            );
          })}

          {/* Separator */}
          <div className="w-px h-6 bg-gray-300 mx-1" />

          {/* Zoom controls */}
          <button
            onClick={() => handleZoom('out')}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100/50 transition-all duration-200 group relative"
            title="Zoom out (5%)"
          >
            <PiMinus size={20} />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Zoom out (5%)
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
            </div>
          </button>

          {/* Zoom percentage display */}
          <div className="px-2 text-xs font-medium text-gray-600 min-w-[3rem] text-center">
            {zoomPercentage}%
          </div>

          <button
            onClick={() => handleZoom('in')}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100/50 transition-all duration-200 group relative"
            title="Zoom in (5%)"
          >
            <PiPlus size={20} />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Zoom in (5%)
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
            </div>
          </button>

          {/* Reset button */}
          <button
            onClick={handleReset}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100/50 transition-all duration-200 group relative"
            title="Reset zoom and pan to origin"
          >
            <PiHouse size={20} />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Reset zoom and pan
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
});

Toolbar.displayName = 'Toolbar';

export default Toolbar;
