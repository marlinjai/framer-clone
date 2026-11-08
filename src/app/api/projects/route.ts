// src/app/api/projects/route.ts
//
// POST /api/projects  (CREATE, admin-guarded via auth-brain `editSite`)
//
// Mints a brand-new EMPTY DRAFT site row in the caller's active workspace and
// returns its id, so the dashboard's "New project" button (MT-09) has something
// to call. Today `createProject` is a client-only MST action that builds a heavy
// demo tree; this is the server create path and it produces a genuinely minimal
// project: one empty home page (`slug: ''`), nothing else.
//
// HARD ISOLATION (same contract as the publish route): the TenantScope this
// writes under is resolved from the SERVER-VERIFIED auth-brain session (the
// request's active company, one of the session's `sites`-granted companies
// chosen by the `framer_company` selector -> that company's workspace -> its
// tenant_group), NEVER from anything
// the client sends. The client supplies only an OPTIONAL display name; which
// workspace/tenant the row lands in is the server's decision, and the site id is
// minted SERVER-SIDE (`crypto.randomUUID`) so the client can't choose or collide
// an id. Authorization is the real auth-brain `editSite` permission
// (workspace.admin per FRAMER_PERMISSIONS).
//
// The created row's `status` is left to the DB default (`draft`): saveProject's
// create block omits status, so this route never passes one and never calls
// publishProject.
//
// Failures surface as the Track-0 `{ error: { code, message } }` envelope:
// 401 unauthenticated, 403 not a workspace admin / no resolvable workspace,
// 503 `auth_unavailable` / `authz_unavailable` when auth-brain or OpenFGA
// cannot answer (never reported as a 403),
// 400 malformed body, 403 `commerce_suspended` (company's commerce suspended),
// 500 `commerce_not_configured` / `commerce_misconfigured` / `commerce_provision_failed`
// when the company's shop schema cannot be set up (nothing is written then), 500
// `create_failed` otherwise.
//
// Runs on the Node runtime because the repository reaches Postgres through
// adapter-prisma.

import { NEW_PROJECT_SITE_SETTINGS } from '@/lib/site/siteSettings';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getSnapshot } from 'mobx-state-tree';
import { z } from 'zod';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import {
  getSiteRepository,
  activeScopeDenial,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
} from '@/server/sites';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { jsonError, readBodyText, PROJECT_BODY_MAX_BYTES } from '@/lib/api/respond';
import { projectNameSchema } from '@/lib/projectName';
import { pageSnapshotSchema } from './_schema';
import { parseModelComponents } from '@/models/ComponentDefinitionModel';
import { withDefaultViewports } from '@/lib/canvas/defaultViewports';
import { ensureCompanyCommerce } from '@/server/sites/companyCommerce';
import { buildEmptyDraftSnapshot } from '@/lib/projects/newProject';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * CM-11, the commerce-tenant onboard hook (src/server/sites/companyCommerce.ts,
 * where its rules are written down), answered as the route's error envelope:
 * null when the company's shop schema stands, else the Response to return.
 */
async function ensureCommerceProvisioned(
  tenantGroupId: string,
  displaySlug: string | undefined,
): Promise<Response | null> {
  const outcome = await ensureCompanyCommerce(tenantGroupId, displaySlug);
  if (outcome.ok) return null;
  const res = jsonError(outcome.code, outcome.message, outcome.status);
  if (outcome.retryAfterSec !== undefined) res.headers.set('retry-after', String(outcome.retryAfterSec));
  return res;
}

