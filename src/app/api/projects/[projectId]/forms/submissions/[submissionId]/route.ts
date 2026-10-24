// PATCH  /api/projects/<projectId>/forms/submissions/<submissionId>  { read }
// DELETE /api/projects/<projectId>/forms/submissions/<submissionId>
// Mark one submission read or unread, or delete it for good
// (src/server/forms/editorHandlers.ts).

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { resolveEditorForms } from '@/server/forms/editorScope';
import { handleDeleteSubmission, handlePatchSubmission } from '@/server/forms/editorHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; submissionId: string }> };

async function handlePATCH(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, submissionId } = await params;
  return handlePatchSubmission(req, projectId, submissionId, { resolve: resolveEditorForms });
}

async function handleDELETE(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, submissionId } = await params;
  return handleDeleteSubmission(req, projectId, submissionId, { resolve: resolveEditorForms });
}

export const PATCH = withAuthAvailability(handlePATCH);
export const DELETE = withAuthAvailability(handleDELETE);
