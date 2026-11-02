'use client';
// src/components/sidebars/right/StateSwitch.tsx
//
// Normal, Hover, Pressed, Focused: which state the properties panel edits. Picking one
// also shows it on the canvas, because a state is otherwise dead there. A state has no
// rule until its first value, so clicking through leaves nothing behind. A radio group
// with a roving tab stop, as a person expects of one: arrows move and pick, Tab leaves.
// Colour changes only: this is pressed all day, so it does not animate.
// See docs/plans/2026-11-02-selector-styling.md, "The panel".
import React, { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { cn } from '@/lib/utils';
import { isDefinitionRule, readRules, storedRulesOf, type StoredRule } from '@/lib/rules/rules';
import { findRuleIndex, namedState } from '@/lib/rules/states';

/** Reading order of the switch: Pressed comes after the Hover it builds on. */
const SWITCH_ORDER = ['hover', 'pressed', 'focused'] as const;

interface Option {
  id: string | null;
  label: string;
  holdsValues: boolean;
}

const StateSwitch = observer(({ variant = 'docked' }: { variant?: 'docked' | 'sheet' }) => {
  const { editorUI } = useStore();
  const group = useRef<HTMLDivElement>(null);
  const target = editorUI.ruleTarget;
  if (!target) return null;

  const rules = storedRulesOf(target.props);
  const holds = (id: string) => {
    const rule = rules[findRuleIndex(rules, id)];
    return !!rule && !isDefinitionRule(rule) && Object.keys(rule.style ?? {}).length > 0;
  };
  const options: Option[] = [
    { id: null, label: 'Normal', holdsValues: false },
    ...SWITCH_ORDER.map((id) => ({ id, label: namedState(id)!.label, holdsValues: holds(id) })),
  ];
  const active = editorUI.activeRule;

  const moveTo = (index: number) => {
    const at = (index + options.length) % options.length;
    editorUI.setActiveRule(options[at].id);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[at]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    moveTo(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index + step);
  };

  const refused = active
    ? readRules(target.props).refused.find(({ rule }) => findRuleIndex([rule as StoredRule], active) !== -1)
    : undefined;

  return (
    <div className="flex-none border-b border-border px-3 py-2" data-testid="state-switch">
      <div
        ref={group}
        role="radiogroup"
        aria-label="Element state"
        className={cn('flex min-w-0 gap-0.5 rounded-[6px] bg-muted p-0.5', variant === 'sheet' ? 'h-11' : 'h-7')}
      >
        {options.map((option, index) => {
          const checked = option.id === active;
          return (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => editorUI.setActiveRule(option.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                'relative flex min-w-0 flex-1 items-center justify-center rounded-[4px] text-[11px] font-medium transition-colors duration-100',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                checked ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{option.label}</span>
              {option.holdsValues ? (
                <>
                  <span aria-hidden data-testid="state-dot" className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-brand" />
                  <span className="sr-only">, holds values</span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>
      {editorUI.ruleRefusal ? (
        <p role="alert" className="mt-1.5 text-[11px] leading-snug text-destructive">
          Not stored: {editorUI.ruleRefusal}.
        </p>
      ) : refused ? (
        <p className="mt-1.5 text-[11px] leading-snug text-destructive" data-testid="state-refused">
          This does not reach the page: {refused.reason}. Change the value or reset it.
        </p>
      ) : null}
    </div>
  );
});

StateSwitch.displayName = 'StateSwitch';
export default StateSwitch;
