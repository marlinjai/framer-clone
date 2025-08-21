// src/components/LeftSidebar.tsx
// Left sidebar with components/layers panel and collapsible functionality
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Layers, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { EditorUIInstance } from '../stores/EditorUIStore';

interface LeftSidebarProps {
  editorUI: EditorUIInstance;
}

const LeftSidebar: React.FC<LeftSidebarProps> = observer(({ editorUI }) => {
  const isCollapsed = editorUI.leftSidebarCollapsed;

  return (
    <div className={`
      bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out
      ${isCollapsed ? 'w-12' : 'w-64'}
    `}>
      {/* Header with collapse toggle */}
      <div className="h-16 flex items-center justify-between px-3 border-b border-gray-200">
        {!isCollapsed && (
          <div className="flex items-center space-x-2">
            <Layers size={20} className="text-gray-600" />
            <span className="font-medium text-gray-900">Components</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editorUI.toggleLeftSidebar()}
          className="p-2 hover:bg-gray-100"
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </Button>
      </div>

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        <>
          {/* Search bar */}
          <div className="p-3 border-b border-gray-200">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Search components..."
                className="pl-9 h-9 text-sm"
              />
            </div>
          </div>

          {/* Component Categories */}
          <div className="flex-1 overflow-y-auto">
            <div className="p-3">
              {/* Basic Components */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-900">Basic</h3>
                  <Button variant="ghost" size="sm" className="p-1">
                    <Plus size={14} />
                  </Button>
                </div>
                <div className="space-y-2">
                  {['Text', 'Button', 'Image', 'Container'].map((component) => (
                    <div
                      key={component}
                      className="p-2 rounded-md border border-gray-200 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors"
                      draggable
                    >
                      <div className="w-full h-8 bg-gray-100 rounded mb-1"></div>
                      <span className="text-xs text-gray-600">{component}</span>
                    </div>
                  ))}
                </div>
              </div>

              <Separator className="my-4" />

              {/* Layout Components */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-900">Layout</h3>
                  <Button variant="ghost" size="sm" className="p-1">
                    <Plus size={14} />
                  </Button>
                </div>
                <div className="space-y-2">
                  {['Stack', 'Grid', 'Flex', 'Card'].map((component) => (
                    <div
                      key={component}
                      className="p-2 rounded-md border border-gray-200 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors"
                      draggable
                    >
                      <div className="w-full h-8 bg-gray-100 rounded mb-1"></div>
                      <span className="text-xs text-gray-600">{component}</span>
                    </div>
                  ))}
                </div>
              </div>

              <Separator className="my-4" />

              {/* Layers Panel */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-900">Layers</h3>
                  <Button variant="ghost" size="sm" className="p-1">
                    <Plus size={14} />
                  </Button>
                </div>
                <div className="space-y-1">
                  {['Page', 'Header', 'Main Content', 'Footer'].map((layer, index) => (
                    <div
                      key={layer}
                      className="flex items-center p-2 rounded hover:bg-gray-50 cursor-pointer"
                      style={{ paddingLeft: `${8 + index * 16}px` }}
                    >
                      <div className="w-3 h-3 bg-blue-500 rounded-sm mr-2"></div>
                      <span className="text-sm text-gray-700 flex-1">{layer}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Collapsed state - show minimal icons */}
      {isCollapsed && (
        <div className="flex flex-col items-center py-4 space-y-4">
          <Button variant="ghost" size="sm" className="p-2">
            <Layers size={18} className="text-gray-600" />
          </Button>
          <Button variant="ghost" size="sm" className="p-2">
            <Search size={18} className="text-gray-600" />
          </Button>
          <Button variant="ghost" size="sm" className="p-2">
            <Plus size={18} className="text-gray-600" />
          </Button>
        </div>
      )}
    </div>
  );
});

LeftSidebar.displayName = 'LeftSidebar';

export default LeftSidebar;
