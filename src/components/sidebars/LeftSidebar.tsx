// src/components/sidebars/LeftSidebar.tsx
// Split-pane sidebar: Pages on top, Components/Layers tabs on bottom, with a
// draggable divider between. The split is our deliberate improvement over
// Framer's mutually-exclusive tabs: the current page's layers stay visible
// while the user navigates between pages.
//
// The sidebar's width is adjustable from a handle on its right edge (drag,
// Arrow keys, Home / End, double-click resets) and remembered per browser
// (src/lib/layers/sidebarWidth.ts). The sidebar floats over the full-screen
// canvas, so nothing else in the editor offsets itself by this width.
'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStore } from '@/hooks/useStore';
import ComponentsPanel from './left/ComponentsPanel';
import LayersPanel from './left/LayersPanel';
import PagesPanel from './left/PagesPanel';
import { PaneTabs, paneTabId, panePanelId, type PaneTab } from './left/PaneTabs';
import ContentManagerPanel from '@/components/cms/ContentManagerPanel';
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_KEY_STEP,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  clampLeftSidebarWidth,
  loadLeftSidebarWidth,
  saveLeftSidebarWidth,
} from '@/lib/layers/sidebarWidth';

// Default and clamp values for the top (Pages) section height. The bottom
// section (Components / Layers) gets whatever is left.
const DEFAULT_TOP_HEIGHT = 240;
const MIN_TOP_HEIGHT = 120;
const MIN_BOTTOM_HEIGHT = 180;

type BottomTab = 'components' | 'layers' | 'content';

const BOTTOM_TABS: readonly PaneTab<BottomTab>[] = [
  { id: 'components', label: 'Components' },
  { id: 'layers', label: 'Layers' },
  { id: 'content', label: 'Content' },
];

