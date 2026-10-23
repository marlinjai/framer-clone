// src/app/api/books/templates/[id]/versions/route.ts
//
// GET /api/books/templates/<id>/versions -> { items: TemplateVersionSummary[] }
//
// The saved versions of a template for the composer's version list (visual
// template composer plan, phase 4): newest first, each with the number of
// issued documents frozen with it. Versions are append-only, so this is a
// history, never something to edit. Another company's or an archived template
// answers 404 `template_not_found`.

import { booksRoute } from '@/server/books/http/route';
import { listTemplateVersions } from '@/server/books/repository/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json({ items: await listTemplateVersions(ctx.scope, id) });
});
