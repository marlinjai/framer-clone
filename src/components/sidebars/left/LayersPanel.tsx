// src/components/sidebars/left/LayersPanel.tsx
// Collapsible viewport trees. Each component row is:
//   - a click target (selects the component)
//   - a drag source (reparent via the unified DragManager)
//   - a drop target (same DragManager resolves drops when the cursor is over
//     a row, via the data-inner-component-id attribute the resolver walks up
//     to find)
'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronRight, ChevronDown, Eye, EyeOff, Lock, Unlock, Trash2, Image, Type, Square } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { ComponentInstance } from '@/models/ComponentModel';
import { useDragSource } from '@/lib/drag';

/**
 * LayersPanel - Collapsible viewport trees (restored original functionality)
 *
 * Features:
 * - Each viewport (Desktop, Tablet, Mobile) as collapsible tree
 * - Shows app component tree within each viewport context
 * - Floating elements section
 * - Visibility and lock controls
 * - Selection integration with viewport context
 *
 * Uses EditorUIStore directly - no prop drilling
 */
const LayersPanel = observer(() => {
  const { editorUI } = useStore();
  const currentPage = editorUI.currentPage;

  // Track collapsed state for each viewport
  const [collapsedViewports, setCollapsedViewports] = useState<Set<string>>(new Set());

  if (!currentPage) {
    return (
      <div className="text-center text-gray-500 text-sm py-8">
        No page selected
      </div>
    );
  }

  // Toggle viewport collapse state
  const toggleViewportCollapse = (viewportId: string) => {
    const newCollapsed = new Set(collapsedViewports);
    if (newCollapsed.has(viewportId)) {
      newCollapsed.delete(viewportId);
    } else {
      newCollapsed.add(viewportId);
    }
    setCollapsedViewports(newCollapsed);
  };

  // Get component icon based on type
  const getComponentIcon = (component: ComponentInstance) => {
    switch (component.type) {
      case 'img': return Image;
      case 'button': return Square;
      case 'div': return component.isViewportNode ? Square : Type;
      default: return Type;
    }
  };

  return (
    <div className="space-y-4">
      {/* Viewport Trees - Each viewport as collapsible section */}
      {currentPage.viewportNodes.map(viewport => {
        const isCollapsed = collapsedViewports.has(viewport.id);
        const isSelected = editorUI.selectedViewportNode?.id === viewport.id;

        return (
          <div key={viewport.id}>
            {/* Viewport Header */}
            <div
              className={`flex items-center justify-between p-2 rounded cursor-pointer hover:bg-gray-50 ${
                isSelected ? 'bg-blue-50 border-l-2 border-blue-500' : ''
              }`}
              onClick={() => {
                editorUI.setSelectedViewportNode(viewport);
              }}
            >
              <div className="flex items-center space-x-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleViewportCollapse(viewport.id);
                  }}
                  className="p-0.5 hover:bg-gray-200 rounded"
                >
                  {isCollapsed ? (
                    <ChevronRight size={14} className="text-gray-400" />
                  ) : (
                    <ChevronDown size={14} className="text-gray-400" />
                  )}
                </button>

                <div className="p-1 rounded bg-gray-100">
                  <Square size={12} className="text-gray-600" />
                </div>

                <span className="text-sm font-medium text-gray-900">
                  {viewport.label}
                </span>

                <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                  {viewport.breakpointMinWidth}px
                </span>
              </div>

              <div className="flex items-center space-x-1">
                {/* Visibility Toggle */}
                <button
                  className="p-1 hover:bg-gray-200 rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    viewport.toggleCanvasVisibility();
                  }}
                >
                  {viewport.canvasVisible ? (
                    <Eye size={12} className="text-gray-400" />
                  ) : (
                    <EyeOff size={12} className="text-gray-400" />
                  )}
                </button>

                {/* Lock Toggle */}
                <button
                  className="p-1 hover:bg-gray-200 rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    viewport.toggleCanvasLock();
                  }}
                >
                  {viewport.canvasLocked ? (
                    <Lock size={12} className="text-gray-400" />
                  ) : (
                    <Unlock size={12} className="text-gray-400" />
                  )}
                </button>
              </div>
            </div>

            {/* Viewport Content - App Component Tree */}
            {!isCollapsed && currentPage.appComponentTree && (
              <div className="ml-4 mt-2 space-y-1">
                <LayerNode
                  component={currentPage.appComponentTree}
                  depth={0}
                  breakpointId={viewport.breakpointId!}
                  getIcon={getComponentIcon}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* Floating Elements Section */}
      {currentPage.floatingElements.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-900">Floating Elements</h3>
            <span className="text-xs text-gray-500">{currentPage.floatingElements.length}</span>
          </div>
          <div className="space-y-1">
            {currentPage.floatingElements.map(element =>
              <LayerNode
                key={element.id}
                component={element}
                depth={0}
                getIcon={getComponentIcon}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Extracted to its own component so the useDragSource hook can be called per
// component row (hooks can't be called conditionally inside a .map).
interface LayerNodeProps {
  component: ComponentInstance;
  depth: number;
  breakpointId?: string;
  getIcon: (c: ComponentInstance) => React.ComponentType<{ size?: number; className?: string }>;
}

const LayerNode = observer(({ component, depth, breakpointId, getIcon }: LayerNodeProps) => {
  const { editorUI } = useStore();
  const IconComponent = getIcon(component);
  const isSelected = editorUI.selectedComponent?.id === component.id &&
                    (!breakpointId || editorUI.selectedViewportNode?.breakpointId === breakpointId);
  const hasChildren = component.children.length > 0;
  const isDraggable = !component.isViewportNode && component.hasParent;

  // The row is both a drag source and (via data-inner-component-id) a drop
  // target: the resolver walks up from the pointer and hits this attribute
  // when the cursor is over a layer row, producing before / after / inside
  // zones just like a canvas component.
  const { onPointerDown } = useDragSource(
    isDraggable ? { kind: 'moveNode', nodeId: component.id } : null,
    component,
  );

  return (
    <div>
      {/* Component Row */}
      <div
        data-inner-component-id={component.id}
        onPointerDown={onPointerDown}
        className={`flex items-center space-x-2 p-1.5 rounded cursor-pointer hover:bg-gray-50 ${
          isSelected ? 'bg-blue-50 border-l-2 border-blue-500' : ''
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => {
          if (component.isViewportNode) {
            editorUI.setSelectedViewportNode(component);
          } else {
            editorUI.selectComponent(component, breakpointId);
          }
        }}
      >
        {/* Expand/Collapse */}
        {hasChildren ? (
          <ChevronDown size={14} className="text-gray-400" />
        ) : (
          <div className="w-3.5" />
        )}

        {/* Component Icon */}
        <div className="p-1 rounded bg-gray-100">
          <IconComponent size={12} className="text-gray-600" />
        </div>

        {/* Component Name */}
        <span className="text-sm text-gray-700 flex-1 truncate">
          {component.displayName}
        </span>

        {/* Visibility Toggle */}
        <button
          className="p-1 hover:bg-gray-200 rounded"
          onClick={(e) => {
            e.stopPropagation();
            component.toggleCanvasVisibility();
          }}
        >
          {component.canvasVisible ? (
            <Eye size={12} className="text-gray-400" />
          ) : (
            <EyeOff size={12} className="text-gray-400" />
          )}
        </button>

        {/* Lock Toggle */}
        <button
          className="p-1 hover:bg-gray-200 rounded"
          onClick={(e) => {
            e.stopPropagation();
            component.toggleCanvasLock();
          }}
        >
          {component.canvasLocked ? (
            <Lock size={12} className="text-gray-400" />
          ) : (
            <Unlock size={12} className="text-gray-400" />
          )}
        </button>

        {/* Delete - tree children only. Viewport nodes and root stay put. */}
        {!component.isViewportNode && component.hasParent && (
          <button
            className="p-1 hover:bg-red-100 rounded"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              const page = editorUI.currentPage;
              if (!page) return;
              page.deleteComponent(component.id);
            }}
          >
            <Trash2 size={12} className="text-gray-400" />
          </button>
        )}
      </div>

      {/* Children - pass down breakpoint context */}
      {hasChildren && component.children.map((child: ComponentInstance) =>
        <LayerNode
          key={child.id}
          component={child}
          depth={depth + 1}
          breakpointId={breakpointId}
          getIcon={getIcon}
        />
      )}
    </div>
  );
});

LayersPanel.displayName = 'LayersPanel';
LayerNode.displayName = 'LayerNode';

export default LayersPanel;
