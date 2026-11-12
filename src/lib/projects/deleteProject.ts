// src/lib/projects/deleteProject.ts
//
// Client side of DELETE /api/projects/<id>, used by the dashboard's delete
// dialog. Turns every failure into a message a person can act on; never throws.

export type DeleteResult =
  | {
      ok: true;
      /** The project is gone, but the removal of its form submissions is still running in the background. */
      formSubmissionsPending?: boolean;
      /** The server's own words for the pending removal: no time promise, the next step and the project id. */
      message?: string;
    }
  | {
      ok: false;
      message: string;
      /** Set on a refused confirmation: the project's current name. */
      currentName?: string;
      /** The project is gone (deleted, or not in this company): drop its card. */
      gone?: boolean;
      /** The project is deleted, but its published pages may linger in a cache, or its form submissions are not removed. */
      deletedWithWarning?: boolean;
      /** The project is deleted and its form submissions are still being removed in the background. */
      formSubmissionsPending?: boolean;
      /** The project is deleted, but its form submissions are NOT removed and nothing is scheduled to remove them. */
      submissionsNotRemoved?: boolean;
    };

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
  if (res.ok) {
    let pending = false;
    let message: string | undefined;
    try {
      const body = await res.json();
      pending = body?.formSubmissionsPending === true;
      if (pending && typeof body.message === 'string') message = body.message;
    } catch {
      // A body that is not JSON is a plain success.
    }
    return pending ? { ok: true, formSubmissionsPending: true, ...(message ? { message } : {}) } : { ok: true };
  }

  let code: string | undefined;
  let serverMessage: string | undefined;
  let currentName: string | undefined;
  let submissionsPending = false;
  try {
    const body: { error?: { code?: string; message?: string; currentName?: unknown; formSubmissionsPending?: unknown } } = await res.json();
    submissionsPending = body.error?.formSubmissionsPending === true;
    code = body.error?.code;
    serverMessage = body.error?.message;
    if (typeof body.error?.currentName === 'string') currentName = body.error.currentName;
  } catch {
    // Non-JSON error body: fall back to the status code below.
  }

  switch (code) {
    case 'confirmation_mismatch':
      // The dialog words this by cause (published or renamed in the meantime).
      return { ok: false, currentName, message: 'The name does not match. Nothing was deleted.' };
    case 'site_not_found':
      // Deleted elsewhere, or the selected company was switched in another tab.
      return {
        ok: false,
        gone: true,
        message:
          'This project is not in the selected company any more: it was deleted, or the company was switched in another tab. Nothing was deleted now.',
      };
    case 'delete_cache_failed':
      // The project IS deleted; only the cached published copy may linger.
      return {
        ok: false,
        gone: true,
        deletedWithWarning: true,
        message: serverMessage ?? 'The project was deleted, but a cached copy may still be served for a while.',
        formSubmissionsPending: submissionsPending,
      };
    case 'delete_submissions_failed':
      // The project IS deleted; its form submissions are not removed and nothing is scheduled to remove them.
      return {
        ok: false,
        gone: true,
        deletedWithWarning: true,
        submissionsNotRemoved: true,
        message: serverMessage ?? 'The project was deleted, but its form submissions could not be removed. Contact support to have them removed.',
      };
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
