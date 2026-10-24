// PreviewShell wires together the toolbar and either the resizable fitted
// frame or a fullscreen-fill frame. `?fullscreen=1` records the choice so it
// is shareable and survives reloads; real browser fullscreen (see
// useFullscreen) is requested by the Fullscreen button or F, because browsers
// refuse it without a user gesture. A load with the param therefore shows the
// in-window fill with an "Enter fullscreen" prompt. State
// (width, height, reload key) lives here so the toolbar's W/H inputs and
// the gutters' drag deltas converge to a single source of truth.
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { getSharedPrismaDataSourceProvider } from '@/lib/bindings/dataSource/prismaProvider';
import EditorCommerceProvider from '@/components/EditorCommerceProvider';
import PreviewFrame from './PreviewFrame';
import FullscreenExitControl from './FullscreenExitControl';
import PreviewToolbar, { type PreviewMode } from './PreviewToolbar';
import ResizeGutter from './ResizeGutter';
import { useFullscreen } from './useFullscreen';

const MIN_WIDTH = 200;
const MAX_WIDTH = 4000;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 8000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface PreviewShellProps {
  /**
   * A `?page=` id the project does not have (typically a page that was never
   * saved, after a full reload): the home page shows instead, with a notice.
   */
  missingPageId?: string;
}

