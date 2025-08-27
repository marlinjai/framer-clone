// src/components/LeftSidebar.tsx
// Left sidebar with components/layers panel and collapsible functionality
'use client';

import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { 
  ChevronLeft, 
  ChevronRight, 
  Layers, 
  Plus, 
  Search, 
  ChevronDown,
  Eye,
  MoreHorizontal,
  Component,
  Box,
  Monitor,
  Tablet,
  Smartphone,
  Image,
  Type
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { EditorUIType } from '../stores/EditorUIStore';
import { ComponentInstance } from '../models/ComponentModel';
// Removed BreakpointModel - using viewport nodes now

interface LeftSidebarProps {
  editorUI: EditorUIType;
}

// LayersPanel component with breakpoint-aware trees
const LayersPanel = observer(({ editorUI }: { editorUI: EditorUIType }) => {
  const currentPage = editorUI.currentPage;
  const rootComponent = currentPage?.appComponentTree;
  const selectedComponent = editorUI.selectedComponent;
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  if (!rootComponent) {
    return (
      <div className="p-4 text-center text-gray-500">
        <Layers size={32} className="mx-auto mb-2 opacity-50" />
        <p className="text-sm">No components</p>
        <p className="text-xs">Add components to see them here</p>
      </div>
    );
  }

  const toggleExpansion = (componentId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(componentId)) {
      newExpanded.delete(componentId);
    } else {
      newExpanded.add(componentId);
    }
    setExpandedNodes(newExpanded);
  };

  // Get breakpoint icon based on device type
  const getBreakpointIcon = (deviceType: string) => {
    switch (deviceType.toLowerCase()) {
      case 'mobile':
        return <Smartphone size={14} />;
      case 'tablet':
        return <Tablet size={14} />;
      case 'desktop':
        return <Monitor size={14} />;
      default:
        return <Monitor size={14} />;
    }
  };

  // Handle component selection for a specific viewport (Framer-style)
  const selectComponentInViewport = (component: ComponentInstance, viewportNode: ComponentInstance) => {
    console.log('selectComponentInViewport called:', { component: component.id, viewport: viewportNode.breakpointLabel });
    
    // Select the component with viewport context
    console.log('Selecting component:', component.id);
    editorUI.selectComponent(component, viewportNode.breakpointId!);
  };

  const renderComponentTree = (component: ComponentInstance, viewportNode: ComponentInstance, depth = 0): React.ReactNode => {
  const isExpanded = expandedNodes.has(`${viewportNode.id}-${component.id}`);
  const hasChildren = component.children.length > 0;
  const isSelectionViewport = editorUI.selectedViewportNode?.id === viewportNode.id; // explicit selection context
  const isSelectedInThisViewport = selectedComponent?.id === component.id && isSelectionViewport;
    
    // Get component icon based on type
    const getComponentIcon = (type: string) => {
      switch (type.toLowerCase()) {
        case 'div':
        case 'section':
        case 'main':
        case 'article':
          return <Box size={14} className="text-blue-500" />;
        case 'button':
          return <Component size={14} className="text-green-500" />;
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
        case 'p':
        case 'span':
          return <div className="w-3.5 h-3.5 bg-purple-500 rounded-sm text-[8px] text-white flex items-center justify-center font-bold">T</div>;
        case 'img':
          return <div className="w-3.5 h-3.5 bg-orange-500 rounded-sm text-[8px] text-white flex items-center justify-center font-bold">I</div>;
        default:
          return <Component size={14} className="text-gray-500" />;
      }
    };

    return (
      <div key={`${viewportNode.id}-${component.id}`} className="select-none">
        <div
          className={`
            flex items-center py-1 px-2 rounded-md cursor-pointer transition-colors group relative
            ${isSelectedInThisViewport ? 'bg-blue-100 text-blue-900 ring-1 ring-blue-300' : 'hover:bg-gray-50'}
          `}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => selectComponentInViewport(component, viewportNode)}
        >
          {/* Expand/Collapse button */}
          <div className="w-4 flex justify-center">
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpansion(`${viewportNode.id}-${component.id}`);
                }}
                className="p-0.5 hover:bg-gray-200 rounded"
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <div className="w-3" />
            )}
          </div>
          
          {/* Component icon */}
          <div className="mr-2">
            {getComponentIcon(component.type)}
          </div>
          
          {/* Component name */}
          <span className="text-sm flex-1 truncate">
            {component.type}
            {component.props.className && (
              <span className="text-xs text-gray-500 ml-1">
                .{component.props.className.split(' ')[0]}
              </span>
            )}
          </span>
          
          {/* Breakpoint indicator (future: show if component has responsive overrides) */}
          <div className="text-xs text-gray-400 mr-2">
            {/* Future: Show colored dot if component has overrides in this breakpoint */}
          </div>
          
          {/* Visibility toggle */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              console.log('Toggle visibility for', component.id, 'in', viewportNode.breakpointLabel);
            }}
            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 rounded transition-opacity"
          >
            <Eye size={12} />
          </button>
          
          {/* More options */}
          <button
            onClick={(e) => e.stopPropagation()}
            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 rounded transition-opacity ml-1"
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
        
        {/* Render children recursively */}
        {hasChildren && isExpanded && (
          <div>
            {component.children.map((child: ComponentInstance) => 
              renderComponentTree(child, viewportNode, depth + 1)
            )}
          </div>
        )}
      </div>
    );
  };

  // Initialize expanded state for root component across all viewports
  React.useEffect(() => {
    if (rootComponent && currentPage) {
      const viewportNodes = currentPage.viewportNodes;
      
      setExpandedNodes(prev => {
        const newExpanded = new Set(prev);
        let hasChanges = false;
        
        viewportNodes.forEach((viewport) => {
          const key = `${viewport.id}-${rootComponent.id}`;
          if (!newExpanded.has(key)) {
            newExpanded.add(key);
            hasChanges = true;
          }
        });
        
        return hasChanges ? newExpanded : prev;
      });
    }
  }, [rootComponent, currentPage]);


  // Render a single unified layer tree (Framer-style)
  const renderLayerTree = (): React.ReactNode[] => {
    const layers: React.ReactNode[] = [];
    
    // Add floating elements (non-viewport canvas components)
    if (currentPage) {
      const floatingElements = currentPage.floatingElements;
      
      floatingElements.forEach((component: ComponentInstance) => {
        const isSelected = editorUI.selectedComponent?.id === component.id;
        
        layers.push(
          <div
            key={component.id}
            className={`
              flex items-center space-x-2 px-2 py-1.5 rounded cursor-pointer text-sm
              ${isSelected ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100 text-gray-700'}
            `}
            onClick={() => editorUI.selectComponent(component)}
          >
            {/* Element Icon */}
            <div className="flex-shrink-0">
              {component.type === 'img' ? (
                <Image size={14} />
              ) : (
                <Type size={14} />
              )}
            </div>
            
            {/* Element Name */}
            <span className="flex-1 truncate">
              {component.type === 'img' ? 'Image' : component.type === 'div' ? 'Text' : component.type}
            </span>
          </div>
        );
      });
    }
    
    // Add viewport nodes (breakpoint frames)
    if (currentPage) {
      const sortedViewports = currentPage.sortedViewportNodes; // Largest first (Desktop, Tablet, Mobile)
      
      sortedViewports.forEach((viewportNode) => {
        const isSelected = editorUI.selectedViewportNode?.id === viewportNode.id;
        
        layers.push(
          <div key={`viewport-${viewportNode.id}`}>
            {/* Viewport Node */}
            <div
              className={`
                flex items-center space-x-2 px-2 py-1.5 rounded cursor-pointer text-sm
                ${isSelected ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100 text-gray-700'}
              `}
              onClick={() => editorUI.setSelectedViewportNode(viewportNode)}
            >
              <div className="flex-shrink-0">
                {getBreakpointIcon(viewportNode.breakpointLabel || 'desktop')}
              </div>
              <span className="flex-1 truncate">{viewportNode.breakpointLabel}</span>
            </div>
            
            {/* Component tree for this viewport */}
            {rootComponent && renderComponentTree(rootComponent, viewportNode, 1)}
          </div>
        );
      });
    }
    
    return layers;
  };

  return (
    <div className="layers-panel space-y-1">
      {renderLayerTree()}
    </div>
  );
});

