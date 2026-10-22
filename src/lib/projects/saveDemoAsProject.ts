// src/lib/projects/saveDemoAsProject.ts
//
// "Save as a new project" for the browser-only demo project: creates a
// dashboard project in the active company from its pages (POST /api/projects,
// which mints the id and requires the company's Lumitra Sites grant and the
// workspace admin permission, like "New project" on the dashboard). Every
// failure becomes a sentence plus, where there is one, the next step.

import { validateProjectName } from '@/lib/projectName';

export interface NextStep {
  href: string;
  label: string;
  /** True when following it leaves this page (the work is stashed first). */
  leavesPage: boolean;
}

export type SaveAsResult =
  | { ok: true; siteId: string }
  | { ok: false; message: string; next?: NextStep };

export async function saveDemoAsProject(
  rawName: string,
  pages: Record<string, unknown>,
): Promise<SaveAsResult> {
  const valid = validateProjectName(rawName);
  if (!valid.ok) return { ok: false, message: valid.message };

  let res: Response;
  try {
    res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: valid.name, project: { pages } }),
    });
  } catch {
    return { ok: false, message: 'Could not save: the network request failed. Nothing was created; try again.' };
  }

  if (res.ok) {
    try {
      const data: { siteId?: unknown } = await res.json();
      if (typeof data.siteId === 'string' && data.siteId) return { ok: true, siteId: data.siteId };
    } catch {
      // Fall through.
    }
    return { ok: false, message: 'The server did not return the new project. Check your projects before trying again.' };
  }

  let code: string | undefined;
  let serverMessage: string | undefined;
  let issue: string | undefined;
  try {
    const body: { error?: { code?: string; message?: string; issues?: Array<{ message?: unknown }> } } =
      await res.json();
    code = body.error?.code;
    serverMessage = body.error?.message;
    const first = body.error?.issues?.[0]?.message;
    if (typeof first === 'string') issue = first;
  } catch {
    // Non-JSON error body.
  }

  switch (code) {
    case 'sites_not_enabled':
      return {
        ok: false,
        message:
          'None of your companies has Lumitra Sites, so there is no company to save this project in. An administrator of your company can enable Lumitra Sites in the Lumitra account portal.',
      };
    case 'no_active_company':
      return {
        ok: false,
        message: 'Choose the company to save this project in, then save again. Your work comes along.',
        next: { href: '/projects?switch=1&next=/', label: 'Choose a company', leavesPage: true },
      };
    case 'unauthorized':
      return {
        ok: false,
        message: 'Your session has ended. Sign in again, then save again. Your work comes along.',
        next: { href: '/projects?next=/', label: 'Sign in', leavesPage: true },
      };
    case 'forbidden':
      return { ok: false, message: 'You need to be an administrator of this company to create a project in it.' };
    case 'invalid_page_slug':
      return { ok: false, message: `A page address needs fixing first: ${serverMessage ?? 'invalid page slug'}` };
    case 'auth_unavailable':
    case 'authz_unavailable':
      return { ok: false, message: 'The sign-in service is temporarily unavailable. Nothing was created; try again in a moment.' };
    case 'bad_body':
      return { ok: false, message: issue ?? serverMessage ?? 'The project could not be read. Nothing was created.' };
    default:
      return {
        ok: false,
        message: serverMessage
          ? `Could not save the project: ${serverMessage}`
          : `Could not save the project (${res.status}). Nothing was created.`,
      };
  }
}
