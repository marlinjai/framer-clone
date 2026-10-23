// src/lib/canvas/spacingDrag.ts
//
// Value math and the write session behind the on-canvas spacing handles
// (SpacingHandlesLayer). The pure functions turn a pointer delta into a
// value; the session writes it into the model for the breakpoint being
// edited, exactly as the properties panel does, and makes one whole drag one
// undo step.
//
// Decisions (documented here and in SpacingHandlesLayer):
// - Values are whole CSS px. Shift snaps to 8px steps. A dragged side is
//   written in px whatever unit it had (the computed px is the start value).
// - Alt/Option held when the drag starts mirrors the value onto the opposite
//   side (top with bottom, left with right), Figma's convention. Gaps have no
//   mirror.
// - Padding and gap never go below 0. Margin never goes below 0 either,
//   except that a margin that is already negative may stay where it is: the
//   floor is min(0, start), so grabbing it does not jump, but a drag never
//   creates a negative margin. Negative margins overlap neighbours, which a
//   handle cannot show honestly.
// - Padding and margin sides write the longhands (paddingTop, marginLeft).
//   When the shorthand the panel writes (`padding: 16px`) is authored at
//   this breakpoint, the drag expands it: all four longhands become explicit
//   (from the computed px) and the shorthand is cleared, at this breakpoint
//   only. Writing a lone longhand next to a live shorthand looks right while
//   dragging but breaks on undo and Escape: React clears a removed longhand
//   with `paddingTop: ''` and does not re-apply the unchanged shorthand, so
//   the side would render as 0 until a remount (seen in the browser). With
//   the shorthand itself changing, React re-applies it after the removals.
// - A gap drag writes `gap`, like the panel's single Gap field. When the
//   element authors the axis longhand (rowGap / columnGap) and it is the one
//   in effect, or authors only the other axis's longhand, the axis longhand
//   is written instead; a two-value `gap` keeps its other axis.
import type { ComponentInstance } from '@/models/ComponentModel';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';
import type { BoxKind, Edges, GapAxis, Side, SpacingTarget } from './spacingGeometry';

export const SNAP_STEP = 8;

export const OPPOSITE_SIDE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * Which pointer axis drives a target, and which way grows it. Padding grows
 * when dragged into the element, margin when dragged away from it, a gap
 * when dragged right or down.
 */
export function dragDirection(target: SpacingTarget): { axis: 'x' | 'y'; sign: 1 | -1 } {
  if (target.kind === 'gap') return { axis: target.axis === 'column' ? 'x' : 'y', sign: 1 };
  const axis = target.side === 'top' || target.side === 'bottom' ? 'y' : 'x';
  const towardsEnd = target.side === 'top' || target.side === 'left'; // dragging +x/+y moves into the element
  const grows = target.kind === 'padding' ? towardsEnd : !towardsEnd;
  return { axis, sign: grows ? 1 : -1 };
}

/** The lowest value a drag may write (see the header). */
export function minValueFor(target: SpacingTarget, start: number): number {
  if (target.kind === 'margin') return Math.min(0, Math.round(start));
  return 0;
}

/**
 * The value for a pointer delta in screen px: start plus the delta divided
 * by the element's screen scale (the camera zoom), rounded to whole px or to
 * 8px steps with `snap`, then floored at `min`.
 */
export function valueFromDrag(input: {
  start: number;
  dx: number;
  dy: number;
  target: SpacingTarget;
  scale: number;
  snap: boolean;
  min: number;
}): number {
  const { axis, sign } = dragDirection(input.target);
  const scale = input.scale > 0 && Number.isFinite(input.scale) ? input.scale : 1;
  const delta = ((axis === 'x' ? input.dx : input.dy) * sign) / scale;
  const raw = input.start + delta;
  const stepped = input.snap ? Math.round(raw / SNAP_STEP) * SNAP_STEP : Math.round(raw);
  const value = Math.max(input.min, stepped);
  return value === 0 ? 0 : value; // never -0
}

/** The sides one drag writes: the grabbed side, plus its opposite when mirrored. */
export function sidesForDrag(side: Side, mirror: boolean): Side[] {
  return mirror ? [side, OPPOSITE_SIDE[side]] : [side];
}

export function sideProp(kind: BoxKind, side: Side): string {
  return `${kind}${side[0].toUpperCase()}${side.slice(1)}`;
}

