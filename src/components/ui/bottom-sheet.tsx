// src/components/ui/bottom-sheet.tsx
//
// A modal bottom sheet for the phone layout (plan
// docs/plans/2026-10-24-editor-on-phones.md): the editor's panels slide up
// from the bottom edge instead of docking at the sides.
//
// Built on the Radix dialog primitive, not on ui/dialog.tsx's DialogContent:
// that one appends the centred viewport-fit classes, a sheet is anchored to
// the bottom edge instead. Radix gives it role="dialog", aria-modal, the
// visible title as its label, a focus trap, focus return to the button that
// opened it, Escape and a tap on the backdrop to close. On top of that: a
// swipe down on the grab handle or title row closes it, and while the
// on-screen keyboard is up the sheet sits on the keyboard and shrinks to the
// visible area, with the focused field scrolled into view.
//
// Detents (optional, the properties sheet; plan section "Quick toolbar"): a
// sheet given `detent` rests at 'peek' (about 38% of the screen, the canvas
// and the edited element visible above it) or 'full' (its size). Swiping the
// handle up from peek goes to full, down from full goes to peek, down from
// peek closes; the chevron button in the title row does the same for those
// who cannot swipe. The sheet keeps its full height and moves down by the
// difference at peek (the CSS `translate` property, so it composes with the
// open and close animation's `transform`), with the same amount of padding at
// the end of the content, so every row stays reachable by scrolling.
'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronDown, ChevronUp, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** How far a swipe down must travel before it closes the sheet, in pixels. */
export const SWIPE_CLOSE_DISTANCE = 80;

/** The resting heights of a sheet with detents. */
export type SheetDetent = 'peek' | 'full';
/** Height of the peek detent, in percent of the small viewport height. */
export const PEEK_SVH = 38;
/** Full heights per size, in percent of the small viewport height. */
export const SHEET_SVH = { tall: 85, medium: 60 } as const;

/**
 * Where a swipe on the handle leaves a sheet: `dy` is the finger's travel
 * (positive down). Returns the next detent, 'close', or null (snap back).
 * Without detents a swipe down closes and nothing else does.
 */
export function swipeOutcome(detent: SheetDetent | undefined, dy: number): SheetDetent | 'close' | null {
  if (dy >= SWIPE_CLOSE_DISTANCE) return detent === 'full' ? 'peek' : 'close';
  if (dy <= -SWIPE_CLOSE_DISTANCE && detent === 'peek') return 'full';
  return null;
}

/**
 * How much of the layout viewport the on-screen keyboard covers, and the
 * visible height, from window.visualViewport. Zero inset without a keyboard
 * (or without the API).
 */
export function useKeyboardInset(active: boolean): { inset: number; visibleHeight: number | null } {
  const [state, setState] = React.useState<{ inset: number; visibleHeight: number | null }>({ inset: 0, visibleHeight: null });
  React.useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setState({ inset, visibleHeight: Math.round(vv.height) });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return state;
}

function isTextEntry(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(type);
}

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The visible title, which is also the dialog's accessible name. */
  title: string;
  /** 'tall' covers up to 85% of the screen, 'medium' 60% (the canvas stays visible above). */
  size?: 'tall' | 'medium';
  /** A lighter backdrop for sheets whose edits should stay visible on the canvas above. */
  backdrop?: 'dim' | 'light';
  /** Extra content in the title row, before the close button. */
  headerExtra?: React.ReactNode;
  /** Resting height, for a sheet with detents (see the header comment). Omit for a fixed-height sheet. */
  detent?: SheetDetent;
  onDetentChange?: (detent: SheetDetent) => void;
  children: React.ReactNode;
  'data-testid'?: string;
}

