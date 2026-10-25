// src/lib/quickbar/actions.ts
//
// The phone editor's quick edits (plan docs/plans/2026-10-24-editor-on-phones.md,
// section "Quick toolbar"): what the floating quick toolbar and the long-press
// menu offer for a selected element, and what each one writes. Kept out of the
// components so every rule is unit tested on the real stores.
//
// Rules shared by every action:
//   - Styles go through `component.updateResponsiveStyle(prop, value, breakpointId)`
//     with the breakpoint of the frame the element was selected in. The cascade
//     is desktop-first, so on the Mobile frame a quick edit is a Mobile override,
//     which is what someone editing on a phone means.
//   - Each action is ONE undo step: actions that write several properties run
//     inside a history batch. A stepper's press-and-hold run opens its own
//     batch around all of its steps (the batch is first-wins, so the inner
//     batches here join it), see QuickToolbar's useRepeatPress.
//   - Values the model does not store (a heading's default size, a flex
//     container's default row direction) are read from the rendered element
//     through `computed`, so a step starts from what the person sees.
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';
import { getComponentCategory } from '@/components/sidebars/right/sectionConfig';
import { ancestorIdsOf, canDeleteLayer } from '@/lib/layers/layerActions';

/** Reads a computed CSS property (kebab or camel case) of the rendered element, or undefined. */
export type ComputedReader = (property: string) => string | undefined;

export interface QuickContext {
  component: ComponentInstance;
  /** The frame the element is edited in (undefined for floating elements). */
  breakpointId: string | undefined;
  history: HistoryStoreInstance | null;
  /** The element's computed style, for values the model does not store. */
  computed?: ComputedReader;
  /** The parent element's computed style (center in parent). */
  parentComputed?: ComputedReader;
}

// ---------- element kinds ----------

/** What the quick toolbar offers is chosen by this. */
export type QuickKind = 'text' | 'container' | 'image' | 'other';

export function quickKindOf(component: ComponentInstance): QuickKind {
  const category = getComponentCategory(component);
  if (category === 'text' || category === 'formSubmit' || component.type === 'button') return 'text';
  if (category === 'container' || category === 'form') return 'container';
  if (category === 'image') return 'image';
  return 'other';
}

/** True when the element's text can be edited inline (a single string child, no nested components). */
export function isTextEditable(component: ComponentInstance): boolean {
  return component.children.length === 0 && typeof (component.props as Record<string, unknown>)?.children === 'string';
}

/** The groups of controls the quick toolbar shows, in order, for an element. */
export type QuickGroup = 'tree' | 'text' | 'container' | 'element';

export function quickGroupsFor(component: ComponentInstance): QuickGroup[] {
  const kind = quickKindOf(component);
  const groups: QuickGroup[] = ['tree'];
  if (kind === 'text') groups.push('text');
  if (kind === 'container') groups.push('container');
  groups.push('element');
  return groups;
}

// ---------- tree navigation ----------

/** The element's ancestors, nearest first, as components (the breadcrumb list). */
export function ancestorsOf(component: ComponentInstance, page: PageModelType): ComponentInstance[] {
  const find = (id: string) => page.findComponent(id);
  return ancestorIdsOf(component, find)
    .map(find)
    .filter((c): c is ComponentInstance => !!c && !c.isViewportNode);
}

export function parentOf(component: ComponentInstance, page: PageModelType): ComponentInstance | undefined {
  return ancestorsOf(component, page)[0];
}

export function firstChildOf(component: ComponentInstance): ComponentInstance | undefined {
  return (component.children as ComponentInstance[]).find(c => c.canvasVisible);
}

/**
 * Select another element of the tree, keeping the frame the selection was
 * made in: without it the HUD has nothing to outline and the next edit would
 * land on the desktop base instead of the frame's override.
 */