/** A computed CSS length in px as a number; `normal`, `auto` and the like read as 0. */
export function parseCssPx(value: string | null | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

const isSet = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * One side of a box shorthand (`padding: 8px 16px`), or undefined when the
 * shorthand is empty or not a plain token list (calc() and friends).
 */
export function shorthandSide(shorthand: unknown, side: Side): string | undefined {
  if (!isSet(shorthand)) return undefined;
  const s = String(shorthand).trim();
  if (s.includes('(')) return undefined;
  const t = s.split(/\s+/);
  const [top, rightV = top, bottomV = top, leftV = rightV] = t;
  return { top, right: rightV, bottom: bottomV, left: leftV }[side];
}

/**
 * True when the side's authored value is `auto` (a centred block). Such a
 * side gets no handle: dragging it would replace the centring with px.
 */
export function isAutoSide(shorthand: unknown, longhand: unknown, side: Side): boolean {
  const v = isSet(longhand) ? String(longhand).trim() : shorthandSide(shorthand, side);
  return v === 'auto';
}

/** One style write: property and value. */
export interface StyleWrite {
  prop: string;
  value: string;
}

/**
 * The writes for a padding or margin drag. `authored` reads the value
 * authored for a property at the breakpoint being edited, `start` the
 * computed px of every side (used when the shorthand is expanded).
 */
export function boxWrites(input: {
  kind: BoxKind;
  sides: Side[];
  value: number;
  start: Edges;
  authored: (prop: string) => unknown;
}): StyleWrite[] {
  const { kind, sides, value, start, authored } = input;
  const px = (n: number) => `${n}px`;
  if (!isSet(authored(kind))) return sides.map(side => ({ prop: sideProp(kind, side), value: px(value) }));
  // Expand: every longhand explicit, the shorthand cleared at this breakpoint.
  const writes: StyleWrite[] = (['top', 'right', 'bottom', 'left'] as Side[]).map(side => ({
    prop: sideProp(kind, side),
    value: px(sides.includes(side) ? value : Math.round(start[side])),
  }));
  writes.push({ prop: kind, value: '' });
  return writes;
}

/**
 * The write for a gap drag on one axis. See the header for the rules; the
 * longhand is "in effect" when it is authored and the `gap` shorthand is not,
 * or comes after it in the style object.
 */
export function gapWrite(input: {
  axis: GapAxis;
  value: number;
  styleKeys: string[];
  authored: (prop: string) => unknown;
}): StyleWrite {
  const { axis, value, styleKeys, authored } = input;
  const longhand = axis === 'row' ? 'rowGap' : 'columnGap';
  const gapAuthored = authored('gap');
  if (isSet(authored(longhand))) {
    const inEffect = !isSet(gapAuthored) || styleKeys.indexOf(longhand) > styleKeys.indexOf('gap');
    if (inEffect) return { prop: longhand, value: `${value}px` };
  }
  // Only the other axis is authored, as a longhand: a new `gap` would also
  // reset that axis (and undoing it would clear it in the DOM), so this axis
  // gets its own longhand.
  if (!isSet(gapAuthored) && isSet(authored(axis === 'row' ? 'columnGap' : 'rowGap'))) {
    return { prop: longhand, value: `${value}px` };
  }
  const tokens = isSet(gapAuthored) && !String(gapAuthored).includes('(')
    ? String(gapAuthored).trim().split(/\s+/)
    : [];
  if (tokens.length === 2) {
    const [row, column] = tokens;
    return { prop: 'gap', value: axis === 'row' ? `${value}px ${column}` : `${row} ${value}px` };
  }
  return { prop: 'gap', value: `${value}px` };
}

export interface SpacingDragSession {
  /** Apply a pointer delta (screen px from the press). Returns the value now shown. */
  update(input: { dx: number; dy: number; snap: boolean }): number;
  /** End the drag: everything written becomes one undo step. */
  commit(): void;
  /** Abort the drag: the model returns to exactly what it was. */
  cancel(): void;
}

/**
 * Start a drag on one spacing target of one component.
 *
 * `start` is the computed px: all four sides for padding or margin, or the
 * row and column gaps. Writes go through `updateResponsiveStyle` at
 * `breakpointId` (undefined for floating elements), like the panel. With a
 * history store, the drag runs in one batch: commit records one entry (none
 * when nothing changed), cancel reverts the batch's own patches, so the model
 * is restored exactly, responsive maps included.
 */
export function startSpacingDrag(input: {
  component: ComponentInstance;
  breakpointId?: string;
  target: SpacingTarget;
  start: Edges | { row: number; column: number };
  scale: number;
  mirror: boolean;
  history: HistoryStoreInstance | null;
}): SpacingDragSession {
  const { component, breakpointId, target, scale, history } = input;
  const startValue = target.kind === 'gap'
    ? (input.start as { row: number; column: number })[target.axis]
    : (input.start as Edges)[target.side];
  const min = minValueFor(target, startValue);
  const label = target.kind === 'gap' ? 'Gap' : target.kind === 'padding' ? 'Padding' : 'Margin';

  // Originals for the fallback restore (no history store).
  const originals = new Map<string, unknown>();
  const authored = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const styleKeys = () => Object.keys((component.props?.style as Record<string, unknown> | undefined) ?? {});

  history?.startBatch(label);
  let shown = startValue;
  let lastWritten: number | null = null;
  let done = false;

  const write = (value: number) => {
    const writes = target.kind === 'gap'
      ? [gapWrite({ axis: target.axis, value, styleKeys: styleKeys(), authored })]
      : boxWrites({
          kind: target.kind,
          sides: sidesForDrag(target.side, input.mirror),
          value,
          start: input.start as Edges,
          authored,
        });
    for (const w of writes) {
      if (!originals.has(w.prop)) originals.set(w.prop, authored(w.prop) ?? '');
      component.updateResponsiveStyle(w.prop, w.value, breakpointId);
    }
  };

  return {
    update({ dx, dy, snap }) {
      if (done) return shown;
      const value = valueFromDrag({ start: startValue, dx, dy, target, scale, snap, min });
      shown = value;
      // A press without movement, or a move that rounds to the same value,
      // writes nothing (and so records no history).
      if (value === lastWritten || (lastWritten === null && value === startValue)) return value;
      write(value);
      lastWritten = value;
      return value;
    },
    commit() {
      if (done) return;
      done = true;
      history?.commitBatch();
    },
    cancel() {
      if (done) return;
      done = true;
      if (history) {
        history.revertBatch();
        return;
      }
      for (const [prop, value] of originals) component.updateResponsiveStyle(prop, value, breakpointId);
    },
  };
}
