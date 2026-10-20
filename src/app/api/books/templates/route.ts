// src/app/api/books/templates/route.ts
//
// GET  /api/books/templates -> { items: DocumentTemplate[] }  (default first)
// POST /api/books/templates -> 201 DocumentTemplate
//
// The company's document templates (Books plan phase 3): layout only (name,
// default flag, accent colour, up to four footer blocks of small print, default
// intro and outro texts for new drafts). Sender, tax status and number formats
// are company configuration, never part of a template. The first template of a
// company becomes its default; a new draft starts with the default template.
// A duplicate name answers 409 `duplicate_template`.

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
  const template = await createTemplate(ctx.scope, body.body as CreateTemplateInput);
  return Response.json(template, { status: 201 });
});
