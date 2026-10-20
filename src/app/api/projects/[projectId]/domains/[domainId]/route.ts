// src/app/api/projects/[projectId]/domains/[domainId]/route.ts
//
// DELETE /api/projects/<projectId>/domains/<domainId>   disconnect a custom
//        domain: the row and its token are deleted, the hostname stops serving
//        on the next request, and the proxy drops its route on its next sync
//        (manageDomain). Guarded like the rest of the editor plane
//        (src/server/domains/guard.ts).

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { authorizeDomainProject } from '@/server/domains/guard';
import { domainErrorResponse } from '@/server/domains/http';
import { getDomainService } from '@/server/domains/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; domainId: string }> };

async function handleDELETE(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, domainId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'manageDomain');
  if (!auth.ok) return auth.response;

  try {
    await getDomainService().removeDomain(auth.project.id, domainId);
    return Response.json({ id: domainId, removed: true });
  } catch (err) {
    return domainErrorResponse(err, 'disconnect the domain');
  }
}

export const DELETE = withAuthAvailability(handleDELETE);
