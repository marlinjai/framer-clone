// src/components/ResponsivePageRenderer.tsx
// Renders a PageModel at different responsive breakpoints
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { PageInstance, BreakpointInstance } from '../models/PageModel';
import ComponentRenderer from './ComponentRenderer';

interface ResponsivePageRendererProps {
  page: PageInstance;
  breakpointName: string;
  className?: string;
  showLabel?: boolean;
  showDeviceFrame?: boolean;
}

// Uniform device frame styles like Framer (consistent across all breakpoints)
const getDeviceFrameStyle = (page: PageInstance, breakpointName: string) => {
  const effectiveWidth = page.getBreakpoint(breakpointName)?.minWidth;
  
  return {
    width: `${effectiveWidth}px`,
    // Uniform Framer-style frame for all devices
    borderRadius: '8px',
    padding: '0',
    backgroundColor: '#ffffff',
    border: '1px solid #e5e7eb',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    overflow: 'hidden'
  };
};

const ResponsivePageRenderer: React.FC<ResponsivePageRendererProps> = observer(({
  page,
  breakpointName,
  className = '',
  showLabel = true,
  showDeviceFrame = true
}: ResponsivePageRendererProps) => {
  const breakpoint = page.getBreakpoint(breakpointName);
  
  if (!breakpoint) {
    return (
      <div className="border-2 border-dashed border-red-300 bg-red-50 p-4 rounded">
        <div className="text-red-600 font-medium">Invalid Breakpoint</div>
        <div className="text-red-500 text-sm">Breakpoint "{breakpointName}" not found</div>
      </div>
    );
  }

  if (!page.hasComponents) {
    return (
      <div className="border-2 border-dashed border-yellow-300 bg-yellow-50 p-4 rounded">
        <div className="text-yellow-600 font-medium">No Components</div>
        <div className="text-yellow-500 text-sm">Page has no root component to render</div>
      </div>
    );
  }

  const frameStyle = showDeviceFrame ? getDeviceFrameStyle(page, breakpointName) : {};
  const effectiveWidth = breakpoint.minWidth;

  return (
    <div className={`relative ${className}`}>
      {/* Breakpoint Label */}
      {showLabel && (
        <div className="absolute -top-8 left-0 text-sm font-medium text-gray-600">
          <div className="flex items-center gap-2">
            <div className="text-gray-600">{breakpoint.label}</div>
            <div className="w-4 h-4 bg-gray-300 rounded-full"> {breakpoint.minWidth}</div>
          </div>
        </div>
      )}

      {/* Device Frame */}
      <div style={frameStyle} className="relative">
        {/* Viewport Content */}
        <div 
          className="bg-white overflow-hidden relative"
          style={{
            width: showDeviceFrame ? '100%' : `${effectiveWidth}px`,
            // Height adapts to content naturally - no fixed height needed
          }}
        >

          {/* Page Content with Responsive Context */}
          <div 
            className="min-h-full overflow-auto"
            style={{
              // Set CSS custom properties for responsive design
              '--viewport-width': `${effectiveWidth}px`,
              '--breakpoint-min-width': `${breakpoint.minWidth}px`,
              // Height is determined by content, not breakpoint
            } as React.CSSProperties}
          >
            {/* Apply responsive CSS classes based on breakpoint */}
            <div className={`
              ${breakpointName === 'mobile' ? 'mobile-viewport' : ''}
              ${breakpointName === 'tablet' ? 'tablet-viewport' : ''}
              ${breakpointName.includes('desktop') ? 'desktop-viewport' : ''}
            `}>
              <ComponentRenderer 
                component={page.rootComponent!} 
                className=""
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';

export default ResponsivePageRenderer;
