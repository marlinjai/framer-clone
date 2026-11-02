'use client';
// src/components/sidebars/right/sections/InputsSection.tsx
//
// The inputs of the component open on the canvas, in the panel of its root: what
// each placement may set. Make input beside a field adds one; here each is renamed,
// moved, given another type or other options, and removed.
//
// - Each change is one ProjectModel action, one undo step.
// - A rename keeps the input's id, so no stored value or binding changes.
// - A new type or new options that would take placement values, connections or
//   the default with them says so first (the editInput dialog); a change that takes
//   nothing runs at once.
// - Remove takes every value and binding to the input across the site with it, in
//   one step that undo brings back, as the contract decides.
// - Moving is by buttons, so it works by keyboard and on a phone.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "Making an input".

import React from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowDown, ArrowUp, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { ComponentDefinitionInstance } from '@/models/ComponentDefinitionModel';
import {
  fieldsFromText,
  fieldsToText,
  INPUT_TYPE_LABELS,
  INPUT_TYPES,
  LIST_FIELD_NOTATION_TYPES,
  parseInputValue,
  optionsFromText,
  optionsToText,
  retypedInput,
  type InputDefinition,
  type InputType,
} from '@/lib/components/inputs';
import { requestInputEdit } from '@/lib/components/editorCommands';
import { CollapsibleSection, FIELD_LABEL, PropertySelect } from '../primitives';
import { CommitField } from './ComponentSection';

const HINT = 'text-[11px] leading-snug text-muted-foreground';
const ICON_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-40 phone:h-9 phone:w-9';

const TYPE_OPTIONS = INPUT_TYPES.map((type) => ({ value: type, label: INPUT_TYPE_LABELS[type] }));

const InputItem = observer(({
  definition,
  input,
  index,
  count,
}: {
  definition: ComponentDefinitionInstance;
  input: InputDefinition;
  index: number;
  count: number;
}) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  if (!project) return null;
  const refuse = (message: string) => editorUI.setEditorNotice({ kind: 'refused', message });
  const connections = project.inputConnectionCount(definition.id, input.id);
  const move = (to: number) => {
    const result = project.moveInput(definition.id, input.id, to);
    if (!result.ok) refuse(result.message);
  };
  const remove = () => {
    const result = project.removeInput(definition.id, input.id);
    if (!result.ok) refuse(result.message);
  };

  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded border border-border p-2" data-testid={`definition-input-${input.id}`}>
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          <CommitField
            label={`Name of ${input.name}`}
            shown={input.name}
            parse={(text) => ({ ok: true, value: text })}
            onCommit={(name) => {
              const result = project.renameInput(definition.id, input.id, String(name));
              return result.ok ? undefined : result.message;
            }}
          />
        </div>
        <button type="button" className={ICON_BUTTON} aria-label={`Move ${input.name} up`} disabled={index === 0} onClick={() => move(index - 1)}>
          <ArrowUp size={13} aria-hidden />
        </button>
        <button type="button" className={ICON_BUTTON} aria-label={`Move ${input.name} down`} disabled={index === count - 1} onClick={() => move(index + 1)}>
          <ArrowDown size={13} aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={`Remove ${input.name}`}
          title="Removes it with every value and connection to it. Undo brings it back."
          onClick={remove}
        >
          <Trash2 size={13} aria-hidden />
        </button>
      </div>
      <PropertySelect
        label=""
        aria-label={`Type of ${input.name}`}
        value={input.type}
        options={TYPE_OPTIONS}
        onChange={(type) => {
          const { next, defaultDropped } = retypedInput(input, type as InputType);
          if (next !== input) requestInputEdit(editorUI, definition.id, next, defaultDropped);
        }}
      />
      {input.type === 'choice' && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>Options</span>
          <CommitField
            // A change the dialog asks about and that is then cancelled must not stay
            // typed in, or the next blur would ask again: the field starts over.
            key={editorUI.componentRequest ? 'asking' : 'idle'}
            label={`Options of ${input.name}`}
            shown={optionsToText(input.options)}
            hint="Separated by commas. Label = value where the value differs."
            parse={(text) => {
              const options = optionsFromText(text);
              return options.ok ? options : { ok: false, reason: `Not stored: ${options.reason}.` };
            }}
            onCommit={(value) => {
              const options = value as { label: string; value: string }[];
              // A default no longer among the options goes, and the dialog says so.
              const keepsDefault = input.default === undefined || options.some((option) => option.value === input.default);
              const next: InputDefinition = { ...input, options };
              if (!keepsDefault) delete next.default;
              requestInputEdit(editorUI, definition.id, next, !keepsDefault);
            }}
          />
        </div>
      )}
      {input.type === 'list' && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>Fields of each item</span>
          <CommitField
            key={editorUI.componentRequest ? 'asking' : 'idle'}
            label={`Fields of ${input.name}`}
            shown={fieldsToText(input.fields)}
            hint={`Separated by commas. Name: type where it is not text (${LIST_FIELD_NOTATION_TYPES.join(', ')}).`}
            parse={(text) => {
              const fields = fieldsFromText(text, input.fields);
              return fields.ok ? fields : { ok: false, reason: `Not stored: ${fields.reason}.` };
            }}
            onCommit={(value) => {
              const next: InputDefinition = { ...input, fields: value as InputDefinition[] };
              // A default the new fields refuse goes, and the dialog says so.
              const keepsDefault = input.default === undefined || parseInputValue(next, input.default).ok;
              if (!keepsDefault) delete next.default;
              requestInputEdit(editorUI, definition.id, next, !keepsDefault);
            }}
          />
        </div>
      )}
      <p className={HINT}>
        {connections === 0
          ? 'Not connected: no field in the component reads it yet.'
          : connections === 1
            ? 'Sets 1 field in the component.'
            : `Sets ${connections} fields in the component.`}
      </p>
    </li>
  );
});
InputItem.displayName = 'InputItem';

export const InputsSection = observer(({ definition }: { definition: ComponentDefinitionInstance }) => (
  <CollapsibleSection title="Inputs" icon={<SlidersHorizontal size={14} />} badge={String(definition.inputs.length)} normalOnly>
    <div className="flex min-w-0 flex-col gap-2" data-testid="definition-inputs">
      {definition.inputs.length === 0 ? (
        <p className={HINT}>
          None yet. Make input beside a field of an element in the component lets each placement set that value.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2" aria-label={`Inputs of ${definition.name}`}>
          {definition.inputs.map((input, index) => (
            <InputItem key={input.id} definition={definition} input={input} index={index} count={definition.inputs.length} />
          ))}
        </ul>
      )}
    </div>
  </CollapsibleSection>
));
InputsSection.displayName = 'InputsSection';
