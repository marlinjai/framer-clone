// src/components/RootCanvasComponentRenderer.tsx
// Renders root canvas components with their ground wrappers (Framer-style)
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import GroundWrapper from './GroundWrapper';
import ComponentRenderer from './ComponentRenderer';
import { ComponentInstance } from '../models/ComponentModel';
import { EditorTool } from '../stores/EditorUIStore';
import { useStore } from '@/hooks/useStore';

interface RootCanvasComponentRendererProps {
  component: ComponentInstance;
  // Breakpoint context for component rendering
  allBreakpoints?: { id: string; minWidth: number; label?: string }[];
  primaryBreakpointId?: string;
}

/**
 * RootCanvasComponentRenderer - Renders root canvas components (Framer-style)
 * 
 * Each root canvas component gets its own GroundWrapper for independent positioning,
 * exactly like Framer's architecture where every canvas item has its own
 * groundNodeWrapper with individual transform state.
 */
const RootCanvasComponentRenderer = observer(({ 
  component, 
  allBreakpoints = [],
  primaryBreakpointId = '',
}: RootCanvasComponentRendererProps) => {
  const { editorUI } = useStore();
  
  // Only render if this is actually a root canvas component
  if (!component.isRootCanvasComponent) {
    console.warn('RootCanvasComponentRenderer: Component is not a root canvas component', component.id);
    return null;
  }
  
  // Handle click selection
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editorUI.selectedTool === EditorTool.SELECT) {
      // Select the root canvas component
      editorUI.setSelectedRootCanvasComponent(component);
    }
  };
  
  // Render the component content
  const renderContent = () => {
    if (allBreakpoints.length > 0 && primaryBreakpointId) {
      return (
        <ComponentRenderer
          component={component}
          breakpointId={primaryBreakpointId}
          allBreakpoints={allBreakpoints}
          primaryId={primaryBreakpointId}
        />
      );
    }
    
    // Fallback rendering without breakpoint context
    return (
      <div 
        style={{
          ...component.props?.style,
          width: component.props?.width || '200px',
          height: component.props?.height || '100px',
        }}
      >
        {component.props?.children || `${component.type} component`}
      </div>
    );
  };
  
  // Get dimensions from component props or canvas bounds
  const bounds = component.canvasBounds;
  const width = bounds?.width || 200;
  const height = bounds?.height || 100;

  return (
    <GroundWrapper
      id={component.id}
      x={component.canvasX!}
      y={component.canvasY!}
      scale={component.canvasScale}
      rotation={component.canvasRotation}
      zIndex={component.canvasZIndex}
      width={width}
      height={height}
      visible={component.canvasVisible}
      onClick={handleClick}
      className={`root-canvas-component root-canvas-component-${component.type}`}
    >
      {renderContent()}
    </GroundWrapper>
  );
});

RootCanvasComponentRenderer.displayName = 'RootCanvasComponentRenderer';

export default RootCanvasComponentRenderer;
