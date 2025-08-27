// src/components/sidebars/LeftSidebar.tsx
// Refactored modular left sidebar with clean component separation
'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Layers, Boxes, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStore } from '@/hooks/useStore';
import ComponentsPanel from './left/ComponentsPanel';
import LayersPanel from './left/LayersPanel';

/**
 * LeftSidebar - Modular components and layers sidebar
 * 
 * Architecture:
 * - Clean component separation with dedicated panels
 * - No prop drilling - uses EditorUIStore directly
 * - Tab-based navigation between Components and Layers
 * - Search functionality for both panels
 * - Responsive design with collapse functionality
 * 
 * Panels:
 * - ComponentsPanel: Component library for adding new elements
 * - LayersPanel: Hierarchical view of page structure
 */
const LeftSidebar = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.leftSidebarCollapsed;
  const [activeTab, setActiveTab] = useState<'components' | 'layers'>('components');
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className={`
      bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)] 
      ${isCollapsed ? 'w-12' : 'w-64'}
    `}>
      {/* Header with collapse toggle and tabs */}
      <div className="border-b border-gray-200">
        {/* Collapse Toggle */}
        <div className="h-12 flex items-center justify-between px-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editorUI.toggleLeftSidebar()}
            className="p-1 hover:bg-gray-100"
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </Button>
          
          {!isCollapsed && (
            <div className="text-sm font-medium text-gray-900">Design</div>
          )}
        </div>
        
        {/* Tab Navigation */}
        {!isCollapsed && (
          <div className="flex">
            <button
              className={`flex-1 flex items-center justify-center space-x-2 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'components' 
                  ? 'border-blue-500 text-blue-600' 
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setActiveTab('components')}
            >
              <Boxes size={16} />
              <span>Components</span>
            </button>
            <button
              className={`flex-1 flex items-center justify-center space-x-2 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'layers' 
                  ? 'border-blue-500 text-blue-600' 
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setActiveTab('layers')}
            >
              <Layers size={16} />
              <span>Layers</span>
            </button>
          </div>
        )}
      </div>

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search Bar */}
          <div className="p-3 border-b border-gray-200">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <Input
                placeholder={`Search ${activeTab}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-8 text-sm"
              />
            </div>
          </div>
          
          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto p-3">
            {activeTab === 'components' ? (
              <ComponentsPanel />
            ) : (
              <LayersPanel />
            )}
          </div>
        </div>
      )}
    </div>
  );
});

LeftSidebar.displayName = 'LeftSidebar';

export default LeftSidebar;

