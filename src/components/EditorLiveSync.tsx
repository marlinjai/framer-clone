// src/components/EditorLiveSync.tsx
//
// The editor follows the open site live (plan docs/plans/2026-11-08-live-agent-canvas.md):
// while a project this tab loaded from the server is open, its LiveSync
// (src/lib/projects/liveSync.ts) listens to the site's stream and adopts other
// writers' versions. Never for the demo at `/`, which has no server copy. Part
// of the editor shell, beside EditorAutosave.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { knownServerVersion } from '@/stores/openProject';
import { startLiveSync } from '@/lib/projects/liveSync';

const EditorLiveSync = observer(() => {
  const rootStore = useStore();
  const { editorUI } = rootStore;
  const project = editorUI.currentProject;
  const projectId =
    project && editorUI.isUnsavedDemo !== true && knownServerVersion(project.id) !== undefined ? project.id : undefined;

  React.useEffect(() => {
    if (!projectId) return;
    return startLiveSync(projectId, rootStore);
  }, [projectId, rootStore]);

  return null;
});

EditorLiveSync.displayName = 'EditorLiveSync';
export default EditorLiveSync;
