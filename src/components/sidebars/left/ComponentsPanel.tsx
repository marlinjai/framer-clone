// src/components/sidebars/left/ComponentsPanel.tsx
// Component library. Each item is a drag source: pointerdown hands off to
// the DragManager with a `create` source; the manager paints the ghost,
// resolves the drop target under the cursor, and on release calls
// page.insertRegistryComponent.
//
// In the phone layout's sheet (`onTapInsert`), where the canvas is covered and
// there is nowhere to drag to, a tap (or Enter / Space) adds the component
// instead, next to or inside the selection (src/lib/layers/tapInsertTarget.ts).
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

const ComponentItem = ({ entry, onTapInsert }: { entry: ComponentRegistryEntry; onTapInsert?: (registryId: string) => void }) => {
  const IconComponent = entry.icon;
  const { onPointerDown } = useDragSource({ kind: 'create', registryId: entry.id });

  if (onTapInsert) {
    return (
      <button
        type="button"
        onClick={() => onTapInsert(entry.id)}
        className="flex w-full items-center space-x-3 p-2 rounded text-left hover:bg-accent transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label={`Add ${entry.label}`}
      >
        <div className={`p-1.5 rounded ${entry.iconClassName}`}>
          <IconComponent size={14} />
        </div>
        <span className="text-sm text-foreground">{entry.label}</span>
      </button>
    );
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className="flex items-center space-x-3 p-2 rounded hover:bg-accent cursor-grab active:cursor-grabbing transition-colors select-none"
      title={`Drag to add ${entry.label}`}
    >
      <div className={`p-1.5 rounded ${entry.iconClassName}`}>
        <IconComponent size={14} />
      </div>
      <span className="text-sm text-foreground">{entry.label}</span>
    </div>
  );
};

export interface ComponentsPanelProps {
  /** Add on tap instead of drag (the phone sheet). */
  onTapInsert?: (registryId: string) => void;
}

const ComponentsPanel = observer(({ onTapInsert }: ComponentsPanelProps = {}) => {
  const basicComponents = listComponentsByCategory('basic');
  const layoutComponents = listComponentsByCategory('layout');
  const dataComponents = listComponentsByCategory('data');
  const commerceComponents = listComponentsByCategory('commerce');
  const formComponents = listComponentsByCategory('form');

  return (
    <div className="space-y-4">
      {onTapInsert && (
        <p className="text-xs text-muted-foreground">Tap a component to add it inside or after the selected element.</p>
      )}
      <div>
        <div className="flex items-center space-x-2 mb-3">
          <h3 className="text-sm font-medium text-foreground">Basic</h3>
          <Plus size={14} className="text-muted-foreground" />
        </div>
        <div className="space-y-1">
          {basicComponents.map((entry) => (
            <ComponentItem key={entry.id} entry={entry} onTapInsert={onTapInsert} />
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center space-x-2 mb-3">
          <h3 className="text-sm font-medium text-foreground">Layout</h3>
          <Plus size={14} className="text-muted-foreground" />
        </div>
        <div className="space-y-1">
          {layoutComponents.map((entry) => (
            <ComponentItem key={entry.id} entry={entry} onTapInsert={onTapInsert} />
          ))}
        </div>
      </div>

      {dataComponents.length > 0 && (
        <div>
          <div className="flex items-center space-x-2 mb-3">
            <h3 className="text-sm font-medium text-foreground">Data</h3>
            <Plus size={14} className="text-muted-foreground" />
          </div>
          <div className="space-y-1">
            {dataComponents.map((entry) => (
              <ComponentItem key={entry.id} entry={entry} onTapInsert={onTapInsert} />
            ))}
          </div>
        </div>
      )}

      {formComponents.length > 0 && (
        <div>
          <div className="flex items-center space-x-2 mb-3">
            <h3 className="text-sm font-medium text-foreground">Forms</h3>
            <Plus size={14} className="text-muted-foreground" />
          </div>
          <div className="space-y-1">
            {formComponents.map((entry) => (
              <ComponentItem key={entry.id} entry={entry} onTapInsert={onTapInsert} />
            ))}
          </div>
        </div>
      )}

      {commerceComponents.length > 0 && (
        <div>
          <div className="flex items-center space-x-2 mb-3">
            <h3 className="text-sm font-medium text-foreground">Commerce</h3>
            <Plus size={14} className="text-muted-foreground" />
          </div>
          <div className="space-y-1">
            {commerceComponents.map((entry) => (
              <ComponentItem key={entry.id} entry={entry} onTapInsert={onTapInsert} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

ComponentsPanel.displayName = 'ComponentsPanel';

export default ComponentsPanel;

// Re-export for callers that want registry metadata.
export { COMPONENT_REGISTRY };
