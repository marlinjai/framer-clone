'use client';
// src/components/sidebars/right/StateSwitch.tsx
//
// Which state the properties panel edits: Normal, Hover, Pressed, Focused, and a row
// for each custom rule. Picking one also shows it on the canvas, because a state is
// otherwise dead there. A state has no rule until its first value, so clicking through
// leaves nothing behind. A radio group with a roving tab stop, as a person expects of
// one: arrows move and pick, Tab leaves. Colour changes only: this is pressed all day,
// so it does not animate. `+` opens the raw field, for everything no control names.
// See docs/plans/2026-11-02-selector-styling.md, "The panel".
import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Plus, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useStore } from '@/hooks/useStore';
import { cn } from '@/lib/utils';
import { isPageRoot, type ComponentInstance } from '@/models/ComponentModel';
import { isDefinitionRule, parseCssText, readRules, ruleCssText, storedRulesOf, type RuleDraft, type StoredRule } from '@/lib/rules/rules';
import { asNamedState, findRuleIndex, namedState, namedStateOf, ruleLabel } from '@/lib/rules/states';
import { FIELD_CONTROL } from './primitives';
import { definitionClash, ruleNotes } from './ruleNotes';

/** Reading order of the switch: Pressed comes after the Hover it builds on. */
const SWITCH_ORDER = ['hover', 'pressed', 'focused'] as const;

const ERROR = 'mt-1.5 text-[11px] leading-snug text-destructive';
const NOTE = 'mt-1.5 text-[11px] leading-snug text-muted-foreground';
const TEXT_BUTTON =
  'inline-flex h-7 flex-none items-center gap-1 rounded-[6px] border border-border px-2 text-[11px] text-foreground transition-colors duration-100 ' +
  'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
/** What makes a frame's width and height unknown to a floating element: the largest frame's are close enough for a note. */
const FALLBACK_FRAME = { width: 1280, height: 800 };

interface Option {
  id: string | null;
  label: string;
  holdsValues: boolean;
  /** Set for a stored rule that does not reach the page. */
  refused?: boolean;
}

const holdsValues = (rule: StoredRule | undefined): boolean =>
  !!rule && (isDefinitionRule(rule) || Object.keys(rule.style ?? {}).length > 0);

/** The field behind `+`: a selector or a whole rule, taken whole or not at all. */
const RawRuleField = observer(({ target, onClose }: { target: ComponentInstance; onClose: () => void }) => {
  const { editorUI } = useStore();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  const add = () => {
    const { rules, refused } = parseCssText(text, { pageRoot: isPageRoot(target) });
    if (refused.length > 0) return setError(`${refused[0].text}: ${refused[0].reason}.`);
    if (rules.length === 0) return setError('Type a selector, such as :nth-child(2n), or a CSS rule.');

    const page = editorUI.currentPage;
    const clash = page ? rules.map((rule) => definitionClash(page, rule)).find(Boolean) : null;
    if (clash) return setError(`${clash}.`);

    const stored = storedRulesOf(target.props);
    const drafts = rules.map(asNamedState).map((rule) => ({ ...rule, id: uuidv4().slice(0, 8) }));
    // A state that exists, asked for by name with nothing to add, is only a pick.
    const existing = drafts.length === 1 ? stored.find((rule) => rule.id !== undefined && sameState(rule, drafts[0])) : undefined;
    if (existing && !holdsValues(drafts[0] as StoredRule)) {
      editorUI.setActiveRule(existing.id);
    } else {
      const result = target.addRules(drafts);
      if (!result.ok) return setError(`${result.reason}`);
      const last = drafts[drafts.length - 1];
      editorUI.setActiveRule(namedStateOf(last as StoredRule)?.id ?? last.id);
    }
    onClose();
  };

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1.5">
      <textarea
        ref={field}
        rows={2}
        value={text}
        aria-label="Selector or CSS rule"
        aria-invalid={error ? true : undefined}
        placeholder=":nth-child(2n), or a rule to paste"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          // A newline is for pasted rules: Shift+Enter, as in a chat box.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            add();
          }
        }}
        className={cn(FIELD_CONTROL, 'h-auto min-h-12 resize-y py-1 font-mono text-[11px]')}
      />
      {error ? <p role="alert" className={ERROR}>{error}</p> : null}
      <div className="flex justify-end gap-1">
        <button type="button" onClick={onClose} className={TEXT_BUTTON}>Cancel</button>
        <button type="button" onClick={add} className={TEXT_BUTTON}>Add rule</button>
      </div>
    </div>
  );
});

RawRuleField.displayName = 'RawRuleField';

const sameState = (rule: StoredRule, draft: RuleDraft): boolean => {
  const state = namedStateOf(rule);
  return !!state && state === namedStateOf({ ...draft, id: 'draft' } as StoredRule);
};

/** A definition has no sections to edit it with, so it opens as the text it is. */
const DefinitionEditor = observer(({ target, rule }: { target: ComponentInstance; rule: StoredRule }) => {
  const { editorUI } = useStore();
  const [text, setText] = useState(() => ruleCssText(rule));
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const { rules, refused } = parseCssText(text, { pageRoot: isPageRoot(target) });
    if (refused.length > 0) return setError(`${refused[0].text}: ${refused[0].reason}.`);
    const [draft] = rules;
    if (rules.length !== 1 || !draft || !('define' in draft)) return setError('This field holds one definition.');
    const clash = editorUI.currentPage ? definitionClash(editorUI.currentPage, draft, rule.id) : null;
    if (clash) return setError(`${clash}.`);
    const result = target.replaceRule(rule.id, draft);
    setError(result.ok ? null : result.reason);
  };

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1.5">
      <textarea
        rows={8}
        value={text}
        aria-label="Definition"
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        className={cn(FIELD_CONTROL, 'h-auto resize-y py-1 font-mono text-[11px]')}
      />
      {error ? <p role="alert" className={ERROR}>{error}</p> : null}
      <div className="flex justify-end">
        <button type="button" onClick={apply} className={TEXT_BUTTON}>Apply</button>
      </div>
    </div>
  );
});

