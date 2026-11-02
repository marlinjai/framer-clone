// src/lib/behaviour/presets/slider.ts
//
// A slider with two thumbs, as two native range inputs: every key a range takes (arrows,
// Page Up and Down, Home, End) and a pointer, and the thumbs cannot cross. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets" and "Prototyped before freezing".
//
// Each thumb clamps its own value to the other's, rather than rewriting `max`, which would
// remap the track and make the thumb jump. Without a script they are two sliders that may
// cross.
//
// PURE: no React, no MST.

import { assertSeed, derived, el, propsOf, stateIdOn, type PresetNode } from './nodes';

export const SLIDER_VERSION = 1;

export interface MultithumbOptions {
  seed: string;
  label?: string;
  min?: number;
  max?: number;
  low?: number;
  high?: number;
}

const RANGE_STYLE = { width: '100%', minHeight: '44px' };

const isRange = (node: PresetNode): boolean => node.type === 'input' && propsOf(node).type === 'range';
const numberOf = (node: PresetNode, name: string, fallback: number): number => {
  const value = Number(propsOf(node)[name]);
  return Number.isFinite(value) ? value : fallback;
};

/** Writes every generated entry from the two ranges the root holds, in their order. */
export function deriveMultithumb(root: PresetNode): PresetNode {
  const children = root.children ?? [];
  const [low, high] = children.filter(isRange);
  if (!low || !high) return root;
  const min = numberOf(low, 'min', 0);
  const max = numberOf(high, 'max', 100);
  const lo = stateIdOn(root, 'low');
  const hi = stateIdOn(root, 'high');
  const thumb = (node: PresetNode, state: string, clamp: [unknown, unknown]): PresetNode =>
    derived(node, {
      on: [{
        id: 'move',
        on: 'input',
        do: [
          { set: state, value: { clamp: [{ event: 'value' }, clamp[0], clamp[1]] } as never },
          { setProp: node.id, prop: 'value', value: { get: state } },
        ],
      }],
    });
  return derived({
    ...root,
    children: children.map((child) => {
      if (child === low) return thumb(child, lo, [min, { get: hi }]);
      return child === high ? thumb(child, hi, [{ get: lo }, max]) : child;
    }),
  }, {
    state: [
      { id: lo, name: 'Low value', type: 'number', initial: numberOf(low, 'defaultValue', min), min, max },
      { id: hi, name: 'High value', type: 'number', initial: numberOf(high, 'defaultValue', max), min, max },
    ],
    preset: { kind: 'slider-multithumb', version: SLIDER_VERSION },
  });
}

export function multithumbSlider({ seed, label = 'Price', min = 0, max = 100, low = 20, high = 80 }: MultithumbOptions): PresetNode {
  assertSeed(seed);
  const range = (id: string, name: string, value: number) =>
    el(id, 'input', { type: 'range', min, max, defaultValue: value, 'aria-label': `${label}, ${name}`, style: RANGE_STYLE });
  return deriveMultithumb(
    el(seed, 'div', { role: 'group', 'aria-label': label, style: { display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '320px' } },
      range(`${seed}-low`, 'lowest', Math.min(low, high)),
      range(`${seed}-high`, 'highest', Math.max(low, high))),
  );
}
