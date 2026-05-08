// src/components/sidebars/LeftSidebar.tsx
// Split-pane sidebar: Pages on top, Components/Layers tabs on bottom, with a
// draggable divider between. The split is our deliberate improvement over
// Framer's mutually-exclusive tabs — the current page's layers stay visible
// while the user navigates between pages.
'use client';
import React, { useCallback, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Layers, Boxes, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStore } from '@/hooks/useStore';
import ComponentsPanel from './left/ComponentsPanel';
import LayersPanel from './left/LayersPanel';
import PagesPanel from './left/PagesPanel';

// Default and clamp values for the top (Pages) section height. The bottom
// section (Components / Layers) gets whatever is left.
const DEFAULT_TOP_HEIGHT = 240;
const MIN_TOP_HEIGHT = 120;
const MIN_BOTTOM_HEIGHT = 180;

const LeftSidebar = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.leftSidebarCollapsed;
  const [activeTab, setActiveTab] = useState<'components' | 'layers'>('layers');
  const [searchQuery, setSearchQuery] = useState('');
  const [topHeight, setTopHeight] = useState(DEFAULT_TOP_HEIGHT);
  const paneContainerRef = useRef<HTMLDivElement>(null);

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
    <div className={`
      bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)]
      ${isCollapsed ? 'w-12' : 'w-64'}
    `}>
      {/* Collapse toggle */}
      <div className="border-b border-gray-200 shrink-0">
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
      </div>

      {/* Split panes — only rendered when the sidebar is expanded. */}
      {!isCollapsed && (
        <div ref={paneContainerRef} className="flex-1 flex flex-col overflow-hidden">
          {/* Top pane: Pages */}
          <div
            style={{ height: topHeight }}
            className="shrink-0 overflow-hidden border-b border-gray-100"
          >
            <PagesPanel />
          </div>

          {/* Draggable divider. Thin 4px target with a visual 1px line; hover
              brightens it to signal affordance. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={onDividerPointerDown}
            className="h-1 shrink-0 cursor-row-resize bg-gray-200 hover:bg-blue-400 transition-colors"
          />

          {/* Bottom pane: Components / Layers */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex shrink-0 border-b border-gray-200">
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

            <div className="p-3 border-b border-gray-200 shrink-0">
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

            <div className="flex-1 overflow-y-auto p-3">
              {activeTab === 'components' && <ComponentsPanel />}
              {activeTab === 'layers' && <LayersPanel />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

LeftSidebar.displayName = 'LeftSidebar';
export default LeftSidebar;
