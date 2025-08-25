// src/components/ResponsivePageRenderer.tsx
// Renders all breakpoint viewports side-by-side
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { PageModelType } from '../models/PageModel';
import ComponentRenderer from './ComponentRenderer';
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
      {breakpoints.map((bp) => (
        <div
          key={bp.id}
          className="relative inline-block mr-8 align-top"
          style={{ width: bp.minWidth ? `${bp.minWidth}px` : '100%' }}
        >
          <div className="absolute -top-8 left-0 text-sm font-medium text-gray-600">
            <div className="flex items-center gap-2">
              <div className="text-gray-600">{bp.label}</div>
              <div className="px-2 py-0.5 bg-gray-200 rounded text-xs">{bp.minWidth}px</div>
            </div>
          </div>
          <div className="bg-white overflow-hidden relative border border-gray-200 rounded w-full h-full">
            {page.rootComponent && (
              <ComponentRenderer
                component={page.rootComponent}
                breakpointId={bp.id}
                allBreakpoints={breakpoints}
                primaryId={project.primaryBreakpoint.id}
              />
            )}
          </div>
        </div>
      ))}
    </>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';
export default ResponsivePageRenderer;
