// POST /api/projects/<projectId>/forms/submissions/<submissionId>/resend
// Send the site owner's email about one submission again, when it failed or was never sent
// (src/server/forms/notify.ts resendFormNotification, behind the editSite guard).

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { resolveEditorForms } from '@/server/forms/editorScope';
import { handleResendNotification } from '@/server/forms/editorHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; submissionId: string }> };

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, submissionId } = await params;
  return handleResendNotification(req, projectId, submissionId, { resolve: resolveEditorForms });
}

export const POST = withAuthAvailability(handlePOST);
