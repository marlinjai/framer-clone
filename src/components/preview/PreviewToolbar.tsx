// Top toolbar for the preview. Hosts back to the editor, reload, the frame
// choice (fill the window, or a device frame with its breakpoint preset and
// W/H inputs), real fullscreen and the page picker. All controls are
// stateless: they read from props and call callbacks owned by the shell.
// Under 768px the button labels collapse to icons (they stay the accessible
// names) and the width and height inputs are hidden.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowLeft, RefreshCw, Maximize2, Smartphone } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';

/** How the page is framed: at the window's width, or in a sized device frame. */
export type PreviewFrameMode = 'fill' | 'device';

export interface PreviewToolbarProps {
  viewportNodes: readonly ComponentInstance[];
  width: number;
  height: number;
  activeBreakpointId: string | undefined;
  frame: PreviewFrameMode;
  onFrameChange: (frame: PreviewFrameMode) => void;
  onWidthChange: (next: number) => void;
  onHeightChange: (next: number) => void;
  onPresetChange: (viewport: ComponentInstance) => void;
  onReload: () => void;
  /** Real browser fullscreen: only the page, with a floating way out. */
  onEnterFullscreen: () => void;
  /** "Editor": back to the editor on the page being previewed. */
  onBack: () => void;
  pages: ReadonlyArray<{ id: string; title: string }>;
  currentPageId: string;
  onPageChange: (pageId: string) => void;
}

const PreviewToolbar = observer(({
  viewportNodes,
  width,
  height,
  activeBreakpointId,
  frame,
  onFrameChange,
  onWidthChange,
  onHeightChange,
  onPresetChange,
  onReload,
  onEnterFullscreen,
  onBack,
  pages,
  currentPageId,
  onPageChange,
}: PreviewToolbarProps) => {
  const isDevice = frame === 'device';

  return (
    <div className="flex items-center gap-1 md:gap-2 h-12 px-2 md:px-3 bg-gray-900 text-gray-100 border-b border-gray-800">
      {/* Back to editor */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
        title="Back to the editor, on this page"
      >
        <ArrowLeft size={14} />
        <span className="text-xs max-md:sr-only">Editor</span>
      </button>

      <div className="w-px h-6 bg-gray-700 mx-1 max-md:hidden" />

      <button
        type="button"
        onClick={onReload}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
        title="Reload preview"
      >
        <RefreshCw size={14} />
        <span className="text-xs max-md:sr-only">Reload</span>
      </button>

      {/* The page fills the window by default, like a visitor sees it; the
          device frame sizes it to a breakpoint instead. */}
      <button
        type="button"
        onClick={() => onFrameChange(isDevice ? 'fill' : 'device')}
        className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800 ${isDevice ? 'bg-gray-800' : ''}`}
        title={isDevice ? 'Fill the window again' : 'Show the page in a device frame'}
        aria-pressed={isDevice}
      >
        <Smartphone size={14} />
        <span className="text-xs max-md:sr-only">Device frame</span>
      </button>

      <button
        type="button"
        onClick={onEnterFullscreen}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
        title="Fullscreen (F)"
      >
        <Maximize2 size={14} />
        <span className="text-xs max-md:sr-only">Fullscreen</span>
      </button>

      <div className="w-px h-6 bg-gray-700 mx-1 max-md:hidden" />

      {/* Which page to preview (also in fullscreen). */}
      <select
        aria-label="Page"
        value={currentPageId}
        onChange={(e) => onPageChange(e.target.value)}
        className="min-w-0 max-w-[220px] max-md:max-w-[120px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100"
        title="Page to preview"
      >
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>

      <div className="flex-1" />

      {/* Device-frame-only controls. Filling the window, the width is the
          window's, so preset + W/H inputs are hidden to keep the toolbar clean. */}
      {isDevice && (
        <>
          <select
            value={activeBreakpointId ?? ''}
            onChange={(e) => {
              const v = viewportNodes.find(n => n.breakpointId === e.target.value);
              if (v) onPresetChange(v);
            }}
            aria-label="Breakpoint"
            className="min-w-0 max-md:max-w-[110px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100"
            title="Breakpoint preset"
          >
            {viewportNodes.map(v => (
              <option key={v.breakpointId} value={v.breakpointId}>
                {v.label}
              </option>
            ))}
          </select>

          {/* Width and height inputs: not on a phone, where the breakpoint
              preset is the useful control and there is no room. */}
          <div className="flex items-center gap-2 max-md:hidden">
            <NumberInput
              ariaLabel="Width"
              value={width}
              onCommit={onWidthChange}
              suffix="W"
            />
            <NumberInput
              ariaLabel="Height"
              value={height}
              onCommit={onHeightChange}
              suffix="H"
            />
          </div>
        </>
      )}
    </div>
  );
});

PreviewToolbar.displayName = 'PreviewToolbar';
export default PreviewToolbar;

interface NumberInputProps {
  ariaLabel: string;
  value: number;
  onCommit: (next: number) => void;
  suffix: string;
}

// Tiny controlled-to-uncontrolled adapter: the displayed value tracks the
// prop, but typing only commits on blur or Enter so the user can scrub the
// digits without triggering a re-resolve on every keystroke.
function NumberInput({ ariaLabel, value, onCommit, suffix }: NumberInputProps) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n > 0) onCommit(n);
    else setDraft(String(value));
  };

  return (
    <div className="flex items-center bg-gray-800 border border-gray-700 rounded">
      <input
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setDraft(String(value));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        className="w-16 bg-transparent px-2 py-1 text-xs text-right outline-none"
        inputMode="numeric"
      />
      <span className="px-2 text-[10px] text-gray-500 border-l border-gray-700">{suffix}</span>
    </div>
  );
}
