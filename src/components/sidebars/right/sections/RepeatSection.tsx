'use client';
// src/components/sidebars/right/sections/RepeatSection.tsx
//
// "Repeat for", on an element inside a component open on the canvas: the element
// is drawn once per item of one of the component's List or Gallery inputs, and its
// fields read the item through the bind button (`{{item.label}}`). New list adds a
// List input with one text field and two items and repeats for it, in one step.
//
// Not on the component's root (the list it would read opens inside it) or on text
// (it repeats with the element around it). Each change is one ProjectModel action.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "List and gallery".

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { ListPlus, Repeat } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ComponentDefinitionInstance } from '@/models/ComponentDefinitionModel';
import { isRepeatable, repeatInputId } from '@/lib/components/repeat';
import type { InputDefinition } from '@/lib/components/inputs';
import { CollapsibleSection, PropertySelect } from '../primitives';

const HINT = 'text-[11px] leading-snug text-muted-foreground';
const ACTION =
  'flex h-7 items-center justify-center gap-1.5 rounded border border-border px-2 text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand phone:h-9';
const NONE = '__none__';

/** A List input for a new repeat: one text field, and two items so the copies show at once. */
function newListFor(definition: ComponentDefinitionInstance, node: ComponentInstance): InputDefinition {
  const ids = new Set(definition.inputs.map((input) => input.id));
  const names = new Set(definition.inputs.map((input) => input.name.toLowerCase()));
  let n = 1;
  while (ids.has(n === 1 ? 'items' : `items${n}`) || names.has(n === 1 ? 'items' : `items ${n}`)) n++;
  const text = (getSnapshot(node) as { props?: { children?: unknown } }).props?.children;
  const first = typeof text === 'string' && text.trim() !== '' ? text : 'Item 1';
  return {
    id: n === 1 ? 'items' : `items${n}`,
    name: n === 1 ? 'Items' : `Items ${n}`,
    type: 'list',
    fields: [{ id: 'text', name: 'Text', type: 'text' }],
    default: [{ text: first }, { text: 'Item 2' }],
  };
}

export const RepeatSection = observer(({ definition, node }: { definition: ComponentDefinitionInstance; node: ComponentInstance }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  if (!project) return null;
  const lists = definition.inputs.filter(isRepeatable);
  const current = repeatInputId(node.props);
  const missing = current !== undefined && !lists.some((input) => input.id === current);
  const run = (inputId: string | null, newList?: InputDefinition) => {
    const result = project.setRepeat(definition.id, node.id, inputId, newList);
    if (!result.ok) editorUI.setEditorNotice({ kind: 'refused', message: result.message });
  };

  return (
    <CollapsibleSection title="Repeat" icon={<Repeat size={14} />} normalOnly>
      <div className="flex min-w-0 flex-col gap-2" data-testid="repeat-section">
        <PropertySelect
          label="Repeat for"
          value={current && !missing ? current : NONE}
          options={[{ value: NONE, label: 'Nothing, shown once' }, ...lists.map((input) => ({ value: input.id, label: input.name }))]}
          onChange={(value) => run(value === NONE ? null : value)}
        />
        {missing && <p className={HINT}>It repeated for an input that is gone, so it shows nothing. Pick a list or stop repeating.</p>}
        <p className={HINT}>
          {current && !missing
            ? 'Shown once per item. Bind its fields to the item with the bind button; each placement sets the items.'
            : lists.length === 0
              ? 'Shown once per item of a list each placement sets. This component has no list yet.'
              : 'Shown once per item of a list each placement sets.'}
        </p>
        <button
          type="button"
          className={ACTION}
          onClick={() => {
            const list = newListFor(definition, node);
            run(list.id, list);
          }}
        >
          <ListPlus size={12} aria-hidden /> New list for this element
        </button>
      </div>
    </CollapsibleSection>
  );
});
RepeatSection.displayName = 'RepeatSection';
