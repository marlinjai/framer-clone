// src/components/ResponsivePageRenderer.tsx
// Renders all breakpoint viewports and root canvas components with ground wrappers (Framer-style)
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { PageModelType } from '../models/PageModel';
import ComponentRenderer from './ComponentRenderer';
import RootCanvasComponentRenderer from './RootCanvasComponentRenderer';
import GroundWrapper from './GroundWrapper';
import { useStore } from '@/hooks/useStore';
import { BreakpointType } from '@/models/BreakpointModel';

interface ResponsivePageRendererProps {
  page: PageModelType;
}

const ResponsivePageRenderer = observer(({ page }: ResponsivePageRendererProps) => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  if (!project || !page) return null;

  const breakpoints: BreakpointType[] = Array
    .from(project.breakpoints.values())
    .sort((a,b)=>a.minWidth-b.minWidth);

  return (
    <>
      {/* Render breakpoint viewports using root canvas components for positioning */}
      {breakpoints.map((bp) => {
        // Find the root canvas component for this breakpoint viewport
        const viewportComponent = page.getRootCanvasComponent(`viewport-${bp.id}`);
        
        if (!viewportComponent) {
          console.warn(`No root canvas component found for breakpoint viewport: ${bp.id}`);
          return null;
        }
        
        return (
          <GroundWrapper
            key={`viewport-${bp.id}`}
            id={`viewport-${bp.id}`}
            x={viewportComponent.canvasX!}
            y={viewportComponent.canvasY!}
            className="breakpoint-viewport w-full"
            onClick={() => {
              // Select this breakpoint when viewport is clicked
              rootStore.editorUI.setSelectedBreakpoint(bp);
            }}
          >
            {/* Viewport container with background and dimensions */}
            <div
              className="relative bg-white shadow-lg rounded-lg overflow-hidden"
              style={{ 
                width: bp.minWidth ? `${bp.minWidth}px` : '400px',
                minHeight: '600px',
              }}
              data-breakpoint={bp.id}
            >
              {/* Viewport label */}
              <div className="absolute -top-8 left-0 text-sm font-medium text-gray-600">
                <div className="flex items-center gap-2">
                  <div className="text-gray-600">{bp.label}</div>
                  <div className="px-2 py-0.5 bg-gray-200 rounded text-xs">{bp.minWidth}px</div>
                </div>
              </div>

              {/* Render component tree for this breakpoint */}
              {page.rootComponent && (
                <ComponentRenderer
                  component={page.rootComponent}
                  breakpointId={bp.id}
                  allBreakpoints={breakpoints}
                  primaryId={project.primaryBreakpoint.id}
                />
              )}
            </div>
          </GroundWrapper>
        );
      })}
      
      {/* Render floating root canvas components */}
      {page.visibleRootCanvasComponents
        .filter(component => !component.id.startsWith('viewport-')) // Exclude viewport components
        .map((component) => (
          <RootCanvasComponentRenderer
            key={component.id}
            component={component}
            allBreakpoints={breakpoints}
            primaryBreakpointId={project.primaryBreakpoint.id}
          />
        ))}
    </>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';
export default ResponsivePageRenderer;
