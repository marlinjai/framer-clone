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
// session's active workspace -> its tenant -> tenant_group), NEVER from anything
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
// 400 malformed body, 500 otherwise (`create_failed`).
//
// Runs on the Node runtime because the repository reaches Postgres through
// adapter-prisma.

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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function POST(req: Request): Promise<Response> {
  // 1. The verified session. No valid session -> 401. This is also the ONLY
  //    source of the tenant scope below.
  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }

  // 2. Resolve the tenant scope from the session's active workspace. A session
  //    with no resolvable active workspace cannot create anywhere -> 403.
  const scopeResult = resolveActiveScope(session);
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

  // 5. Mint the id SERVER-SIDE and persist a minimal draft snapshot under the
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
