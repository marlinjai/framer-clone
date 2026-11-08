// src/app/api/projects/[projectId]/confirmations/[approvalId]/route.ts
//
// A signed-in person approves the publish or rollback an agent asked for through
// the Lumitra Sites MCP endpoint (src/server/mcp/approveRoute.ts). Editor host
// only, cookie session only.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { approveConfirmation } from '@/server/mcp/approveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; approvalId: string }> };

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, approvalId } = await params;
  return approveConfirmation(req, projectId, approvalId);
}

export const POST = withAuthAvailability(handlePOST);
