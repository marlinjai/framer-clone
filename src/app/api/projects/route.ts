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
// request's active workspace, chosen among the session's own workspaces by the
// membership-checked `framer_ws` selector -> its tenant -> tenant_group), NEVER from anything
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

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readActiveWorkspaceCookie } from '@/lib/activeWorkspaceCookie';
import { getSnapshot } from 'mobx-state-tree';
import { z } from 'zod';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import {
  getSiteRepository,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
} from '@/server/sites';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { createIntrinsicComponent } from '@/models/ComponentModel';
import { jsonError } from '@/lib/api/respond';
import {
  commerceSlugFor,
  CommerceTenantSuspendedError,
  ensureCommerceTenant,
} from '@/server/commerce/provisioning/provision';
import { AppRoleSearchPathError } from '@marlinjai/tenant-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * CM-11, the commerce-tenant ONBOARD HOOK.
 *
 * framer-clone does NOT mint tenant-groups: the workspace -> tenant -> tenant_group
 * hierarchy is owned by auth-brain and arrives on the verified session (scope.ts).
 * So provisioning is hooked at the first framer-clone path that (a) has a
 * server-verified `tenantGroupId` AND (b) owns commerce DDL: the project/site
 * create path. The first time a tenant-group creates a project here, its
 * `tg_<id>` commerce schema is stood up (migrations + `commerce_app` grants +
 * a read-only check of the `ext`-locked backstop) on the OWNER connection, out-of-band from the
 * request's app-role pool. Every later project of an already provisioned company
 * costs one registry read and nothing else (`ensureCommerceTenant`: no lock, no
 * DDL, no role check); only a miss runs the full provision, under the global
 * provisioning lock with bounded waits (10 s lock, 30 s statement).
 *
 * The registry slug is `commerceSlugFor(tenant group, display slug)`: the
 * display slug plus the tenant-group id, so two companies whose auth-brain slugs
 * collide never block each other on the UNIQUE `tenant_groups.slug`.
 *
 * It runs BEFORE the site row is written, and a failure fails the request with
 * a named code, with the cause in the server log:
 *  - 500 `commerce_not_configured` when COMMERCE_OWNER_DATABASE_URL is unset. A
 *    production container cannot even start without it (deploy/boot.sh), so
 *    this only catches a miswired environment, loudly, instead of creating
 *    projects whose shop would fail later.
 *  - 403 `commerce_suspended` when an operator suspended the company's commerce
 *    (`tenant_groups.status = 'suspended'`). Provisioning would set it active
 *    again, so it is never attempted; 403 rather than 500 because nothing is
 *    broken and a retry cannot succeed: the refusal is a decision about this
 *    company, lifted only by an operator.
 *  - 500 `commerce_misconfigured` when the app role commerce_app's default
 *    search_path is not exactly `ext` (tenant-db AppRoleSearchPathError).
 *    Provisioning only verifies that value, never sets it (the owner role may
 *    not alter roles), so a retry cannot succeed until an administrator runs
 *    the repair command the error names, which goes to the server log only; the
 *    container start step refuses to start on the same condition, so this
 *    catches a value changed after the start.
 *  - 500 `commerce_provision_failed` when provisioning throws anything else (database down, a
 *    tenant group id that is not a UUID, a migration error, a provisioning lock
 *    not granted within 10 s).
 * Provisioning first means a failure leaves NOTHING behind: no site row whose
 * company has no commerce schema, no "created but broken" project, and a retry
 * of the same request is clean. The connection details stay out of the
 * response; the log carries them.
 *
 * FLAG (deferral): there is no job/outbox seam in framer-clone to defer the DDL
 * to, so the first provision runs inline in this request. If a background-job
 * seam lands later, move this off the request path.
 */
