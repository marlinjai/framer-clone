// src/lib/components/makeInput.ts
//
// "Make input" on a row of a node inside a definition: which input that row asks
// for, with the node's current value as its default, and the expression that reads
// it back. ProjectModel.makeInput then adds the input and writes the binding as one
// step. A value the type refuses is left out of the default, which renders the
// node's stored value, so the outcome is the same either way.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "Making an input".
//
// PURE: no React, no MST. Client and server safe.

import { inputExpressionFor, parseInputValue, type InputDefinition, type InputType } from './inputs';

/** What the row is on: a node's tag and props, and, on a nested placement, the inner input it sets. */
export interface MakeInputSource {
  type: string;
  props: Record<string, unknown>;
  /** The inner definition's input, when the slot is a placement's `input.<id>`. */
  inner?: InputDefinition;
}

/** Style keys whose value is a colour. */
const COLOR_STYLE = /(^|\.)(color|backgroundColor|borderColor|outlineColor|fill|stroke|caretColor|accentColor|textDecorationColor)$/;

function typeFor(slot: string, source: MakeInputSource): InputType {
  if (source.inner) return source.inner.type;
  if (slot === 'href') return 'link';
  if (slot === 'src') return 'image';
  if (slot === 'visible') return 'toggle';
  if (slot.startsWith('style.') && COLOR_STYLE.test(slot)) return 'color';
  return 'text';
}

function currentValue(slot: string, source: MakeInputSource, type: InputType): unknown {
  const { props } = source;
  if (source.inner) {
    const own = (props.inputs as Record<string, unknown> | undefined)?.[source.inner.id];
    return own ?? source.inner.default;
  }
  if (type === 'image') return { src: props.src, alt: typeof props.alt === 'string' ? props.alt : '' };
  if (slot === 'visible') return true;
  if (slot.startsWith('style.')) {
    const value = (props.style as Record<string, unknown> | undefined)?.[slot.slice('style.'.length)];
    // A responsive map is a value per breakpoint, which an input default may hold too.
    return value;
  }
  return props[slot];
}

/** A unique id and name for the new input, from the row's label. */
function identity(label: string, inputs: readonly InputDefinition[]): { id: string; name: string } {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'input';
  const ids = new Set(inputs.map(input => input.id));
  const names = new Set(inputs.map(input => input.name));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  let name = label || 'Input';
  for (let n = 2; names.has(name); n++) name = `${label || 'Input'} ${n}`;
  return { id, name };
}

/** The input "Make input" adds for this row, and what the binding reads. */
export function inputDraftFor(
  source: MakeInputSource,
  slot: string,
  label: string,
  inputs: readonly InputDefinition[],
): { input: InputDefinition; expression: string } {
  const type = typeFor(slot, source);
  const { id, name } = identity(label, inputs);
  const shape: InputDefinition = source.inner
    ? { ...source.inner, id, name, default: undefined, description: undefined, group: undefined }
    : { id, name, type };
  const value = currentValue(slot, source, type);
  const parsed = value === undefined ? undefined : parseInputValue(shape, value);
  const input: InputDefinition = Object.fromEntries(
    Object.entries({ ...shape, default: parsed?.ok ? parsed.value : undefined }).filter(([, v]) => v !== undefined),
  ) as unknown as InputDefinition;
  return { input, expression: inputExpressionFor(input, slot) };
}
