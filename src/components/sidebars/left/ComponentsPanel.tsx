// src/components/sidebars/left/ComponentsPanel.tsx
// Component library. Each item is a drag source: pointerdown hands off to
// the DragManager with a `create` source; the manager paints the ghost,
// resolves the drop target under the cursor, and on release calls
// page.insertRegistryComponent.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Plus } from 'lucide-react';
import {
  COMPONENT_REGISTRY,
  ComponentRegistryEntry,
  listComponentsByCategory,
} from '@/lib/componentRegistry';
import { useDragSource } from '@/lib/drag';

const ComponentItem = ({ entry }: { entry: ComponentRegistryEntry }) => {
  const IconComponent = entry.icon;
  const { onPointerDown } = useDragSource({ kind: 'create', registryId: entry.id });

  return (
    <div
      onPointerDown={onPointerDown}
      className="flex items-center space-x-3 p-2 rounded hover:bg-gray-50 cursor-grab active:cursor-grabbing transition-colors select-none"
      title={`Drag to add ${entry.label}`}
    >
      <div className={`p-1.5 rounded ${entry.iconClassName}`}>
        <IconComponent size={14} />
      </div>
      <span className="text-sm text-gray-700">{entry.label}</span>
    </div>
  );
};

const ComponentsPanel = observer(() => {
  const basicComponents = listComponentsByCategory('basic');
  const layoutComponents = listComponentsByCategory('layout');

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center space-x-2 mb-3">
          <h3 className="text-sm font-medium text-gray-900">Basic</h3>
          <Plus size={14} className="text-gray-400" />
        </div>
        <div className="space-y-1">
          {basicComponents.map((entry) => (
            <ComponentItem key={entry.id} entry={entry} />
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center space-x-2 mb-3">
          <h3 className="text-sm font-medium text-gray-900">Layout</h3>
          <Plus size={14} className="text-gray-400" />
        </div>
        <div className="space-y-1">
          {layoutComponents.map((entry) => (
            <ComponentItem key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </div>
  );
});

ComponentsPanel.displayName = 'ComponentsPanel';

export default ComponentsPanel;

// Re-export for callers that want registry metadata.
export { COMPONENT_REGISTRY };
