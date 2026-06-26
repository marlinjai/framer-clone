'use client';

// src/app/projects/[projectId]/preview/PreviewMount.tsx
//
// The client island that mounts the preview for a server-loaded project (MT-11).
// It mirrors MT-10's EditorMount, but renders the PreviewShell instead of the
// editor: it hydrates the loaded snapshot into the shared MST store (the SAME
// ingest path EditorApp uses for the editor route) and selects the project's
// home page, so PreviewShell — which reads `editorUI.currentProject` /
// `currentPage` — previews THIS project rather than the seeded in-memory one.
//
// PreviewShell is loaded with `ssr:false` so MST + the browser-only renderer
// never reach the SSR pass; the server page stays a pure server component that
// only resolves the session + serializes the snapshot.

import dynamic from 'next/dynamic';
import React from 'react';
import { useStore } from '@/hooks/useStore';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

const PreviewShell = dynamic(
  () => import('@/components/preview/PreviewShell'),
  { ssr: false },
);

export default function PreviewMount({
  projectSnapshot,
}: {
  projectSnapshot: ProjectSnapshotOut;
}) {
  const rootStore = useStore();
  const initRef = React.useRef(false);

  if (!initRef.current) {
    // Hydrate the server-loaded project and select it + its home page, so the
    // shared store the PreviewShell reads reflects THIS project. The snapshot's
    // own id keys the store (ingest replaces any existing project with that id).
    const projectId = rootStore.projectStore.ingestProjectSnapshot(projectSnapshot);
    const project = rootStore.projectStore.getProject(projectId);
    rootStore.editorUI.setCurrentProject(project);
    rootStore.editorUI.setCurrentPage(
      project?.findPageBySlug('') ?? project?.pagesArray[0],
    );
    initRef.current = true;
  }

  return <PreviewShell />;
}
