// src/app/projects/[projectId]/page.tsx
//
// The per-project editor route (MT-10): `app.lumitra.co/projects/<projectId>`
// loads the REAL project SERVER-SIDE — scoped to the caller's workspace via the
// verified auth-brain session — and hands its snapshot to the client editor
// shell (MT-08's hydration). A cross-workspace id 404s; it NEVER renders another
// tenant's project.
//
// This is a pure server component: it resolves the session + serializes the
// project (loader.ts) and delegates the browser-only editor mount to the
// EditorMount client island. All redirect/404 control flow lives here so the
// loader stays a side-effect-free, unit-testable function.

import { notFound, redirect } from 'next/navigation';
import AuthUnavailable from '../AuthUnavailable';
import { loadProjectSnapshot } from './loader';
import EditorMount from './EditorMount';

export const dynamic = 'force-dynamic';

interface ProjectEditorPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectEditorPage({
  params,
}: ProjectEditorPageProps) {
  const { projectId } = await params;
  const result = await loadProjectSnapshot(projectId);

  // Fail-closed: no valid session -> bounce to login.
  if (result.status === 'unauthenticated') {
    redirect(result.loginUrl);
  }

  // auth-brain could not answer: a retry notice on this same address, never
  // the login.
  if (result.status === 'auth_unavailable') {
    return <AuthUnavailable retryHref={`/projects/${encodeURIComponent(projectId)}`} />;
  }

  // Valid session, no workspace picked yet -> the dashboard's chooser, which
  // renders (never redirects) and then continues back here.
  if (result.status === 'choose_workspace') {
    redirect(result.chooserUrl);
  }

  // Missing OR cross-workspace id -> 404. Never render a foreign tenant's site.
  if (result.status === 'not_found') {
    notFound();
  }

  return <EditorMount projectSnapshot={result.snapshot} />;
}
