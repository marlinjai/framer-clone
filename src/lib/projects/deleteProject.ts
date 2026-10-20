// src/lib/projects/deleteProject.ts
//
// Client side of DELETE /api/projects/<id>, used by the dashboard's delete
// dialog. Turns every failure into a message a person can act on; never throws.

export type DeleteResult =
  | { ok: true }
  | { ok: false; message: string; currentName?: string; gone?: boolean };

export async function deleteProject(projectId: string, confirmName?: string): Promise<DeleteResult> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(confirmName !== undefined ? { confirmName } : {}),
    });
  } catch {
    return { ok: false, message: 'Could not delete the project: the network request failed. Nothing was deleted; try again.' };
  }
  if (res.ok) return { ok: true };

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
    case 'confirmation_mismatch':
      return {
        ok: false,
        currentName,
        message: currentName !== undefined
          ? `The name does not match. This project is now called "${currentName}"; type that name to confirm.`
          : 'The name does not match the project. Nothing was deleted.',
      };
    case 'site_not_found':
      // Already gone (deleted in another tab, or by someone else).
      return { ok: false, gone: true, message: 'This project no longer exists; it may already have been deleted.' };
    case 'delete_cache_failed':
      // The project IS deleted; only the cached published copy may linger.
      return { ok: false, gone: true, message: serverMessage ?? 'The project was deleted, but a cached copy may still be served for a while.' };
    case 'forbidden':
      return { ok: false, message: 'You do not have permission to delete this project.' };
    case 'unauthorized':
      return { ok: false, message: 'Your session has ended. Sign in again to delete the project.' };
    case 'no_active_company':
      return { ok: false, message: 'No company is selected. Reload the page and choose a company.' };
    case 'auth_unavailable':
    case 'authz_unavailable':
      return { ok: false, message: 'Could not delete the project: the sign-in service is temporarily unavailable. Nothing was deleted; try again in a moment.' };
    default:
      return {
        ok: false,
        message: serverMessage
          ? `Could not delete the project: ${serverMessage}`
          : `Could not delete the project (${res.status}). Nothing was deleted.`,
      };
  }
}
