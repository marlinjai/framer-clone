'use server';

// src/app/projects/company-actions.ts
//
// The server action behind the company chooser and the "Switch company"
// control on /projects. It works as a plain HTML form post (no client script
// needed): the chosen company id is validated against the VERIFIED session and
// its `sites` grant before the `framer_company` cookie is written
// (selectActiveCompany), then the browser is sent on to the dashboard or to the
// editor path it came from.

import { redirect } from 'next/navigation';
import { safeEditorReturnPath, selectActiveCompany } from '@/server/auth/activeCompany';

export async function chooseCompany(formData: FormData): Promise<void> {
  const result = await selectActiveCompany(formData.get('companyId'));
  if (!result.ok && result.reason === 'auth_unavailable') {
    // auth-brain could not answer: go on to the requested page, which shows
    // the "sign-in service unavailable, retry" notice for that same address.
    redirect(safeEditorReturnPath(formData.get('next')));
  }
  if (!result.ok) {
    // No valid session: the dashboard sends the user to the login. A company
    // the session does not offer (forged, membership removed, or the `sites`
    // grant revoked): back to the chooser with a visible error, nothing
    // written. An expired session keeps the deep link: the dashboard carries
    // `next` through the login and continues there afterwards.
    const next = safeEditorReturnPath(formData.get('next'));
    const nextQuery = next === '/projects' ? '' : `next=${encodeURIComponent(next)}`;
    redirect(
      result.reason === 'unauthenticated'
        ? `/projects${nextQuery ? `?${nextQuery}` : ''}`
        : `/projects?switch=1&error=company_unavailable${nextQuery ? `&${nextQuery}` : ''}`,
    );
  }
  redirect(safeEditorReturnPath(formData.get('next')));
}