export function selectInSameFrame(editorUI: EditorUIType, node: ComponentInstance): void {
  editorUI.selectComponent(node, node.isFloatingElement ? undefined : editorUI.selectedViewportNode?.breakpointId);
}

// ---------- helpers ----------

function inBatch(history: HistoryStoreInstance | null, name: string, run: () => void): void {
  if (!history || history.batch) {
    run();
    return;
  }
  history.startBatch(name);
  try {
    run();
  } finally {
    history.commitBatch();
  }
}

function stored(ctx: QuickContext, prop: string): unknown {
  return ctx.component.getResponsiveStyleValue(prop, ctx.breakpointId);
}

function set(ctx: QuickContext, prop: string, value: string): void {
  ctx.component.updateResponsiveStyle(prop, value, ctx.breakpointId);
}

/** A pixel number from "16px", 16 or "16"; undefined for other units or nothing. */
export function pxNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)(px)?$/);
  return m ? parseFloat(m[1]) : undefined;
}

/** The value of a property in px: the stored px value, else the rendered one. */
function currentPx(ctx: QuickContext, prop: string, cssProp: string, fallback: number): number {
  const own = pxNumber(stored(ctx, prop));
  if (own !== undefined) return own;
  const rendered = pxNumber(ctx.computed?.(cssProp));
  return rendered ?? fallback;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- text ----------

export const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 400;

export function fontSizeOf(ctx: QuickContext): number {
  return currentPx(ctx, 'fontSize', 'font-size', 16);
}

/** Step the font size by `delta` px (a stored rem or em becomes the px it renders at). */
export function stepFontSize(ctx: QuickContext, delta: number): number {
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, round(fontSizeOf(ctx) + delta)));
  inBatch(ctx.history, 'Font size', () => set(ctx, 'fontSize', `${next}px`));
  return next;
}

/** The weights the toggle cycles through, with their names. */
export const WEIGHT_CYCLE = [
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '700', label: 'Bold' },
] as const;

export function fontWeightOf(ctx: QuickContext): number {
  const raw = stored(ctx, 'fontWeight') ?? ctx.computed?.('font-weight');
  if (raw === 'bold') return 700;
  if (raw === 'normal' || raw === undefined) return 400;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 400;
}

/** The name of a weight for the toggle ("Bold"); the nearest cycle entry. */
export function weightLabel(weight: number): string {
  let best: (typeof WEIGHT_CYCLE)[number] = WEIGHT_CYCLE[0];
  for (const w of WEIGHT_CYCLE) if (Math.abs(Number(w.value) - weight) < Math.abs(Number(best.value) - weight)) best = w;
  return best.label;
}

/** Regular, Medium, Bold, Regular: the next weight above the current one, wrapping. */
export function cycleFontWeight(ctx: QuickContext): string {
  const current = fontWeightOf(ctx);
  const next = WEIGHT_CYCLE.find(w => Number(w.value) > current) ?? WEIGHT_CYCLE[0];
  inBatch(ctx.history, 'Font weight', () => set(ctx, 'fontWeight', next.value));
  return next.value;
}

export function setFontFamily(ctx: QuickContext, stack: string): void {
  inBatch(ctx.history, 'Font', () => set(ctx, 'fontFamily', stack));
}

export type TextAlign = 'left' | 'center' | 'right';

export function textAlignOf(ctx: QuickContext): TextAlign {
  const raw = String(stored(ctx, 'textAlign') ?? ctx.computed?.('text-align') ?? 'left');
  if (raw === 'center') return 'center';
  if (raw === 'right' || raw === 'end') return 'right';
  return 'left';
}

export function setTextAlign(ctx: QuickContext, align: TextAlign): void {
  inBatch(ctx.history, 'Text align', () => set(ctx, 'textAlign', align));
}

export function setTextColor(ctx: QuickContext, color: string): void {
  inBatch(ctx.history, 'Text color', () => set(ctx, 'color', color));
}

// ---------- containers ----------

