'use client';
// DataSourceSection: the right-sidebar "Data" section. For the selected node it
// resolves the registry's bindable slots and renders a BindingControl per slot;
// for Collection / TableView data components it additionally renders the
// QueryBuilder. Renders nothing for components with no bindable slots so the
// sidebar stays unchanged for plain layout primitives.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Database } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { getBindableSlotsFor } from '@/lib/componentRegistry';
import { holdsText } from '@/lib/renderer/textContent';
import { cn } from '@/lib/utils';
import { CollapsibleSection, FIELD_CONTROL, FIELD_LABEL } from '../primitives';
import BindingControl from '../BindingControl';
import QueryBuilder from '../QueryBuilder';
import { getRegistryIdForNode } from '../registryId';
import { TextContentField } from './TextContentSection';

export { getRegistryIdForNode };

interface DataSourceSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

/** The static (unbound) control shown next to a slot. */
const StaticSlotControl = observer(
  ({ node, slot, label }: { node: ComponentInstance; slot: string; label: string }) => {
    if (slot === 'children') {
      // Committed on blur or Enter: one edit, one undo step.
      return <TextContentField key={node.id} node={node} label={label} variant="line" />;
    }

    const raw = node.props?.[slot];
    const display = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    return (
      <input
        type="text"
        readOnly
        aria-label={label}
        value={display}
        placeholder={`Unset (${label})`}
        className={cn(FIELD_CONTROL, 'bg-muted text-muted-foreground')}
      />
    );
  },
);
StaticSlotControl.displayName = 'StaticSlotControl';

export const DataSourceSection = observer(({ component }: DataSourceSectionProps) => {
  const registryId = getRegistryIdForNode(component);
  const slots = registryId ? getBindableSlotsFor(registryId) : {};

  const kind = (component.props as Record<string, unknown> | undefined)?.['data-component-kind'];
  const showQueryBuilder = kind === 'collection' || kind === 'table-view';

  // For data components the QueryBuilder owns filter / sort / limit (written to
  // props.query), so we drop those slots from the per-slot binding controls to
  // avoid two competing controls for the same concept.
  const QUERY_SLOTS = new Set(['filter', 'sort', 'limit']);
  // The text of a text element has its own section at the top of the panel
  // (TextContentSection, with the same bind button), so it is not repeated here.
  const textHasOwnSection = holdsText(component);
  const slotEntries = Object.entries(slots).filter(
    ([slot]) => !(showQueryBuilder && QUERY_SLOTS.has(slot)) && !(textHasOwnSection && slot === 'children'),
  );

  if (slotEntries.length === 0 && !showQueryBuilder) return null;

  return (
    <CollapsibleSection title="Data" icon={<Database size={14} />}>
      {slotEntries.map(([slot, meta]) => (
        <div key={slot} className="flex min-w-0 flex-col gap-1.5">
          {/* Stacked label: the field shares its row with the bind button. */}
          <span className={FIELD_LABEL}>{meta.label}</span>
          <BindingControl node={component} slot={slot} meta={meta}>
            <StaticSlotControl node={component} slot={slot} label={meta.label} />
          </BindingControl>
        </div>
      ))}

      {showQueryBuilder && (
        <div className="mt-1 min-w-0 border-t border-border pt-3">
          <div className={cn(FIELD_LABEL, 'mb-2 font-medium')}>Query</div>
          <QueryBuilder node={component} />
        </div>
      )}
    </CollapsibleSection>
  );
});

DataSourceSection.displayName = 'DataSourceSection';

export default DataSourceSection;
