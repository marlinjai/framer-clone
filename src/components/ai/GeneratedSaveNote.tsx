// src/components/ai/GeneratedSaveNote.tsx
//
// The generator dialog's line on whether a generated page or section is kept.
// The editor saves it right away (src/lib/projects/autosave.ts), so the line
// follows the save: Saving..., Saved, or Not saved (the reason is in the top
// bar). The demo editor at `/` has no autosave: there it still asks for Save.
'use client';

import React from 'react';
import { useAutosaveState } from '@/hooks/useAutosave';

export function GeneratedSaveNote({ projectId, demo }: { projectId: string | undefined; demo: boolean }) {
  const state = useAutosaveState(demo ? undefined : projectId);
  if (demo) return <> Save the project to keep it.</>;
  switch (state.phase) {
    case 'saving':
    case 'unsaved':
      return <> Saving...</>;
    case 'retrying':
    case 'failed':
    case 'conflict':
      return <> Not saved yet: see the message next to Save.</>;
    default:
      return <> Saved.</>;
  }
}
