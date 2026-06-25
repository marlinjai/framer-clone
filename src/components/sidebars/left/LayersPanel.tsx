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
import {
  ChevronRight,
  ChevronDown,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  Image,
  Type,
  Square,
  Monitor,
  Tablet,
  Smartphone,
  MoreHorizontal,
} from 'lucide-react';
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

// Map viewport label to device icon
function ViewportIcon({ label }: { label: string }) {
  const lower = label.toLowerCase();
  if (lower.includes('mobile') || lower.includes('phone')) {
    return <Smartphone size={15} className="text-muted-foreground flex-none" />;
  }
  if (lower.includes('tablet')) {
    return <Tablet size={15} className="text-muted-foreground flex-none" />;
  }
  return <Monitor size={15} className="text-muted-foreground flex-none" />;
}

const LayersPanel = observer(() => {
  const { editorUI } = useStore();
  const currentPage = editorUI.currentPage;

  // Track collapsed state for each viewport
  const [collapsedViewports, setCollapsedViewports] = useState<Set<string>>(new Set());

  if (!currentPage) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
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
    <div className="flex-1 overflow-auto py-0.5 px-2 pb-2">
      {/* Viewport Trees - Each viewport as collapsible section */}
      {currentPage.viewportNodes.map(viewport => {
        const isCollapsed = collapsedViewports.has(viewport.id);
        const breakpointWidth = viewport.breakpointMinWidth ?? 1280;

        return (
          <div key={viewport.id}>
            {/* Viewport Group Row: 30px, chevron + device icon + uppercase name + dimension pill */}
            <div
              className="flex items-center gap-1.5 h-[30px] px-1.5 rounded-[6px] cursor-pointer hover:bg-accent"
              onClick={() => editorUI.setSelectedViewportNode(viewport)}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleViewportCollapse(viewport.id);
                }}
                className="w-[14px] h-[14px] flex items-center justify-center flex-none"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} className="text-muted-foreground" />
                ) : (
                  <ChevronDown size={14} className="text-muted-foreground" />
                )}
              </button>

              <ViewportIcon label={viewport.label} />

              <span
                className="text-muted-foreground flex-1 truncate"
                style={{ fontSize: '12.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em' }}
              >
                {viewport.label}
              </span>

              <span
                className="font-mono text-muted-foreground bg-muted border border-border rounded-[5px]"
                style={{ fontSize: '10.5px', padding: '1px 6px' }}
              >
                {breakpointWidth}
              </span>
            </div>

            {/* Viewport Content - App Component Tree */}
            {!isCollapsed && currentPage.appComponentTree && (
              <div>
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
          {/* Floating section header */}
          <div className="flex items-center gap-1.5 px-1.5 pt-2.5 pb-1.5">
            <span
              className="text-muted-foreground"
              style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Floating elements
            </span>
            <span
              className="font-mono text-muted-foreground bg-muted rounded-full"
              style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px' }}
            >
              {currentPage.floatingElements.length}
            </span>
          </div>
          <div>
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
  const isContainer = hasChildren;

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
      {/* Component Row: 28px, group for hover-reveal */}
      <div
        data-inner-component-id={component.id}
        onPointerDown={onPointerDown}
        className={`group flex items-center gap-1.5 h-[28px] px-1.5 rounded-[6px] cursor-pointer hover:bg-accent relative ${
          isSelected ? 'bg-brand/10' : ''
        }`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        onClick={() => {
          if (component.isViewportNode) {
            editorUI.setSelectedViewportNode(component);
          } else {
            editorUI.selectComponent(component, breakpointId);
          }
        }}
      >
        {/* Selection: 2px left rail */}
        {isSelected && (
          <span
            className="absolute left-0 bg-brand rounded-[2px]"
            style={{ top: '5px', bottom: '5px', width: '2px' }}
          />
        )}

        {/* Indent guide: thin vertical rule, one per depth level */}
        {depth > 0 && (
          <span className="text-border flex-none flex justify-center" style={{ width: '14px', fontSize: '12px' }}>
            │
          </span>
        )}

        {/* Expand/Collapse chevron (only when row has children) */}
        {hasChildren ? (
          <ChevronDown size={13} className="text-muted-foreground flex-none" />
        ) : (
          <span style={{ width: '13px' }} className="flex-none" />
        )}

        {/* Type icon: 14px, text-muted-foreground; selected gets text-brand */}
        <IconComponent
          size={14}
          className={`flex-none ${isSelected ? 'text-brand' : 'text-muted-foreground'}`}
        />

        {/* Component name: 13px, truncate; selected gets text-brand + weight 500 */}
        <span
          className={`flex-1 truncate ${isSelected ? 'text-brand' : 'text-foreground'}`}
          style={{ fontSize: '13px', fontWeight: isSelected ? 500 : 400 }}
        >
          {component.displayName}
        </span>

        {/* Hover-revealed action cluster */}
        <span className="hidden group-hover:flex items-center gap-0.5">
          {/* Visibility: if hidden, show a dimmed EyeOff persistently */}
          <button
            className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              component.toggleCanvasVisibility();
            }}
          >
            {component.canvasVisible ? (
              <Eye size={13} />
            ) : (
              <EyeOff size={13} className="text-border" />
            )}
          </button>

          {/* Lock */}
          <button
            className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              component.toggleCanvasLock();
            }}
          >
            {component.canvasLocked ? (
              <Lock size={13} />
            ) : (
              <Unlock size={13} />
            )}
          </button>

          {/* Container: overflow menu; leaf: delete */}
          {isContainer ? (
            <button
              className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
              title="More"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={13} />
            </button>
          ) : (
            !component.isViewportNode && component.hasParent && (
              <button
                className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  const page = editorUI.currentPage;
                  if (!page) return;
                  page.deleteComponent(component.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            )
          )}
        </span>

        {/* Always-visible dimmed EyeOff for hidden elements (outside hover cluster) */}
        {!component.canvasVisible && (
          <span className="flex group-hover:hidden">
            <EyeOff size={13} className="text-border" />
          </span>
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
