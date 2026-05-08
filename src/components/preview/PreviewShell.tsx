// PreviewShell wires together the toolbar and either the resizable fitted
// frame or a fullscreen-fill frame. Mode is driven by the `?fullscreen=1`
// query param so the choice is shareable and survives reloads. State
// (width, height, reload key) lives here so the toolbar's W/H inputs and
// the gutters' drag deltas converge to a single source of truth.
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { getSharedInMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import PreviewFrame from './PreviewFrame';
import PreviewToolbar, { type PreviewMode } from './PreviewToolbar';
import ResizeGutter from './ResizeGutter';

const MIN_WIDTH = 200;
const MAX_WIDTH = 4000;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 8000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const PreviewShell = observer(() => {
  const rootStore = useStore();
  const page = rootStore.editorUI.currentPage;
  const project = rootStore.editorUI.currentProject;
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode: PreviewMode = searchParams.get('fullscreen') === '1' ? 'fullscreen' : 'fitted';
  const isFullscreen = mode === 'fullscreen';

  // Initial frame size: largest viewport's dimensions, falling back to a
  // standard desktop size if the page has no viewports yet.
  const initialViewport = page?.sortedViewportNodes[0];
  const [width, setWidthRaw] = useState<number>(initialViewport?.viewportWidth ?? 1280);
  const [height, setHeightRaw] = useState<number>(initialViewport?.viewportHeight ?? 800);
  const [reloadKey, setReloadKey] = useState(0);

  // Live window width while in fullscreen mode. Used only for breakpoint
  // resolution; the frame itself fills via CSS so its actual rendered width
  // always matches the viewport regardless of this value.
  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    if (!isFullscreen) return;
    const onResize = () => setWindowWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isFullscreen]);

  const widthRef = useRef(width);
  widthRef.current = width;

  const setWidth = useCallback((next: number) => {
    setWidthRaw(clamp(Math.round(next), MIN_WIDTH, MAX_WIDTH));
  }, []);
  const setHeight = useCallback((next: number) => {
    setHeightRaw(clamp(Math.round(next), MIN_HEIGHT, MAX_HEIGHT));
  }, []);

  const onToggleMode = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (isFullscreen) params.delete('fullscreen');
    else params.set('fullscreen', '1');
    const qs = params.toString();
    router.replace(qs ? `/preview?${qs}` : '/preview');
  }, [isFullscreen, router, searchParams]);

  const onPresetChange = useCallback((viewport: ComponentInstance) => {
    if (viewport.viewportWidth) setWidth(viewport.viewportWidth);
    if (viewport.viewportHeight) setHeight(viewport.viewportHeight);
  }, [setWidth, setHeight]);

  // Empty / not-yet-loaded state: someone hit /preview directly without first
  // mounting the editor (which is what seeds the demo project today). Offer a
  // link back rather than crashing.
  if (!project || !page) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-gray-900 text-gray-300 gap-3">
        <div className="text-sm">No project is loaded.</div>
        <Link href="/" className="text-xs text-blue-400 hover:underline">
          Open the editor →
        </Link>
      </div>
    );
  }

  const viewportNodes = page.sortedViewportNodes;
  const activeBreakpointId = viewportNodes.find(v => v.viewportWidth === width)?.breakpointId;

  return (
    <DataSourceProviderContext.Provider value={getSharedInMemoryDataSourceProvider()}>
    <div className="w-screen h-screen flex flex-col bg-gray-950">
      <PreviewToolbar
        viewportNodes={viewportNodes}
        width={width}
        height={height}
        activeBreakpointId={activeBreakpointId}
        mode={mode}
        onWidthChange={setWidth}
        onHeightChange={setHeight}
        onPresetChange={onPresetChange}
        onReload={() => setReloadKey(k => k + 1)}
        onToggleMode={onToggleMode}
      />

      {isFullscreen ? (
        <div className="flex-1 min-h-0 overflow-hidden" style={{ background: '#0b0d12' }}>
          <PreviewFrame
            key={reloadKey}
            page={page}
            width={windowWidth}
            height={0}
            fill
          />
        </div>
      ) : (
        <div className="flex-1 overflow-auto" style={{ background: '#0b0d12' }}>
          {/* Centered column. Top padding leaves room for the gutter "feel" and
              mirrors Framer's preview canvas spacing. */}
          <div className="min-h-full flex items-start justify-center py-12">
            <div className="relative" style={{ width }}>
              <ResizeGutter
                side="left"
                onResize={setWidth}
                getStartWidth={() => widthRef.current}
              />
              <PreviewFrame key={reloadKey} page={page} width={width} height={height} />
              <ResizeGutter
                side="right"
                onResize={setWidth}
                getStartWidth={() => widthRef.current}
              />
            </div>
          </div>
        </div>
      )}
    </div>
    </DataSourceProviderContext.Provider>
  );
});

PreviewShell.displayName = 'PreviewShell';
export default PreviewShell;
