// applyEffects: turns each node's stored `props.effects` into what the
// published page renders: data attributes the effects runtime and stylesheet
// key on, plus CSS custom properties carrying the values. The properties are
// written into `style` as responsive maps (`{ base, <breakpointId>: value }`)
// where a breakpoint differs, so applyResponsiveStyles, which runs next, moves
// them into the page's media-query stylesheet exactly like a responsive style.
// The runtime then reads computed values and never needs to know the width.
//
// Runs on the HYDRATED tree (after hydrateBindings, before
// applyResponsiveStyles), so cloned collection rows carry their effects too.
// `effects` never reaches the DOM.
//
// PURE: no React, no MST, no server-only.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { effectDomAcrossBreakpoints, storedEffectsOf } from '@/lib/effects/effects';

export interface EffectsResult {
  /** The rewritten tree (a new tree; the input is not mutated). */
  root: ComponentNode;
  /** Some node has an appear or a parallax: the page needs the client runtime and the start-state rules. */
  needsRuntime: boolean;
  /** Some node has any effect: the page needs the effects stylesheet. */
  hasEffects: boolean;
}

export function applyEffects(root: ComponentNode, breakpoints: readonly BreakpointRef[]): EffectsResult {
  let needsRuntime = false;
  let hasEffects = false;

  const visit = (node: ComponentNode): ComponentNode => {
    const next: ComponentNode = { ...node };
    const props = node.props as Record<string, unknown> | undefined;
    if (props && 'effects' in props) {
      const { effects: _drop, ...rest } = props;
      void _drop;
      const dom = effectDomAcrossBreakpoints(storedEffectsOf(props), breakpoints);
      if (dom) {
        hasEffects = true;
        if (dom.needsRuntime) needsRuntime = true;
        const style = rest.style && typeof rest.style === 'object' && !Array.isArray(rest.style)
          ? (rest.style as Record<string, unknown>)
          : {};
        const merged: Record<string, unknown> = { ...rest, ...dom.attributes };
        if (Object.keys(dom.style).length > 0 || rest.style !== undefined) merged.style = { ...style, ...dom.style };
        next.props = merged as ComponentNode['props'];
      } else {
        next.props = rest as ComponentNode['props'];
      }
    }
    if (node.children) next.children = node.children.map(visit);
    return next;
  };

  return { root: visit(root), needsRuntime, hasEffects };
}
