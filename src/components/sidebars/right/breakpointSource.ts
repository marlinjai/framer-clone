// src/components/sidebars/right/breakpointSource.ts
//
// Where a responsive style value shown in the properties panel comes from, for
// the indicator before a row's label (BreakpointSourceDot). Desktop-first
// cascade, see docs/plans/2026-10-23-breakpoint-style-inheritance.md: on the
// largest breakpoint every value is the base, so there is no indicator; below
// it a value is either set on this breakpoint (an override, which can be
// reset) or inherited from a larger one.
import type { ComponentInstance } from '@/models/ComponentModel';

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
