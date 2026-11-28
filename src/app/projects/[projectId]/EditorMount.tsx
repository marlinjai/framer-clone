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
import { CustomCodeAuthoringProvider } from '@/components/customCode/CustomCodeAuthoring';

const EditorApp = dynamic(() => import('@/components/EditorApp'), { ssr: false });

export default function EditorMount({
  projectSnapshot,
  projectVersion,
  site,
  branch = null,
  customCodeAvailable = false,
}: {
  projectSnapshot: ProjectSnapshotOut;
  /** The site version read with the snapshot (the version lock). */
  projectVersion: number;
  /** Where the published site lives (page settings URL preview). */
  site?: SiteAddress;
  /** Main or a branch, when site branches are on for the company. */
  branch?: EditorBranchState | null;
  /** CUSTOM_CODE_AVAILABLE on this server: may custom code blocks be written (slice C4). */
  customCodeAvailable?: boolean;
}) {
  return (
    <SiteAddressProvider initial={site}>
      <SiteBranchProvider initial={branch}>
        <CustomCodeAuthoringProvider available={customCodeAvailable} projectId={projectSnapshot.id ?? null}>
          <EditorApp projectSnapshot={projectSnapshot} projectVersion={projectVersion} />
        </CustomCodeAuthoringProvider>
      </SiteBranchProvider>
    </SiteAddressProvider>
  );
}
// ci-replay touch
