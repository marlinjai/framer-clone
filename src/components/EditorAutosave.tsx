// src/components/EditorAutosave.tsx
//
// The editor's autosave lifetime (plan docs/plans/2026-11-04-editor-autosave.md),
// part of the editor shell (EditorApp renders it first), not of anything that
// only shows the state: it watches the current project (never the demo at `/`)
// while the editor is open, and when the editor closes or another project
// opens it commits text still being typed and saves what the server does not
// hold (useAutosave). Being first in the shell, its cleanup runs before the
// canvas's and the panels', while their open drafts are still registered.
'use client';

import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useAutosave } from '@/hooks/useAutosave';

const EditorAutosave = observer(() => {
  const { editorUI } = useStore();
  useAutosave(editorUI.currentProject, editorUI.isUnsavedDemo !== true);
  return null;
});

EditorAutosave.displayName = 'EditorAutosave';
export default EditorAutosave;
