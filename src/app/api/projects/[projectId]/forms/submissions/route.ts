// GET /api/projects/<projectId>/forms/submissions: the project's form
// submissions, newest first (src/server/forms/editorHandlers.ts).

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { resolveEditorForms } from '@/server/forms/editorScope';
import { handleListSubmissions } from '@/server/forms/editorHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  return handleListSubmissions(req, projectId, { resolve: resolveEditorForms });
}

export const GET = withAuthAvailability(handleGET);
