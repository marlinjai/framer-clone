// src/app/api/projects/[projectId]/domains/[domainId]/verify/route.ts
//
// POST /api/projects/<projectId>/domains/<domainId>/verify   check the domain's
//      DNS server-side (TXT ownership token, CNAME or A routing) and, once
//      verified, its certificate; records pending / verified / active / failed
//      with the reason (manageDomain). The answer is the updated domain; a DNS
//      problem is a status with a reason, not an HTTP error. Guarded like the
//      rest of the editor plane (src/server/domains/guard.ts).

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { authorizeDomainProject } from '@/server/domains/guard';
import { domainErrorResponse, requireCustomDomainConfig } from '@/server/domains/http';
import { getDomainService } from '@/server/domains/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; domainId: string }> };

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, domainId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'manageDomain');
  if (!auth.ok) return auth.response;

  const configured = requireCustomDomainConfig();
  if (!configured.ok) return configured.response;

  try {
    const domain = await getDomainService().verifyDomain(
      auth.project.id,
      domainId,
      configured.config,
    );
    return Response.json({ domain });
  } catch (err) {
    return domainErrorResponse(err, 'verify the domain');
  }
}

export const POST = withAuthAvailability(handlePOST);
