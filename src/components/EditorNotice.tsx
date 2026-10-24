'use client';
// src/components/EditorNotice.tsx
//
// One dismissable message above the canvas (editorUI.editorNotice), set when a
// project opens: the project was changed elsewhere while this tab has unsaved
// work (a Save here would overwrite it), or the page asked for in the address
// does not exist. The live region is always present, so the message is
// announced when it appears.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';

const EditorNotice = observer(() => {
  const { editorUI } = useStore();
  const notice = editorUI.editorNotice;
  return (
    <div
      role="status"
      aria-live="polite"
      data-editor-ui="true"
      // Placed by EditorApp's notice stack under the top bar.
      className={notice ? 'pointer-events-auto flex max-w-[640px] items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow' : 'sr-only'}
    >
      {notice ? (
        <>
          <span>{notice.message}</span>
          {notice.kind === 'changedElsewhere' ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100"
            >
              Load the newer version
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => editorUI.setEditorNotice(undefined)}
            aria-label="Dismiss notice"
            className="shrink-0 rounded px-1 hover:bg-amber-100"
          >
            ×
          </button>
        </>
      ) : null}
    </div>
  );
});

EditorNotice.displayName = 'EditorNotice';
export default EditorNotice;
