// src/components/sidebars/right/breakpointSource.ts
//
// Where a responsive style value shown in the properties panel comes from, for
// the indicator before a row's label (BreakpointSourceDot). Desktop-first
// cascade, see docs/plans/2026-10-23-breakpoint-style-inheritance.md: on the
// largest breakpoint every value is the base, so there is no indicator; below
// it a value is either set on this breakpoint (an override, which can be
// reset) or inherited from a larger one.
import type { ComponentInstance } from '@/models/ComponentModel';
import { storedRulesOf } from '@/lib/rules/rules';
import { readInState, type StateRead } from '@/lib/rules/stateValues';
import { whilePanelWritesRule } from '@/stores/EditorUIStore';

export type BreakpointSourceInfo =
  | {
      kind: 'own';
      /** The breakpoint being edited, e.g. "Tablet". */
      breakpointLabel: string;
      /** The breakpoint the value comes from after a reset, e.g. "Desktop". */
      resetToLabel: string;
      onReset: () => void;
    }
  | {
      kind: 'inherited';
      /** The larger breakpoint the value comes from, e.g. "Desktop". */
      fromLabel: string;
    }
  | {
      /** Set in the state being edited, on this breakpoint. The reset removes it. */
      kind: 'state-own';
      stateLabel: string;
      onReset: () => void;
    }
  | {
      /** Set in the state being edited, on a larger breakpoint. */
      kind: 'state-larger';
      stateLabel: string;
      fromLabel: string;
    }
  | {
      /** Not set in this state: the row shows another layer's value, greyed. "Hover" or "Normal". */
      kind: 'state-inherited';
      fromLabel: string;
    };

/** The label of a breakpoint on the component's page ("Tablet"), or undefined. */
export function breakpointLabel(component: ComponentInstance, breakpointId: string | undefined): string | undefined {
  if (!breakpointId) return undefined;
  return (component.pageBreakpoints as { id: string; label: string }[]).find(b => b.id === breakpointId)?.label;
}

/**
 * The source of one or more style properties shown in one row (W / H, the
 * four padding sides). Own when any of them is set on this breakpoint, and the
 * reset then removes every one of those overrides in one undo step; else
 * inherited from the first larger breakpoint that provides one of them. No
 * indicator on the largest breakpoint, without a breakpoint (floating
 * elements) or when nothing is set anywhere.
 */
export function styleSource(
  component: ComponentInstance,
  breakpointId: string | undefined,
  properties: readonly string[],
): BreakpointSourceInfo | undefined {
  if (!breakpointId || component.isLargestBreakpoint(breakpointId)) return undefined;
  const breakpoints = component.pageBreakpoints as { id: string; label: string }[];
  const labelOf = (id: string) => breakpoints.find(b => b.id === id)?.label ?? 'Breakpoint';
  const sources = properties.map(p => component.getResponsiveStyleSource(p, breakpointId).source);

  const own = properties.filter((_, i) => sources[i].kind === 'own');
  if (own.length > 0) {
    // After the reset the value comes from the nearest larger breakpoint that
    // sets one of these properties itself; with none, from the largest.
    const index = breakpoints.findIndex(b => b.id === breakpointId);
    let resetTo = breakpoints[0];
    for (let i = index - 1; i >= 0; i--) {
      const id = breakpoints[i].id;
      if (own.some(p => component.getResponsiveStyleSource(p, id).source.kind === 'own')) {
        resetTo = breakpoints[i];
        break;
      }
    }
    return {
      kind: 'own',
      breakpointLabel: labelOf(breakpointId),
      resetToLabel: resetTo?.label ?? 'Breakpoint',
      onReset: () => component.resetResponsiveStyles(own, breakpointId),
    };
  }

  const inherited = sources.find(s => s.kind === 'inherited');
  if (inherited && inherited.kind === 'inherited') return { kind: 'inherited', fromLabel: labelOf(inherited.breakpointId) };
  return undefined;
}

/** One property read in a state, on what the node stores now. */
export function readStateValue(component: ComponentInstance, ruleId: string, property: string, breakpointId: string | undefined): StateRead {
  return readInState({
    rules: storedRulesOf(component.props),
    normal: (component.props as { style?: Record<string, unknown> }).style ?? {},
    ruleId,
    property,
    breakpointId,
    breakpoints: component.cascadeBreakpoints(breakpointId),
  });
}

/**
 * The source of a row while a state is edited, in place of styleSource. Set in the
 * state wins, and its reset clears every property of the row set here, in one undo
 * step; a breakpoint below the one that set it says so, as a row does in Normal.
 * Otherwise the row reads from what the state implies, or from Normal. Nothing set
 * anywhere has no indicator, the same as styleSource.
 */
export function stateSource(
  component: ComponentInstance,
  ruleId: string,
  stateLabel: string,
  breakpointId: string | undefined,
  properties: readonly string[],
): BreakpointSourceInfo | undefined {
  const reads = properties.map((property) => readStateValue(component, ruleId, property, breakpointId));
  const inState = reads.filter((read) => read.layer === 'state');
  const setHere = inState.filter((read) => read.setHere);
  if (setHere.length > 0) {
    const keys = [...new Set(setHere.map((read) => read.key))];
    return {
      kind: 'state-own',
      stateLabel,
      // The panel's own write, so a state emptied here stays the state being edited.
      onReset: () => whilePanelWritesRule(() => component.clearRuleStyles(ruleId, keys, breakpointId)),
    };
  }
  if (inState.length > 0) {
    return { kind: 'state-larger', stateLabel, fromLabel: breakpointLabel(component, inState[0].fromBreakpoint) ?? 'a larger breakpoint' };
  }
  const implied = reads.find((read) => read.layer === 'implied');
  if (implied) return { kind: 'state-inherited', fromLabel: implied.fromLabel };
  return reads.some((read) => read.layer === 'normal') ? { kind: 'state-inherited', fromLabel: 'Normal' } : undefined;
}

/**
 * The source of an appear or scroll effect on `breakpointId`, for the Effects
 * section's rows: the same indicator as a style row. The whole group cascades
 * at once (src/lib/effects/effects.ts), so the reset removes the breakpoint's
 * override of the group and it inherits from the next larger breakpoint.
 */
export function effectSource(
  component: ComponentInstance,
  breakpointId: string | undefined,
  group: 'appear' | 'scroll',
): BreakpointSourceInfo | undefined {
  if (!breakpointId || component.isLargestBreakpoint(breakpointId)) return undefined;
  const breakpoints = component.pageBreakpoints as { id: string; label: string }[];
  const labelOf = (id: string) => breakpoints.find(b => b.id === id)?.label ?? 'Breakpoint';
  const source = component.getEffectSource(group, breakpointId).source;
  if (source.kind === 'own') {
    const index = breakpoints.findIndex(b => b.id === breakpointId);
    let resetTo = breakpoints[0];
    for (let i = index - 1; i >= 0; i--) {
      if (component.getEffectSource(group, breakpoints[i].id).source.kind === 'own') {
        resetTo = breakpoints[i];
        break;
      }
    }
    return {
      kind: 'own',
      breakpointLabel: labelOf(breakpointId),
      resetToLabel: resetTo?.label ?? 'Breakpoint',
      onReset: () => component.resetEffect(group, breakpointId),
    };
  }
  if (source.kind === 'inherited') return { kind: 'inherited', fromLabel: labelOf(source.breakpointId) };
  return undefined;
}
