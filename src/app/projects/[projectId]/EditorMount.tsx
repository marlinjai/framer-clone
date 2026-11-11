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
// prop, which hydrates THAT project (MT-08) instead of seeding the demo. The
// site's address goes into SiteAddressProvider for the page settings panel.

import dynamic from 'next/dynamic';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import { SiteAddressProvider, type SiteAddress } from '@/contexts/SiteAddressContext';
import { SiteBranchProvider } from '@/contexts/SiteBranchContext';
import type { EditorBranchState } from '@/lib/sites/branches';

const EditorApp = dynamic(() => import('@/components/EditorApp'), { ssr: false });

export default function EditorMount({
  projectSnapshot,
  projectVersion,
  site,
  branch = null,
}: {
  projectSnapshot: ProjectSnapshotOut;
  /** The site version read with the snapshot (the version lock). */
  projectVersion: number;
  /** Where the published site lives (page settings URL preview). */
  site?: SiteAddress;
  /** Main or a branch, when site branches are on for the company. */
  branch?: EditorBranchState | null;
}) {
  return (
    <SiteAddressProvider initial={site}>
      <SiteBranchProvider initial={branch}>
        <EditorApp projectSnapshot={projectSnapshot} projectVersion={projectVersion} />
      </SiteBranchProvider>
    </SiteAddressProvider>
  );
}