async function ensureCommerceProvisioned(
  tenantGroupId: string,
  displaySlug: string | undefined,
): Promise<Response | null> {
  if (!process.env.COMMERCE_OWNER_DATABASE_URL) {
    console.error(
      `[commerce] cannot provision tenant_group ${tenantGroupId}: COMMERCE_OWNER_DATABASE_URL is not set`,
    );
    return jsonError(
      'commerce_not_configured',
      'the shop database is not configured on this server; no project was created',
      500,
    );
  }
  try {
    await ensureCommerceTenant({ tenantGroupId, slug: commerceSlugFor(tenantGroupId, displaySlug) });
    return null;
  } catch (err) {
    if (err instanceof CommerceTenantSuspendedError) {
      console.error(`[commerce] project create refused: commerce for tenant_group ${tenantGroupId} is suspended`);
      return jsonError(
        'commerce_suspended',
        "this company's shop is suspended; no project was created. Contact support to lift the suspension.",
        403,
      );
    }
    if (err instanceof AppRoleSearchPathError) {
      console.error(
        `[commerce] cannot provision tenant_group ${tenantGroupId}: the app role is misconfigured (${err.problem}). ${err.message}`,
      );
      return jsonError(
        'commerce_misconfigured',
        'the shop database on this server needs an administrator to fix it; no project was created',
        500,
      );
    }
    console.error(
      `[commerce] ensureCommerceTenant failed for tenant_group ${tenantGroupId}:`,
      err,
    );
    return jsonError(
      'commerce_provision_failed',
      'setting up the shop for this company failed; no project was created, try again',
      500,
    );
  }
}

// The only thing the client may influence: a display name. Everything else
// (id, workspace scope, status, page structure) is server-derived. The body is
// OPTIONAL — a bare POST with no body creates "Untitled Project".
const createBodySchema = z.object({ name: z.string().optional() });

/**
 * Build a MINIMAL valid draft ProjectModel snapshot: one home page (`slug: ''`)
 * whose app tree is a single empty `div` root, no canvas/viewport nodes. We
 * round-trip through `ProjectModel.create(...)` + `getSnapshot(...)` so the
 * result is GUARANTEED to be a structurally valid SnapshotOut (the same shape
 * saveProject/projectToPersisted read) rather than a hand-built shape that could
 * silently drift from the model.
 */
function buildEmptyDraftSnapshot(
  siteId: string,
  name: string,
  now: number,
): ProjectSnapshotOut {
  const pageId = crypto.randomUUID();
  const rootId = `root-${crypto.randomUUID()}`;

  const project = ProjectModel.create({
    id: siteId,
    metadata: { title: name, description: '', createdAt: now, updatedAt: now },
    pages: {
      [pageId]: {
        id: pageId,
        slug: '',
        metadata: { title: name, description: '' },
        appComponentTree: getSnapshot(
          createIntrinsicComponent(rootId, 'div', {}),
        ),
        canvasNodes: {},
      },
    },
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

  // 2. Resolve the tenant scope from the request's active workspace (the
  //    membership-checked `framer_ws` selector, else the session's own active
  //    workspace, else its only workspace). A request with no resolvable
  //    workspace cannot create anywhere -> 403 `no_active_workspace`.
  const scopeResult = resolveActiveScope(session, readActiveWorkspaceCookie(req));
  if (!scopeResult.ok) {
    return jsonError(
      'no_active_workspace',
      'no active workspace to create a project in',
      403,
    );
  }
  const { scope } = scopeResult;

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
  const raw = await req.text();
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
  }

  // 5. CM-11 onboard hook: ensure this tenant-group's `tg_<id>` commerce schema
  //    exists BEFORE the site row is written (idempotent, OWNER connection). A
  //    failure returns its 500 here and nothing is persisted. The tenant slug
  //    comes from the SERVER-verified session, never the client; fall back to
  //    the tenant_group id alone if the tenant isn't on the session.
  const tenantSlug = session.tenants.find((t) => t.group_id === scope.tenantGroupId)?.slug;
  const commerceFailure = await ensureCommerceProvisioned(scope.tenantGroupId, tenantSlug);
  if (commerceFailure) return commerceFailure;

  // 6. Mint the id SERVER-SIDE and persist a minimal draft snapshot under the
  //    session scope. No publishProject call: the row stays `draft` (DB default).
  const siteId = crypto.randomUUID();
  const now = Date.now();
  const snapshot = buildEmptyDraftSnapshot(siteId, name, now);

  try {
    const repo = getSiteRepository();
    await repo.saveProject(scope, snapshot);
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
