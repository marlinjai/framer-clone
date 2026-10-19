import 'server-only';

// src/server/cms/editorScope.ts
//
// The guard every CMS grid server action (src/server/cms/actions.ts) runs first:
// the request must be on the EDITOR host, and only then is the auth-brain
// session asked for the active workspace scope (requireWorkspaceScope).
//
// Why the host check: a server action is dispatched by its id on ANY path of
// ANY host this app serves, so without it a published site's own script on
// `<label>.sites.lumitra.co` could POST a grid action same-origin, and the
// browser would attach the visitor's apex `.lumitra.co` session cookie. That is
// exactly what decision D2 of the multi-tenancy phase 2 plan forbids: the
// published-site plane must never be authorized by the editor session. So off
// the editor host every action is refused before the session is even read.
//
// Lives outside actions.ts because a 'use server' module may only export async
// server actions, and this helper must not become a callable action itself.

import { headers } from 'next/headers';
import { isEditorHost } from '@/lib/editorHost';
import type { FramerAction } from '@/lib/permissions';
import { AuthError, requireWorkspaceScope } from '@/server/auth/requireWorkspaceScope';
import type { TenantScope } from '@/server/sites';

/**
 * Resolve the authorized active-workspace scope for a CMS grid action, or throw
 * AuthError: 403 `forbidden` off the editor host (no session read), otherwise
 * whatever requireWorkspaceScope decides (401 / 403 / 503).
 */
export async function requireCmsEditorScope(action: FramerAction): Promise<TenantScope> {
  const host = (await headers()).get('host');
  if (!isEditorHost(host)) {
    throw new AuthError(403, 'the CMS editor is not available on this host', 'forbidden');
  }
  return requireWorkspaceScope(action);
}