// What the client may influence: a display name and, optionally, the PAGES and
// the reusable COMPONENTS they place (the editor's "Save as a new project" for
// the browser-only demo project). Everything else (id, workspace scope, status, analytics binding)
// is server-derived. The body is OPTIONAL: a bare POST with no body creates
// "Untitled Project" with one empty home page.
// The name follows the same rule as a rename (src/lib/projectName.ts).
const createBodySchema = z.object({
  name: projectNameSchema.optional(),
  project: z
    .object({
      pages: z.record(z.string(), pageSnapshotSchema),
      components: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * A new project from pages made in the browser (the demo editor). Only the
 * pages and their components are taken: the id is minted here, the metadata is fresh, and any
 * `lumitra` analytics binding in the input is dropped (a client never chooses
 * a key reference). Round-tripped through ProjectModel so a malformed page is
 * refused (thrown) rather than stored; pages without frames get the defaults.
 */
function buildSnapshotFromPages(
  siteId: string,
  name: string,
  pages: Record<string, unknown>,
  components: Record<string, unknown>,
  now: number,
): ProjectSnapshotOut {
  const repaired: Record<string, unknown> = {};
  for (const [pageId, page] of Object.entries(pages)) {
    repaired[pageId] = withDefaultViewports({ ...(page as object), id: pageId } as { canvasNodes?: unknown });
  }
  const project = ProjectModel.create({
    id: siteId,
    metadata: { title: name, description: '', createdAt: now, updatedAt: now },
    // A new project starts in German (src/lib/site/siteSettings.ts); projects
    // saved before Site settings existed keep `en`.
    siteSettings: NEW_PROJECT_SITE_SETTINGS,
    pages: repaired as never,
    components: components as never,
  });
  return getSnapshot(project) as ProjectSnapshotOut;
}

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
  //    none resolvable -> 403 `no_active_company`. Nothing is created.
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const { scope, companyId } = scopeResult;

  // 3. Admin guard: the real auth-brain `editSite` permission (workspace.admin)
  //    on the resolved workspace. 401 (no session) / 403 (not an admin).
  const auth = await authenticateRequest(req, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return jsonError(
      auth.status === 401 ? 'unauthorized' : 'forbidden',
      auth.error,
      auth.status,
    );
  }

  // 4. Validate the OPTIONAL body. An empty/absent body is fine (-> Untitled);
  //    a present-but-malformed body is a 400. We read the raw text so a bare
  //    POST with no body doesn't trip JSON.parse on an empty string.
  let name = 'Untitled Project';
  let pages: Record<string, unknown> | undefined;
  let components: Record<string, unknown> = {};
  const body = await readBodyText(req, PROJECT_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  const raw = body.text;
  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError('bad_json', 'invalid JSON body', 400);
    }
    const result = createBodySchema.safeParse(parsed);
    if (!result.success) {
      return jsonError('bad_body', 'invalid request body', 400, {
        issues: result.error.issues,
      });
    }
    if (result.data.name !== undefined) name = result.data.name;
    if (result.data.project) {
      pages = result.data.project.pages;
      // Exactly one home page (empty slug): a project's root address must
      // show something. (The slug rules alone accept a project with none.)
      const homes = Object.values(pages).filter((p) => (p as { slug?: unknown }).slug === '').length;
      if (homes !== 1) {
        return jsonError(
          'bad_body',
          homes === 0 ? 'a project needs a home page (a page with an empty slug)' : 'a project has exactly one home page',
          400,
        );
      }
      // Reading a stored definition skips a bad one; here that would quietly turn
      // its placements into Missing components in a project that claims to be
      // saved, so the person is told, as for a page that cannot be read.
      components = result.data.project.components ?? {};
      const refused = parseModelComponents(components).refused[0];
      if (refused) {
        return jsonError('bad_body', `component ${refused.id} could not be read (${refused.reason}); nothing was created`, 400);
      }
    }
  }

  // The pages, if any, are checked BEFORE anything is provisioned or written.
  const siteId = crypto.randomUUID();
  const now = Date.now();
  let snapshot: ProjectSnapshotOut;
  try {
    snapshot = pages ? buildSnapshotFromPages(siteId, name, pages, components, now) : buildEmptyDraftSnapshot(siteId, name, now);
  } catch (err) {
    console.error('[projects] refused pages for a new project:', err);
    return jsonError('bad_body', 'the pages of this project could not be read; nothing was created', 400);
  }

  // 5. CM-11 onboard hook: ensure this tenant-group's `tg_<id>` commerce schema
  //    exists BEFORE the site row is written (idempotent, OWNER connection). A
  //    failure returns its 500 here and nothing is persisted. The tenant group
  //    and the slug are the CHOSEN company's, from the SERVER-verified session,
  //    never the client (with two companies in one group, the first tenant of
  //    the group would name the wrong one).
  const tenantSlug = session.tenants.find((t) => t.id === companyId)?.slug;
  const commerceFailure = await ensureCommerceProvisioned(scope.tenantGroupId, tenantSlug);
  if (commerceFailure) return commerceFailure;

  // 6. Persist the snapshot built above (id minted SERVER-SIDE) under the
  //    session scope. No publishProject call: the row stays `draft` (DB
  //    default). The page slug rules apply (saveProject): a broken slug is a
  //    400 and nothing is written.

  try {
    const repo = getSiteRepository();
    await repo.saveProject(scope, snapshot, { companyId });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    return jsonError(
      'create_failed',
      err instanceof Error ? err.message : 'failed to create site',
      500,
    );
  }

  return Response.json({ siteId });
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