function displayOf(ctx: QuickContext): string {
  return String(stored(ctx, 'display') ?? ctx.computed?.('display') ?? 'block');
}

function isFlex(display: string): boolean {
  return display === 'flex' || display === 'inline-flex';
}

/** 'row' or 'column' for a flex container; undefined when it is not one. */
export function layoutDirectionOf(ctx: QuickContext): 'row' | 'column' | undefined {
  if (!isFlex(displayOf(ctx))) return undefined;
  const raw = String(stored(ctx, 'flexDirection') ?? ctx.computed?.('flex-direction') ?? 'row');
  return raw.startsWith('column') ? 'column' : 'row';
}

/**
 * The layout direction toggle: a block (or grid) container becomes a
 * vertical flex stack first (the same flow it had, now with gap and
 * alignment); after that each tap swaps row and column.
 */
export function toggleLayoutDirection(ctx: QuickContext): 'row' | 'column' {
  const current = layoutDirectionOf(ctx);
  const next = current === undefined ? 'column' : current === 'row' ? 'column' : 'row';
  inBatch(ctx.history, 'Layout direction', () => {
    if (current === undefined) set(ctx, 'display', 'flex');
    set(ctx, 'flexDirection', next);
  });
  return next;
}

/** True when the container centres its content both ways. */
export function isContentCentered(ctx: QuickContext): boolean {
  const display = displayOf(ctx);
  const value = (p: string, css: string) => String(stored(ctx, p) ?? ctx.computed?.(css) ?? '');
  if (isFlex(display)) return value('justifyContent', 'justify-content') === 'center' && value('alignItems', 'align-items') === 'center';
  if (display === 'grid') return value('justifyItems', 'justify-items') === 'center' && value('alignItems', 'align-items') === 'center';
  return false;
}

/**
 * Centre the content in one tap: a flex container gets justify and align
 * center; a grid gets justify-items and align-items center; a block container
 * becomes a vertical flex stack with both centred. Tapping again when it is
 * already centred puts the content back at the start (flex) or default (grid).
 */
export function toggleCenterContent(ctx: QuickContext): boolean {
  const centred = isContentCentered(ctx);
  const display = displayOf(ctx);
  inBatch(ctx.history, 'Center content', () => {
    if (display === 'grid') {
      set(ctx, 'justifyItems', centred ? 'stretch' : 'center');
      set(ctx, 'alignItems', centred ? 'stretch' : 'center');
      return;
    }
    if (!isFlex(display)) {
      set(ctx, 'display', 'flex');
      set(ctx, 'flexDirection', 'column');
    }
    set(ctx, 'justifyContent', centred ? 'flex-start' : 'center');
    set(ctx, 'alignItems', centred ? 'stretch' : 'center');
  });
  return !centred;
}

export const SPACING_STEP = 4;

export function gapOf(ctx: QuickContext): number {
  return currentPx(ctx, 'gap', 'row-gap', 0);
}

/** Step the gap; a block container becomes a vertical flex stack (gap needs flex or grid). */
export function stepGap(ctx: QuickContext, delta: number): number {
  const next = Math.max(0, round(gapOf(ctx) + delta));
  const display = displayOf(ctx);
  inBatch(ctx.history, 'Gap', () => {
    if (!isFlex(display) && display !== 'grid') {
      set(ctx, 'display', 'flex');
      set(ctx, 'flexDirection', 'column');
    }
    set(ctx, 'gap', `${next}px`);
  });
  return next;
}

const PADDING_SIDES = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;

/** The padding shown on the stepper: the top side as rendered (the stepper writes all four alike). */
export function paddingOf(ctx: QuickContext): number {
  return currentPx(ctx, 'paddingTop', 'padding-top', 0);
}

/**
 * Step the padding of all four sides, as the properties panel's single
 * Padding field does (src/components/sidebars/right/sections/LayoutSection.tsx):
 * the sides get the value; the shorthand is cleared on the largest breakpoint
 * and, below it, overridden with the same value when one is in effect.
 */
