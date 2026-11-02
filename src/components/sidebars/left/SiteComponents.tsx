// src/components/sidebars/left/SiteComponents.tsx
//
// The Components panel's "This site" list: the site's own reusable components,
// each with how many placements it has. An entry is a drag source of kind `place`
// (src/lib/drag/types.ts), or a tap in the phone layout, and its menu renames,
// opens, duplicates or deletes the definition. An entry that cannot go where it
// would land (a component inside itself, or nested too deep) is greyed with the
// reason, and choosing it says why.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "The Components panel".
'use client';
import React, { useCallback, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { Component, Copy, MoreHorizontal, Pencil, TextCursorInput, Trash2 } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { useDragSource } from '@/lib/drag';
import { placementRefusal, type ComponentDefinitions } from '@/lib/components/definition';
import type { ComponentDefinitionInstance } from '@/models/ComponentDefinitionModel';
import { ContextMenu, type MenuCloseReason, type MenuItem } from './ContextMenu';

const ENTRY =
  'flex min-w-0 flex-1 items-center gap-3 rounded p-2 text-left select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

const SiteComponentEntry = observer(({
  definition,
  refusal,
  onTapPlace,
}: {
  definition: ComponentDefinitionInstance;
  refusal: string | null;
  onTapPlace?: (definitionId: string) => void;
}) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const count = project?.placementCount(definition.id) ?? 0;
  const { onPointerDown } = useDragSource(refusal ? null : { kind: 'place', definitionId: definition.id });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback((reason: MenuCloseReason) => {
    setMenu(null);
    if (reason !== 'outside') moreRef.current?.focus();
  }, []);

  const sayWhy = () => {
    if (refusal) editorUI.setEditorNotice({ kind: 'refused', message: refusal });
  };
  const items: MenuItem[] = [
    { label: 'Rename', icon: <TextCursorInput size={14} />, onClick: () => editorUI.setComponentRequest({ kind: 'rename', definitionId: definition.id }) },
    {
      label: 'Edit component',
      icon: <Pencil size={14} />,
      disabled: editorUI.currentPage === definition.page,
      onClick: () => editorUI.enterComponent(definition.id),
    },
    {
      label: 'Duplicate',
      icon: <Copy size={14} />,
      onClick: () => {
        const result = project?.duplicateDefinition(definition.id);
        if (result && !result.ok) editorUI.setEditorNotice({ kind: 'refused', message: result.message });
      },
    },
    { label: 'Delete component', icon: <Trash2 size={14} />, destructive: true, onClick: () => editorUI.setComponentRequest({ kind: 'delete', definitionId: definition.id }) },
  ];

  const label = (
    <>
      <span className="rounded bg-brand/10 p-1.5 text-brand">
        <Component size={14} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{definition.name}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-label={`${count} placements`}>
        {count}
      </span>
    </>
  );

  return (
    <div className="flex items-center gap-1" data-testid="site-component">
      {onTapPlace ? (
        <button
          type="button"
          aria-label={`Add ${definition.name}`}
          aria-disabled={refusal ? true : undefined}
          title={refusal ?? undefined}
          onClick={() => (refusal ? sayWhy() : onTapPlace(definition.id))}
          className={`${ENTRY} ${refusal ? 'opacity-50' : 'hover:bg-accent'}`}
        >
          {label}
        </button>
      ) : (
        <div
          onPointerDown={refusal ? undefined : onPointerDown}
          onClick={refusal ? sayWhy : undefined}
          aria-disabled={refusal ? true : undefined}
          title={refusal ?? `Drag to add ${definition.name}`}
          className={`${ENTRY} ${refusal ? 'cursor-not-allowed opacity-50' : 'cursor-grab hover:bg-accent active:cursor-grabbing'}`}
        >
          {label}
        </div>
      )}
      <button
        ref={moreRef}
        type="button"
        aria-label={`More actions for ${definition.name}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand phone:h-9 phone:w-9"
      >
        <MoreHorizontal size={14} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </div>
  );
});
SiteComponentEntry.displayName = 'SiteComponentEntry';

export const SiteComponents = observer(({ onTapPlace }: { onTapPlace?: (definitionId: string) => void }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  if (!project) return null;
  const definitions = Array.from(project.components.values()).sort((a, b) => a.name.localeCompare(b.name));
  // The definition open on the canvas, if one is: what is placed now lands inside it.
  const holder = definitions.find((definition) => definition.page === editorUI.currentPage)?.id;
  const stored = holder ? (getSnapshot(project.components) as unknown as ComponentDefinitions) : undefined;

  return (
    <section aria-labelledby="site-components-heading" data-testid="site-components">
      <h3 id="site-components-heading" className="mb-3 text-sm font-medium text-foreground">This site</h3>
      {definitions.length === 0 ? (
        <p className="text-xs leading-snug text-muted-foreground">
          To reuse something on several pages, select it and choose Create component in its menu in Layers.
        </p>
      ) : (
        <div className="space-y-1">
          {definitions.map((definition) => (
            <SiteComponentEntry
              key={definition.id}
              definition={definition}
              refusal={stored ? placementRefusal(stored, holder, definition.id) : null}
              onTapPlace={onTapPlace}
            />
          ))}
        </div>
      )}
    </section>
  );
});
SiteComponents.displayName = 'SiteComponents';
