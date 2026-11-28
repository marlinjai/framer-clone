// src/lib/projects/unpublishProject.ts
//
// Client side of POST /api/projects/unpublish, used by the Published versions
// dialog and the dashboard card. Turns every failure into a message a person can
// act on; never throws.
//
// The server turns the site into a draft BEFORE it clears its caches, so a 500 or
// a lost answer does not mean "nothing happened": the site may be offline in the
// database while a cached copy is still served. Unpublishing is idempotent, so
// those messages ask for a second try.

export type UnpublishResult = { ok: true } | { ok: false; message: string };

export async function unpublishProject(projectId: string): Promise<UnpublishResult> {
  let res: Response;
  try {
    res = await fetch('/api/projects/unpublish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: projectId }),
    });
  } catch {
    return {
      ok: false,
      message: 'The network request failed, so it is not known whether the site went offline. Try again.',
    };
  }
  if (res.ok) return { ok: true };

  let code: string | undefined;
  let serverMessage: string | undefined;
  try {
    const body: { error?: { code?: string; message?: string } } = await res.json();
    code = body.error?.code;
    serverMessage = body.error?.message;
  } catch {
    // Non-JSON error body: fall back to the status code below.
  }

  switch (code) {
    case 'forbidden':
      return { ok: false, message: 'You do not have permission to unpublish this site.' };
    case 'unauthorized':
      return { ok: false, message: 'Your session has ended. Sign in again to unpublish the site.' };
    case 'site_not_found':
      return {
        ok: false,
        message:
          'This project is not in the selected company any more: it was deleted, or the company was switched in another tab.',
      };
    case 'no_active_company':
      return { ok: false, message: 'No company is selected. Reload the page and choose a company.' };
    case 'auth_unavailable':
    case 'authz_unavailable':
      return { ok: false, message: 'The sign-in service is temporarily unavailable. Try again in a moment.' };
  }
  const reason = serverMessage ?? `HTTP ${res.status}`;
  if (res.status >= 500) {
    return {
      ok: false,
      message: `Unpublishing did not finish (${reason}). Visitors may still see the site. Try again.`,
    };
  }
  return { ok: false, message: `Could not unpublish the site: ${reason}` };
}
// ci-replay touch
