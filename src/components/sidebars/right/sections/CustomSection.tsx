'use client';
// src/components/sidebars/right/sections/CustomSection.tsx
//
// The general editor at the end of the properties panel: the element's tag, then
// any CSS property and any attribute the sections above have no control for, and
// any value their controls cannot hold (ownedKeys.ts), so nothing a page can hold
// needs a hand-written control first. CSS follows the state being edited, through
// the same hook as every style section; the tag and attributes are Normal's alone.
// Styles are per breakpoint like every style row, with the same source dot and
// reset. Fields are native (select, input with a datalist), so they keep the
// keyboard and screen-reader behaviour of the rest of the panel. Typing only
// changes a draft: Enter, blur or Add commits one model action, so one edit is one
// undo step, and Escape puts the field back. What the renderers would drop is
// refused here with a message and never stored (src/lib/styles/customEditor.ts).

import React, { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useOpenDraft } from '@/hooks/useOpenDraft';
import { observer } from 'mobx-react-lite';
import { getParent, hasParent } from 'mobx-state-tree';
import { Braces, ChevronDown, X } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { cssStyleKey, cssPropertyName } from '@/lib/responsive/responsiveCss';
import { formKindOf } from '@/lib/forms/definition';
import {
  attributeName,
  attributeNameError,
  attributeProp,
  attributeStoredValue,
  attributeSuggestions,
  attributeValueError,
  cssPropertyError,
  cssPropertySpelling,
  cssPropertySuggestions,
  cssValueError,
  isAttributeProp,
  isBooleanAttribute,
  isSupportedDeclaration,
  tagGroups,
  tagNestingHint,
  contentOf,
  tagRefusal,
} from '@/lib/styles/customEditor';
import { cn } from '@/lib/utils';
import { CollapsibleSection, FIELD_CONTROL, FIELD_LABEL, NormalOnly, PropertyRow, TextInput } from '../primitives';
import { useFieldIdentity } from '../primitives/field';
import type { BreakpointSourceInfo } from '../breakpointSource';
import { useStyleTarget } from '../useStyleTarget';
import { controlHolds, isPartlyOwned, ownedProps, ownedStyleKeys } from '../ownedKeys';
import { getComponentCategory, type ComponentCategory } from '../sectionConfig';

const ERROR = 'text-[11px] leading-snug text-destructive';
const HINT = 'text-[11px] leading-snug text-muted-foreground';
const ICON_BUTTON =
  'flex h-7 w-7 flex-none items-center justify-center rounded-[6px] text-muted-foreground transition-colors ' +
  'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const TEXT_BUTTON =
  'h-7 flex-none rounded-[6px] border border-border px-2.5 text-[11px] text-foreground transition-colors ' +
  'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

const LOCKED_TAG: ReadonlySet<ComponentCategory> = new Set(['form', 'formField', 'formSubmit', 'stickyCta', 'mapEmbed', 'fxScene']);

interface CustomSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const TAG_GROUPS = tagGroups();

/** Forms, the sticky bar and data components are defined by their tag and markers. */
function canChooseTag(component: ComponentInstance, category: ComponentCategory): boolean {
  const props = component.props as Record<string, unknown>;
  return component.isHostElement && !LOCKED_TAG.has(category) && !props['data-component-kind'];
}

/** The tag of the element around this one (the array sits between the two in the tree). */
function parentTag(component: ComponentInstance): string | undefined {
  if (!hasParent(component, 2)) return undefined;
  const type = (getParent(component, 2) as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/** Hundreds of options: rendered once per list, not on every keystroke. */
const Suggestions = memo(({ id, names }: { id: string; names: readonly string[] }) => (
  <datalist id={id}>
    {names.map((name) => (
      <option key={name} value={name} />
    ))}
  </datalist>
));

Suggestions.displayName = 'Suggestions';

const TagPicker = observer(({ component }: { component: ComponentInstance }) => {
  const { id } = useFieldIdentity('', undefined);
  const [refusal, setRefusal] = useState<string | null>(null);
  const tag = component.type as string;
  const groups = TAG_GROUPS;
  const offered = groups.some((group) => group.tags.includes(tag));
  const hint = tagNestingHint(tag, parentTag(component));

  const choose = (next: string) => {
    const problem = tagRefusal(next, contentOf(component));
    setRefusal(problem);
    if (!problem) component.setTag(next);
  };

  return (
    <>
      <div className="relative min-w-0">
        <select
          id={id}
          value={tag}
          aria-invalid={refusal ? true : undefined}
          onChange={(e) => choose(e.target.value)}
          className={cn(FIELD_CONTROL, 'cursor-pointer appearance-none truncate pr-6 font-mono text-[11px]')}
        >
          {offered ? null : <option value={tag}>{tag}</option>}
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.tags.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          size={12}
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      {refusal ? (
        <p role="alert" className={cn(ERROR, 'mt-1.5')}>{refusal}</p>
      ) : hint ? (
        <p className={cn(HINT, 'mt-1.5')}>{hint}</p>
      ) : null}
    </>
  );
});

TagPicker.displayName = 'TagPicker';

interface ValueRowProps {
  name: string;
  value: string;
  placeholder?: string;
  note?: string | null;
  source?: BreakpointSourceInfo;
  /** Stores the value, or returns why it was refused. */
  onCommit: (text: string) => string | null;
  /** Absent where there is nothing here to remove: an inherited value in a state. */
  onRemove?: () => void;
  removeLabel: string;
}

/** One set property or attribute: its full name, its value and a remove button. */
function ValueRow({ name, value, placeholder, note, source, onCommit, onRemove, removeLabel }: ValueRowProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  const commit = () => {
    draftState.settled();
    if (draft !== value) setError(onCommit(draft));
  };
  // Counted as unsaved, and committed by Cmd+S, leaving and unmount (useOpenDraft).
  const draftState = useOpenDraft(() => commit());

  return (
    <PropertyRow label={name} source={source} group>
      <div className="flex min-w-0 items-center gap-1">
        <TextInput
          mono
          value={draft}
          placeholder={placeholder}
          aria-label={`${name} value`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            draftState.edited();
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              draftState.settled();
              setDraft(value);
              setError(null);
            }
          }}
        />
        {onRemove ? (
          <button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove} className={ICON_BUTTON}>
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={cn(ERROR, 'mt-1.5')}>{error}</p>
      ) : note ? (
        <p className={cn(HINT, 'mt-1.5')}>{note}</p>
      ) : null}
    </PropertyRow>
  );
}

