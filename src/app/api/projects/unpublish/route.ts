// src/app/api/projects/unpublish/route.ts
//
// POST /api/projects/unpublish  (WRITE, admin-guarded via auth-brain `publishSite`)
//
// The inverse of /api/projects/publish: it transitions a site back to the
// `draft` status so it stops being served live. Unlike publish, it carries NO
// editor snapshot — the body is just the target `{ siteId }`; the working copy
// is untouched. The site's `SiteDomain` row is deliberately PRESERVED (MT-06
// decision D3), so a later re-publish reuses the same slug and the live URL is
// stable across a publish/unpublish/re-publish cycle.
//
// HARD ISOLATION (the whole point of P1): the TenantScope this writes under is
// resolved from the SERVER-VERIFIED auth-brain session (the session's active
// company -> its workspace -> tenant_group), NEVER from anything the client
// sends. The client supplies only the site id; which workspace it acts in is the
// server's decision. Authorization is the real auth-brain `publishSite`
// permission (workspace.admin), the same gate as publish.
//
// Failures surface loudly as the Track-0 `{ error: { code, message } }`
// envelope: 401 unauthenticated, 403 not a workspace admin / no resolvable
// company (`no_active_company`) / no company with Sites (`sites_not_enabled`), 400 malformed body, 404 cross-workspace site id, 500 otherwise.
//
// Runs on the Node runtime because the repository reaches Postgres through
// adapter-prisma.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { z } from 'zod';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import {
  getSiteRepository,
  activeScopeDenial,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
} from '@/server/sites';
import { jsonError, parseBody } from '@/lib/api/respond';
import {
  resolveSubdomainForSiteId,
  revalidateCustomHostsForSiteId,
  revalidateSiteCache,
} from '@/server/sites/cachedResolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The request body: just the site to unpublish. No snapshot — unpublish never
// touches the working copy.
const unpublishBodySchema = z.object({ siteId: z.string().min(1) });

async function handlePOST(req: Request): Promise<Response> {
  // 1. The verified session. No valid session -> 401. This is also the ONLY
  //    source of the tenant scope below.
  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }

  // 2. Resolve the tenant scope from the request's active company (the
  //    `framer_company` selector, else the session's active_tenant, else its
  //    only company; only companies with the `sites` grant count), mapped to
  //    that company's workspace. No granted company -> 403 `sites_not_enabled`;
  //    none resolvable -> 403 `no_active_company`. Nothing is unpublishd.
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const { scope } = scopeResult;

  // 3. Admin guard: the real auth-brain `publishSite` permission (workspace.admin)
  //    on the resolved workspace — the same gate as publish. 401 / 403.
  const auth = await authenticateRequest(req, scope.workspaceId, 'publishSite');
  if (!auth.authenticated) {
    return jsonError(
      auth.status === 401 ? 'unauthorized' : 'forbidden',
      auth.error,
      auth.status,
    );
  }

  // 4. Validate the body. Malformed -> 400.
  const body = await parseBody(req, unpublishBodySchema);
  if (!body.ok) return body.response;

  // 5. Flip the site back to draft. A cross-workspace site id is rejected
  //    (SiteNotFoundError -> 404) inside the repository; any other failure is a
  //    loud 500. The SiteDomain row survives (MT-06 guarantees it).
  const { siteId } = body.data;
  try {
    const repo = getSiteRepository();
    await repo.unpublishProject(scope, siteId);
    // Invalidate the origin render cache (MT-17) so the now-draft site stops
    // being served from cache on the next request. The SiteDomain row survives
    // an unpublish (MT-06 D3), so its subdomain is still readable here — that is
    // the same `site:<subdomain>` tag the resolver cached under. A site with no
    // allocated subdomain has nothing cached, so there is nothing to revalidate.
    const subdomain = await resolveSubdomainForSiteId(siteId);
    if (subdomain) revalidateSiteCache(subdomain);
    // Its custom domains too: an unpublished site must stop serving on every
    // host at once, never linger on a connected domain from cache.
    // Cached custom-host hits never expire on their own, so a failure here
    // would leave the unpublished site live on its custom domains. Unpublish is
    // idempotent: surface the failure so the caller retries.
    await revalidateCustomHostsForSiteId(siteId);
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'unpublish_failed',
      err instanceof Error ? err.message : 'failed to unpublish site',
      500,
    );
  }

  return Response.json({
    siteId,
    status: 'draft',
  });
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