export function stepPadding(ctx: QuickContext, delta: number): number {
  const next = Math.max(0, round(paddingOf(ctx) + delta));
  const value = `${next}px`;
  inBatch(ctx.history, 'Padding', () => {
    for (const side of PADDING_SIDES) set(ctx, side, value);
    const shorthandInEffect = stored(ctx, 'padding') !== undefined;
    set(ctx, 'padding', ctx.component.isLargestBreakpoint(ctx.breakpointId) || !shorthandInEffect ? '' : value);
  });
  return next;
}

// ---------- any element ----------

/**
 * How "center in parent" is done depends on the parent's layout on this
 * breakpoint:
 *   - flex column: `align-self: center` (cross axis);
 *   - flex row: `margin-left/right: auto` (the free space on the main axis is
 *     shared on both sides);
 *   - grid: `justify-self: center`;
 *   - block (or anything else): `margin-left/right: auto`, which only centres
 *     a block narrower than its parent, so an element of automatic width also
 *     gets `width: fit-content`, and an inline element (a span, a link) becomes
 *     a block first (auto margins do nothing on inline boxes).
 */
export type CenterMechanism = 'alignSelf' | 'autoMargins' | 'justifySelf';

export function centerMechanismFor(parentDisplay: string, parentDirection: string): CenterMechanism {
  if (isFlex(parentDisplay)) return parentDirection.startsWith('column') ? 'alignSelf' : 'autoMargins';
  if (parentDisplay === 'grid' || parentDisplay === 'inline-grid') return 'justifySelf';
  return 'autoMargins';
}

function parentLayout(ctx: QuickContext, parent: ComponentInstance | undefined): { display: string; direction: string } {
  const bp = ctx.breakpointId;
  const display = String(parent?.getResponsiveStyleValue('display', bp) ?? ctx.parentComputed?.('display') ?? 'block');
  const direction = String(parent?.getResponsiveStyleValue('flexDirection', bp) ?? ctx.parentComputed?.('flex-direction') ?? 'row');
  return { display, direction };
}

export function isCenteredInParent(ctx: QuickContext, parent: ComponentInstance | undefined): boolean {
  const { display, direction } = parentLayout(ctx, parent);
  const mechanism = centerMechanismFor(display, direction);
  if (mechanism === 'alignSelf') return stored(ctx, 'alignSelf') === 'center';
  if (mechanism === 'justifySelf') return stored(ctx, 'justifySelf') === 'center';
  return stored(ctx, 'marginLeft') === 'auto' && stored(ctx, 'marginRight') === 'auto';
}

/** Centre the element horizontally in its parent (see CenterMechanism). Returns the mechanism used. */
export function centerInParent(ctx: QuickContext, parent: ComponentInstance | undefined): CenterMechanism {
  const { display, direction } = parentLayout(ctx, parent);
  const mechanism = centerMechanismFor(display, direction);
  inBatch(ctx.history, 'Center in parent', () => {
    if (mechanism === 'alignSelf') {
      set(ctx, 'alignSelf', 'center');
      return;
    }
    if (mechanism === 'justifySelf') {
      set(ctx, 'justifySelf', 'center');
      return;
    }
    set(ctx, 'marginLeft', 'auto');
    set(ctx, 'marginRight', 'auto');
    if (!isFlex(display)) {
      const ownDisplay = String(stored(ctx, 'display') ?? ctx.computed?.('display') ?? 'block');
      if (ownDisplay.startsWith('inline')) set(ctx, 'display', ownDisplay === 'inline-flex' ? 'flex' : ownDisplay === 'inline-grid' ? 'grid' : 'block');
      const width = stored(ctx, 'width');
      if (width === undefined || width === '' || width === 'auto' || width === '100%') set(ctx, 'width', 'fit-content');
    }
  });
  return mechanism;
}