interface AddFormProps {
  /** Names the two fields for assistive technology: "CSS property", "Attribute". */
  thing: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  suggestions: readonly string[];
  nameError: (name: string) => string | null;
  valueError: (name: string, value: string) => string | null;
  /** An empty value is a real value (a boolean or a `data-` attribute). */
  allowsEmptyValue?: boolean;
  /** The name alone is enough: Enter there adds it without a value. */
  needsNoValue?: (name: string) => boolean;
  /** Stores it. A reason comes back when it was refused after all, and the form keeps what was typed. */
  onAdd: (name: string, value: string) => string | null | void;
  /** A change empties the form: a half-typed value in Hover is not one for Pressed. */
  scope?: string;
}

function AddForm({
  thing,
  namePlaceholder,
  valuePlaceholder,
  suggestions,
  nameError,
  valueError,
  allowsEmptyValue = false,
  needsNoValue,
  onAdd,
  scope,
}: AddFormProps) {
  const listId = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameField = useRef<HTMLDivElement>(null);
  const valueField = useRef<HTMLDivElement>(null);
  const focusField = (shell: HTMLDivElement | null) => shell?.querySelector('input')?.focus();

  useEffect(() => {
    setName('');
    setValue('');
    setError(null);
  }, [scope]);

  const add = () => {
    const problem =
      nameError(name) ??
      (value.trim() === '' && !allowsEmptyValue ? 'Type a value.' : valueError(name, value));
    setError(problem);
    if (problem) return;
    const refusal = onAdd(name, value);
    if (refusal) {
      setError(refusal);
      return;
    }
    setName('');
    setValue('');
    focusField(nameField.current);
  };

  const fromName = () => {
    const problem = nameError(name);
    setError(problem);
    if (problem) return;
    if (value === '' && needsNoValue?.(name)) add();
    else focusField(valueField.current);
  };

  const clear = () => {
    setName('');
    setValue('');
    setError(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div ref={nameField}>
        <TextInput
          mono
          list={listId}
          value={name}
          placeholder={namePlaceholder}
          aria-label={`${thing} name`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fromName();
            if (e.key === 'Escape') clear();
          }}
        />
        <Suggestions id={listId} names={suggestions} />
      </div>
      <div ref={valueField} className="flex min-w-0 items-center gap-1">
        <TextInput
          mono
          value={value}
          placeholder={valuePlaceholder}
          aria-label={`${thing} value`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            if (e.key === 'Escape') clear();
          }}
        />
        <button type="button" aria-label={`Add ${thing}`} onClick={add} className={TEXT_BUTTON}>
          Add
        </button>
      </div>
      {error ? <p role="alert" className={ERROR}>{error}</p> : null}
    </div>
  );
}

