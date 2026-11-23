// src/components/sidebars/left/LayersPanel.tsx
// Collapsible viewport trees. A page's tree has one root (the page body, which
// carries page-wide styles per breakpoint); it has no row of its own, the
// breakpoint row stands for it: its children are listed under the breakpoint,
// a click on the breakpoint row selects the root in that breakpoint, a drop
// onto it goes into the root, and its menu holds the root's actions (never
// Delete or Duplicate). Inside a component definition the root is the
// component's own element, so there it keeps its row.
//
// Each component row is:
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
// src/lib/layers/layerActions.ts; fold state rules in foldState.ts; row icons
// in ../layerIcon.ts (shared with the properties panel header).
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
  MoreHorizontal,
  Component,
  Pencil,
  Unlink,
} from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { ComponentInstance } from '@/models/ComponentModel';
import { DATA_TEXT_NODE_ROW, DATA_VIEWPORT_ID, useDragSource } from '@/lib/drag';
import { isTextNodeType } from '@/lib/renderer/textNode';
import { isPlacementType, type PlacementProps } from '@/lib/components/placement';
import { requestCreateComponent, requestDetach } from '@/lib/components/editorCommands';
import { getHistoryStore } from '@/stores/RootStore';
import {
  collapseAll,
  expandAll,
  expandAncestors,
  toggleFold,
  toggleFoldSubtree,
} from '@/lib/layers/foldState';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { ancestorIdsOf, canDeleteLayer, deleteLayer, duplicateLayer } from '@/lib/layers/layerActions';
import { layerActionsWidth } from '@/lib/layers/sidebarWidth';
import { ContextMenu, type MenuItem, type MenuCloseReason } from './ContextMenu';
import { derivedRowsOf } from '@/lib/layers/fxRows';
import { breakpointRefsOf, layerIconOf, viewportIconOf } from '../layerIcon';
import { FxSceneRows } from './FxSceneRows';

// Touch screens (no hover): the selected row keeps its action cluster visible
// and its name makes room for it (plan docs/plans/2026-10-24-editor-on-phones.md).
const TOUCH_SELECTED_REVEAL = '[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto';
const TOUCH_SELECTED_NAME_PAD = '[@media(hover:none)]:pr-[var(--layer-actions-w)] @max-[172px]:[@media(hover:none)]:pr-[26px]';

/** Keeps a press on a row control from reaching the row's drag source. */
const stopPointer = (e: React.PointerEvent) => e.stopPropagation();

/** Hide / Show and, for anything but a text node, Lock / Unlock: menu items every row offers. */
function visibilityItems(component: ComponentInstance, isTextRow: boolean): MenuItem[] {
  const isHidden = !component.canvasVisible;
  const isLocked = !!component.canvasLocked;
  return [
    {
      label: isHidden ? 'Show layer' : 'Hide layer',
      icon: isHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      onClick: () => component.toggleCanvasVisibility(),
    },
    ...(isTextRow
      ? []
      : [{
          label: isLocked ? 'Unlock layer' : 'Lock layer',
          icon: isLocked ? <Unlock size={14} /> : <Lock size={14} />,
          onClick: () => component.toggleCanvasLock(),
        }]),
  ];
}

const actionButtonClass =
  'w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-background hover:text-foreground';

interface RowActionsProps {
  component: ComponentInstance;
  isTextRow: boolean;
  isSelected: boolean;
  menuOpen: boolean;
  moreButtonRef: React.RefObject<HTMLButtonElement | null>;
  onOpenMenu: (at: { x: number; y: number }) => void;
}

/**
 * The persistent hidden / locked indicators and the action cluster of a row.
 * The cluster is revealed on hover, and while a control inside has keyboard
 * focus (opacity, not display, so the buttons stay tabbable). A touch screen
 * has no hover, so there the selected row shows it.
 */
