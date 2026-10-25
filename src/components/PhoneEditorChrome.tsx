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
//   element). Instead the Properties button becomes an "Edit" button named
//   after the selection, highlighted while the selection is new (not yet
//   opened, and not the root element a page selects by itself when it opens).
// - When it mounts, and when the page changes, the camera fits the narrowest
//   breakpoint frame (the phone frame, normally) to the screen's width; the
//   Fit button fits every frame (an overview).
// - While a text is edited inline on the canvas, the bar and any sheet step
//   aside (nothing may cover the text), and the camera pans the text into
//   the part of the screen the on-screen keyboard leaves visible.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { reaction } from 'mobx';
import { Layers, SlidersHorizontal, PencilLine } from 'lucide-react';
import { PiCursorLight, PiHandGrabbingBold, PiArrowUUpLeft, PiArrowUUpRight } from 'react-icons/pi';
import { EditorTool, type EditorUIType } from '@/stores/EditorUIStore';
import { getUndoManager } from '@/stores/RootStore';
import { revealOffset, useCameraControls, type CameraTransform, type CanvasInsets, type Edges, type Rect } from '@/lib/canvas/cameraControls';
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

/** Room above a breakpoint frame for its name label (ResponsivePageRenderer puts it 32px above). */
const FRAME_LABEL_SPACE = 28;

function measureInsets(bar: HTMLElement | null, extraTop = 0): CanvasInsets {
  const top = document.querySelector<HTMLElement>('[data-editor-topbar]')?.getBoundingClientRect().bottom ?? 0;
  const bottom = bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0;
  return { top: top + extraTop, bottom };
}

/**
 * The part of the screen the edited text may use, in client pixels: below
 * the top bar, above the on-screen keyboard (the visual viewport's bottom).
 */
function editingVisibleEdges(): Edges {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const vTop = vv ? vv.offsetTop : 0;
  const vLeft = vv ? vv.offsetLeft : 0;
  const vHeight = vv ? vv.height : window.innerHeight;
  const vWidth = vv ? vv.width : window.innerWidth;
  const barBottom = document.querySelector<HTMLElement>('[data-editor-topbar]')?.getBoundingClientRect().bottom ?? 0;
  return { top: Math.max(vTop, barBottom), bottom: vTop + vHeight, left: vLeft, right: vLeft + vWidth };
}

/** The screen box to keep visible: the text, or its caret when the text is taller than the room. */
function editedTextBox(el: HTMLElement, visible: Edges): Edges {
  const r = el.getBoundingClientRect();
  if (r.height <= visible.bottom - visible.top - 32) return r;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const c = sel.getRangeAt(0).getBoundingClientRect();
    if (c.height > 0) return { top: c.top, bottom: c.bottom, left: r.left, right: Math.min(r.right, r.left + (visible.right - visible.left)) };
  }
  return r;
}

/**
 * While `editingId` is edited inline, keep its text inside the visible area
 * whenever the visual viewport changes (the keyboard opens, closes or
 * changes height) and once the keyboard has settled. Pans only, never zooms.
 */
function useRevealEditedText(editingId: string | undefined, apply: (t: CameraTransform) => void, read: () => CameraTransform) {
  React.useEffect(() => {
    if (!editingId) return;
    const reveal = () => {
      const el = Array.from(
        document.querySelectorAll<HTMLElement>('[data-camera-transform] [contenteditable="true"][data-inner-component-id]'),
      ).find((node) => node.getAttribute('data-inner-component-id') === editingId);
      if (!el) return;
      const visible = editingVisibleEdges();
      const { dx, dy } = revealOffset(editedTextBox(el, visible), visible);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const cur = read();
      apply({ zoom: cur.zoom, panX: cur.panX + dx, panY: cur.panY + dy });
    };
    const vv = window.visualViewport;
    let raf = requestAnimationFrame(reveal);
    // The keyboard slides in over about 300ms on iOS; reveal again once it is up.
    const settle = window.setTimeout(reveal, 350);
    const onViewport = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(reveal);
    };
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
    };
  }, [editingId, apply, read]);
}

const PhoneEditorChrome = observer(({ editorUI }: { editorUI: EditorUIType }) => {
  const [sheet, setSheet] = React.useState<PhoneSheet>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const { zoomPercentage, fit, apply, read } = useCameraControls();

  // Inline text editing on the canvas: close any sheet, hide the bar (below),
  // and keep the text above the keyboard.
  const editingId = editorUI.editingComponent?.id;
  React.useEffect(() => {
    if (editingId) setSheet(null);
  }, [editingId]);
  useRevealEditedText(editingId, apply, read);

  const undoManager = getUndoManager();
  // An element on the page, not a breakpoint frame.
  const target = editorUI.selectedComponent;
  const hasSelection = !!target;
  // The Edit button is highlighted for a NEW selection only: opening a page
  // selects its root element by itself, and a highlight that is always on
  // tells nothing. The selection present when the layout opens, and each one
  // whose properties were opened, counts as seen.
  const [seenSelectionId, setSeenSelectionId] = React.useState<string | undefined>(() => editorUI.selectedComponent?.id);
  React.useEffect(
    () =>
      reaction(
        () => editorUI.currentPage?.id,
        () => setSeenSelectionId(editorUI.selectedComponent?.id),
      ),
    [editorUI],
  );
  React.useEffect(() => {
    if (sheet === 'properties') setSeenSelectionId(target?.id);
  }, [sheet, target?.id]);
  const isNewSelection = !!target && target.id !== seenSelectionId;

  // Fit the phone frame to the screen when the layout opens and when the page
  // changes. The frames render a frame or two after the page is set, so the
  // fit retries for a short while until there is something to measure.
  React.useEffect(() => {
    let raf = 0;
    const fitWhenReady = (triesLeft: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const done = fit({
          mode: 'width',
          pick: narrowestFrame,
          padding: 16,
          insets: measureInsets(barRef.current, FRAME_LABEL_SPACE),
        });
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
        // Hidden while a text is edited on the canvas: it must not cover the
        // text, and the keyboard's Done (or a tap elsewhere) ends the edit.
        hidden={!!editingId}
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
            onClick={() => fit({ mode: 'contain', insets: measureInsets(barRef.current, FRAME_LABEL_SPACE) })}
          >
            <span className="text-[13px] font-semibold leading-none">Fit</span>
          </BarButton>
          <BarButton
            label={hasSelection ? 'Edit' : 'Properties'}
            ariaLabel={target ? `Edit ${target.displayName}` : 'Properties'}
            onClick={() => open('properties')}
            emphasis={isNewSelection && sheet !== 'properties'}
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
        <LeftSidebar variant="sheet" onComponentInserted={() => setSheet(null)} />
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
