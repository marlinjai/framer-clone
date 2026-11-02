// src/lib/behaviour/presets/splitter.ts
//
// A window splitter: a separator between two panes, moved by Left and Right, Home and End,
// collapsed and restored by Enter, and dragged by a pointer. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets" and "Prototyped before freezing".
//
// The position is a number in percent, and a collapse is a flag beside it, so Enter flips
// one value and the position comes back where it was. What the page shows, `aria-valuenow`
// and `--u-split` (the first pane's width), is 0 while collapsed and the position otherwise.
// Moving it, by key or by pointer, opens it again. Without a script the split stays at its
// first value.
//
// PURE: no React, no MST.

import type { Action, Expression } from '../format';
import { assertSeed, derived, el, initialOf, onKeys, propsOf, stateIdOn, type PresetNode } from './nodes';

export const SPLITTER_VERSION = 1;

export interface SplitterOptions {
  seed: string;
  label?: string;
  /** Where the split starts, in percent. */
  at?: number;
  first?: string;
  second?: string;
}

const STEP = 5;
const SPLIT_VAR = '--u-split';

const isSeparator = (node: PresetNode): boolean => propsOf(node).role === 'separator';

/** Writes every generated entry on the root and its separator. `firstAt` is read back from the state after the first time. */
export function deriveSplitter(root: PresetNode, firstAt?: number): PresetNode {
  const children = root.children ?? [];
  const separator = children.find(isSeparator);
  if (!separator) return root;
  const pos = stateIdOn(root, 'position');
  const shut = stateIdOn(root, 'collapsed');
  const drag = stateIdOn(root, 'dragging');
  const at = firstAt ?? initialOf(root, pos);
  const shown: Expression = { map: shut, cases: { true: 0, false: { get: pos } } };
  const open: Action = { set: shut, value: false };
  const to = (value: Expression): Action => ({ set: pos, value });

  return derived({
    ...root,
    children: children.map((child) => (child !== separator ? child : derived(child, {
      bind: [{ attr: 'aria-valuenow', from: shown }],
      on: [
        onKeys('left', ['ArrowLeft'], open, { step: pos, by: -STEP }),
        onKeys('right', ['ArrowRight'], open, { step: pos, by: STEP }),
        onKeys('home', ['Home'], open, to(0)),
        onKeys('end', ['End'], open, to(100)),
        onKeys('collapse', ['Enter'], { toggle: shut }),
        { id: 'grab', on: 'pointerdown', do: [{ capturePointer: true }, { set: drag, value: true }] },
        { id: 'drag', on: 'pointermove', if: { state: drag, eq: true }, do: [open, to({ clamp: [{ pointer: 'x', of: root.id, as: 'percent' }, 0, 100] })] },
        { id: 'drop', on: 'pointerup', do: [{ set: drag, value: false }] },
      ],
    }))),
  }, {
    state: [
      { id: pos, name: 'Split', type: 'number', initial: at, min: 0, max: 100 },
      { id: shut, name: 'Collapsed', type: 'boolean', initial: false },
      { id: drag, name: 'Dragging', type: 'boolean', initial: false },
    ],
    bind: [{ cssVar: SPLIT_VAR, from: shown, unit: '%' }],
    preset: { kind: 'windowsplitter', version: SPLITTER_VERSION },
  });
}

export function splitter({ seed, label = 'Resize', at = 50, first = 'First pane', second = 'Second pane' }: SplitterOptions): PresetNode {
  assertSeed(seed);
  const firstPane = `${seed}-first`;
  return deriveSplitter(
    el(seed, 'div', { style: { display: 'flex', width: '100%', minHeight: '160px' } },
      el(firstPane, 'div', { id: firstPane, children: first, style: { width: `var(${SPLIT_VAR}, ${at}%)`, overflow: 'auto', padding: '12px', boxSizing: 'border-box' } }),
      el(`${seed}-separator`, 'div', {
        role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': label, 'aria-controls': firstPane, 'aria-valuemin': 0, 'aria-valuemax': 100,
        style: { flex: '0 0 12px', background: '#d4d4d4', cursor: 'col-resize', touchAction: 'none' },
      }),
      el(`${seed}-second`, 'div', { children: second, style: { flex: '1', overflow: 'auto', padding: '12px' } })),
    at,
  );
}