export type WidthMode = 'fit' | 'fill' | 'fixed';

/** The width mode the stored width expresses, or undefined when the width is automatic. */
export function widthModeOf(ctx: QuickContext): WidthMode | undefined {
  const w = stored(ctx, 'width');
  if (w === undefined || w === '' || w === 'auto') return undefined;
  if (w === 'fit-content' || w === 'max-content') return 'fit';
  if (w === '100%') return 'fill';
  return 'fixed';
}

/** Width modes apply to elements inside a frame; a floating element's box is sized in px only. */
export function canSetWidthMode(component: ComponentInstance): boolean {
  return !component.isFloatingElement && !component.isViewportNode;
}

/**
 * Fit: `fit-content`. Fill: `100%` of the parent. Fixed: the width it renders
 * at now, in whole px (`renderedWidth`), so switching to fixed changes nothing
 * visible until the person resizes.
 */
export function setWidthMode(ctx: QuickContext, mode: WidthMode, renderedWidth: number | undefined): void {
  const value = mode === 'fit' ? 'fit-content' : mode === 'fill' ? '100%' : `${Math.max(1, Math.round(renderedWidth ?? 100))}px`;
  inBatch(ctx.history, 'Width', () => set(ctx, 'width', value));
}

// ---------- copy and paste style ----------

/**
 * The properties Copy style takes: how an element looks (colour, type,
 * borders, corners, shadow, opacity), never where it sits or how big it is.
 * Pasting a heading's width or a section's flex direction onto something
 * else is not what anyone means by "paste style".
 */
export function isAppearanceStyle(prop: string): boolean {
  if (/^(background|border|outline|font|text)/.test(prop)) return true;
  return [
    'color',
    'opacity',
    'boxShadow',
    'filter',
    'backdropFilter',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
    'mixBlendMode',
  ].includes(prop);
}

export type CopiedStyle = Record<string, string | number>;

/** The element's appearance as it renders on `breakpointId` (inherited values included). */
export function copyStyle(component: ComponentInstance, breakpointId: string | undefined): CopiedStyle {
  const style = ((component.props as Record<string, unknown>)?.style ?? {}) as Record<string, unknown>;
  const out: CopiedStyle = {};
  for (const prop of Object.keys(style)) {
    if (!isAppearanceStyle(prop)) continue;
    const value = component.getResponsiveStyleValue(prop, breakpointId);
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number') out[prop] = value;
  }
  return out;
}

/** Write a copied style onto `component` on `breakpointId`, as one undo step. Returns how many properties were set. */
export function pasteStyle(
  component: ComponentInstance,
  breakpointId: string | undefined,
  copied: CopiedStyle,
  history: HistoryStoreInstance | null,
): number {
  const entries = Object.entries(copied);
  if (entries.length === 0) return 0;
  inBatch(history, 'Paste style', () => {
    for (const [prop, value] of entries) component.updateResponsiveStyle(prop, String(value), breakpointId);
  });
  return entries.length;
}

// ---------- the long-press menu ----------

export type ContextMenuItem =
  | 'selectParent'
  | 'selectChild'
  | 'editText'
  | 'duplicate'
  | 'copyStyle'
  | 'pasteStyle'
  | 'delete';

/** The long-press menu's items for an element, in order. */
export function contextMenuItemsFor(
  component: ComponentInstance,
  page: PageModelType,
  hasCopiedStyle: boolean,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (parentOf(component, page)) items.push('selectParent');
  if (quickKindOf(component) === 'container' && firstChildOf(component)) items.push('selectChild');
  if (isTextEditable(component)) items.push('editText');
  if (canDeleteLayer(component)) items.push('duplicate');
  items.push('copyStyle');
  if (hasCopiedStyle) items.push('pasteStyle');
  if (canDeleteLayer(component)) items.push('delete');
  return items;
}
