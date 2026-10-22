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
import { openProject } from '@/stores/openProject';

const PreviewShell = dynamic(
  () => import('@/components/preview/PreviewShell'),
  { ssr: false },
);

export default function PreviewMount({
  projectSnapshot,
  pageId = null,
}: {
  projectSnapshot: ProjectSnapshotOut;
  /** `?page=<pageId>` from the address: the page to show. */
  pageId?: string | null;
}) {
  const rootStore = useStore();
  const opened = React.useRef<{ missingPageId?: string } | null>(null);

  if (!opened.current) {
    // The server-loaded project, unless this browser already holds it (came
    // from the editor): then its working copy, unsaved work included, is what
    // gets previewed. The page from `?page=`, else home. See openProject.
    const { missingPageId } = openProject(rootStore, projectSnapshot, pageId);
    opened.current = { missingPageId };
  }

  return <PreviewShell missingPageId={opened.current.missingPageId} />;
}