const LeftSidebar = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.leftSidebarCollapsed;
  const [activeTab, setActiveTab] = useState<BottomTab>('layers');
  const tabsId = useId();
  const [searchQuery, setSearchQuery] = useState('');
  const [topHeight, setTopHeight] = useState(DEFAULT_TOP_HEIGHT);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const width = editorUI.leftSidebarWidth;
  // While the width handle is dragged the collapse transition is off, so the
  // edge follows the pointer instead of easing behind it.
  const [isResizingWidth, setIsResizingWidth] = useState(false);
  // Off until the remembered width is applied, so a stored width does not
  // animate in from the default on every editor load.
  const [widthLoaded, setWidthLoaded] = useState(false);

  // The remembered width is read after mount (storage is browser-only, and
  // reading it during render would differ from the server render).
  useEffect(() => {
    editorUI.setLeftSidebarWidth(loadLeftSidebarWidth());
    setWidthLoaded(true);
  }, [editorUI]);

  const commitWidth = useCallback((next: number) => {
    const clamped = clampLeftSidebarWidth(next);
    editorUI.setLeftSidebarWidth(clamped);
    saveLeftSidebarWidth(clamped);
  }, [editorUI]);

  // Width handle drag: same document-level pointermove/up approach as the
  // Pages divider below. The width is saved once, when the drag ends.
  const onWidthHandlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = editorUI.leftSidebarWidth;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setIsResizingWidth(true);

    const onMove = (moveEvent: PointerEvent) => {
      editorUI.setLeftSidebarWidth(startWidth + (moveEvent.clientX - startX));
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', cleanup);
      document.removeEventListener('pointercancel', cleanup);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setIsResizingWidth(false);
      saveLeftSidebarWidth(editorUI.leftSidebarWidth);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', cleanup);
    document.addEventListener('pointercancel', cleanup);
  }, [editorUI]);

  const onWidthHandleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = editorUI.leftSidebarWidth - LEFT_SIDEBAR_KEY_STEP;
    else if (event.key === 'ArrowRight') next = editorUI.leftSidebarWidth + LEFT_SIDEBAR_KEY_STEP;
    else if (event.key === 'Home') next = LEFT_SIDEBAR_MIN_WIDTH;
    else if (event.key === 'End') next = LEFT_SIDEBAR_MAX_WIDTH;
    else if (event.key === 'Enter') next = LEFT_SIDEBAR_DEFAULT_WIDTH;
    if (next === undefined) return;
    // Arrow keys must not also nudge a selected canvas node.
    event.preventDefault();
    event.stopPropagation();
    commitWidth(next);
  }, [editorUI, commitWidth]);

  // Divider drag: plain document-level pointermove/up listeners. Clamped by
  // the container's current height so the Pages pane can't eat all of the
  // Components/Layers pane (and vice versa).
  const onDividerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startTop = topHeight;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent) => {
      const container = paneContainerRef.current;
      if (!container) return;
      const height = container.clientHeight;
      const maxTop = height - MIN_BOTTOM_HEIGHT;
      const next = Math.max(MIN_TOP_HEIGHT, Math.min(maxTop, startTop + (moveEvent.clientY - startY)));
      setTopHeight(next);
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', cleanup);
      document.removeEventListener('pointercancel', cleanup);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', cleanup);
    document.addEventListener('pointercancel', cleanup);
  }, [topHeight]);

  return (
    <div
      className={`
        relative bg-background border-r border-border flex flex-col h-[calc(100vh-4rem)]
        ${widthLoaded && !isResizingWidth ? 'transition-[width] duration-300 ease-in-out' : ''}
        ${isCollapsed ? 'w-12' : ''}
      `}
      style={isCollapsed ? undefined : { width }}
    >
      {/* Width handle on the right edge, only while expanded. A 6px hit area
          centred on the border; hover and focus show the brand line. */}
      {!isCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
          aria-valuetext={`${width} pixels`}
          tabIndex={0}
          title="Drag to resize, double-click to reset"
          onPointerDown={onWidthHandlePointerDown}
          onDoubleClick={() => commitWidth(LEFT_SIDEBAR_DEFAULT_WIDTH)}
          onKeyDown={onWidthHandleKeyDown}
          className={`absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize outline-none transition-colors hover:bg-brand focus-visible:bg-brand ${
            isResizingWidth ? 'bg-brand' : ''
          }`}
        />
      )}

      {/* Collapse toggle */}
      <div className="border-b border-border shrink-0">
        <div className="h-12 flex items-center justify-between px-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editorUI.toggleLeftSidebar()}
            className="p-1 hover:bg-accent"
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </Button>
          {!isCollapsed && (
            <div className="text-sm font-medium text-foreground">Design</div>
          )}
        </div>
      </div>

      {/* Split panes, only rendered when the sidebar is expanded. */}
      {!isCollapsed && (
        <div ref={paneContainerRef} className="flex-1 flex flex-col overflow-hidden">
          {/* Top pane: Pages */}
          <div
            style={{ height: topHeight }}
            className="shrink-0 overflow-hidden border-b border-border"
          >
            <PagesPanel />
          </div>

          {/* Draggable divider. Thin 4px target with a visual 1px line; hover
              brightens it to signal affordance. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={onDividerPointerDown}
            className="h-1 shrink-0 cursor-row-resize bg-border hover:bg-brand transition-colors"
          />

          {/* Bottom pane: Components / Layers / Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="shrink-0 px-3 pt-3">
              <PaneTabs
                tabs={BOTTOM_TABS}
                active={activeTab}
                onChange={setActiveTab}
                label="Sidebar panels"
                idPrefix={tabsId}
              />
            </div>

            <div className="p-3 border-b border-border shrink-0">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={`Search ${activeTab}...`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-8 text-sm"
                />
              </div>
            </div>

            <div
              role="tabpanel"
              id={panePanelId(tabsId, activeTab)}
              aria-labelledby={paneTabId(tabsId, activeTab)}
              className="flex-1 overflow-y-auto p-3"
            >
              {activeTab === 'components' && <ComponentsPanel />}
              {activeTab === 'layers' && <LayersPanel />}
              {activeTab === 'content' && <ContentManagerPanel />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

LeftSidebar.displayName = 'LeftSidebar';
export default LeftSidebar;
