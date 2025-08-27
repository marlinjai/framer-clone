// src/components/ResponsivePageRenderer.tsx
// Renders all canvas nodes using Framer-style unified approach
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import ComponentRenderer from './ComponentRenderer';
import GroundWrapper from './GroundWrapper';
import { useStore } from '@/hooks/useStore';
import { EditorTool } from '@/stores/EditorUIStore';
import { useTransformContext } from '@/contexts/TransformContext';
// Removed unused import: CanvasNodeType

const ResponsivePageRenderer = observer(() => {
  const rootStore = useStore();
  const { state: transformState } = useTransformContext();
  const project = rootStore.editorUI.currentProject;
  const page = rootStore.editorUI.currentPage;
  if (!project || !page) return null;

  const { appComponentTree } = page;
  
  // Get viewport nodes for responsive rendering
  const viewportNodes = page.sortedViewportNodes;
  
  // Convert to format expected by ComponentRenderer
  const breakpoints = viewportNodes.map(viewport => ({
    id: viewport.breakpointId!,
    minWidth: viewport.breakpointMinWidth!,
    label: viewport.label!
  }));
  
  // Use first viewport as primary (largest minWidth)
  const primaryViewport = viewportNodes[0];

  return (
    <>
      {/* Framer-style unified approach: all canvas nodes */}
      
      {/* 1. Render viewport nodes */}
      {viewportNodes.map(viewport => (
        <GroundWrapper 
          key={viewport.id}
          id={viewport.id}
          x={viewport.canvasX!} 
          y={viewport.canvasY!}
          className="viewport-node cursor-grab hover:cursor-grab"
          onClick={(e) => {
            e.stopPropagation();
            if (rootStore.editorUI.selectedTool === EditorTool.SELECT) {
              rootStore.editorUI.setSelectedViewportNode(viewport);
            }
          }}
          onMouseDown={(e: React.MouseEvent) => {
            // Start drag operation for viewport nodes (same as floating elements)
            if (rootStore.editorUI.selectedTool === EditorTool.SELECT && e.button === 0) {
              e.preventDefault();
              e.stopPropagation();
              
              // Select the viewport first
              rootStore.editorUI.setSelectedViewportNode(viewport);
              
              // Start drag operation using EditorUIStore
              const startPos = { x: e.clientX, y: e.clientY };
              rootStore.editorUI.startDrag(viewport, startPos);
              
              const startCanvasX = viewport.canvasX || 0;
              const startCanvasY = viewport.canvasY || 0;
              
              // Visual feedback: change cursor and add dragging class
              const groundWrapper = e.currentTarget as HTMLElement;
              groundWrapper.style.cursor = 'grabbing';
              groundWrapper.style.opacity = '0.8';
              groundWrapper.classList.add('dragging');
              
              const handleMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startPos.x;
                const deltaY = moveEvent.clientY - startPos.y;
                
                // Transform screen delta to canvas delta (account for zoom)
                const { zoom } = transformState.current;
                const canvasDeltaX = deltaX / zoom;
                const canvasDeltaY = deltaY / zoom;
                
                // Calculate new position and snap to pixels (integer coordinates)
                const newX = Math.round(startCanvasX + canvasDeltaX);
                const newY = Math.round(startCanvasY + canvasDeltaY);
                
                // Update drag state in store
                rootStore.editorUI.updateDrag({ x: moveEvent.clientX, y: moveEvent.clientY });
                
                // Update viewport position immediately for real-time feedback with pixel snapping
                viewport.updateCanvasTransform({ x: newX, y: newY });
              };
              
              const handleMouseUp = () => {
                // End drag operation in store
                rootStore.editorUI.endDrag();
                
                // Reset visual feedback
                groundWrapper.style.cursor = 'grab';
                groundWrapper.style.opacity = '1';
                groundWrapper.classList.remove('dragging');
                
                // Cleanup event listeners
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                document.body.style.cursor = '';
                
                console.log('🎯 Viewport drag completed. Final position:', {
                  canvasX: viewport.canvasX,
                  canvasY: viewport.canvasY
                });
              };
              
              // Set drag cursor
              document.body.style.cursor = 'grabbing';
              
              // Add global event listeners
              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
            }
          }}
        >
          {/* Viewport frame */}
          <div
            className="relative bg-white shadow-lg rounded-lg "
            style={{ 
              width: `${viewport.viewportWidth}px`,
              height: `${viewport.viewportHeight}px`,
            }}
            data-viewport-id={viewport.id}
            data-breakpoint-id={viewport.breakpointId}
          >
            {/* Viewport label - clickable for viewport selection */}
            <div 
              className="absolute -top-8 left-0 text-sm font-medium text-gray-600 cursor-pointer hover:bg-gray-100 rounded px-2 py-1 -mx-2 -my-1"
              onClick={(e) => {
                e.stopPropagation();
                rootStore.editorUI.setSelectedViewportNode(viewport);
              }}
            >
              <div className="flex items-center gap-2">
                <div className="text-gray-600">{viewport.label}</div>
                <div className="px-2 py-0.5 bg-gray-200 rounded text-xs">
                  {viewport.breakpointMinWidth}px
                </div>
                <div className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
                  {viewport.viewportWidth}×{viewport.viewportHeight}
                </div>
              </div>
            </div>

            {/* Render the same app tree with this viewport's breakpoint resolution */}
            <div className="w-full h-full overflow-auto">
              {appComponentTree && (
                <ComponentRenderer 
                  component={appComponentTree}
                  breakpointId={viewport.breakpointId!}  // Use viewport's breakpoint ID
                  allBreakpoints={breakpoints}
                  primaryId={primaryViewport?.breakpointId || viewport.breakpointId!}
                />
              )}
            </div>
          </div>
        </GroundWrapper>
      ))}
      
      {/* 2. Render floating elements */}
      {page.floatingElements.map(element => (
        <GroundWrapper 
          key={element.id}
          id={element.id}
          x={element.canvasX!} 
          y={element.canvasY!}
          scale={element.canvasScale}
          rotation={element.canvasRotation}
          zIndex={element.canvasZIndex}
          width={parseInt(element.props?.style?.width) || undefined}
          height={parseInt(element.props?.style?.height) || undefined}
          className="floating-element cursor-grab hover:cursor-grab"
          onClick={(e) => {
            e.stopPropagation();
            if (rootStore.editorUI.selectedTool === EditorTool.SELECT) {
              rootStore.editorUI.selectComponent(element);
            }
          }}
          onMouseDown={(e: React.MouseEvent) => {
            // Start drag operation for floating elements
            if (rootStore.editorUI.selectedTool === EditorTool.SELECT && e.button === 0) {
              e.preventDefault();
              e.stopPropagation();
              
              // Select the element first
              rootStore.editorUI.selectComponent(element);
              
              // Start drag operation using EditorUIStore
              const startPos = { x: e.clientX, y: e.clientY };
              rootStore.editorUI.startDrag(element, startPos);
              
              const startCanvasX = element.canvasX || 0;
              const startCanvasY = element.canvasY || 0;
              
              // Visual feedback: change cursor and add dragging class
              const groundWrapper = e.currentTarget as HTMLElement;
              groundWrapper.style.cursor = 'grabbing';
              groundWrapper.style.opacity = '0.8';
              groundWrapper.classList.add('dragging');
              
              const handleMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startPos.x;
                const deltaY = moveEvent.clientY - startPos.y;
                
                // Transform screen delta to canvas delta (account for zoom)
                const { zoom } = transformState.current;
                const canvasDeltaX = deltaX / zoom;
                const canvasDeltaY = deltaY / zoom;
                
                // Calculate new position and snap to pixels (integer coordinates)
                const newX = Math.round(startCanvasX + canvasDeltaX);
                const newY = Math.round(startCanvasY + canvasDeltaY);
                
                // Update drag state in store
                rootStore.editorUI.updateDrag({ x: moveEvent.clientX, y: moveEvent.clientY });
                
                // Update component position immediately for real-time feedback with pixel snapping
                element.updateCanvasTransform({ x: newX, y: newY });
              };
              
              const handleMouseUp = () => {
                // End drag operation in store
                rootStore.editorUI.endDrag();
                
                // Reset visual feedback
                groundWrapper.style.cursor = 'grab';
                groundWrapper.style.opacity = '1';
                groundWrapper.classList.remove('dragging');
                
                // Cleanup event listeners
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                document.body.style.cursor = '';
                
                console.log('🎯 Drag completed. Final position:', {
                  canvasX: element.canvasX,
                  canvasY: element.canvasY
                });
              };
              
              // Set drag cursor
              document.body.style.cursor = 'grabbing';
              
              // Add global event listeners
              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
            }
          }}
        >
          <ComponentRenderer 
            component={element}
            breakpointId="" // No breakpoint context for floating elements
            allBreakpoints={breakpoints}
            primaryId={primaryViewport?.breakpointId || 'default'}
          />
        </GroundWrapper>
      ))}
    </>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';
export default ResponsivePageRenderer;
