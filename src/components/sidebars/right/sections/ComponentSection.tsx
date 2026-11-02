'use client';
// src/components/sidebars/right/sections/ComponentSection.tsx
//
// The properties panel's section for a placement of a reusable component: the
// form its definition's inputs generate, one row per input with that type's
// control, the initial state, and Edit component, Detach and Reset all. Size,
// Position and Effects follow it (sectionConfig.ts); everything else is the
// definition's, by decision 7 of the contract.
//
// - A value goes through parseInputValue before it is stored, the check the
//   renderer runs again, and a refused value stays in the field with the reason.
// - Each row has the bind button, which is what puts a placement in a collection
//   on `{{row.title}}`, and a reset where the placement has a value of its own.
// - A value is one per placement, not one per breakpoint. A value stored per
//   breakpoint (from data or a generator) shows where it applies on this frame,
//   and a change here sets it everywhere, which the row says.
// - A placement whose definition is gone (an undo, another tab's save) says so
//   and keeps the node, so restoring the definition restores it.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "The right panel".

import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Component, Pencil, RotateCcw, Unlink } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindableSlotMeta } from '@/lib/bindings/types';
import { useStore } from '@/hooks/useStore';
import { isResponsiveMap, resolveCascade, type BreakpointRef } from '@/lib/responsive/cascade';
import { parseInputValue, type ImageValue, type InputDefinition } from '@/lib/components/inputs';
import type { PlacementProps } from '@/lib/components/placement';
import { requestDetach } from '@/lib/components/editorCommands';
import { extractBreakpoints } from '@/lib/renderer/server/componentSnapshot';
import { definitionBreakpointFor } from '@/lib/components/breakpoints';
import { getSnapshot } from 'mobx-state-tree';
import { CollapsibleSection, ColorInput, FIELD_CONTROL, FIELD_LABEL, PropertySelect, PropertySwitch, TextInput } from '../primitives';
import BindingControl from '../BindingControl';
import { cn } from '@/lib/utils';

interface ComponentSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';
const ERROR = 'text-[11px] leading-snug text-destructive';
const ACTION =
  'flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded border border-border px-2 text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand phone:h-9';

/** The types whose value has a control of its own here. The others are set from data for now. */
const EDITABLE = new Set(['text', 'number', 'toggle', 'color', 'image', 'link', 'choice', 'file', 'date', 'border', 'shadow', 'cursor', 'transition']);

/** A stored value on this frame: a value per breakpoint resolves to the one that applies. */
function valueOn(value: unknown, breakpointId: string | undefined, breakpoints: readonly BreakpointRef[]): unknown {
  return isResponsiveMap(value, new Set(breakpoints.map((b) => b.id))) ? resolveCascade(value, breakpointId, breakpoints).value : value;
}

const asText = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

/**
 * A field that keeps what is typed and stores it on Enter or blur, once it parses:
 * one edit, one undo step. A refused value stays with the reason under it.
 */
const CommitField = ({
  label,
  shown,
  placeholder,
  parse,
  onCommit,
  multiline,
  inputMode,
  mono,
}: {
  label: string;
  shown: string;
  placeholder?: string;
  parse: (text: string) => { ok: true; value: unknown } | { ok: false; reason: string };
  onCommit: (value: unknown) => void;
  multiline?: boolean;
  inputMode?: 'decimal' | 'url';
  mono?: boolean;
}) => {
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(shown);
    setError(null);
  }, [shown]);
  const commit = () => {
    if (draft === shown) return;
    const parsed = parse(draft);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    onCommit(parsed.value);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      setDraft(shown);
      setError(null);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {multiline ? (
        <textarea
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          rows={3}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={keys}
          className={cn(FIELD_CONTROL, 'h-auto resize-y py-1')}
        />
      ) : (
        <TextInput
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          inputMode={inputMode}
          mono={mono}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
      )}
      {error && <p role="alert" className={ERROR}>{error}</p>}
    </div>
  );
};

