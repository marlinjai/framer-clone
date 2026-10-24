// src/components/Toolbar.tsx
// Floating bottom toolbar for tool selection and zoom controls (tablet and
// desktop; phones get PhoneEditorChrome's docked bottom bar instead).
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { PiCursorLight, PiHandGrabbingBold, PiPlus, PiMinus, PiHouse, PiArrowUUpLeft, PiArrowUUpRight } from "react-icons/pi";
import { EditorTool, EditorUIType } from '../stores/EditorUIStore';
import { getUndoManager } from '@/stores/RootStore';
import { useCameraControls } from '@/lib/canvas/cameraControls';

// Tool configuration with React Icons
const TOOLS = {
  [EditorTool.GRAB]: {
    name: 'Grab (H)',
    icon: PiHandGrabbingBold,
    description: 'Pan the canvas. Hold Space or drag with the middle mouse button to pan from any tool'
  },
  [EditorTool.SELECT]: {
    name: 'Select (V)',
    icon: PiCursorLight,
    description: 'Select and move components. Drag on empty canvas to select several, Shift+click to add'
  }
};

interface ToolbarProps {
  editorUI: EditorUIType;
}

const Toolbar = observer(({ editorUI }: ToolbarProps) => {
  // Zoom display, step zoom and reset share their camera code with the phone
  // bottom bar (src/lib/canvas/cameraControls.ts).
  const { zoomPercentage, zoomStep: handleZoom, reset: handleReset } = useCameraControls();

  const undoManager = getUndoManager();
  const canUndo = !!undoManager?.canUndo;
  const canRedo = !!undoManager?.canRedo;
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/i.test(navigator.platform);
  const modKey = isMac ? '⌘' : 'Ctrl';

  return (
    <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
      <div className="bg-background backdrop-blur-sm rounded-xl shadow-lg border border-border p-2">
        <div className="flex items-center space-x-1">
          {/* Undo / Redo. Disabled mirrors canUndo/canRedo on the scoped
              UndoManager so history reflects only projectStore mutations. */}
          <button
            onClick={() => undoManager?.canUndo && undoManager.undo()}
            disabled={!canUndo}
            className={`flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-200 group relative ${
              canUndo
                ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
                : 'text-muted-foreground cursor-not-allowed'
            }`}
            title={`Undo (${modKey}+Z)`}
          >
            <PiArrowUUpLeft size={20} />
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-foreground text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Undo ({modKey}+Z)
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-foreground" />
            </div>
          </button>
          <button
            onClick={() => undoManager?.canRedo && undoManager.redo()}
            disabled={!canRedo}
            className={`flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-200 group relative ${
              canRedo
                ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
                : 'text-muted-foreground cursor-not-allowed'
            }`}
            title={`Redo (${modKey}+Shift+Z)`}
          >
            <PiArrowUUpRight size={20} />
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-foreground text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Redo ({modKey}+Shift+Z)
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-foreground" />
            </div>
          </button>

          {/* Separator */}
          <div className="w-px h-6 bg-border mx-1" />

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
                    ? 'bg-brand text-white shadow-sm scale-105' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }
                `}
                title={`${toolInfo.name} - ${toolInfo.description}`}
              >
                <IconComponent size={20} />
                
                {/* Active indicator */}
                {isActive && (
                  <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2">
                    <div className="w-1 h-1 bg-background rounded-full"></div>
                  </div>
                )}
                
                {/* Tooltip */}
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-foreground text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
                  {toolInfo.name}
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-foreground"></div>
                </div>
              </button>
            );
          })}

          {/* Separator */}
          <div className="w-px h-6 bg-border mx-1" />

          {/* Zoom controls */}
          <button
            onClick={() => handleZoom('out')}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 group relative"
            title="Zoom out (5%)"
          >
            <PiMinus size={20} />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-foreground text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Zoom out (5%)
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-foreground"></div>
            </div>
          </button>

          {/* Zoom percentage display */}
          <div className="px-2 text-xs font-medium text-muted-foreground min-w-[3rem] text-center">
            {zoomPercentage}%
          </div>

          <button
            onClick={() => handleZoom('in')}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 group relative"
            title="Zoom in (5%)"
          >
            <PiPlus size={20} />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-foreground text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Zoom in (5%)
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-foreground"></div>
            </div>
          </button>

          {/* Reset button */}
          <button
            onClick={handleReset}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 group relative"
            title="Reset zoom and pan to origin"
          >
            <PiHouse size={20} />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-3 px-3 py-1.5 bg-foreground text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none whitespace-nowrap shadow-lg">
              Reset zoom and pan
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-foreground"></div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
});

Toolbar.displayName = 'Toolbar';

export default Toolbar;
