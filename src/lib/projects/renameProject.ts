// src/lib/projects/renameProject.ts
//
// Client side of the project rename (PATCH /api/projects/<id>), shared by the
// dashboard card and the editor's top bar. Turns every failure into a message a
// person can act on; never throws.

import { validateProjectName } from '@/lib/projectName';

export type RenameResult =
  | { ok: true; name: string }
  | { ok: false; message: string; currentName?: string };

export async function renameProject(
  projectId: string,
  rawName: string,
  expectedName?: string,
): Promise<RenameResult> {
  const valid = validateProjectName(rawName);
  if (!valid.ok) return { ok: false, message: valid.message };

  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: valid.name,
        ...(expectedName !== undefined ? { expectedName } : {}),
      }),
    });
  } catch {
    return { ok: false, message: 'Could not rename the project: the network request failed. Try again.' };
  }

  if (res.ok) {
    try {
      const data: { name?: unknown } = await res.json();
      return { ok: true, name: typeof data.name === 'string' ? data.name : valid.name };
    } catch {
      return { ok: true, name: valid.name };
    }
  }

  let code: string | undefined;
  let serverMessage: string | undefined;
  let currentName: string | undefined;
  try {
    const body: { error?: { code?: string; message?: string; currentName?: unknown } } = await res.json();
    code = body.error?.code;
    serverMessage = body.error?.message;
    if (typeof body.error?.currentName === 'string') currentName = body.error.currentName;
  } catch {
    // Non-JSON error body: fall back to the status code below.
  }

  switch (code) {
    case 'name_conflict':
      return {
        ok: false,
        currentName,
        message: currentName !== undefined
          ? `Someone renamed this project to "${currentName}" in the meantime. Try again if you still want to change it.`
          : 'Someone renamed this project in the meantime. Reload and try again.',
      };
    case 'site_not_found':
      return { ok: false, message: 'This project no longer exists in the selected company.' };
    case 'forbidden':
      return { ok: false, message: 'You do not have permission to rename this project.' };
    case 'unauthorized':
      return { ok: false, message: 'Your session has ended. Sign in again to rename the project.' };
    case 'no_active_company':
      return { ok: false, message: 'No company is selected. Reload the page and choose a company.' };
    case 'auth_unavailable':
    case 'authz_unavailable':
      return { ok: false, message: 'Could not rename the project: the sign-in service is temporarily unavailable. Try again in a moment.' };
    default:
      return {
        ok: false,
        message: serverMessage
          ? `Could not rename the project: ${serverMessage}`
          : `Could not rename the project (${res.status}).`,
      };
  }
}