/** A colour, with the reason under it when a typed value is refused. */
const ColorControl = ({
  input,
  value,
  check,
  onCommit,
}: {
  input: InputDefinition;
  value: unknown;
  check: (raw: unknown) => { ok: true; value: unknown } | { ok: false; reason: string };
  onCommit: (value: unknown) => void;
}) => {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ColorInput
        label=""
        aria-label={input.name}
        value={asText(value)}
        onChange={(next) => {
          const parsed = check(next);
          setError(parsed.ok ? null : parsed.reason);
          if (parsed.ok) onCommit(next);
        }}
      />
      {error && <p role="alert" className={ERROR}>{error}</p>}
    </div>
  );
};

/** The control for one input, by its type. `value` is what the placement shows on this frame. */
const InputControl = ({ input, value, onCommit }: { input: InputDefinition; value: unknown; onCommit: (value: unknown) => void }) => {
  // The value is stored as given once it parses: the renderer parses it again, and
  // what parsing gives back is for the page (a number with its unit, for one).
  const check = (raw: unknown): { ok: true; value: unknown } | { ok: false; reason: string } => {
    const parsed = parseInputValue(input, raw);
    return parsed.ok ? { ok: true, value: raw } : { ok: false, reason: `Not stored: ${parsed.reason}.` };
  };
  const placeholder = input.default === undefined ? undefined : asText(input.default) || undefined;
  switch (input.type) {
    case 'toggle':
      return <PropertySwitch aria-label={input.name} checked={value === true} onCheckedChange={(checked) => onCommit(checked)} />;
    case 'choice':
      return (
        <PropertySelect
          label=""
          aria-label={input.name}
          value={typeof value === 'string' ? value : ''}
          options={input.options ?? []}
          onChange={(next) => onCommit(next)}
        />
      );
    case 'color':
      return <ColorControl input={input} value={value} check={check} onCommit={onCommit} />;
    case 'number':
      return (
        <CommitField
          label={input.name}
          shown={asText(value)}
          placeholder={placeholder}
          inputMode="decimal"
          parse={(text) => (text.trim() === '' ? { ok: false, reason: 'Type a number, or reset to use the default.' } : check(Number(text)))}
          onCommit={onCommit}
        />
      );
    case 'image': {
      const image = (value && typeof value === 'object' ? value : {}) as Partial<ImageValue>;
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <CommitField
            label={`${input.name} address`}
            shown={asText(image.src)}
            placeholder="/photo.jpg"
            inputMode="url"
            mono
            parse={(text) => check({ src: text.trim(), alt: image.alt ?? '' })}
            onCommit={onCommit}
          />
          <CommitField
            label={`${input.name} description`}
            shown={asText(image.alt)}
            placeholder="What the image shows"
            parse={(text) => (image.src ? check({ src: image.src, alt: text }) : { ok: false, reason: 'Add the address first.' })}
            onCommit={onCommit}
          />
        </div>
      );
    }
    default:
      return (
        <CommitField
          label={input.name}
          shown={asText(value)}
          placeholder={placeholder}
          multiline={input.type === 'text' && input.multiline}
          inputMode={input.type === 'link' || input.type === 'file' ? 'url' : undefined}
          mono={input.type === 'link' || input.type === 'file'}
          parse={(text) => check(input.type === 'text' ? text : text.trim())}
          onCommit={onCommit}
        />
      );
  }
};

