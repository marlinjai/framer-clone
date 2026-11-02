// src/lib/behaviour/presets/tooltip.ts
//
// A tooltip: shows on focus and on hover, stays while the pointer is on it, and Escape
// dismisses it, also when it came from hover alone and the focus is elsewhere. Without a
// script the text stays in the flow as the control's description. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets" and "Prototyped before freezing".
//
// A leave waits before it closes, so the pointer can cross to the tooltip, and an enter
// replaces that wait. The Escape trigger hears the whole page, so it has to sit inside the
// scope holding the state: that is the preset's root, not the page's.
//
// PURE: no React, no MST.

import type { Trigger } from '../format';
import { assertSeed, derived, el, propsOf, stateIdOn, type PresetNode } from './nodes';

export const TOOLTIP_VERSION = 1;

export interface TooltipOptions {
  seed: string;
  label?: string;
  text?: string;
}

const SHOWN = 'shown';
const ENTER_MS = 40;
const LEAVE_MS = 150;

const TIP_STYLE = {
  position: 'absolute', top: '100%', left: '0', zIndex: 10, marginTop: '4px', padding: '4px 8px', width: 'max-content', maxWidth: 'min(240px, 80vw)',
  borderRadius: '4px', background: '#171717', color: '#fff', fontSize: '14px',
};

/** Writes every generated entry on the root, its control and the tooltip. */
export function deriveTooltip(root: PresetNode): PresetNode {
  const state = stateIdOn(root, SHOWN);
  const later = (id: string, on: string, ms: number, value: boolean): Trigger =>
    ({ id, on, do: [{ delay: ms, key: state, do: [{ set: state, value }] }] });
  const now = (id: string, on: string, value: boolean): Trigger =>
    ({ id, on, do: [{ cancel: state }, { set: state, value }] });
  return derived({
    ...root,
    children: root.children?.map((child) => (propsOf(child).role === 'tooltip'
      ? derived(child, {
          showWhen: { state, eq: true },
          on: [{ id: 'stay', on: 'mouseenter', do: [{ cancel: state }] }, later('leave', 'mouseleave', LEAVE_MS, false)],
        })
      : derived(child, {
          noScript: 'show',
          on: [later('enter', 'mouseenter', ENTER_MS, true), later('leave', 'mouseleave', LEAVE_MS, false), now('focus', 'focus', true), now('blur', 'blur', false)],
        }))),
  }, {
    state: [{ id: state, name: 'Tooltip shown', type: 'boolean', initial: false }],
    on: [{ ...now('escape', 'keydown', false), scope: 'document', keys: ['Escape'] }],
    preset: { kind: 'tooltip', version: TOOLTIP_VERSION },
  });
}

export function tooltip({ seed, label = 'Save', text = 'Saves the page' }: TooltipOptions): PresetNode {
  assertSeed(seed);
  const tip = `${seed}-tip`;
  return deriveTooltip(
    el(seed, 'div', { style: { position: 'relative', display: 'inline-block' } },
      el(`${seed}-control`, 'button', { type: 'button', 'aria-describedby': tip, children: label, style: { padding: '8px 16px', minHeight: '44px', font: 'inherit' } }),
      el(tip, 'div', {
        id: tip,
        role: 'tooltip',
        children: text,
        style: TIP_STYLE,
        // Without the gate it is the control's description, in the flow, covering nothing.
        rules: [{ id: 'in-flow', selector: '&', gate: 'off', style: { position: 'static', background: 'none', color: 'inherit', marginTop: '0', padding: '0' } }],
      })),
  );
}
