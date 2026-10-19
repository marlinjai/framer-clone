'use server';

// src/app/projects/workspace-actions.ts
//
// The server action behind the workspace chooser and the "Switch workspace"
// control on /projects. It works as a plain HTML form post (no client script
// needed): the chosen id is validated against the VERIFIED session before the
// `framer_ws` cookie is written (selectActiveWorkspace), then the browser is
// sent on to the dashboard or to the editor path it came from.

import { redirect } from 'next/navigation';
import {
  safeEditorReturnPath,
  selectActiveWorkspace,
} from '@/server/auth/activeWorkspace';

export async function chooseWorkspace(formData: FormData): Promise<void> {
  const result = await selectActiveWorkspace(formData.get('workspaceId'));
  if (!result.ok && result.reason === 'auth_unavailable') {
    // auth-brain could not answer: go on to the requested page, which shows
    // the "sign-in service unavailable, retry" notice for that same address.
    redirect(safeEditorReturnPath(formData.get('next')));
  }
  if (!result.ok) {
    // No valid session: the dashboard sends the user to the login. An id the
    // session does not contain (forged, or membership just removed): back to
    // the chooser with a visible error, nothing written.
    // An expired session keeps the deep link: the dashboard carries `next`
    // through the login and continues there afterwards.
    const next = safeEditorReturnPath(formData.get('next'));
    const nextQuery = next === '/projects' ? '' : `next=${encodeURIComponent(next)}`;
    redirect(
      result.reason === 'unauthenticated'
        ? `/projects${nextQuery ? `?${nextQuery}` : ''}`
        : `/projects?switch=1&error=workspace_unavailable${nextQuery ? `&${nextQuery}` : ''}`,
    );
  }
  redirect(safeEditorReturnPath(formData.get('next')));
}
