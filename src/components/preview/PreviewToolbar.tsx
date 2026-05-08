// Top toolbar for /preview. Hosts back navigation, reload, fullscreen, the
// breakpoint preset selector, and W/H number inputs. All controls are
// stateless: they read from props and call onChange callbacks owned by the
// shell.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, Maximize2, Minimize2 } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';

export type PreviewMode = 'fitted' | 'fullscreen';

export interface PreviewToolbarProps {
  viewportNodes: readonly ComponentInstance[];
  width: number;
  height: number;
  activeBreakpointId: string | undefined;
  mode: PreviewMode;
  onWidthChange: (next: number) => void;
  onHeightChange: (next: number) => void;
  onPresetChange: (viewport: ComponentInstance) => void;
  onReload: () => void;
  onToggleMode: () => void;
}

const PreviewToolbar = observer(({
  viewportNodes,
  width,
  height,
  activeBreakpointId,
  mode,
  onWidthChange,
  onHeightChange,
  onPresetChange,
  onReload,
  onToggleMode,
}: PreviewToolbarProps) => {
  const router = useRouter();
  const isFullscreen = mode === 'fullscreen';

  return (
    <div className="flex items-center gap-2 h-12 px-3 bg-gray-900 text-gray-100 border-b border-gray-800">
      {/* Back to editor */}
      <button
        type="button"
        onClick={() => router.push('/')}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
        title="Back to editor"
      >
        <ArrowLeft size={14} />
        <span className="text-xs">Editor</span>
      </button>

      <div className="w-px h-6 bg-gray-700 mx-1" />

      <button
        type="button"
        onClick={onReload}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
        title="Reload preview"
      >
        <RefreshCw size={14} />
        <span className="text-xs">Reload</span>
      </button>

      <button
        type="button"
        onClick={onToggleMode}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        aria-pressed={isFullscreen}
      >
        {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        <span className="text-xs">{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
      </button>

      <div className="flex-1" />

      {/* Fitted-mode-only controls. In fullscreen the frame always fills the
          viewport, so preset + W/H inputs are hidden to keep the toolbar clean. */}
      {!isFullscreen && (
        <>
          <select
            value={activeBreakpointId ?? ''}
            onChange={(e) => {
              const v = viewportNodes.find(n => n.breakpointId === e.target.value);
              if (v) onPresetChange(v);
            }}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100"
            title="Breakpoint preset"
          >
            {viewportNodes.map(v => (
              <option key={v.breakpointId} value={v.breakpointId}>
                {v.label}
              </option>
            ))}
          </select>

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
