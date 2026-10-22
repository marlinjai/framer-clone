// src/app/api/books/templates/route.ts
//
// GET  /api/books/templates -> { items: DocumentTemplate[] }  (default first)
// POST /api/books/templates -> 201 DocumentTemplate
//
// The company's document templates (Books plan phase 3, versioned by the
// visual template composer plan): layout only. Each answer carries the current
// version's template document (model version 2) and, for the phase 3 form,
// its accent colour and small-print footer blocks. POST starts from a preset
// (`preset`: klassisch, modern or kompakt; Klassisch by default) or a whole
// `document`, and saves version 1 only when the save gate passes (422
// `template_invalid` with the named problems). Sender, tax status and number
// formats are company configuration, never part of a template. The first
// template of a company becomes its default; a new draft starts with the
// default template. A duplicate name answers 409 `duplicate_template`.

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { createTemplate, listTemplates, type CreateTemplateInput } from '@/server/books/repository/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute('read', async (ctx) => {
  return Response.json({ items: await listTemplates(ctx.scope) });
});

export const POST = booksRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (typeof body.body.name !== 'string') {
    return jsonError('bad_body', 'invalid request body', 400, { issues: [{ path: ['name'], message: 'required' }] });
  }
  const template = await createTemplate(ctx.scope, body.body as CreateTemplateInput, { userId: ctx.userId });
  return Response.json(template, { status: 201 });
});
