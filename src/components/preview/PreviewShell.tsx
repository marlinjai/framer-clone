// PreviewShell wires together the toolbar and the page, either filling the
// window (the default, how a visitor sees it) or in the resizable device
// frame; the choice is remembered per browser (framePreference). Real browser
// fullscreen (see useFullscreen) is requested by the Fullscreen button or F,
// because browsers refuse it without a user gesture. It runs in two places:
// over the editor (PreviewOverlay, `onClose` set: instant, from the store the
// editor already holds) and at the preview routes for direct links. State
// (width, height, reload key) lives here so the toolbar's W/H inputs and
// the gutters' drag deltas converge to a single source of truth.
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { getSharedPrismaDataSourceProvider } from '@/lib/bindings/dataSource/prismaProvider';
import EditorCommerceProvider from '@/components/EditorCommerceProvider';
import PreviewFrame from './PreviewFrame';
import FullscreenExitControl from './FullscreenExitControl';
import PreviewToolbar, { type PreviewFrameMode } from './PreviewToolbar';
import { readFramePreference, writeFramePreference } from './framePreference';
import ResizeGutter from './ResizeGutter';
import { useFullscreen } from './useFullscreen';

const MIN_WIDTH = 200;
const MAX_WIDTH = 4000;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 8000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The breakpoint frame to open the preview with on a window narrower than the
 * widest frame (a phone): the widest frame that fits the window, else the
 * narrowest one. Null when the widest already fits (keep it, as before).
 */
export function viewportForWindow(
  viewports: ReadonlyArray<{ viewportWidth?: number; viewportHeight?: number }>,
  windowWidth: number,
): { width: number; height: number } | null {
  const sized = viewports
    .filter((v): v is { viewportWidth: number; viewportHeight?: number } => typeof v.viewportWidth === 'number')
    .slice()
    .sort((a, b) => b.viewportWidth - a.viewportWidth);
  if (sized.length === 0 || sized[0].viewportWidth <= windowWidth) return null;
  const pick = sized.find((v) => v.viewportWidth <= windowWidth) ?? sized[sized.length - 1];
  return { width: pick.viewportWidth, height: pick.viewportHeight ?? 800 };
}

export interface PreviewShellProps {
  /**
   * A `?page=` id the project does not have (typically a page that was never
   * saved, after a full reload): the home page shows instead, with a notice.
   */
  missingPageId?: string;
  /**
   * Set when the preview is shown over the editor (PreviewOverlay): "Editor"
   * and Escape close it, and the address is left to the editor.
   */
  onClose?: () => void;
}

const PreviewShell = observer(({ missingPageId, onClose }: PreviewShellProps = {}) => {
  const rootStore = useStore();
  const page = rootStore.editorUI.currentPage;
  const project = rootStore.editorUI.currentProject;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  // The notice applies until the person picks a page themselves.
  const [showMissingNotice, setShowMissingNotice] = useState(Boolean(missingPageId));
  // The text goes in after the first paint, so the live region announces it.
  const [noticeReady, setNoticeReady] = useState(false);
  useEffect(() => setNoticeReady(true), []);
  // Fill the window (the default) or the device frame; `immersive` (real or
  // fallback fullscreen) also drops every bit of chrome.
  const [frame, setFrameRaw] = useState<PreviewFrameMode>(() =>
    typeof window === 'undefined' ? 'fill' : readFramePreference(),
  );
  const setFrame = useCallback((next: PreviewFrameMode) => {
    setFrameRaw(next);
    writeFramePreference(next);
  }, []);
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

  // On a window narrower than the widest frame (a phone), open on the frame
  // that fits instead (plan docs/plans/2026-10-24-editor-on-phones.md). After
  // mount, so the server render and hydration agree.
  useEffect(() => {
    if (!page) return;
    const fit = viewportForWindow(page.sortedViewportNodes, window.innerWidth);
    if (!fit) return;
    setWidthRaw(fit.width);
    setHeightRaw(fit.height);
    // Only the first size: later choices are the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setWidth = useCallback((next: number) => {
    setWidthRaw(clamp(Math.round(next), MIN_WIDTH, MAX_WIDTH));
  }, []);
  const setHeight = useCallback((next: number) => {
    setHeightRaw(clamp(Math.round(next), MIN_HEIGHT, MAX_HEIGHT));
  }, []);

  // Every address change stays on THIS preview (the project's, or the demo's
  // /preview) and keeps the other parameters, the page included. Written with
  // history.replaceState, which Next keeps useSearchParams in step with: no
  // navigation, so switching page never reloads the project from the server
  // (that would also drop unsaved work shown here). Over the editor the
  // address is the editor's, which keeps `?page=` in step by itself.
  const replaceParams = useCallback((change: (params: URLSearchParams) => void) => {
    if (onClose) return;
    const params = new URLSearchParams(searchParams.toString());
    change(params);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, searchParams, onClose]);

  const fullscreen = useFullscreen(rootRef);
  const { immersive } = fullscreen;
  const isFill = frame === 'fill' || immersive;
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

  // The request is made inside the click or key handler, so it still counts
  // as the person's gesture.
  const onEnterFullscreen = useCallback(() => {
    void fullscreen.enter();
  }, [fullscreen]);
  const onExitFullscreen = useCallback(() => {
    void fullscreen.exit();
  }, [fullscreen]);

  // F toggles fullscreen unless the person is typing somewhere. Escape leaves
  // the in-window fullscreen stand-in (the browser handles its own), and over
  // the editor otherwise closes the preview.
  const keysRef = useRef({ immersive, native: fullscreen.native, onEnterFullscreen, onExitFullscreen, onClose });
  keysRef.current = { immersive, native: fullscreen.native, onEnterFullscreen, onExitFullscreen, onClose };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
      const k = keysRef.current;
      if (e.key === 'Escape') {
        if (e.defaultPrevented || typing) return;
        if (k.immersive) {
          if (!k.native) {
            e.preventDefault();
            k.onExitFullscreen();
          }
          return;
        }
        if (k.onClose) {
          e.preventDefault();
          k.onClose();
        }
        return;
      }
      if (e.key.toLowerCase() !== 'f' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing) return;
      e.preventDefault();
      if (k.immersive) k.onExitFullscreen();
      else k.onEnterFullscreen();
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
  // Back to the editor on the same page: over the editor, close; at a route,
  // the project's editor, or the browser-only demo editor at `/`.
  const editorBase = rootStore.editorUI.isUnsavedDemo ? '/' : `/projects/${project.id}`;
  const editorHref = `${editorBase}?page=${encodeURIComponent(page.id)}`;
  const onBack = onClose ?? (() => router.push(editorHref));
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
        frame={frame}
        onFrameChange={setFrame}
        onWidthChange={setWidth}
        onHeightChange={setHeight}
        onPresetChange={onPresetChange}
        onReload={() => setReloadKey(k => k + 1)}
        onEnterFullscreen={onEnterFullscreen}
        onBack={onBack}
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
