'use client';

// src/app/projects/[projectId]/EditorMount.tsx
//
// The client island that mounts the visual editor for a server-loaded project.
// The editor UI is purely client-side (no SSR), exactly like the standalone `/`
// mount in src/app/page.tsx: it owns the MST store, the drag layers, and the
// browser-only devtools wiring. Keeping the `dynamic(..., { ssr: false })`
// import here (a 'use client' boundary) means the server page stays a pure
// server component that only resolves the session + serializes the snapshot —
// no server-only code ever reaches the client bundle.
//
// The snapshot is passed straight through to EditorApp's `projectSnapshot`
// prop, which hydrates THAT project (MT-08) instead of seeding the demo.

import dynamic from 'next/dynamic';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

const EditorApp = dynamic(() => import('@/components/EditorApp'), { ssr: false });

export default function EditorMount({
  projectSnapshot,
}: {
  projectSnapshot: ProjectSnapshotOut;
}) {
  return <EditorApp projectSnapshot={projectSnapshot} />;
}