export function BottomSheet({
  open,
  onOpenChange,
  title,
  size = 'tall',
  backdrop = 'dim',
  headerExtra,
  detent,
  onDetentChange,
  children,
  'data-testid': testId,
}: BottomSheetProps) {
  const { inset, visibleHeight } = useKeyboardInset(open);
  const swipe = React.useRef<{ startY: number; dy: number } | null>(null);
  const [dragOffset, setDragOffset] = React.useState(0);

  // Swipe down to close, from the grab handle or the title row. Touch events
  // rather than pointer events: they keep arriving even if the browser starts
  // a gesture of its own, and nothing here sets touch-action.
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      swipe.current = null;
      return;
    }
    // A tap on a button in the title row (close, extras) stays a tap.
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    swipe.current = { startY: e.touches[0].clientY, dy: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current;
    if (!s || e.touches.length !== 1) return;
    const raw = e.touches[0].clientY - s.startY;
    // Upward travel only means something at peek (towards full).
    s.dy = detent === 'peek' ? raw : Math.max(0, raw);
    setDragOffset(s.dy);
  };
  const onTouchEnd = () => {
    const s = swipe.current;
    swipe.current = null;
    setDragOffset(0);
    if (!s) return;
    const outcome = swipeOutcome(detent, s.dy);
    if (outcome === 'close') onOpenChange(false);
    else if (outcome) onDetentChange?.(outcome);
  };

  // A field focused inside the sheet scrolls itself into view once the
  // keyboard has opened and the sheet has resized.
  const onFocusCapture = (e: React.FocusEvent) => {
    const target = e.target;
    if (!isTextEntry(target)) return;
    window.setTimeout(() => target.scrollIntoView({ block: 'nearest' }), 300);
  };

  const heightClass = size === 'tall' ? 'h-[85svh]' : 'h-[60svh]';
  const style: React.CSSProperties = {};
  const keyboardUp = inset > 0 && !!visibleHeight;
  if (keyboardUp) {
    style.bottom = inset;
    // max-height beats the svh height class whenever the visible area is smaller.
    style.maxHeight = `${Math.max(160, (visibleHeight ?? 0) - 16)}px`;
  }
  // At peek the sheet sits lower by the difference (never while typing: the
  // keyboard already shrinks it to the visible area).
  const peekOffset = detent === 'peek' && !keyboardUp ? `${SHEET_SVH[size] - PEEK_SVH}svh` : '0px';
  if (detent) {
    style.translate = dragOffset !== 0 ? `0 max(0px, calc(${peekOffset} + ${dragOffset}px))` : `0 ${peekOffset}`;
  } else if (dragOffset > 0) {
    style.transform = `translateY(${dragOffset}px)`;
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="bottom-sheet-overlay"
          data-testid={testId ? `${testId}-backdrop` : undefined}
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[1000]',
            backdrop === 'dim' ? 'bg-foreground/40' : 'bg-foreground/10',
          )}
        />
        <DialogPrimitive.Content
          data-slot="bottom-sheet"
          data-editor-ui="true"
          data-testid={testId}
          // No description element: the title says what the sheet holds.
          aria-describedby={undefined}
          // Radix hides the rest of the page from assistive technology but
          // does not say so on the dialog itself.
          aria-modal="true"
          onFocusCapture={onFocusCapture}
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom fixed inset-x-0 bottom-0 z-[1010] flex flex-col overflow-hidden rounded-t-2xl border-t border-border bg-background shadow-2xl duration-[180ms] ease-out outline-none',
            heightClass,
            // Detent changes glide (translate only, under 200ms, ease-out); a finger drag follows directly.
            detent ? 'transition-[translate] motion-reduce:transition-none' : '',
            dragOffset !== 0 ? 'transition-none' : '',
          )}
          style={style}
          data-detent={detent}
        >
          <div
            className="shrink-0 border-b border-border"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
          >
            {/* Grab handle: a visual cue for the swipe down. */}
            <div className="flex justify-center pt-2" aria-hidden="true">
              <div className="h-1 w-10 rounded-full bg-border" />
            </div>
            <div className="flex h-11 items-center gap-2 pl-4 pr-2">
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</DialogPrimitive.Title>
              {headerExtra}
              {detent && onDetentChange && (
                <button
                  type="button"
                  onClick={() => onDetentChange(detent === 'peek' ? 'full' : 'peek')}
                  aria-label={detent === 'peek' ? `Expand ${title}` : `Shrink ${title}`}
                  data-testid={testId ? `${testId}-detent` : undefined}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {detent === 'peek' ? <ChevronUp className="size-5" /> : <ChevronDown className="size-5" />}
                </button>
              )}
              <DialogPrimitive.Close
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-label={`Close ${title}`}
              >
                <XIcon className="size-5" />
              </DialogPrimitive.Close>
            </div>
          </div>
          {/* The panel inside owns its scrolling (both sidebars scroll their
              own content), so the sheet only gives it the remaining height. */}
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]"
            style={peekOffset !== '0px' ? { paddingBottom: `calc(${peekOffset} + env(safe-area-inset-bottom))` } : undefined}
          >
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