const PreviewShell = observer(({ missingPageId }: PreviewShellProps = {}) => {
  const rootStore = useStore();
  const page = rootStore.editorUI.currentPage;
  const project = rootStore.editorUI.currentProject;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The notice applies until the person picks a page themselves.
  const [showMissingNotice, setShowMissingNotice] = useState(Boolean(missingPageId));
  // The text goes in after the first paint, so the live region announces it.
  const [noticeReady, setNoticeReady] = useState(false);
  useEffect(() => setNoticeReady(true), []);
  // The param alone (a load or reload) fills the window under the toolbar;
  // `immersive` (real or fallback fullscreen) also drops every bit of chrome.
  const paramFill = searchParams.get('fullscreen') === '1';
  const rootRef = useRef<HTMLDivElement>(null);

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
  const widthRef = useRef(width);
  widthRef.current = width;

  const setWidth = useCallback((next: number) => {
    setWidthRaw(clamp(Math.round(next), MIN_WIDTH, MAX_WIDTH));
  }, []);
  const setHeight = useCallback((next: number) => {
    setHeightRaw(clamp(Math.round(next), MIN_HEIGHT, MAX_HEIGHT));
  }, []);

  // Every address change stays on THIS preview (the project's, or the demo's
  // /preview) and keeps the other parameters, the page included. Written with
  // history.replaceState, which Next keeps useSearchParams in step with: no
  // navigation, so switching page or fullscreen never reloads the project
  // from the server (that would also drop unsaved work shown here).
  const replaceParams = useCallback((change: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    change(params);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, searchParams]);

  // Esc, the exit control or the browser ended real fullscreen: back to the
  // fitted preview, with the param gone so a reload agrees.
  const onLeaveFullscreen = useCallback(() => {
    replaceParams((params) => params.delete('fullscreen'));
  }, [replaceParams]);
  const fullscreen = useFullscreen(rootRef, { onLeave: onLeaveFullscreen });
  const { immersive } = fullscreen;
  const isFill = paramFill || immersive;
  useEffect(() => {
    if (!isFill) return;
    const onResize = () => setWindowWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    // Entering real fullscreen changes the width without always firing resize.
    document.addEventListener('fullscreenchange', onResize);
    document.addEventListener('webkitfullscreenchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
      document.removeEventListener('webkitfullscreenchange', onResize);
    };
  }, [isFill]);
  const mode: PreviewMode = isFill ? 'fullscreen' : 'fitted';

  const onEnterFullscreen = useCallback(() => {
    // The request goes first so it still counts as the click's user gesture.
    const entering = fullscreen.enter();
    if (!paramFill) replaceParams((params) => params.set('fullscreen', '1'));
    return entering;
  }, [fullscreen, paramFill, replaceParams]);
  const onExitFullscreen = useCallback(() => {
    void fullscreen.exit();
    replaceParams((params) => params.delete('fullscreen'));
  }, [fullscreen, replaceParams]);
  // Fill from a load (param only): the button enters real fullscreen. Once
  // immersive, or when fitted, it toggles as usual.
  const onToggleMode = useCallback(() => {
    if (immersive) onExitFullscreen();
    else void onEnterFullscreen();
  }, [immersive, onEnterFullscreen, onExitFullscreen]);

  // F toggles fullscreen unless the person is typing somewhere.
  const onToggleModeRef = useRef(onToggleMode);
  onToggleModeRef.current = onToggleMode;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      onToggleModeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onPageChange = useCallback((pageId: string) => {
    const next = project?.getPage(pageId);
    if (!next) return;
    rootStore.editorUI.setCurrentPage(next);
    setShowMissingNotice(false);
    replaceParams((params) => params.set('page', pageId));
  }, [project, rootStore, replaceParams]);

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
        <Link href="/projects" className="text-xs text-brand hover:underline">
          Open your projects →
        </Link>
      </div>
    );
  }

  const viewportNodes = page.sortedViewportNodes;
  // Back to the editor on the same page: the project's editor, or the
  // browser-only demo editor at `/` for its project.
  const editorBase = rootStore.editorUI.isUnsavedDemo ? '/' : `/projects/${project.id}`;
  const editorHref = `${editorBase}?page=${encodeURIComponent(page.id)}`;
  // Title plus address, so two pages with the same title can be told apart.
  const pages = project.pagesArray.map((p) => ({
    id: p.id,
    title: `${p.metadata.title || 'Untitled page'} (/${p.slug ?? ''})`,
  }));
  const isDemo = rootStore.editorUI.isUnsavedDemo;
  const activeBreakpointId = viewportNodes.find(v => v.viewportWidth === width)?.breakpointId;

  return (
    <DataSourceProviderContext.Provider value={getSharedPrismaDataSourceProvider()}>
    <EditorCommerceProvider>
    <div ref={rootRef} className="w-screen h-screen flex flex-col bg-gray-950">
      {immersive ? (
        <FullscreenExitControl onExit={onExitFullscreen} />
      ) : (
      <>
      <PreviewToolbar
        viewportNodes={viewportNodes}
        width={width}
        height={height}
        activeBreakpointId={activeBreakpointId}
        mode={mode}
        enterOnly={paramFill && !immersive}
        onWidthChange={setWidth}
        onHeightChange={setHeight}
        onPresetChange={onPresetChange}
        onReload={() => setReloadKey(k => k + 1)}
        onToggleMode={onToggleMode}
        editorHref={editorHref}
        pages={pages}
        currentPageId={page.id}
        onPageChange={onPageChange}
      />
      {/* Always present, so the notice is announced when its text appears. */}
      <div
        role="status"
        aria-live="polite"
        className={showMissingNotice && noticeReady ? 'flex items-center gap-3 bg-amber-950 px-3 py-1.5 text-xs text-amber-100' : 'sr-only'}
      >
        {showMissingNotice && noticeReady ? (
          <>
            <span>
              {isDemo
                ? 'That page is not in this demo project, so its home page is shown.'
                : 'The page you asked for is not in the saved project (it may not be saved yet), so the home page is shown. Save in the editor, then preview again.'}
            </span>
            <button
              type="button"
              onClick={() => setShowMissingNotice(false)}
              className="ml-auto rounded px-1.5 hover:bg-amber-900"
              aria-label="Dismiss notice"
            >
              ×
            </button>
          </>
        ) : null}
      </div>
      {paramFill && !immersive ? (
        <div className="flex items-center gap-3 bg-gray-800 px-3 py-1.5 text-xs text-gray-200">
          <span>This preview fills the window. Enter fullscreen to see the page alone (or press F).</span>
          <button
            type="button"
            onClick={() => void onEnterFullscreen()}
            className="rounded bg-brand px-2 py-1 text-white hover:opacity-90"
          >
            Enter fullscreen
          </button>
          <button
            type="button"
            onClick={onExitFullscreen}
            className="rounded px-2 py-1 hover:bg-gray-700"
          >
            Show fitted preview
          </button>
        </div>
      ) : null}
      </>
      )}

      {isFill ? (
        <div className="flex-1 min-h-0 overflow-hidden" style={{ background: '#0b0d12' }}>
          <PreviewFrame
            key={reloadKey}
            page={page}
            width={windowWidth}
            height={0}
            fill
            smoothScroll={project?.site.smoothScroll ?? false}
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
              <PreviewFrame
                key={reloadKey}
                page={page}
                width={width}
                height={height}
                smoothScroll={project?.site.smoothScroll ?? false}
              />
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
    </EditorCommerceProvider>
    </DataSourceProviderContext.Provider>
  );
});

PreviewShell.displayName = 'PreviewShell';
export default PreviewShell;
