// src/app/api/projects/publish/route.ts
//
// POST /api/projects/publish  (WRITE, admin-guarded via auth-brain `publishSite`)
//
// The publish write path. It serializes the editor's live ProjectModel (sent as
// a snapshot in the body) into the canonical Site + SitePage rows via the P1
// site repository, then transitions the Site to the `published` status.
//
// HARD ISOLATION (the whole point of P1): the TenantScope this writes under is
// resolved from the SERVER-VERIFIED auth-brain session (the session's active
// company -> its workspace -> tenant_group), NEVER from anything the client
// sends. The client supplies only the project snapshot; which workspace/tenant
// it lands in is the server's decision. Authorization is the real auth-brain
// `publishSite` permission (workspace.admin) — the same real-auth path every
// write now uses since the interim admin-secret stub was removed (MT-14).
//
// Failures surface loudly as the Track-0 `{ error: { code, message } }`
// envelope: 401 unauthenticated, 403 not a workspace admin / no resolvable
// company (`no_active_company`) / no company with Sites (`sites_not_enabled`), 400 malformed body, 404 cross-workspace site id, 500 otherwise. A
// publish failure is never swallowed into a silent success.
//
// Runs on the Node runtime because the repository reaches Postgres through
// adapter-prisma.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import {
  getSiteRepository,
  activeScopeDenial,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
  SiteNotFoundError,
  SiteGoneError,
} from '@/server/sites';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import { jsonError, parseBody } from '@/lib/api/respond';
import {
  revalidateCustomHostsForSiteId,
  revalidateSiteCache,
} from '@/server/sites/cachedResolver';
import { projectBodySchema as publishBodySchema } from '../_schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  //    none resolvable -> 403 `no_active_company`. Nothing is publishd.
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const { scope } = scopeResult;

  // 3. Admin guard: the real auth-brain `publishSite` permission (workspace.admin)
  //    on the resolved workspace. 401 (no session) / 403 (not an admin).
  const auth = await authenticateRequest(req, scope.workspaceId, 'publishSite');
  if (!auth.authenticated) {
    return jsonError(
      auth.status === 401 ? 'unauthorized' : 'forbidden',
      auth.error,
      auth.status,
    );
  }

  // 4. Validate the snapshot body. Malformed -> 400.
  const body = await parseBody(req, publishBodySchema);
  if (!body.ok) return body.response;

  // 5. Persist the snapshot, transition the site to published, then allocate
  //    (or return the already-allocated) subdomain. A cross-workspace site id is
  //    rejected (SiteNotFoundError -> 404) inside the repository; an exhausted
  //    subdomain allocation surfaces the typed SubdomainAllocationError (-> 500
  //    via siteRepositoryErrorResponse); any other failure is a loud 500. A
  //    publish is NEVER swallowed into a silent success-with-no-URL.
  const project = body.data.project as unknown as ProjectSnapshotOut;
  let subdomain: string;
  try {
    const repo = getSiteRepository();
    await repo.saveProject(scope, project, { mustExist: true });
    await repo.publishProject(scope, project.id);
    // ensureSiteDomain is idempotent: a re-publish returns the SAME slug, so the
    // live URL is stable across publish/unpublish/re-publish cycles.
    ({ subdomain } = await repo.ensureSiteDomain(scope, project.id));
    // Invalidate the origin render cache (MT-17) for THIS host so the next
    // storefront request re-reads and serves the freshly-published content. The
    // tag matches the subdomain the resolver keys on (`site:<subdomain>`).
    revalidateSiteCache(subdomain);
    // The site's custom domains (verified or not) are revalidated too, so a
    // connected domain serves the new content on its next request as well.
    // The write already committed: a failure to read the site's hosts here must
    // not turn it into a reported failure. Logged; cached custom-host hits do
    // not expire on their own, so those hosts may serve the previous content
    // until the next publish or a domain lifecycle event revalidates them.
    await revalidateCustomHostsForSiteId(project.id).catch((err: unknown) => {
      console.error('[sites] custom-domain cache revalidation failed for ' + project.id, err);
    });
  } catch (err) {
    // A project deleted while this publish was running (between the save and
    // the status flip or the address allocation) surfaces as a plain not-found
    // from the later steps: answer with the same message a Save gets.
    if (err instanceof SiteNotFoundError) return siteRepositoryErrorResponse(new SiteGoneError());
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'publish_failed',
      err instanceof Error ? err.message : 'failed to publish site',
      500,
    );
  }

  // Compose the live URL from the server-read base host. Unset (local dev)
  // returns liveUrl: null but STILL surfaces the allocated subdomain — the route
  // never hardcodes the base host.
  const baseHost = process.env.PUBLIC_SITE_BASE_HOST;
  const liveUrl = baseHost ? `https://${subdomain}.${baseHost}` : null;

  const publishedPages = Object.values(body.data.project.pages).map(
    (page) => page.slug ?? '',
  );
  return Response.json({
    siteId: project.id,
    status: 'published',
    publishedPages,
    subdomain,
    liveUrl,
  });
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
