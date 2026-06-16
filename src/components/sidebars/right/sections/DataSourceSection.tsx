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
import { getBindableSlotsFor, getComponentEntry } from '@/lib/componentRegistry';
import { CollapsibleSection } from '../primitives';
import BindingControl from '../BindingControl';
import QueryBuilder from '../QueryBuilder';

interface DataSourceSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

/**
 * Resolve the registry id for a node so we can look up its bindable slots.
 * Nodes are created as `${registryId}-${uuid}`, so the id prefix is the most
 * reliable signal; we fall back to the data-component marker and then the
 * intrinsic html type for hand-built nodes.
 */
export function getRegistryIdForNode(node: ComponentInstance): string | undefined {
  const idPrefix = node.id.split('-')[0];
  if (getComponentEntry(idPrefix)) return idPrefix;

  const kind = (node.props as Record<string, unknown> | undefined)?.['data-component-kind'];
  if (kind === 'collection') return 'collection';
  if (kind === 'record-view') return 'recordView';
  if (kind === 'table-view') return 'tableView';

  switch (node.type) {
    case 'p':
      return 'text';
    case 'button':
      return 'button';
    case 'img':
      return 'image';
    default:
      return undefined;
  }
}

/** The static (unbound) control shown next to a slot. */
const StaticSlotControl = observer(
  ({ node, slot, label }: { node: ComponentInstance; slot: string; label: string }) => {
    if (slot === 'children') {
      const value = typeof node.props?.children === 'string' ? node.props.children : '';
      return (
        <input
          type="text"
          aria-label={label}
          value={value}
          placeholder={label}
          onChange={(e) => node.setTextContent(e.target.value)}
          className="h-7 w-full rounded border border-gray-200 px-2 text-xs outline-none focus:border-blue-400"
        />
      );
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
        className="h-7 w-full rounded border border-gray-200 bg-gray-50 px-2 text-xs text-gray-500 outline-none"
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
  const slotEntries = Object.entries(slots).filter(
    ([slot]) => !(showQueryBuilder && QUERY_SLOTS.has(slot)),
  );

  if (slotEntries.length === 0 && !showQueryBuilder) return null;

  return (
    <CollapsibleSection title="Data" icon={<Database size={12} />}>
      {slotEntries.map(([slot, meta]) => (
        <div key={slot} className="space-y-1">
          <label className="text-[11px] text-gray-500">{meta.label}</label>
          <BindingControl node={component} slot={slot} meta={meta}>
            <StaticSlotControl node={component} slot={slot} label={meta.label} />
          </BindingControl>
        </div>
      ))}

      {showQueryBuilder && (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <div className="mb-1 text-[11px] font-medium text-gray-500">Query</div>
          <QueryBuilder node={component} />
        </div>
      )}
    </CollapsibleSection>
  );
});

DataSourceSection.displayName = 'DataSourceSection';

export default DataSourceSection;