function RowActions({ component, isTextRow, isSelected, menuOpen, moreButtonRef, onOpenMenu }: RowActionsProps) {
  const isHidden = !component.canvasVisible;
  const isLocked = !!component.canvasLocked;
  return (
    <>
      {/* Persistent state indicators, covered by the action cluster on hover */}
      {(isHidden || isLocked) && (
        <span className="flex items-center gap-1 flex-none text-muted-foreground" aria-hidden="true">
          {isLocked && <Lock size={12} />}
          {isHidden && <EyeOff size={12} />}
        </span>
      )}

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

          {!isTextRow && (
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
          )}
        </span>

        <button
          ref={moreButtonRef}
          type="button"
          className={actionButtonClass}
          title="More layer actions"
          aria-label="More layer actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onPointerDown={stopPointer}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </span>
    </>
  );
}

/** An open row menu, at the cursor (right-click) or under the More button. */
function useRowMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  // Stable, so the open menu's listeners (and its first-item focus) are not
  // re-run when the row re-renders after an action.
  const closeMenu = useCallback((reason: MenuCloseReason) => {
    setMenu(null);
    if (reason !== 'outside') moreButtonRef.current?.focus();
  }, []);
  return { menu, setMenu, moreButtonRef, closeMenu };
}

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
  const tree = currentPage.appComponentTree as ComponentInstance | undefined;
  // On a page the breakpoint row stands for the root; in a definition the root is the component.
  const pageBody = tree && !editorUI.inComponent ? tree : undefined;
  // The trees whose rows fold: with the root folded into the breakpoint rows,
  // its children are the top rows, so the root's own id never enters the set.
  const roots: ComponentInstance[] = [
    ...(pageBody ? (pageBody.children as ComponentInstance[]) : tree ? [tree] : []),
    ...currentPage.floatingElements,
  ];
  const viewportIds = currentPage.viewportNodes.map(v => v.id);
  const breakpoints = breakpointRefsOf(currentPage);

  // Alt+click folds or opens the group together with every container in it.
  const toggleViewportCollapse = (viewportId: string, withSubtree: boolean) => {
    const next = toggleFold(collapsed, viewportId);
    if (!withSubtree || !pageBody) {
      editorUI.setCollapsedLayerIds(next);
      return;
    }
    const children = pageBody.children as ComponentInstance[];
    editorUI.setCollapsedLayerIds(next.has(viewportId) ? collapseAll(next, children) : expandAll(next, children));
  };

  // Collapse all folds everything: the breakpoint groups and every container
  // row in them, so opening one group afterwards lists only its sections.
  // Expand all opens everything.
  const onCollapseAll = () => {
    const next = collapseAll(collapsed, roots);
    for (const id of viewportIds) next.add(id);
    editorUI.setCollapsedLayerIds(next);
  };
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
        const breakpointId = viewport.breakpointId!;

        return (
          <div key={viewport.id}>
            <BreakpointRow
              viewport={viewport}
              pageBody={pageBody}
              isCollapsed={isCollapsed}
              onToggleCollapse={(withSubtree) => toggleViewportCollapse(viewport.id, withSubtree)}
            />

            {/* Viewport content: the page body's children, or a definition's root */}
            {!isCollapsed && pageBody && pageBody.children.map((child: ComponentInstance) =>
              <LayerNode
                key={child.id}
                component={child}
                depth={0}
                breakpointId={breakpointId}
                breakpoints={breakpoints}
                hiddenByAncestor={!pageBody.canvasVisible}
              />
            )}
            {!isCollapsed && !pageBody && tree && (
              <LayerNode component={tree} depth={0} breakpointId={breakpointId} breakpoints={breakpoints} />
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
                breakpoints={breakpoints}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});

interface BreakpointRowProps {
  viewport: ComponentInstance;
  /** The page's root, which this row stands for; undefined inside a component definition. */
  pageBody?: ComponentInstance;
  isCollapsed: boolean;
  onToggleCollapse: (withSubtree: boolean) => void;
}

/**
 * A breakpoint group's row: chevron, device icon, uppercase name and width.
 * On a page it is the page body's row as well (see the file header): it
 * selects the root in this breakpoint, takes drops into the root (the drop
 * resolver reads `data-viewport-id` as "append to the page tree", never as a
 * sibling of the root), and carries the root's hide, lock and fold actions.
 */
const BreakpointRow = observer(({ viewport, pageBody, isCollapsed, onToggleCollapse }: BreakpointRowProps) => {
  const { editorUI } = useStore();
  const { menu, setMenu, moreButtonRef, closeMenu } = useRowMenu();
  const breakpointId = viewport.breakpointId;
  const breakpointWidth = viewport.breakpointMinWidth ?? 1280;
  const label = viewport.label ?? '';
  const DeviceIcon = viewportIconOf(label);
  const isSelected = !!pageBody && editorUI.isSelected(pageBody.id) &&
                     editorUI.selectedViewportNode?.breakpointId === breakpointId;
  const isDimmed = !!pageBody && !pageBody.canvasVisible;

  const menuItems: MenuItem[] = pageBody
    ? [
        ...visibilityItems(pageBody, false),
        {
          label: isCollapsed ? 'Expand' : 'Collapse',
          icon: isCollapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
          onClick: () => onToggleCollapse(false),
        },
      ]
    : [];

  return (
    <div>
      <div
        {...(pageBody
          ? {
              [DATA_VIEWPORT_ID]: viewport.id,
              'data-layer-row': pageBody.id,
              'data-layer-breakpoint': breakpointId,
            }
          : {})}
        className={`@container group relative flex items-center gap-1.5 h-[30px] px-1.5 rounded-[6px] cursor-pointer hover:bg-accent ${
          isSelected ? 'bg-brand/10' : ''
        }`}
        style={{ ['--layer-actions-w' as string]: `${layerActionsWidth(3)}px` }}
        onClick={(e) => {
          if (!pageBody) editorUI.setSelectedViewportNode(viewport);
          else if (e.shiftKey) editorUI.toggleInSelection(pageBody, breakpointId);
          else editorUI.selectComponent(pageBody, breakpointId);
        }}
        onContextMenu={(e) => {
          if (!pageBody) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${label}`}
          title={pageBody ? (isCollapsed ? 'Expand (Alt+click: with all children)' : 'Collapse (Alt+click: with all children)') : undefined}
          onPointerDown={stopPointer}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(e.altKey);
          }}
          className="w-[14px] h-[14px] flex items-center justify-center flex-none"
        >
          {isCollapsed ? (
            <ChevronRight size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </button>

        <DeviceIcon size={15} className={`flex-none ${isSelected ? 'text-brand' : 'text-muted-foreground'} ${isDimmed ? 'opacity-50' : ''}`} />

        <span
          className={`flex-1 truncate ${isSelected ? 'text-brand' : 'text-muted-foreground'} ${isDimmed ? 'opacity-50' : ''}`}
          style={{ fontSize: '12.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em' }}
        >
          {label}
        </span>

        <span
          className="font-mono text-muted-foreground bg-muted border border-border rounded-[5px]"
          style={{ fontSize: '10.5px', padding: '1px 6px' }}
        >
          {breakpointWidth}
        </span>

        {pageBody && (
          <RowActions
            component={pageBody}
            isTextRow={false}
            isSelected={isSelected}
            menuOpen={menu !== null}
            moreButtonRef={moreButtonRef}
            onOpenMenu={setMenu}
          />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
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
  /** The page's breakpoints, so a container's icon follows its layout in this breakpoint. */
  breakpoints: BreakpointRef[];
  /** An ancestor is hidden on the canvas: the row is dimmed like its parent. */
  hiddenByAncestor?: boolean;
}

const LayerNode = observer(({ component, depth, breakpointId, breakpoints, hiddenByAncestor = false }: LayerNodeProps) => {
  const { editorUI } = useStore();
  // A floating element (no breakpoint) reads as the largest breakpoint, as the canvas draws it.
  const IconComponent = layerIconOf(component, { breakpointId: breakpointId ?? '', breakpoints });
  // Primary and extra (marquee / Shift+click) selections both highlight.
  const isSelected = editorUI.isSelected(component.id) &&
                    (!breakpointId || editorUI.selectedViewportNode?.breakpointId === breakpointId);
  // An FX scene box also lists its scene's layers under its own children (derived rows, not nodes).
  const derived = derivedRowsOf(component);
  const hasChildren = component.children.length > 0 || !!derived;
  const isFolded = hasChildren && editorUI.collapsedLayerIds.has(component.id);
  const isDraggable = !component.isViewportNode && component.hasParent;
  const isHidden = !component.canvasVisible;
  // A text node has no element of its own: clicking its row selects the element
  // it sits in (whose panel edits it), and there is nothing on the canvas to lock.
  const isTextRow = isTextNodeType(component.type);
  const isDimmed = isHidden || hiddenByAncestor;
  const deletable = canDeleteLayer(component);
  // Width of the hover strip, reserved on the name so it truncates beside the
  // buttons instead of running under them (see the row's container query).
  const actionsWidth = layerActionsWidth(3);
  const name = component.displayName as string;
  // A placement is one row, and its menu reaches the definition.
  const definitionId = isPlacementType(component.type) ? (component.props as Partial<PlacementProps>).component : undefined;
  const definition = definitionId ? editorUI.currentProject?.components.get(definitionId) : undefined;

  const { menu, setMenu, moreButtonRef, closeMenu } = useRowMenu();

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

  const onDetach = () => {
    const page = editorUI.currentPage;
    if (page) requestDetach(editorUI, page.id, component.id, breakpointId);
  };

  // The row's own node when it is not part of the selection, otherwise the selection.
  const onCreateComponent = () => {
    if (!editorUI.isSelected(component.id)) editorUI.selectComponent(component, breakpointId);
    requestCreateComponent(editorUI);
  };

  const menuItems: MenuItem[] = [
    ...(definition
      ? [
          { label: 'Edit component', icon: <Pencil size={14} />, onClick: () => editorUI.enterComponent(definition.id, component.id) },
          { label: 'Detach', icon: <Unlink size={14} />, onClick: onDetach },
        ]
      : []),
    ...visibilityItems(component, isTextRow),
    ...(hasChildren
      ? [{
          label: isFolded ? 'Expand' : 'Collapse',
          icon: isFolded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
          onClick: () => editorUI.setCollapsedLayerIds(toggleFold(editorUI.collapsedLayerIds, component.id)),
        }]
      : []),
    ...(deletable && !isTextRow && component.hasParent
      ? [{ label: 'Create component', icon: <Component size={14} />, onClick: onCreateComponent }]
      : []),
    ...(deletable
      ? [
          { label: 'Duplicate', icon: <Copy size={14} />, onClick: onDuplicate },
          { label: 'Delete layer', icon: <Trash2 size={14} />, onClick: onDelete, destructive: true },
        ]
      : []),
  ];

  return (
    <div>
      {/* Component Row: 28px, group for hover-reveal */}
      <div
        data-inner-component-id={component.id}
        data-layer-row={component.id}
        data-layer-breakpoint={breakpointId}
        {...(isTextRow ? { [DATA_TEXT_NODE_ROW]: '' } : {})}
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

        <RowActions
          component={component}
          isTextRow={isTextRow}
          isSelected={isSelected}
          menuOpen={menu !== null}
          moreButtonRef={moreButtonRef}
          onOpenMenu={setMenu}
        />
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
          breakpoints={breakpoints}
          hiddenByAncestor={isDimmed}
        />
      )}

      {derived && !isFolded && (
        <FxSceneRows box={component} rows={derived.rows} depth={depth + 1} breakpointId={breakpointId} dimmed={isDimmed} />
      )}
    </div>
  );
});

LayersPanel.displayName = 'LayersPanel';
LayerNode.displayName = 'LayerNode';
BreakpointRow.displayName = 'BreakpointRow';

export default LayersPanel;
