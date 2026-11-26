'use client';

// src/components/customCode/CustomCodeInsertItem.tsx
//
// The Components panel's "Custom code" item (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// slice C4, D101). Not a registry entry and not a drag source: a button that adds an empty
// block (no saved code, a fallback in the site language) inside or after the selection, one
// undo step, then selects it so the properties panel opens its Custom code section. It shows
// only where a block can be written: CUSTOM_CODE_AVAILABLE on, the site switched on, the
// person a workspace admin, and not a branch.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Code2 } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { tapInsertTarget } from '@/lib/layers/tapInsertTarget';
import { canInsertCustomCode, useCustomCodeAuthoring } from './CustomCodeAuthoring';

export const CustomCodeInsertItem = observer(({ onInserted }: { onInserted?: () => void }) => {
  const { editorUI } = useStore();
  const authoring = useCustomCodeAuthoring();
  const [problem, setProblem] = React.useState<string | null>(null);
  if (!canInsertCustomCode(authoring) || editorUI.isUnsavedDemo) return null;

  const insert = () => {
    setProblem(null);
    const page = editorUI.currentPage;
    if (!page) return setProblem('Open a page first.');
    const created = page.insertCustomCodeBlock(tapInsertTarget(editorUI.selectedComponent));
    if (!created) return setProblem('A custom code block cannot go here. Select a section or a box, then add it again.');
    const narrowest = page.viewportNodes
      .slice()
      .sort((a, b) => (a.viewportWidth ?? Infinity) - (b.viewportWidth ?? Infinity))[0];
    editorUI.selectComponent(created, editorUI.selectedViewportNode?.breakpointId ?? narrowest?.breakpointId);
    onInserted?.();
  };

  return (
    <div>
      <div className="mb-3 flex items-center space-x-2">
        <h3 className="text-sm font-medium text-foreground">Code</h3>
      </div>
      <button
        type="button"
        onClick={insert}
        data-testid="insert-custom-code"
        aria-describedby="insert-custom-code-hint"
        className="flex w-full select-none items-center space-x-3 rounded p-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <div className="rounded bg-muted p-1.5 text-muted-foreground">
          <Code2 size={14} />
        </div>
        <span className="text-sm text-foreground">Custom code</span>
      </button>
      <p id="insert-custom-code-hint" className="mt-1 text-xs text-muted-foreground">
        Adds a block for your own HTML and JavaScript inside or after the selected element.
      </p>
      {problem && <p className="mt-1 text-xs text-destructive" role="alert">{problem}</p>}
    </div>
  );
});
CustomCodeInsertItem.displayName = 'CustomCodeInsertItem';
