// src/components/PhoneEditorChrome.tsx
//
// The editor's chrome on a phone (plan docs/plans/2026-10-24-editor-on-phones.md):
// a bottom bar docked to the screen edge, and the two side panels as bottom
// sheets opened from it. EditorApp mounts this instead of the docked sidebars
// and the floating Toolbar when useIsPhone() is true.
//
//   [Layers] [Undo] [Redo] [Select] [Hand] [Fit 34%] [Properties | Edit]
//
// - One sheet at a time: a single state value, opening one replaces the other.
// - Selecting an element does NOT open the properties sheet (it would cover
//   what was just tapped, and a touch that selects often goes on to drag the
//   element). Instead the Properties button turns into a highlighted "Edit"
//   button named after the selection.
// - When it mounts, and when the page changes, the camera fits the narrowest
//   breakpoint frame (the phone frame, normally) to the screen's width; the
//   Fit button fits every frame (an overview).
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { reaction } from 'mobx';
import { Layers, SlidersHorizontal, PencilLine } from 'lucide-react';
import { PiCursorLight, PiHandGrabbingBold, PiArrowUUpLeft, PiArrowUUpRight } from 'react-icons/pi';
import { EditorTool, type EditorUIType } from '@/stores/EditorUIStore';
import { getUndoManager } from '@/stores/RootStore';
import { useCameraControls, type CanvasInsets, type Rect } from '@/lib/canvas/cameraControls';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import LeftSidebar from '@/components/sidebars/LeftSidebar';
import RightSidebar from '@/components/sidebars/RightSidebar';

export type PhoneSheet = 'layers' | 'properties' | null;

/** The narrowest frame (the phone breakpoint in a default project), for the opening fit. */
export function narrowestFrame(frames: Rect[]): Rect[] {
  if (frames.length === 0) return frames;
  return [frames.reduce((a, b) => (b.width < a.width ? b : a))];
}

interface BarButtonProps {
  label: string;
  /** Accessible name when it differs from the visible label. */
  ariaLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** Highlighted (brand fill), e.g. Edit while something is selected. */
  emphasis?: boolean;
  expanded?: boolean;
  controls?: string;
  children: React.ReactNode;
}

function BarButton({ label, ariaLabel, onClick, disabled, pressed, emphasis, expanded, controls, children }: BarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : 'dialog'}
      aria-controls={controls}
      className={`flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 ${
        emphasis
          ? 'bg-brand text-white'
          : pressed
            ? 'bg-brand/12 text-brand'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {children}
      <span className="max-w-full truncate" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

function measureInsets(bar: HTMLElement | null): CanvasInsets {
  const top = document.querySelector<HTMLElement>('[data-editor-topbar]')?.getBoundingClientRect().bottom ?? 0;
  const bottom = bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0;
  return { top, bottom };
}

const PhoneEditorChrome = observer(({ editorUI }: { editorUI: EditorUIType }) => {
  const [sheet, setSheet] = React.useState<PhoneSheet>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const { zoomPercentage, fit } = useCameraControls();

  const undoManager = getUndoManager();
  const target = editorUI.selectedComponent ?? editorUI.selectedViewportNode;
  const hasSelection = !!target;

  // Fit the phone frame to the screen when the layout opens and when the page
  // changes. The frames render a frame or two after the page is set, so the
  // fit retries for a short while until there is something to measure.
  React.useEffect(() => {
    let raf = 0;
    const fitWhenReady = (triesLeft: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const done = fit({ mode: 'width', pick: narrowestFrame, padding: 16, insets: measureInsets(barRef.current) });
        if (!done && triesLeft > 0) fitWhenReady(triesLeft - 1);
      });
    };
    fitWhenReady(30);
    const stop = reaction(
      () => editorUI.currentPage?.id,
      () => fitWhenReady(30),
    );
    return () => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, [editorUI, fit]);

  const open = (next: Exclude<PhoneSheet, null>) => setSheet((cur) => (cur === next ? null : next));
  const onSheetChange = (which: Exclude<PhoneSheet, null>) => (isOpen: boolean) =>
    setSheet((cur) => (isOpen ? which : cur === which ? null : cur));

  const isSelect = editorUI.isToolSelected(EditorTool.SELECT);
  const isGrab = editorUI.isToolSelected(EditorTool.GRAB);

  return (
    <>
      <div
        ref={barRef}
        data-editor-ui="true"
        data-testid="phone-bottom-bar"
        role="toolbar"
        aria-label="Editor tools"
        className="fixed inset-x-0 bottom-0 z-90 border-t border-border bg-background px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex max-w-[560px] items-center gap-1">
          <BarButton label="Layers" ariaLabel="Pages and layers" onClick={() => open('layers')} expanded={sheet === 'layers'}>
            <Layers size={20} />
          </BarButton>
          <BarButton label="Undo" onClick={() => undoManager?.undo()} disabled={!undoManager?.canUndo}>
            <PiArrowUUpLeft size={20} />
          </BarButton>
          <BarButton label="Redo" onClick={() => undoManager?.redo()} disabled={!undoManager?.canRedo}>
            <PiArrowUUpRight size={20} />
          </BarButton>
          <BarButton label="Select" ariaLabel="Select tool" onClick={() => editorUI.setSelectedTool(EditorTool.SELECT)} pressed={isSelect}>
            <PiCursorLight size={20} />
          </BarButton>
          <BarButton label="Hand" ariaLabel="Hand tool, pan the canvas" onClick={() => editorUI.setSelectedTool(EditorTool.GRAB)} pressed={isGrab}>
            <PiHandGrabbingBold size={20} />
          </BarButton>
          <BarButton
            label={`${zoomPercentage}%`}
            ariaLabel={`Fit all frames to the screen (zoom ${zoomPercentage}%)`}
            onClick={() => fit({ mode: 'contain', insets: measureInsets(barRef.current) })}
          >
            <span className="text-[13px] font-semibold leading-none">Fit</span>
          </BarButton>
          <BarButton
            label={hasSelection ? 'Edit' : 'Properties'}
            ariaLabel={target ? `Edit ${target.displayName}` : 'Properties'}
            onClick={() => open('properties')}
            emphasis={hasSelection && sheet !== 'properties'}
            expanded={sheet === 'properties'}
          >
            {hasSelection ? <PencilLine size={20} /> : <SlidersHorizontal size={20} />}
          </BarButton>
        </div>
      </div>

      <BottomSheet
        open={sheet === 'layers'}
        onOpenChange={onSheetChange('layers')}
        title="Pages and layers"
        size="tall"
        data-testid="layers-sheet"
      >
        <LeftSidebar variant="sheet" />
      </BottomSheet>

      <BottomSheet
        open={sheet === 'properties'}
        onOpenChange={onSheetChange('properties')}
        title="Properties"
        size="medium"
        backdrop="light"
        data-testid="properties-sheet"
      >
        <RightSidebar variant="sheet" />
      </BottomSheet>
    </>
  );
});

PhoneEditorChrome.displayName = 'PhoneEditorChrome';
export default PhoneEditorChrome;
