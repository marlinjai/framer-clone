// src/components/phone/QuickToolbar.tsx
//
// The phone editor's floating quick toolbar (plan
// docs/plans/2026-10-24-editor-on-phones.md, section "Quick toolbar"): a
// compact glass bar next to the selected element with the edits a phone user
// reaches for most (select the parent or a child, font size, weight, family,
// alignment and colour for text, direction, centring, gap and padding for
// containers, centring in the parent, width mode, duplicate, delete), so the
// page stays visible while it changes. "More" opens the full properties sheet
// at its peek height.
//
// - Placement is pure math (src/lib/quickbar/placement.ts): above the element,
//   below it without room, docked over the bottom bar when neither fits; never
//   under the bars or the keyboard.
// - It follows the element through pan and zoom with direct DOM writes from
//   the camera subscription (no React render per frame), and hides while the
//   camera moves, a drag runs, or a sheet or the long-press menu is open,
//   reappearing when the motion settles.
// - Every edit is one undo step and writes the frame's own value through
//   updateResponsiveStyle (src/lib/quickbar/actions.ts); a small dot on a
//   control says the value is set on this frame (an override of a larger one).
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  CornerDownRight,
  Minus,
  PencilLine,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { EditorTool, type EditorUIType } from '@/stores/EditorUIStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { getDragManager, getHistoryStore } from '@/stores/RootStore';
import { useTransformContext } from '@/contexts/TransformContext';
import { useKeyboardInset } from '@/components/ui/bottom-sheet';
import { styleSource, breakpointLabel } from '@/components/sidebars/right/breakpointSource';
import { FONT_LIBRARY, findLibraryFamily, fontFaceCss, fontStack, parseFontFamilyList } from '@/lib/fonts/registry';
import { canDeleteLayer, duplicateLayer } from '@/lib/layers/layerActions';
import { deleteSelection } from '@/lib/canvas/deleteSelection';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  QUICKBAR_GAP,
  QUICKBAR_MARGIN,
  QUICKBAR_MOVED_EVENT,
  placeQuickbar,
  type PlacementResult,
} from '@/lib/quickbar/placement';
import {
  SPACING_STEP,
  ancestorsOf,
  canSetWidthMode,
  centerInParent,
  cycleFontWeight,
  firstChildOf,
  fontSizeOf,
  fontWeightOf,
  gapOf,
  isCenteredInParent,
  isContentCentered,
  isTextEditable,
  layoutDirectionOf,
  paddingOf,
  parentOf,
  quickGroupsFor,
  selectInSameFrame,
  setFontFamily,
  setTextAlign,
  setTextColor,
  setWidthMode,
  stepFontSize,
  stepGap,
  stepPadding,
  textAlignOf,
  toggleCenterContent,
  toggleLayoutDirection,
  weightLabel,
  widthModeOf,
  type QuickContext,
  type TextAlign,
  type WidthMode,
} from '@/lib/quickbar/actions';
import { beginInlineTextEdit, computedReaderFor, elementFor, measureVisibleArea, screenRectFor } from '@/lib/quickbar/dom';

/** How long the camera must rest before the toolbar comes back, in ms. */
export const SETTLE_MS = 160;
/** First repeat of a held stepper, then each repeat comes sooner down to the floor. */
export const REPEAT_FIRST_MS = 400;
export const REPEAT_MIN_MS = 50;

export const TEXT_SWATCHES = ['#111111', '#ffffff', '#6b7280', '#1d4ed8', '#b91c1c', '#15803d', '#b45309', '#6d28d9'];

type Panel = 'ancestors' | 'fonts' | 'color' | null;

// ---------- small controls ----------

interface QBtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  label: string;
  /** The value is set on this frame (an override): a dot in the corner. */
  override?: boolean;
  pressed?: boolean;
  wide?: boolean;
}

const QBtn = React.forwardRef<HTMLButtonElement, QBtnProps>(function QBtn(
  { label, override, pressed, wide, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={override ? `${label} (set on this breakpoint)` : label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        'relative flex h-9 shrink-0 items-center justify-center gap-1 rounded-lg text-[13px] font-medium text-foreground',
        'hover:bg-foreground/8 active:bg-foreground/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-35',
        wide ? 'px-2' : 'w-9',
        pressed && 'bg-brand/15 text-brand',
        className,
      )}
      {...rest}
    >
      {children}
      {override && (
        <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand" data-testid="quick-override" />
      )}
    </button>
  );
});

/**
 * A press-and-hold button: one step on the press, then repeats that speed up
 * while held, all of it one history batch (one undo step). Keyboard activation
 * (Enter or Space, a click with detail 0) does one step.
 */
