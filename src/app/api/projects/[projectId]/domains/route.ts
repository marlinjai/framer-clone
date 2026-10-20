// src/app/api/projects/[projectId]/domains/route.ts
//
// GET  /api/projects/<projectId>/domains   the project's custom domains, with
//      the exact DNS records each one needs (viewSite)
// POST /api/projects/<projectId>/domains   { hostname } -> add a domain, pending
//      until verified (manageDomain, a workspace admin)
//
// Guarded like every editor route (src/server/domains/guard.ts): editor host
// only (404 elsewhere, the published plane never reads a session, D2), a
// verified session (401), the project's workspace in a company with the
// `sites` grant plus the permission (403), auth-brain or OpenFGA outages as
// 503 auth_unavailable / authz_unavailable. Plan:
// docs/plans/2026-06-25-framer-custom-domains.md.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { parseBody } from '@/lib/api/respond';
import { readCustomDomainConfig } from '@/server/domains/config';
import { authorizeDomainProject } from '@/server/domains/guard';
import { domainErrorResponse, requireCustomDomainConfig } from '@/server/domains/http';
import { getDomainService } from '@/server/domains/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

const addBodySchema = z.object({ hostname: z.string().min(1).max(2048) });

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return auth.response;

  const configResult = readCustomDomainConfig();
  const config = configResult.configured ? configResult.config : null;
  try {
    const domains = await getDomainService().listDomains(auth.project.id, config);
    return Response.json(
      {
        configured: config !== null,
        target: config
          ? { host: config.targetHost, ipv4: config.ipv4, ipv6: config.ipv6 }
          : null,
        domains,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    return domainErrorResponse(err, 'list the domains');
  }
}

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'manageDomain');
  if (!auth.ok) return auth.response;

  const configured = requireCustomDomainConfig();
  if (!configured.ok) return configured.response;

  const body = await parseBody(req, addBodySchema);
  if (!body.ok) return body.response;

  try {
    const { domain, created } = await getDomainService().addDomain(
      auth.project,
      body.data.hostname,
      configured.config,
    );
    return Response.json({ domain }, { status: created ? 201 : 200 });
  } catch (err) {
    return domainErrorResponse(err, 'add the domain');
  }
}

export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);
