// src/app/api/projects/[projectId]/document/route.ts
//
// GET /api/projects/<projectId>/document: the project as it is stored now, for
// an open editor that heard a `site:version` on its live stream (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 1). It is the only way
// content reaches the editor after its first load: the stream says that a
// version exists, this route hands over the copy, for every writer alike (the
// editor never replays an agent's operations).
//
// Answers `{ version, snapshot }`, the same snapshot the editor page loads
// (loadProjectWithVersion), with `ETag` set to the version and 304 when the
// request's If-None-Match names it. Guarded like the events route and the save
// route (src/server/sites/liveGuard.ts): editor host (404), session (401), the
// active company with `sites` (403), `editSite` (403), the project in that
// workspace (404); outages answer 503.
//
// After a write every open editor of the site asks at once, so the serialized
// answer is kept per (workspace, site, version) (src/server/sites/liveDocumentCache.ts):
// the guard still runs on every request, and only the load and the
// serialization are skipped for a version already served.

import { getSnapshot } from 'mobx-state-tree';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError } from '@/lib/api/respond';
import { authorizeLiveProject } from '@/server/sites/liveGuard';
import { cachedDocument, documentEpoch, rememberDocument } from '@/server/sites/liveDocumentCache';
import { getSiteRepository, siteRepositoryErrorResponse, SiteRepositoryError } from '@/server/sites';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

const etagOf = (version: number) => `"${version}"`;

/** True when If-None-Match names this version (a list, or a weak tag, counts too). */
function namesVersion(header: string | null, version: number): boolean {
  if (!header) return false;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etagOf(version));
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeLiveProject(req, projectId);
  if (!auth.ok) return auth.response;

  const headers = { 'cache-control': 'private, no-cache' };
  if (namesVersion(req.headers.get('if-none-match'), auth.version)) {
    return new Response(null, { status: 304, headers: { ...headers, etag: etagOf(auth.version) } });
  }
  const json = { ...headers, 'content-type': 'application/json' };
  const kept = cachedDocument(auth.scope, projectId, auth.version);
  if (kept !== undefined) return new Response(kept, { headers: { ...json, etag: etagOf(auth.version) } });
  try {
    const epoch = documentEpoch();
    const { project, version } = await getSiteRepository().loadProjectWithVersion(auth.scope, projectId);
    const snapshot = getSnapshot(project) as ProjectSnapshotOut;
    const body = JSON.stringify({ version, snapshot });
    rememberDocument(auth.scope, projectId, version, body, epoch);
    return new Response(body, { headers: { ...json, etag: etagOf(version) } });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    console.error(`[live] the document of site ${projectId} could not be loaded`, err);
    return jsonError('document_failed', 'the project could not be loaded', 500);
  }
}

export const GET = withAuthAvailability(handleGET);
