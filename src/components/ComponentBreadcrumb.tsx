'use client';
// src/components/ComponentBreadcrumb.tsx
//
// The way out of a definition open on the canvas: "Home > Card", with how many
// placements an edit here reaches. It sits in the notice stack under the top bar and
// shows only while a definition is open. Esc and the Pages panel leave too.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronRight } from 'lucide-react';
import { useStore } from '@/hooks/useStore';

const ComponentBreadcrumb = observer(() => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const page = editorUI.currentPage;
  if (!editorUI.inComponent || !project || !page) return null;

  const definition = Array.from(project.components.values()).find(candidate => candidate.page === page);
  const count = definition ? project.placementCount(definition.id) : 0;

  return (
    <nav
      aria-label="Component you are editing"
      data-editor-ui="true"
      data-testid="component-breadcrumb"
      className="pointer-events-auto flex max-w-[640px] items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs shadow"
    >
      {editorUI.componentTrail.map((back, index) => (
        <React.Fragment key={back.pageId}>
          <button
            type="button"
            onClick={() => editorUI.leaveComponent(index)}
            className="max-w-[200px] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {project.pageName(back.pageId) ?? 'Page'}
          </button>
          <ChevronRight size={12} aria-hidden="true" className="flex-none text-muted-foreground" />
        </React.Fragment>
      ))}
      <span aria-current="page" className="max-w-[200px] truncate px-1 font-medium">
        {definition?.name ?? page.metadata.title}
      </span>
      <span className="flex-none text-muted-foreground">
        {count === 1 ? '1 placement' : `${count} placements`}
      </span>
    </nav>
  );
});

ComponentBreadcrumb.displayName = 'ComponentBreadcrumb';
export default ComponentBreadcrumb;
