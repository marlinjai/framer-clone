// src/components/ai/GeneratedSaveNote.tsx
//
// The generator dialog's line on whether a generated page or section is kept.
// The editor saves it right away (src/lib/projects/autosave.ts), so the line
// follows the save in the same words as the top bar's save status (one
// wording, useSaveStatusLabel): Saved, Saving… (only when it takes longer
// than 300 ms), or Not saved with a pointer to the top bar, which holds the
// reason and Retry. The demo editor at `/` has no autosave: there it points at
// "Keep as project".
'use client';

import React from 'react';
import { useAutosaveState, useSaveStatusLabel } from '@/hooks/useAutosave';

export function GeneratedSaveNote({ projectId, demo }: { projectId: string | undefined; demo: boolean }) {
  const state = useAutosaveState(demo ? undefined : projectId);
  const label = useSaveStatusLabel(state);
  if (demo) return <> Not saved: this demo is kept only in this tab (Keep as project saves it).</>;
  if (label === 'Not saved') return <> Not saved: see the save status in the top bar.</>;
  if (label === 'Changed elsewhere') return <> Not saved: changed elsewhere (see the top bar).</>;
  return <> {label}.</>;
}
