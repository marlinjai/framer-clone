// src/app/projects/migrate-company/route.ts
//
// GET /projects/migrate-company?next=<editor path>
//
// The ONE-TIME migration of the retired per-workspace selector `framer_ws` (PR
// #99, a workspace id) to the per-company selector `framer_company` (a tenant
// id). The dashboard redirects here once when a valid session still carries
// `framer_ws`; a server component cannot write cookies, this route handler can.
//
//   - Valid session: when there is no usable `framer_company` yet and the old
//     workspace belongs to a company that holds the `sites` grant, that company
//     becomes the `framer_company`. In EVERY valid-session case `framer_ws` is
//     deleted in this same response.
//   - No session, or auth-brain not answering: nothing is written or deleted
//     (the dashboard then sends to the login or shows the retry notice, and the
//     choice survives for the migration after that).
//
// LOOP-FREE BY CONSTRUCTION: this handler always answers with a redirect to
// `/projects?migrated=1` (plus the validated `next`), and the dashboard never
// redirects here while `migrated=1` is set. So even a browser that refuses to
// drop the old cookie gets exactly one hop. The relative `Location` keeps the
// editor's public host (the request URL behind the proxy is the internal one).

import { NextResponse } from 'next/server';
import {
  AuthUnavailableError,
  verifySessionOrThrowUnavailable,
} from '@/lib/authBrainAvailability';
import {
  ACTIVE_COMPANY_COOKIE,
  LEGACY_WORKSPACE_COOKIE,
  activeCompanyCookieOptions,
  expiredCookieOptions,
  readCompanySelectors,
  readRequestCookie,
} from '@/lib/activeCompanyCookie';
import { safeEditorReturnPath } from '@/server/auth/activeCompany';
import { resolveActiveCompany } from '@/server/sites/scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'lumitra_session';

/** The dashboard address this handler always returns to. */
function migratedReturnPath(next: string): string {
  return next === '/projects'
    ? '/projects?migrated=1'
    : `/projects?migrated=1&next=${encodeURIComponent(next)}`;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = safeEditorReturnPath(url.searchParams.get('next'));
  const res = new NextResponse(null, {
    status: 303,
    headers: { Location: migratedReturnPath(next), 'Cache-Control': 'no-store' },
  });

  const sessionCookie = readRequestCookie(req, SESSION_COOKIE);
  if (!sessionCookie) return res;

  let session = null;
  try {
    session = await verifySessionOrThrowUnavailable(sessionCookie);
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      console.error('[auth] auth-brain unavailable during company migration', err.cause);
      return res;
    }
    throw err;
  }
  if (!session) return res;

  const selectors = readCompanySelectors(req);
  const resolved = resolveActiveCompany(session, selectors);
  if (resolved.ok && resolved.source === 'legacy_cookie') {
    res.cookies.set(ACTIVE_COMPANY_COOKIE, resolved.companyId, activeCompanyCookieOptions());
  }
  if (selectors.legacyWorkspaceCookie) {
    res.cookies.set(LEGACY_WORKSPACE_COOKIE, '', expiredCookieOptions());
  }
  return res;
}
