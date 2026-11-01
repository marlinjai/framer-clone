'use client';
// src/components/sidebars/right/sections/CustomSection.tsx
//
// The general editor at the end of the properties panel: the element's tag, then
// any CSS property and any attribute the sections above have no control for, and
// any value their controls cannot hold (ownedKeys.ts), so nothing a page can hold
// needs a hand-written control first.
// Styles are per breakpoint like every style row, with the same source dot and
// reset. Fields are native (select, input with a datalist), so they keep the
// keyboard and screen-reader behaviour of the rest of the panel. Typing only
// changes a draft: Enter, blur or Add commits one model action, so one edit is one
// undo step, and Escape puts the field back. What the renderers would drop is
// refused here with a message and never stored (src/lib/styles/customEditor.ts).

import React, { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getParent, hasParent } from 'mobx-state-tree';
import { Braces, ChevronDown, X } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { cssStyleKey, cssPropertyName } from '@/lib/responsive/responsiveCss';
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
  tagRefusal,
} from '@/lib/styles/customEditor';
import { cn } from '@/lib/utils';
import { CollapsibleSection, FIELD_CONTROL, FIELD_LABEL, PropertyRow, TextInput } from '../primitives';
import { useFieldIdentity } from '../primitives/field';
import { breakpointLabel, styleSource, type BreakpointSourceInfo } from '../breakpointSource';
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

const LOCKED_TAG: ReadonlySet<ComponentCategory> = new Set(['form', 'formField', 'formSubmit', 'stickyCta']);

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
    const props = component.props as Record<string, unknown>;
    const problem = tagRefusal(next, { childCount: component.children.length, text: props.children });
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
  onRemove: () => void;
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
    if (draft !== value) setError(onCommit(draft));
  };

  return (
    <PropertyRow label={name} source={source} group>
      <div className="flex min-w-0 items-center gap-1">
        <TextInput
          mono
          value={draft}
          placeholder={placeholder}
          aria-label={`${name} value`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(value);
              setError(null);
            }
          }}
        />
        <button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove} className={ICON_BUTTON}>
          <X size={12} aria-hidden />
        </button>
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
  onAdd: (name: string, value: string) => void;
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
}: AddFormProps) {
  const listId = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameField = useRef<HTMLDivElement>(null);
  const valueField = useRef<HTMLDivElement>(null);
  const focusField = (shell: HTMLDivElement | null) => shell?.querySelector('input')?.focus();

  const add = () => {
    const problem =
      nameError(name) ??
      (value.trim() === '' && !allowsEmptyValue ? 'Type a value.' : valueError(name, value));
    setError(problem);
    if (problem) return;
    onAdd(name, value);
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
  const stored = ((component.props as Record<string, unknown>).style ?? {}) as Record<string, unknown>;
  const valueOf = (key: string) => String(component.getResponsiveStyleValue(key, breakpointId) ?? '');
  const keys = Object.keys(stored).filter((key) => !owned.has(key) || (isPartlyOwned(key) && !controlHolds(key, valueOf(key))));
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
            source={styleSource(component, breakpointId, [key])}
            removeLabel={`Remove ${name} on every breakpoint`}
            onRemove={() => component.removeStyleProperty(key)}
            onCommit={(text) => {
              const problem = cssValueError(key, text);
              if (!problem) component.updateResponsiveStyle(key, text.trim(), breakpointId);
              return problem;
            }}
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
        onAdd={(typed, value) => {
          component.updateResponsiveStyle(cssStyleKey(cssPropertySpelling(typed)), value.trim(), breakpointId);
        }}
      />
    </div>
  );
});

CssEditor.displayName = 'CssEditor';

const AttributeEditor = observer(({ component, category }: { component: ComponentInstance; category: ComponentCategory }) => {
  const owned = useMemo(() => ownedProps(category), [category]);
  const tag = component.type as string;
  const props = component.props as Record<string, unknown>;
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
              const problem = attributeValueError(name, text);
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
        valueError={attributeValueError}
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
  return (
    <CollapsibleSection title="Custom" icon={<Braces size={14} />} badge={breakpointLabel(component, breakpointId)}>
      {/* Keyed by node, so a draft or a refusal never carries over to another element. */}
      <React.Fragment key={component.id}>
        {canChooseTag(component, category) ? (
          <PropertyRow label="Tag" hint="The HTML element this node renders as">
            <TagPicker component={component} />
          </PropertyRow>
        ) : null}
        <CssEditor component={component} breakpointId={breakpointId} category={category} />
        <AttributeEditor component={component} category={category} />
      </React.Fragment>
    </CollapsibleSection>
  );
});

CustomSection.displayName = 'CustomSection';