const InputRow = observer(({
  component,
  input,
  value,
  perBreakpoint,
}: {
  component: ComponentInstance;
  input: InputDefinition;
  value: unknown;
  perBreakpoint: boolean;
}) => {
  const stored = (component.props as Partial<PlacementProps>).inputs ?? {};
  const own = Object.hasOwn(stored, input.id);
  const meta: BindableSlotMeta = { label: input.name, allowedModes: ['read'], scopeHint: 'any' };
  const write = (next: unknown) => component.setProps({ inputs: { ...stored, [input.id]: next } });
  const reset = () => {
    const { [input.id]: _gone, ...rest } = stored;
    void _gone;
    component.setProps({ inputs: Object.keys(rest).length > 0 ? rest : undefined });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`component-input-${input.id}`}>
      <div className="flex min-w-0 items-center gap-1">
        <span className={cn(FIELD_LABEL, 'min-w-0 flex-1 truncate')} title={input.description}>{input.name}</span>
        {own && (
          <button
            type="button"
            aria-label={`Reset ${input.name}`}
            title="Back to the component's default"
            onClick={reset}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>
      {input.type === 'event' ? (
        <p className={HINT}>An event: what it does is set in this placement&apos;s interactions.</p>
      ) : (
        <BindingControl node={component} slot={`input.${input.id}`} meta={meta}>
          {EDITABLE.has(input.type) ? (
            <InputControl input={input} value={value} onCommit={write} />
          ) : (
            <p className={HINT}>Set from data with the bind button.</p>
          )}
        </BindingControl>
      )}
      {input.description && <p className={HINT}>{input.description}</p>}
      {own && perBreakpoint && <p className={HINT}>Set per breakpoint. A change here sets it for every breakpoint.</p>}
    </div>
  );
});
InputRow.displayName = 'InputRow';

export const ComponentSection = observer(({ component, breakpointId }: ComponentSectionProps) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const page = editorUI.currentPage;
  const props = component.props as Partial<PlacementProps>;
  const definition = props.component ? project?.components.get(props.component) : undefined;

  if (!definition) {
    return (
      <CollapsibleSection title="Component" icon={<Component size={14} />} normalOnly>
        <p className={HINT} data-testid="component-missing">
          Its component no longer exists, so nothing shows here on the page. Undo brings the component back, or delete this
          placement.
        </p>
      </CollapsibleSection>
    );
  }

  const holder = page ? extractBreakpoints(getSnapshot(page.canvasNodes)) : [];
  const definitionFrames = extractBreakpoints(getSnapshot(definition.page.canvasNodes));
  const frame = holder.find((b) => b.id === breakpointId) ?? holder.reduce<BreakpointRef | undefined>((a, b) => (!a || b.minWidth > a.minWidth ? b : a), undefined);
  const inner = frame ? definitionBreakpointFor(frame.minWidth, definitionFrames) : undefined;
  const own = props.inputs ?? {};
  const states = definition.states;
  const hasOwn = Object.keys(own).length > 0 || props.state !== undefined
    || Object.keys(component.bindings).some((slot) => slot === 'state' || slot.startsWith('input.'));
  const count = project?.placementCount(definition.id) ?? 0;

  return (
    <CollapsibleSection title="Component" icon={<Component size={14} />} badge={definition.name} normalOnly>
      <div className="flex min-w-0 flex-col gap-3" data-testid="component-section">
        <p className={HINT}>
          {count === 1 ? 'Placed once.' : `Placed ${count} times.`} Its content is edited in the component, and every
          placement follows.
        </p>
        <div className="flex min-w-0 gap-1.5">
          <button type="button" className={ACTION} onClick={() => editorUI.enterComponent(definition.id, component.id)}>
            <Pencil size={12} aria-hidden /> Edit component
          </button>
          <button
            type="button"
            className={ACTION}
            onClick={() => page && requestDetach(editorUI, page.id, component.id, breakpointId)}
          >
            <Unlink size={12} aria-hidden /> Detach
          </button>
        </div>

        {definition.inputs.length === 0 && (
          <p className={HINT}>
            No inputs yet. In the component, Make input beside a field lets each placement set that value.
          </p>
        )}
        {definition.inputs.map((input) => {
          const stored = own[input.id];
          // A placement's value is keyed on what holds it, a default on the definition's frames.
          const value = stored === undefined
            ? valueOn(input.default, inner?.id, definitionFrames)
            : valueOn(stored, breakpointId, holder);
          return (
            <InputRow
              key={input.id}
              component={component}
              input={input}
              value={value}
              perBreakpoint={isResponsiveMap(stored, new Set(holder.map((b) => b.id)))}
            />
          );
        })}

        {states.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={FIELD_LABEL}>Starts in</span>
            <BindingControl node={component} slot="state" meta={{ label: 'State', allowedModes: ['read'], scopeHint: 'any' }}>
              <PropertySelect
                label=""
                aria-label="Initial state"
                value={props.state ?? 'primary'}
                options={[{ value: 'primary', label: 'Primary' }, ...states.map((state) => ({ value: state.id, label: state.name }))]}
                onChange={(next) => component.setProps({ state: next === 'primary' ? undefined : next })}
              />
            </BindingControl>
          </div>
        )}

        {hasOwn && (
          <button type="button" className={ACTION} onClick={() => component.resetPlacementValues()}>
            <RotateCcw size={12} aria-hidden /> Reset all
          </button>
        )}
      </div>
    </CollapsibleSection>
  );
});

ComponentSection.displayName = 'ComponentSection';