const CssEditor = observer(({ component, breakpointId, category }: CustomSectionProps & { category: ComponentCategory }) => {
  const owned = useMemo(() => ownedStyleKeys(category), [category]);
  const target = useStyleTarget(component, breakpointId);
  const { stateLabel } = target;
  const stored = target.storedKeys();
  const normal = Object.keys(((component.props as Record<string, unknown>).style ?? {}) as Record<string, unknown>);
  const valueOf = (key: string) => String(target.getStyleValue(key) ?? '');
  // In a state, what Normal holds shows too, greyed, so it can be given a value here.
  const keys = [...new Set([...normal, ...stored])].filter((key) => !owned.has(key) || (isPartlyOwned(key) && !controlHolds(key, valueOf(key))));
  const suggestions = useMemo(() => cssPropertySuggestions.filter((name) => !owned.has(cssStyleKey(name))), [owned]);

  const nameError = (typed: string) => {
    const problem = cssPropertyError(typed);
    if (problem) return problem;
    const key = cssStyleKey(cssPropertySpelling(typed));
    const section = owned.get(key);
    return section && !isPartlyOwned(key) ? `${cssPropertySpelling(typed)} has its own control in the ${section} section.` : null;
  };

  const valueError = (typed: string, value: string) => {
    const key = cssStyleKey(cssPropertySpelling(typed));
    const section = owned.get(key);
    if (section && controlHolds(key, value)) return `Use the ${section} section for this value. Custom is for values its control cannot hold, such as calc().`;
    return cssValueError(key, value);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={FIELD_LABEL}>CSS</span>
      {keys.map((key) => {
        const name = cssPropertyName(key);
        const value = valueOf(key);
        return (
          <ValueRow
            key={key}
            name={name}
            value={value}
            placeholder="Not set here"
            note={isSupportedDeclaration(name, value) ? null : `This browser ignores this value for ${name}.`}
            source={target.src(key)}
            removeLabel={stateLabel ? `Remove ${name} from ${stateLabel} on every breakpoint` : `Remove ${name} on every breakpoint`}
            onRemove={stored.includes(key) ? () => target.removeStyle(key) : undefined}
            onCommit={(text) => cssValueError(key, text) ?? target.setStyleValue(key, text.trim())}
          />
        );
      })}
      <AddForm
        thing="CSS property"
        namePlaceholder="Property, as clip-path"
        valuePlaceholder="Value"
        suggestions={suggestions}
        nameError={nameError}
        valueError={valueError}
        scope={stateLabel}
        onAdd={(typed, value) => target.setStyleValue(cssStyleKey(cssPropertySpelling(typed)), value.trim())}
      />
    </div>
  );
});

CssEditor.displayName = 'CssEditor';

const AttributeEditor = observer(({ component, category }: { component: ComponentInstance; category: ComponentCategory }) => {
  const owned = useMemo(() => ownedProps(category), [category]);
  const tag = component.type as string;
  const props = component.props as Record<string, unknown>;
  // A submit button is a button whatever its stored type.
  const renderedTag = formKindOf(props) === 'form-submit' ? 'button' : tag;
  const rows = Object.keys(props).filter((prop) => {
    const kind = typeof props[prop];
    return isAttributeProp(prop) && !owned.has(prop) && (kind === 'string' || kind === 'number' || kind === 'boolean');
  });
  const suggestions = useMemo(
    () => attributeSuggestions(tag).filter((name) => !owned.has(attributeProp(name, tag))),
    [owned, tag],
  );

  const nameError = (typed: string) => {
    const problem = attributeNameError(typed, tag);
    if (problem) return problem;
    return owned.has(attributeProp(typed, tag)) ? `${typed.trim()} has its own control above.` : null;
  };

  const write = (name: string, text: string) => {
    component.setProps({ [attributeProp(name, tag)]: attributeStoredValue(name, text) });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={FIELD_LABEL}>Attributes</span>
      {rows.map((prop) => {
        const name = attributeName(prop);
        return (
          <ValueRow
            key={prop}
            name={name}
            value={String(props[prop])}
            removeLabel={`Remove ${name}`}
            onRemove={() => component.setProps({ [prop]: undefined })}
            onCommit={(text) => {
              const problem = attributeValueError(name, text, renderedTag);
              if (!problem) write(name, text);
              return problem;
            }}
          />
        );
      })}
      <AddForm
        thing="Attribute"
        namePlaceholder="Attribute, as aria-label"
        valuePlaceholder="Value"
        suggestions={suggestions}
        nameError={nameError}
        valueError={(name, value) => attributeValueError(name, value, renderedTag)}
        allowsEmptyValue
        needsNoValue={isBooleanAttribute}
        onAdd={write}
      />
    </div>
  );
});

AttributeEditor.displayName = 'AttributeEditor';

export const CustomSection = observer(({ component, breakpointId }: CustomSectionProps) => {
  const category = getComponentCategory(component);
  const { badge } = useStyleTarget(component, breakpointId);
  return (
    <CollapsibleSection title="Custom" icon={<Braces size={14} />} badge={badge}>
      {/* Keyed by node, so a draft or a refusal never carries over to another element. */}
      <React.Fragment key={component.id}>
        {canChooseTag(component, category) ? (
          <NormalOnly>
            <PropertyRow label="Tag" hint="The HTML element this node renders as">
              <TagPicker component={component} />
            </PropertyRow>
          </NormalOnly>
        ) : null}
        <CssEditor component={component} breakpointId={breakpointId} category={category} />
        <NormalOnly>
          <AttributeEditor component={component} category={category} />
        </NormalOnly>
      </React.Fragment>
    </CollapsibleSection>
  );
});

CustomSection.displayName = 'CustomSection';