function RepeatButton({ label, onStep, batchName, children, disabled }: {
  label: string;
  onStep: () => void;
  batchName: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const stepRef = React.useRef(onStep);
  stepRef.current = onStep;
  const timer = React.useRef<number | undefined>(undefined);
  const holding = React.useRef(false);

  const stop = React.useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (holding.current) {
      holding.current = false;
      getHistoryStore()?.commitBatch();
    }
  }, []);
  React.useEffect(() => stop, [stop]);

  const step = () => {
    stepRef.current();
    haptic();
  };

  return (
    <QBtn
      label={label}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a nicety (keeps the hold when the finger slides a little).
        }
        stop();
        holding.current = true;
        getHistoryStore()?.startBatch(batchName);
        step();
        let delay = REPEAT_FIRST_MS;
        const loop = () => {
          timer.current = window.setTimeout(() => {
            if (!holding.current) return;
            step();
            delay = Math.max(REPEAT_MIN_MS, delay * 0.75);
            loop();
          }, delay);
        };
        loop();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onClick={(e) => {
        // Keyboard activation only: a pointer press already stepped.
        if (e.detail === 0) step();
      }}
    >
      {children}
    </QBtn>
  );
}

function Stepper({ label, value, unit, onStep, batchName, override, prefix, step = 1 }: {
  label: string;
  value: number;
  unit?: string;
  onStep: (delta: number) => void;
  batchName: string;
  override?: boolean;
  prefix?: string;
  step?: number;
}) {
  return (
    <div role="group" aria-label={label} className="relative flex shrink-0 items-center rounded-lg bg-foreground/5">
      {prefix && <span className="pl-2 text-[11px] font-medium text-muted-foreground" aria-hidden>{prefix}</span>}
      <RepeatButton label={`Decrease ${label.toLowerCase()}`} onStep={() => onStep(-step)} batchName={batchName}>
        <Minus size={15} />
      </RepeatButton>
      <output className="min-w-7 text-center text-[13px] font-semibold tabular-nums" aria-live="polite" aria-label={`${label} ${value}${unit ?? ''}`}>
        {value}
      </output>
      <RepeatButton label={`Increase ${label.toLowerCase()}`} onStep={() => onStep(step)} batchName={batchName}>
        <Plus size={15} />
      </RepeatButton>
      {override && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-brand" data-testid="quick-override" />}
    </div>
  );
}

const WIDTH_NEXT: Record<WidthMode | 'auto', WidthMode> = { auto: 'fit', fit: 'fill', fill: 'fixed', fixed: 'fit' };
const WIDTH_LABEL: Record<WidthMode | 'auto', string> = { auto: 'Auto', fit: 'Fit', fill: 'Fill', fixed: 'Fixed' };

// ---------- the toolbar ----------

export interface QuickToolbarProps {
  editorUI: EditorUIType;
  /** Hidden by the chrome (a sheet is open). */
  hidden?: boolean;
  /** "More": open the full properties sheet. */
  onMore: () => void;
}

const QuickToolbar = observer(({ editorUI, hidden = false, onMore }: QuickToolbarProps) => {
  const component = editorUI.selectedComponent;
  const page = editorUI.currentPage;
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  const dragActive = getDragManager()?.isActive ?? false;
  const multi = editorUI.selectedComponentList.length > 1;
  const anchorable = !!component && !component.isViewportNode && (component.isFloatingElement || !!breakpointId);
  const active =
    !!component &&
    !!page &&
    anchorable &&
    !hidden &&
    !dragActive &&
    !multi &&
    editorUI.selectedTool === EditorTool.SELECT &&
    !editorUI.editingComponent &&
    !editorUI.phoneContextMenu;

  const [panel, setPanel] = React.useState<Panel>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const placementRef = React.useRef<PlacementResult | null>(null);
  const { inset } = useKeyboardInset(true);
  const { subscribe } = useTransformContext();

  // A new selection closes any open popover.
  React.useEffect(() => setPanel(null), [component?.id]);

  // The spacing handles keep out from under the toolbar (SpacingHandlesLayer
  // treats its rect as an obstacle), so they re-measure whenever it moves,
  // shows or hides. Only a real change is announced, so this cannot loop.
  const lastAnnouncedRef = React.useRef<string | null>(null);
  const announceMoved = React.useCallback((key: string) => {
    if (lastAnnouncedRef.current === key) return;
    lastAnnouncedRef.current = key;
    window.dispatchEvent(new Event(QUICKBAR_MOVED_EVENT));
  }, []);

  const position = React.useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = active && component ? screenRectFor(component, breakpointId) : null;
    if (!rect) {
      wrapper.dataset.shown = 'false';
      announceMoved('hidden');
      return;
    }
    const area = measureVisibleArea(inset);
    const bar = { width: wrapper.offsetWidth, height: wrapper.offsetHeight };
    const placed = placeQuickbar(rect, bar, area);
    placementRef.current = placed;
    wrapper.style.transform = `translate(${Math.round(placed.left)}px, ${Math.round(placed.top)}px)`;
    wrapper.dataset.placement = placed.placement;
    wrapper.dataset.shown = 'true';
    announceMoved(`${Math.round(placed.left)},${Math.round(placed.top)},${bar.width},${bar.height}`);

    const pop = panelRef.current;
    if (pop) {
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      // Away from the element: over the toolbar when the toolbar is above it.
      const above = placed.top - QUICKBAR_GAP - ph;
      const below = placed.top + bar.height + QUICKBAR_GAP;
      const preferAbove = placed.placement !== 'below';
      const fitsAbove = above >= area.top + QUICKBAR_MARGIN;
      const fitsBelow = below + ph <= area.bottom - QUICKBAR_MARGIN;
      const top = (preferAbove && fitsAbove) || !fitsBelow ? Math.max(area.top + QUICKBAR_MARGIN, above) : below;
      const left = Math.min(Math.max(QUICKBAR_MARGIN, placed.left), area.width - QUICKBAR_MARGIN - pw);
      pop.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
  }, [active, component, breakpointId, inset, announceMoved]);

  // After every render (a value changed, so did the element's size), and on
  // the next frame once layout has caught up.
  React.useLayoutEffect(() => {
    position();
    const raf = requestAnimationFrame(position);
    return () => cancelAnimationFrame(raf);
  });

  // Pan and zoom: hide while the camera moves, come back where the element
  // ended up once it rests. No React render per frame.
  React.useEffect(() => {
    let settle: number | undefined;
    const stop = subscribe(() => {
      const wrapper = wrapperRef.current;
      if (wrapper) wrapper.dataset.shown = 'false';
      // Announce the hide too, or the re-show at the same place would be
      // de-duplicated and the spacing handles keep a stale obstacle.
      announceMoved('hidden');
      window.clearTimeout(settle);
      settle = window.setTimeout(position, SETTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(settle);
    };
  }, [subscribe, position, announceMoved]);

  React.useEffect(() => {
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [position]);

  // Escape closes a popover.
  React.useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPanel(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panel]);

  if (!component || !page) {
    return <div ref={wrapperRef} data-shown="false" className="hidden" data-testid="quick-toolbar" />;
  }

  const history = getHistoryStore();
  const el = elementFor(component, breakpointId);
  const parent = parentOf(component, page);
  const parentEl = el?.parentElement?.closest<HTMLElement>('[data-inner-component-id]') ?? null;
  const ctx: QuickContext = {
    component,
    breakpointId,
    history,
    computed: computedReaderFor(el),
    parentComputed: computedReaderFor(parentEl),
  };
  const own = (...props: string[]) => styleSource(component, breakpointId, props)?.kind === 'own';
  const groups = quickGroupsFor(component);
  const child = firstChildOf(component);
  const frameLabel = breakpointId && !component.isLargestBreakpoint(breakpointId) ? breakpointLabel(component, breakpointId) : undefined;
  const select = (node: ComponentInstance) => {
    selectInSameFrame(editorUI, node);
    haptic();
    setPanel(null);
  };
  const toggle = (which: Exclude<Panel, null>) => setPanel((cur) => (cur === which ? null : which));

  const widthMode = widthModeOf(ctx) ?? 'auto';
  const align = textAlignOf(ctx);
  const direction = layoutDirectionOf(ctx);
  const currentFamily = parseFontFamilyList(String(component.getResponsiveStyleValue('fontFamily', breakpointId) ?? ''))[0];
  const currentLibrary = currentFamily ? findLibraryFamily(currentFamily) : undefined;
  const color = String(component.getResponsiveStyleValue('color', breakpointId) ?? ctx.computed?.('color') ?? '#111111');

  return (
    <>
      <div
        ref={wrapperRef}
        data-editor-ui="true"
        data-testid="quick-toolbar"
        data-shown="false"
        role="toolbar"
        aria-label={`Quick edits for ${component.displayName}`}
        className="glass-surface float-enter fixed left-0 top-0 z-[95] flex max-w-[calc(100vw-16px)] flex-col gap-0.5 rounded-xl p-1"
        style={{ willChange: 'transform' }}
      >
        <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          <QBtn label="Select parent" disabled={!parent} onClick={() => parent && select(parent)}>
            <ArrowUp size={17} />
          </QBtn>
          <QBtn
            label={`Layer: ${component.displayName}. Show its parents`}
            wide
            className="max-w-[104px]"
            aria-expanded={panel === 'ancestors'}
            aria-haspopup="menu"
            onClick={() => toggle('ancestors')}
            data-testid="quick-breadcrumb"
          >
            <span className="flex min-w-0 flex-col items-start leading-none">
              <span className="max-w-[72px] truncate">{component.displayName}</span>
              {frameLabel && <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand">{frameLabel}</span>}
            </span>
            <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
          </QBtn>
          {groups.includes('container') && (
            <QBtn label="Select first child" disabled={!child} onClick={() => child && select(child)}>
              <CornerDownRight size={17} />
            </QBtn>
          )}
          {isTextEditable(component) && (
            <QBtn
              label="Edit text"
              onClick={() => {
                if (!beginInlineTextEdit(editorUI, component)) onMore();
              }}
            >
              <PencilLine size={17} />
            </QBtn>
          )}
          <QBtn
            label="Center in parent"
            disabled={!parent}
            pressed={!!parent && isCenteredInParent(ctx, parent)}
            override={own('marginLeft', 'marginRight', 'alignSelf', 'justifySelf')}
            onClick={() => centerInParent(ctx, parent)}
          >
            <AlignHorizontalJustifyCenter size={17} />
          </QBtn>
          {canSetWidthMode(component) && (
            <QBtn
              label={`Width: ${WIDTH_LABEL[widthMode]}. Change to ${WIDTH_LABEL[WIDTH_NEXT[widthMode]]}`}
              wide
              override={own('width')}
              onClick={() => setWidthMode(ctx, WIDTH_NEXT[widthMode], el?.offsetWidth || undefined)}
              data-testid="quick-width"
            >
              <span className="text-[11px] text-muted-foreground">W</span>
              {WIDTH_LABEL[widthMode]}
            </QBtn>
          )}
          {canDeleteLayer(component) && (
            <>
              <QBtn label="Duplicate" onClick={() => duplicateLayer(page, editorUI, history)}>
                <Copy size={16} />
              </QBtn>
              <QBtn label="Delete" className="text-red-600 dark:text-red-400" onClick={() => deleteSelection(page, editorUI, history)}>
                <Trash2 size={16} />
              </QBtn>
            </>
          )}
          <QBtn label="More properties" onClick={onMore} data-testid="quick-more">
            <SlidersHorizontal size={16} />
          </QBtn>
        </div>

        {groups.includes('text') && (
          <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" data-testid="quick-text-row">
            <Stepper
              label="Font size"
              value={Math.round(fontSizeOf(ctx))}
              unit="px"
              batchName="Font size"
              override={own('fontSize')}
              onStep={(d) => stepFontSize(ctx, d)}
            />
            <QBtn
              label={`Weight: ${weightLabel(fontWeightOf(ctx))}. Tap for the next weight`}
              wide
              override={own('fontWeight')}
              onClick={() => cycleFontWeight(ctx)}
              style={{ fontWeight: fontWeightOf(ctx) }}
            >
              {weightLabel(fontWeightOf(ctx))}
            </QBtn>
            <QBtn
              label={`Font: ${currentLibrary?.displayName ?? 'Inherited'}. Choose a font`}
              override={own('fontFamily')}
              aria-expanded={panel === 'fonts'}
              aria-haspopup="menu"
              onClick={() => toggle('fonts')}
              style={currentLibrary ? { fontFamily: fontStack(currentLibrary) } : undefined}
            >
              Aa
            </QBtn>
            {(['left', 'center', 'right'] as TextAlign[]).map((a) => (
              <QBtn
                key={a}
                label={`Align ${a}`}
                pressed={align === a}
                override={align === a && own('textAlign')}
                onClick={() => setTextAlign(ctx, a)}
              >
                {a === 'left' ? <AlignLeft size={16} /> : a === 'center' ? <AlignCenter size={16} /> : <AlignRight size={16} />}
              </QBtn>
            ))}
            <QBtn
              label="Text color"
              override={own('color')}
              aria-expanded={panel === 'color'}
              aria-haspopup="dialog"
              onClick={() => toggle('color')}
            >
              <span aria-hidden className="h-5 w-5 rounded-full border border-foreground/25" style={{ background: color }} />
            </QBtn>
          </div>
        )}

        {groups.includes('container') && (
          <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" data-testid="quick-container-row">
            <QBtn
              label={direction === undefined ? 'Stack the content (flex column)' : `Direction: ${direction}. Change to ${direction === 'row' ? 'column' : 'row'}`}
              override={own('flexDirection', 'display')}
              onClick={() => toggleLayoutDirection(ctx)}
            >
              {direction === 'row' ? <ArrowRight size={17} /> : <ArrowDown size={17} />}
            </QBtn>
            <QBtn
              label="Center content"
              pressed={isContentCentered(ctx)}
              override={own('justifyContent', 'alignItems', 'justifyItems')}
              onClick={() => toggleCenterContent(ctx)}
            >
              <AlignVerticalJustifyCenter size={17} />
            </QBtn>
            <Stepper
              label="Gap"
              prefix="Gap"
              value={Math.round(gapOf(ctx))}
              unit="px"
              step={SPACING_STEP}
              batchName="Gap"
              override={own('gap')}
              onStep={(d) => stepGap(ctx, d)}
            />
            <Stepper
              label="Padding"
              prefix="Pad"
              value={Math.round(paddingOf(ctx))}
              unit="px"
              step={SPACING_STEP}
              batchName="Padding"
              override={own('paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'padding')}
              onStep={(d) => stepPadding(ctx, d)}
            />
          </div>
        )}
      </div>

      {panel && active && (
        <div
          ref={panelRef}
          data-editor-ui="true"
          data-testid={`quick-panel-${panel}`}
          className="glass-surface fixed left-0 top-0 z-[96] max-h-[45svh] w-[min(280px,calc(100vw-16px))] overflow-y-auto overscroll-contain rounded-xl p-1"
        >
          {panel === 'ancestors' && (
            <div role="menu" aria-label="Select a layer">
              {[component, ...ancestorsOf(component, page)].map((node, i) => (
                <button
                  key={node.id}
                  type="button"
                  role="menuitem"
                  aria-current={i === 0 ? 'true' : undefined}
                  onClick={() => (i === 0 ? setPanel(null) : select(node))}
                  className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  style={{ paddingLeft: 8 + Math.min(i, 6) * 6 }}
                >
                  <span className="min-w-0 flex-1 truncate">{node.displayName}</span>
                  {i === 0 ? <Check size={15} className="text-brand" /> : <span className="text-[11px] text-muted-foreground">{i === 1 ? 'Parent' : ''}</span>}
                </button>
              ))}
            </div>
          )}

          {panel === 'fonts' && (
            <div role="menu" aria-label="Font">
              {/* Declares every library face so each name shows in its own face; a face downloads only when drawn. */}
              <style>{fontFaceCss(FONT_LIBRARY.map((f) => f.id))}</style>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!currentLibrary}
                onClick={() => {
                  setFontFamily(ctx, '');
                  setPanel(null);
                }}
                className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <span className="flex-1">Inherit</span>
                {!currentLibrary && <Check size={15} className="text-brand" />}
              </button>
              {FONT_LIBRARY.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={currentLibrary?.id === f.id}
                  onClick={() => {
                    setFontFamily(ctx, fontStack(f));
                    setPanel(null);
                  }}
                  className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <span className="min-w-0 flex-1 truncate text-[16px]" style={{ fontFamily: fontStack(f) }}>
                    {f.displayName}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.category}</span>
                  {currentLibrary?.id === f.id && <Check size={15} className="text-brand" />}
                </button>
              ))}
            </div>
          )}

          {panel === 'color' && (
            <div role="group" aria-label="Text color" className="p-1">
              <div className="grid grid-cols-8 gap-1.5">
                {TEXT_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    onClick={() => {
                      setTextColor(ctx, c);
                      setPanel(null);
                    }}
                    className="h-8 w-8 rounded-full border border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    style={{ background: c }}
                  />
                ))}
              </div>
              <label className="mt-2 flex h-10 items-center gap-2 rounded-lg px-1 text-[14px]">
                <input
                  type="color"
                  aria-label="Custom text color"
                  className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
                  value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#111111'}
                  // The picker reports every move: one undo step for the whole visit.
                  onFocus={() => history?.startBatch('Text color')}
                  onBlur={() => history?.commitBatch()}
                  onChange={(e) => setTextColor(ctx, e.target.value)}
                />
                Custom
              </label>
            </div>
          )}
        </div>
      )}
    </>
  );
});

QuickToolbar.displayName = 'QuickToolbar';
export default QuickToolbar;
