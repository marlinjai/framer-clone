// src/app/projects/[projectId]/preview/page.tsx
//
// The per-project PREVIEW route (MT-11): `app.lumitra.co/projects/<id>/preview`
// previews a SPECIFIC project rather than relying on the single seeded in-memory
// project. It is scoped + auth-gated EXACTLY like the editor route (MT-10): the
// workspace is derived only from the SERVER-verified session, a cross-workspace
// id 404s, and no session bounces to login (return_to of THIS preview URL).
//
// Pure server component: it reuses MT-10's `loadProjectSnapshot` loader (passing
// the `/preview` return-path suffix so login bounces back here) and delegates
// the browser-only preview render to the PreviewMount client island, which
// hydrates the loaded snapshot into the store and renders the existing
// PreviewShell — the SAME preview UI the in-memory `/preview` uses, just fed the
// loaded project instead of the seeded one.

import { notFound, redirect } from 'next/navigation';
import { loadProjectSnapshot } from '../loader';
import PreviewMount from './PreviewMount';

export const dynamic = 'force-dynamic';

interface ProjectPreviewPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectPreviewPage({
  params,
}: ProjectPreviewPageProps) {
  const { projectId } = await params;
  const result = await loadProjectSnapshot(projectId, '/preview');

  // Fail-closed: no valid session / no resolvable workspace -> bounce to login.
  if (result.status === 'unauthenticated') {
    redirect(result.loginUrl);
  }

  // Missing OR cross-workspace id -> 404. Never preview a foreign tenant's site.
  if (result.status === 'not_found') {
    notFound();
  }

  return <PreviewMount projectSnapshot={result.snapshot} />;
}
