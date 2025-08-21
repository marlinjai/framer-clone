// src/components/Toolbar.tsx
// Simple bottom toolbar for tool selection
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { PiCursorLight, PiHandGrabbingBold } from "react-icons/pi";
import { EditorTool, EditorUIType } from '../stores/EditorUIStore';

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
  return (
    <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
      <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200/50 p-2">
        <div className="flex items-center space-x-1">
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
        </div>
      </div>
    </div>
  );
});

Toolbar.displayName = 'Toolbar';

export default Toolbar;
