// src/components/ResponsivePageRenderer.tsx
// Renders all canvas nodes using Framer-style unified approach
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import ComponentRenderer from './ComponentRenderer';
import GroundWrapper from './GroundWrapper';
import { useStore } from '@/hooks/useStore';
// Removed unused import: CanvasNodeType

const ResponsivePageRenderer = observer(() => {
  const rootStore = useStore();
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
    label: viewport.breakpointLabel!
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
          className="viewport-node"
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
                <div className="text-gray-600">{viewport.breakpointLabel}</div>
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
          className="floating-element"
          onClick={() => {
            // Select floating element (no viewport context)
            rootStore.editorUI.selectComponent(element);
          }}
        >
          <ComponentRenderer 
            component={element}
            breakpointId={primaryViewport?.breakpointId || 'default'}
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
