/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ComponentInstance } from '../models/ComponentModel';
import { EditorTool } from '../stores/EditorUIStore';
import { useStore } from '@/hooks/useStore';

interface ComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  primaryId: string;
}

const ComponentRenderer = observer(({ component, breakpointId, allBreakpoints, primaryId }: ComponentRendererProps) => {
  const { editorUI } = useStore();

  const { attributes, style } = component.getResolvedProps(breakpointId, allBreakpoints, primaryId);

  const finalProps: Record<string, unknown> = {
    ...attributes,
    style: Object.keys(style).length ? style : undefined,
    'data-component-id': `${breakpointId}-${component.id}`,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (editorUI.selectedTool === EditorTool.SELECT) {
        editorUI.selectComponent(component, breakpointId);
      }
      (attributes as any)?.onClick?.(e);
    }
  };

  const children = component.children.map(ch =>
    <ComponentRenderer
      key={ch.id}
      component={ch}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      primaryId={primaryId}
    />
  );

  if (component.isHostElement) {
    return React.createElement(component.type as any, finalProps, children.length ? children : (attributes as any).children);
  }

  // Function components registry (simplified)
  const Impl = (window as any).__componentRegistry?.[component.type];
  if (Impl) {
    return <Impl {...finalProps}>{children}</Impl>;
  }

  return (
    <div style={{ border: '1px dashed orange', padding: 8, fontSize: 12, color: '#92400e' }}>
      Unknown component: {component.type}
      {children}
    </div>
  );
});

export default ComponentRenderer;