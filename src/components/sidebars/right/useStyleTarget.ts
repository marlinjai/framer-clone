// src/components/sidebars/right/useStyleTarget.ts
//
// Where a style section reads and writes: Normal, or the state the switch picked
// (StateSwitch.tsx). Every section gets its values, its writes and each row's source
// from here, so one place decides what a state means and no section has to know. See
// docs/plans/2026-11-02-selector-styling.md, "The panel".
'use client';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { storedRulesOf } from '@/lib/rules/rules';
import { findRuleIndex } from '@/lib/rules/states';
import { whilePanelWritesRule } from '@/stores/EditorUIStore';
import { breakpointLabel, readStateValue, stateSource, styleSource, type BreakpointSourceInfo } from './breakpointSource';

export interface StyleTarget {
  /** The state being edited, or undefined on Normal. */
  stateLabel: string | undefined;
  /** The value a row shows: this state's, or what it falls back to. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStyleValue: (prop: string) => any;
  /** Stores a value, or returns why it was refused (the panel also shows that under the switch). */
  setStyleValue: (prop: string, value: string | number) => string | null;
  /** Where a row's value comes from: the dot before the label, and the caption in a state. */
  src: (...props: string[]) => BreakpointSourceInfo | undefined;
  /** Removes a property on every breakpoint of what is being edited. */
  removeStyle: (prop: string) => void;
  /** The keys that what is being edited stores. */
  storedKeys: () => string[];
  /** The section badge: "Tablet", or "Hover · Tablet" in a state. */
  badge: string | undefined;
}

export function useStyleTarget(component: ComponentInstance, breakpointId?: string): StyleTarget {
  const { editorUI } = useStore();
  const label = breakpointLabel(component, breakpointId);
  const ruleId = editorUI.ruleTarget?.id === component.id ? editorUI.activeRule : null;

  if (!ruleId) {
    return {
      stateLabel: undefined,
      getStyleValue: (prop) => component.getResponsiveStyleValue(prop, breakpointId),
      setStyleValue: (prop, value) => {
        component.updateResponsiveStyle(prop, value, breakpointId);
        return null;
      },
      src: (...props) => styleSource(component, breakpointId, props),
      removeStyle: (prop) => component.removeStyleProperty(prop),
      storedKeys: () => Object.keys((component.props as { style?: object }).style ?? {}),
      badge: label,
    };
  }

  const stateLabel = editorUI.activeRuleLabel ?? 'State';
  const read = (prop: string) => readStateValue(component, ruleId, prop, breakpointId);

  return {
    stateLabel,
    getStyleValue: (prop) => read(prop).value,
    setStyleValue: (prop, value) => {
      // A field that commits on blur hands back what it was showing. That is not an
      // edit, and writing it would pin an inherited value and leave a rule behind.
      const current = read(prop);
      if (current.layer !== 'state' && String(current.value ?? '') === String(value)) return null;
      const result = whilePanelWritesRule(() => component.setRuleStyle(ruleId, prop, value, breakpointId));
      const refusal = result.ok ? null : result.reason;
      editorUI.setRuleRefusal(refusal);
      return refusal;
    },
    src: (...props) => stateSource(component, ruleId, stateLabel, breakpointId, props),
    removeStyle: (prop) => {
      whilePanelWritesRule(() => component.clearRuleStyles(ruleId, [prop]));
    },
    storedKeys: () => {
      const rules = storedRulesOf(component.props);
      const rule = rules[findRuleIndex(rules, ruleId)];
      return Object.keys(rule?.style ?? {});
    },
    badge: label ? `${stateLabel} · ${label}` : stateLabel,
  };
}
