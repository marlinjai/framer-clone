// src/lib/behaviour/presets/toolbar.ts
//
// A toolbar: one Tab stop, and Left, Right, Home and End between its controls. The server
// writes no `tabindex`, so without a script every control is reachable by Tab, and the
// runtime writes the one Tab stop. See docs/plans/2026-11-02-behaviour-model.md, "Presets".
//
// PURE: no React, no MST.

import { assertSeed, derived, el, onKeys, type PresetNode } from './nodes';

export const TOOLBAR_VERSION = 1;

export interface ToolbarOptions {
  seed: string;
  label?: string;
  items?: string[];
}

const BUTTON_STYLE = { padding: '8px 12px', minHeight: '44px', border: '1px solid #e5e5e5', borderRadius: '6px', background: '#fff', font: 'inherit', cursor: 'pointer' };

/** Every generated entry, all on the root: a control needs none of its own. */
export function deriveToolbar(root: PresetNode): PresetNode {
  const go = (move: 'next' | 'prev' | 'first' | 'last') => ({ rove: root.id, move });
  return derived(root, {
    group: { role: 'button', axis: 'line', wrap: true },
    on: [
      onKeys('next', ['InlineEnd'], go('next')),
      onKeys('prev', ['InlineStart'], go('prev')),
      onKeys('first', ['Home'], go('first')),
      onKeys('last', ['End'], go('last')),
    ],
    preset: { kind: 'toolbar', version: TOOLBAR_VERSION },
  });
}

export function toolbar({ seed, label = 'Actions', items = ['Bold', 'Italic', 'Underline'] }: ToolbarOptions): PresetNode {
  assertSeed(seed);
  return deriveToolbar(
    el(seed, 'div', { role: 'toolbar', 'aria-label': label, style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
      ...items.map((item, index) => el(`${seed}-item-${index}`, 'button', { type: 'button', role: 'button', children: item, style: BUTTON_STYLE }))),
  );
}