const LeftSidebar = observer(({ editorUI }: LeftSidebarProps) => {
  const isCollapsed = editorUI.leftSidebarCollapsed;
  const [activeSection, setActiveSection] = useState<'components' | 'layers'>('components');
  const [componentsExpanded, setComponentsExpanded] = useState(true);
  const [layersExpanded, setLayersExpanded] = useState(true);

  return (
    <div className={`
      bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)]
  ${isCollapsed ? 'w-12' : 'w-80'}
    `}>
      {/* Header with section tabs when expanded */}
      <div className="h-16 flex items-center border-b border-gray-200">
        {!isCollapsed && (
          <div className="flex-1 flex">
            <button
              onClick={() => setActiveSection('components')}
              className={`
                flex-1 flex items-center justify-center space-x-2 py-3 text-sm font-medium transition-colors
                ${activeSection === 'components' 
                  ? 'text-blue-600 border-b-2 border-blue-600' 
                  : 'text-gray-600 hover:text-gray-900'}
              `}
            >
              <Component size={16} />
              <span>Components</span>
            </button>
            <button
              onClick={() => setActiveSection('layers')}
              className={`
                flex-1 flex items-center justify-center space-x-2 py-3 text-sm font-medium transition-colors
                ${activeSection === 'layers' 
                  ? 'text-blue-600 border-b-2 border-blue-600' 
                  : 'text-gray-600 hover:text-gray-900'}
              `}
            >
              <Layers size={16} />
              <span>Layers</span>
            </button>
          </div>
        )}
        <div className="px-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editorUI.toggleLeftSidebar()}
            className="p-2 hover:bg-gray-100"
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </Button>
        </div>
      </div>

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        <>
          {/* Search bar */}
          <div className="p-3 border-b border-gray-200">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <Input
                placeholder={`Search ${activeSection}...`}
                className="pl-9 h-9 text-sm"
              />
            </div>
          </div>

          {/* Components Tab Content */}
          {activeSection === 'components' && (
            <div className="flex-1 overflow-y-auto">
              <div className="p-3">
                {/* Basic Components */}
                <div className="mb-6">
                  <div 
                    className="flex items-center justify-between mb-3 cursor-pointer"
                    onClick={() => setComponentsExpanded(!componentsExpanded)}
                  >
                    <div className="flex items-center space-x-2">
                      {componentsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <h3 className="text-sm font-medium text-gray-900">Basic</h3>
                    </div>
                    <Button variant="ghost" size="sm" className="p-1">
                      <Plus size={14} />
                    </Button>
                  </div>
                  {componentsExpanded && (
                    <div className="space-y-2">
                      {[
                        { name: 'Text', color: 'bg-purple-500', icon: 'T' },
                        { name: 'Button', color: 'bg-green-500', icon: 'B' },
                        { name: 'Image', color: 'bg-orange-500', icon: 'I' },
                        { name: 'Container', color: 'bg-blue-500', icon: 'C' }
                      ].map((component) => (
                        <div
                          key={component.name}
                          className="p-3 rounded-md border border-gray-200 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors"
                          draggable
                        >
                          <div className="flex items-center space-x-3">
                            <div className={`w-8 h-8 ${component.color} rounded flex items-center justify-center text-white font-bold text-sm`}>
                              {component.icon}
                            </div>
                            <span className="text-sm text-gray-700">{component.name}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator className="my-4" />

                {/* Layout Components */}
                <div className="mb-6">
                  <div 
                    className="flex items-center justify-between mb-3 cursor-pointer"
                    onClick={() => setComponentsExpanded(!componentsExpanded)}
                  >
                    <div className="flex items-center space-x-2">
                      {componentsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <h3 className="text-sm font-medium text-gray-900">Layout</h3>
                    </div>
                    <Button variant="ghost" size="sm" className="p-1">
                      <Plus size={14} />
                    </Button>
                  </div>
                  {componentsExpanded && (
                    <div className="space-y-2">
                      {[
                        { name: 'Stack', color: 'bg-indigo-500', icon: 'S' },
                        { name: 'Grid', color: 'bg-pink-500', icon: 'G' },
                        { name: 'Flex', color: 'bg-cyan-500', icon: 'F' },
                        { name: 'Card', color: 'bg-emerald-500', icon: 'C' }
                      ].map((component) => (
                        <div
                          key={component.name}
                          className="p-3 rounded-md border border-gray-200 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors"
                          draggable
                        >
                          <div className="flex items-center space-x-3">
                            <div className={`w-8 h-8 ${component.color} rounded flex items-center justify-center text-white font-bold text-sm`}>
                              {component.icon}
                            </div>
                            <span className="text-sm text-gray-700">{component.name}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Layers Tab Content */}
          {activeSection === 'layers' && (
            <div className="flex-1 overflow-y-auto">
              <div className="p-3">
                <div 
                  className="flex items-center justify-between mb-3 cursor-pointer"
                  onClick={() => setLayersExpanded(!layersExpanded)}
                >
                  <div className="flex items-center space-x-2">
                    {layersExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <h3 className="text-sm font-medium text-gray-900">Page Layers</h3>
                  </div>
                  <Button variant="ghost" size="sm" className="p-1">
                    <Plus size={14} />
                  </Button>
                </div>
                {layersExpanded && (
                  <div className="space-y-1">
                    <LayersPanel editorUI={editorUI} />
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Collapsed state - show section toggle icons */}
      {isCollapsed && (
        <div className="flex flex-col items-center py-4 space-y-4">
          <Button 
            variant="ghost" 
            size="sm" 
            className="p-2"
            onClick={() => {
              editorUI.toggleLeftSidebar();
              setActiveSection('components');
            }}
          >
            <Component size={18} className="text-gray-600" />
          </Button>
          <Button 
            variant="ghost" 
            size="sm" 
            className="p-2"
            onClick={() => {
              editorUI.toggleLeftSidebar();
              setActiveSection('layers');
            }}
          >
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