DefinitionEditor.displayName = 'DefinitionEditor';

const StateSwitch = observer(({ variant = 'docked' }: { variant?: 'docked' | 'sheet' }) => {
  const { editorUI } = useStore();
  const group = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const target = editorUI.ruleTarget;
  if (!target) return null;

  const rules = storedRulesOf(target.props);
  const { refused } = readRules(target.props, { pageRoot: isPageRoot(target) });
  const refusedRule = (rule: StoredRule) => refused.find((entry) => entry.rule === rule);
  const customRules = rules.filter((rule) => !namedStateOf(rule));
  const active = editorUI.activeRule;
  const activeStored = active ? rules[findRuleIndex(rules, active)] : undefined;

  const options: Option[] = [
    { id: null, label: 'Normal', holdsValues: false },
    ...SWITCH_ORDER.map((id) => ({ id, label: namedState(id)!.label, holdsValues: holdsValues(rules[findRuleIndex(rules, id)]) })),
    ...customRules.map((rule) => ({ id: rule.id, label: ruleLabel(rule), holdsValues: holdsValues(rule), refused: !!refusedRule(rule) })),
  ];
  const checkedId = activeStored && namedStateOf(activeStored) ? namedStateOf(activeStored)!.id : active;

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

  const radio = (option: Option, index: number, row: boolean) => {
    const checked = option.id === checkedId;
    return (
      <button
        key={option.id ?? 'normal'}
        type="button"
        role="radio"
        aria-checked={checked}
        title={option.label}
        tabIndex={checked ? 0 : -1}
        onClick={() => editorUI.setActiveRule(option.id)}
        onKeyDown={(event) => onKeyDown(event, index)}
        className={cn(
          'relative flex min-w-0 items-center rounded-[4px] text-[11px] font-medium transition-colors duration-100',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          row ? cn('w-full justify-start px-2 font-mono', variant === 'sheet' ? 'h-11' : 'h-7') : 'flex-1 justify-center',
          checked ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <span className="truncate">{option.label}</span>
        {option.holdsValues ? (
          <>
            <span
              aria-hidden
              data-testid="state-dot"
              className={cn('absolute right-0.5 top-0.5 h-1 w-1 rounded-full', option.refused ? 'bg-destructive' : 'bg-brand')}
            />
            <span className="sr-only">, holds values</span>
          </>
        ) : null}
      </button>
    );
  };

  const refusal = activeStored ? refusedRule(activeStored) : undefined;
  const frame = editorUI.selectedViewportNode;
  const notes = ruleNotes({
    target,
    page: editorUI.currentPage,
    rule: activeStored,
    frame: frame?.viewportWidth ? { width: frame.viewportWidth, height: frame.viewportHeight ?? FALLBACK_FRAME.height } : FALLBACK_FRAME,
  });

  return (
    <div className="flex-none border-b border-border px-3 py-2" data-testid="state-switch">
      <div ref={group} role="radiogroup" aria-label="Element state" className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1">
          <div className={cn('flex min-w-0 flex-1 gap-0.5 rounded-[6px] bg-muted p-0.5', variant === 'sheet' ? 'h-11' : 'h-7')}>
            {options.slice(0, SWITCH_ORDER.length + 1).map((option, index) => radio(option, index, false))}
          </div>
          <button
            type="button"
            aria-label="Add a custom rule"
            title="Add a custom rule"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
            className={cn(
              'flex flex-none items-center justify-center rounded-[6px] text-muted-foreground transition-colors duration-100',
              'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              variant === 'sheet' ? 'h-11 w-11' : 'h-7 w-7',
            )}
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        {customRules.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-0.5 rounded-[6px] bg-muted p-0.5">
            {options.slice(SWITCH_ORDER.length + 1).map((option, index) => radio(option, index + SWITCH_ORDER.length + 1, true))}
          </div>
        ) : null}
      </div>

      {adding ? <RawRuleField key={target.id} target={target} onClose={() => setAdding(false)} /> : null}

      {editorUI.ruleRefusal ? (
        <p role="alert" className={ERROR}>Not stored: {editorUI.ruleRefusal}.</p>
      ) : refusal ? (
        <p className={ERROR} data-testid="state-refused">This does not reach the page: {refusal.reason}. Change the value or delete the rule.</p>
      ) : null}
      {notes.map((note) => (
        <p key={note} className={NOTE} data-testid="rule-note">{note}</p>
      ))}

      {activeStored && isDefinitionRule(activeStored) ? <DefinitionEditor key={activeStored.id} target={target} rule={activeStored} /> : null}

      {activeStored ? (
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={() => target.removeRule(activeStored.id)} className={TEXT_BUTTON}>
            <Trash2 size={12} aria-hidden />
            Delete rule
          </button>
        </div>
      ) : null}
    </div>
  );
});

StateSwitch.displayName = 'StateSwitch';
export default StateSwitch;
