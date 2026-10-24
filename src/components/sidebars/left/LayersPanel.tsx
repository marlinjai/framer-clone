// src/components/sidebars/left/LayersPanel.tsx
// Collapsible viewport trees. Each component row is:
//   - a click target (selects the component)
//   - a drag source (reparent via the unified DragManager)
//   - a drop target (same DragManager resolves drops when the cursor is over
//     a row, via the data-inner-component-id attribute the resolver walks up
//     to find)
//   - foldable when it has children (chevron button; Alt+click folds or
//     unfolds the whole subtree)
//   - the home of the row actions: Hide / Show, Lock / Unlock, Delete, and a
//     More menu with the same actions (also on right-click)
//
// Every control inside a row stops its pointerdown from reaching the row.
// The row's drag source captures the pointer on pointerdown, and pointer
// capture retargets the click that follows to the row, so without this a
// button's onClick never fires (and pressing it could start a drag).
//
// Hide and lock semantics, and Delete's selection rules, live in
// src/lib/layers/layerActions.ts; fold state rules in foldState.ts.
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import {
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  Copy,
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
import { getHistoryStore } from '@/stores/RootStore';
import {
  collapseAll,
  expandAll,
  expandAncestors,
  toggleFold,
  toggleFoldSubtree,
} from '@/lib/layers/foldState';
import { ancestorIdsOf, canDeleteLayer, deleteLayer, duplicateLayer } from '@/lib/layers/layerActions';
import { layerActionsWidth } from '@/lib/layers/sidebarWidth';
import { ContextMenu, type MenuItem, type MenuCloseReason } from './ContextMenu';

// Touch screens (no hover): the selected row keeps its action cluster visible
// and its name makes room for it (plan docs/plans/2026-10-24-editor-on-phones.md).
const TOUCH_SELECTED_REVEAL = '[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto';
const TOUCH_SELECTED_NAME_PAD = '[@media(hover:none)]:pr-[var(--layer-actions-w)] @max-[172px]:[@media(hover:none)]:pr-[26px]';

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

// Get component icon based on type
function getComponentIcon(component: ComponentInstance) {
  switch (component.type) {
    case 'img': return Image;
    case 'button': return Square;
    case 'div': return component.isViewportNode ? Square : Type;
    default: return Type;
  }
}

/** Keeps a press on a row control from reaching the row's drag source. */
const stopPointer = (e: React.PointerEvent) => e.stopPropagation();

const LayersPanel = observer(() => {
  const { editorUI } = useStore();
  const currentPage = editorUI.currentPage;
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedId = editorUI.selectedComponent?.id;
  const selectedFrameId = editorUI.selectedViewportNode?.id;

  // A selection made on the canvas reveals its row: every folded ancestor
  // (and the breakpoint group it was picked in) opens, then the row scrolls
  // into view. Keyed on the selected id and its frame only, so folding an
  // ancestor of the current selection afterwards is not undone.
  useEffect(() => {
    const ui = editorUI;
    const page = ui.currentPage;
    const selected = ui.selectedComponent;
    if (!page || !selected) return;
    const ancestors = ancestorIdsOf(selected, id => page.findComponent(id));
    const viewportId = ui.selectedViewportNode?.id;
    ui.setCollapsedLayerIds(
      expandAncestors(ui.collapsedLayerIds, viewportId ? [...ancestors, viewportId] : ancestors),
    );
    const breakpointId = ui.selectedViewportNode?.breakpointId;
    const frame = requestAnimationFrame(() => {
      const root = panelRef.current;
      if (!root) return;
      const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-layer-row]'))
        .filter(el => el.dataset.layerRow === selected.id);
      const row = rows.find(el => !breakpointId || el.dataset.layerBreakpoint === breakpointId) ?? rows[0];
      row?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [editorUI, selectedId, selectedFrameId]);

  if (!currentPage) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        No page selected
      </div>
    );
  }

  const collapsed = editorUI.collapsedLayerIds;
  const roots: ComponentInstance[] = [
    ...(currentPage.appComponentTree ? [currentPage.appComponentTree as ComponentInstance] : []),
    ...currentPage.floatingElements,
  ];
  const viewportIds = currentPage.viewportNodes.map(v => v.id);

  const toggleViewportCollapse = (viewportId: string) => {
    editorUI.setCollapsedLayerIds(toggleFold(collapsed, viewportId));
  };

  // Collapse all folds every container row but keeps the breakpoint groups
  // open, so each shows its top row. Expand all opens everything.
  const onCollapseAll = () => editorUI.setCollapsedLayerIds(collapseAll(collapsed, roots));
  const onExpandAll = () => {
    const next = expandAll(collapsed, roots);
    for (const id of viewportIds) next.delete(id);
    editorUI.setCollapsedLayerIds(next);
  };

  return (
    <div ref={panelRef} className="flex-1 overflow-auto py-0.5 px-2 pb-2">
      {/* Fold controls for the whole tree */}
      <div className="flex items-center justify-end gap-0.5 pb-1">
        <button
          type="button"
          title="Expand all layers"
          aria-label="Expand all layers"
          onClick={onExpandAll}
          className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronsUpDown size={13} />
        </button>
        <button
          type="button"
          title="Collapse all layers"
          aria-label="Collapse all layers"
          onClick={onCollapseAll}
          className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronsDownUp size={13} />
        </button>
      </div>

      {/* Viewport Trees - Each viewport as collapsible section */}
      {currentPage.viewportNodes.map(viewport => {
        const isCollapsed = collapsed.has(viewport.id);
        const breakpointWidth = viewport.breakpointMinWidth ?? 1280;

        return (
          <div key={viewport.id}>
            {/* Viewport Group Row: 30px, chevron + device icon + uppercase name + dimension pill */}
            <div
              className="flex items-center gap-1.5 h-[30px] px-1.5 rounded-[6px] cursor-pointer hover:bg-accent"
              onClick={() => editorUI.setSelectedViewportNode(viewport)}
            >
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${viewport.label}`}
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
  /** An ancestor is hidden on the canvas: the row is dimmed like its parent. */
  hiddenByAncestor?: boolean;
}

const LayerNode = observer(({ component, depth, breakpointId, hiddenByAncestor = false }: LayerNodeProps) => {
  const { editorUI } = useStore();
  const IconComponent = getComponentIcon(component);
  // Primary and extra (marquee / Shift+click) selections both highlight.
  const isSelected = editorUI.isSelected(component.id) &&
                    (!breakpointId || editorUI.selectedViewportNode?.breakpointId === breakpointId);
  const hasChildren = component.children.length > 0;
  const isFolded = hasChildren && editorUI.collapsedLayerIds.has(component.id);
  const isDraggable = !component.isViewportNode && component.hasParent;
  const isHidden = !component.canvasVisible;
  const isLocked = !!component.canvasLocked;
  const isDimmed = isHidden || hiddenByAncestor;
  const deletable = canDeleteLayer(component);
  // Width of the hover strip, reserved on the name so it truncates beside the
  // buttons instead of running under them (see the row's container query).
  const actionsWidth = layerActionsWidth(3);
  const name = component.displayName as string;

  // Open row menu, at the cursor (right-click) or under the More button.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // The row is both a drag source and (via data-inner-component-id) a drop
  // target: the resolver walks up from the pointer and hits this attribute
  // when the cursor is over a layer row, producing before / after / inside
  // zones just like a canvas component.
  const { onPointerDown } = useDragSource(
    isDraggable ? { kind: 'moveNode', nodeId: component.id } : null,
    component,
  );

  const onToggleFold = (e: React.MouseEvent) => {
    e.stopPropagation();
    editorUI.setCollapsedLayerIds(
      e.altKey
        ? toggleFoldSubtree(editorUI.collapsedLayerIds, component)
        : toggleFold(editorUI.collapsedLayerIds, component.id),
    );
  };

  const onDelete = () => {
    const page = editorUI.currentPage;
    if (!page) return;
    deleteLayer(page, editorUI, getHistoryStore(), component);
  };

  const onDuplicate = () => {
    const page = editorUI.currentPage;
    if (!page) return;
    duplicateLayer(page, editorUI, getHistoryStore(), component);
  };

  const menuItems: MenuItem[] = [
    {
      label: isHidden ? 'Show layer' : 'Hide layer',
      icon: isHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      onClick: () => component.toggleCanvasVisibility(),
    },
    {
      label: isLocked ? 'Unlock layer' : 'Lock layer',
      icon: isLocked ? <Unlock size={14} /> : <Lock size={14} />,
      onClick: () => component.toggleCanvasLock(),
    },
    ...(hasChildren
      ? [{
          label: isFolded ? 'Expand' : 'Collapse',
          icon: isFolded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
          onClick: () => editorUI.setCollapsedLayerIds(toggleFold(editorUI.collapsedLayerIds, component.id)),
        }]
      : []),
    ...(deletable
      ? [
          { label: 'Duplicate', icon: <Copy size={14} />, onClick: onDuplicate },
          { label: 'Delete layer', icon: <Trash2 size={14} />, onClick: onDelete, destructive: true },
        ]
      : []),
  ];

  // Stable, so the open menu's listeners (and its first-item focus) are not
  // re-run when the row re-renders after an action.
  const closeMenu = useCallback((reason: MenuCloseReason) => {
    setMenu(null);
    if (reason !== 'outside') moreButtonRef.current?.focus();
  }, []);

  const actionButtonClass =
    'w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-background hover:text-foreground';

  return (
    <div>
      {/* Component Row: 28px, group for hover-reveal */}
      <div
        data-inner-component-id={component.id}
        data-layer-row={component.id}
        data-layer-breakpoint={breakpointId}
        onPointerDown={onPointerDown}
        // @container: the row's own width (after its depth indent) decides
        // whether the full action strip fits beside a readable name.
        className={`@container group flex items-center gap-1.5 h-[28px] px-1.5 rounded-[6px] cursor-pointer hover:bg-accent relative ${
          isSelected ? 'bg-brand/10' : ''
        }`}
        style={{ paddingLeft: `${6 + depth * 14}px`, ['--layer-actions-w' as string]: `${actionsWidth}px` }}
        onClick={(e) => {
          if (component.isViewportNode) {
            editorUI.setSelectedViewportNode(component);
          } else if (e.shiftKey) {
            editorUI.toggleInSelection(component, breakpointId);
          } else {
            editorUI.selectComponent(component, breakpointId);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
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

        {/* Fold chevron (only when row has children). Alt+click folds or
            unfolds every container below as well. */}
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={!isFolded}
            aria-label={`${isFolded ? 'Expand' : 'Collapse'} ${name}`}
            title={isFolded ? 'Expand (Alt+click: with all children)' : 'Collapse (Alt+click: with all children)'}
            onPointerDown={stopPointer}
            onClick={onToggleFold}
            className="w-[13px] h-[13px] flex items-center justify-center flex-none text-muted-foreground hover:text-foreground"
          >
            {isFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span style={{ width: '13px' }} className="flex-none" />
        )}

        {/* Type icon: 14px, text-muted-foreground; selected gets text-brand */}
        <IconComponent
          size={14}
          className={`flex-none ${isSelected ? 'text-brand' : 'text-muted-foreground'} ${isDimmed ? 'opacity-50' : ''}`}
        />

        {/* Component name: 13px, truncate; selected gets text-brand + weight 500;
            hidden rows (and rows inside a hidden one) are dimmed */}
        <span
          className={`flex-1 truncate group-hover:pr-[var(--layer-actions-w)] group-focus-within:pr-[var(--layer-actions-w)] @max-[172px]:group-hover:pr-[26px] @max-[172px]:group-focus-within:pr-[26px] ${isSelected ? `text-brand ${TOUCH_SELECTED_NAME_PAD}` : 'text-foreground'} ${isDimmed ? 'opacity-50' : ''}`}
          style={{ fontSize: '13px', fontWeight: isSelected ? 500 : 400 }}
        >
          {name}
        </span>

        {/* Persistent state indicators, covered by the action cluster on hover */}
        {(isHidden || isLocked) && (
          <span className="flex items-center gap-1 flex-none text-muted-foreground" aria-hidden="true">
            {isLocked && <Lock size={12} />}
            {isHidden && <EyeOff size={12} />}
          </span>
        )}

        {/* Action cluster: revealed on hover, and while a control inside has
            keyboard focus (opacity, not display, so the buttons stay tabbable).
            A touch screen has no hover, so there the selected row shows it. */}
        <span
          className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded-[5px] bg-accent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto ${isSelected ? TOUCH_SELECTED_REVEAL : ''}`}
        >
          {/* Hide and lock: dropped when the row is too narrow for them beside
              a readable name (deep rows, narrow sidebar). "More" and
              right-click offer every action, Delete and Duplicate included. */}
          <span className="flex items-center gap-0.5 @max-[172px]:hidden">
            <button
              type="button"
              className={actionButtonClass}
              title={isHidden ? 'Show layer' : 'Hide layer'}
              aria-label={isHidden ? 'Show layer' : 'Hide layer'}
              aria-pressed={isHidden}
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                component.toggleCanvasVisibility();
              }}
            >
              {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>

            <button
              type="button"
              className={actionButtonClass}
              title={isLocked ? 'Unlock layer' : 'Lock layer'}
              aria-label={isLocked ? 'Unlock layer' : 'Lock layer'}
              aria-pressed={isLocked}
              onPointerDown={stopPointer}
              onClick={(e) => {
                e.stopPropagation();
                component.toggleCanvasLock();
              }}
            >
              {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
            </button>
          </span>

          <button
            ref={moreButtonRef}
            type="button"
            className={actionButtonClass}
            title="More layer actions"
            aria-label="More layer actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onPointerDown={stopPointer}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
      )}

      {/* Children - pass down breakpoint context; folded rows hide them */}
      {hasChildren && !isFolded && component.children.map((child: ComponentInstance) =>
        <LayerNode
          key={child.id}
          component={child}
          depth={depth + 1}
          breakpointId={breakpointId}
          hiddenByAncestor={isDimmed}
        />
      )}
    </div>
  );
});

LayersPanel.displayName = 'LayersPanel';
LayerNode.displayName = 'LayerNode';

export default LayersPanel;
