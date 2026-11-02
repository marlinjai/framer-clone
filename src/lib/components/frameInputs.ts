// src/lib/components/frameInputs.ts
//
// A placement on one frame, for the two surfaces that resolve a frame at a time. The
// published page keeps a responsive value as a map, for its stylesheet. A frame has
// one value, or a colour map would land in an inline style.
//
// The canvas needs two cursors: a placement's own values are keyed on what holds it,
// and a definition's defaults on the definition.
//
// PURE: no React, no MST. Client and server safe.

import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { isResponsiveMap, resolveCascade, type BreakpointRef } from '@/lib/responsive/cascade';
import { mapValues } from './breakpoints';
import { createRenderBudget, mergeStyle, resolveInputValues, type PlacementInstance } from './expand';
import type { InputDefinition } from './inputs';

/** A breakpoint in a list. An unknown or absent id reads as the largest, as everywhere. */
export interface BreakpointCursor {
  id: string | undefined;
  breakpoints: readonly BreakpointRef[];
}

function valueAt(value: unknown, { id, breakpoints }: BreakpointCursor): unknown {
  return isResponsiveMap(value, new Set(breakpoints.map(b => b.id))) ? resolveCascade(value, id, breakpoints).value : value;
}

// These surfaces render far more often than a page is served, so a problem is logged
// once for the session rather than once per render. It is never charged.
const warnings = createRenderBudget();

/** The complete values of a placement on one frame, resolved in the scope outside it. */
export function inputValuesAt(
  instance: PlacementInstance,
  own: BreakpointCursor,
  defaults: BreakpointCursor,
  scope: BindingScope,
): Record<string, unknown> {
  const flat: PlacementInstance = {
    ...instance,
    inputs: Object.fromEntries(Object.entries(instance.inputs).map(([id, value]) => [id, valueAt(value, own)])),
    inputDefinitions: instance.inputDefinitions.map(input =>
      input.default === undefined ? input : { ...input, default: valueAt(input.default, defaults) }),
  };
  return resolveInputValues(flat, scope, warnings);
}

/** A definition drawn on its own canvas: its defaults, through the same path as a placement. */
export function defaultValuesAt(
  inputs: InputDefinition[],
  cursor: BreakpointCursor,
  scope: BindingScope,
): Record<string, unknown> {
  return inputValuesAt({ inputs: {}, bindings: {}, inputDefinitions: inputs }, cursor, cursor, scope);
}

/**
 * A placement's style on one frame, as plain values. The merge is the published
 * page's, per property and per breakpoint, on maps keyed on the page: a value on a
 * frame comes from whichever side set one nearest, so a definition's Mobile value
 * survives a placement's base, where laying the placement's resolved value over the
 * root would lose it. Holds only the placement's own properties.
 */
export function placementStyleAt(
  placed: unknown,
  rootStyle: unknown,
  breakpoints: { holder: readonly BreakpointRef[]; definition: readonly BreakpointRef[]; page: readonly BreakpointRef[] },
  frameId: string,
): Record<string, unknown> {
  const { holder, definition, page } = breakpoints;
  if (!placed || typeof placed !== 'object') return {};
  const merged = mergeStyle(mapValues(rootStyle, definition, page), mapValues(placed, holder, page)) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(placed)) {
    const value = resolveCascade(merged[key], frameId, page).value;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export { warnings as editorInputWarnings };
