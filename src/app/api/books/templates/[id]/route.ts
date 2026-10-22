// src/app/api/books/templates/[id]/route.ts
//
// GET    /api/books/templates/<id> -> DocumentTemplate
// PATCH  /api/books/templates/<id> -> DocumentTemplate
// DELETE /api/books/templates/<id> -> 204
//
// PATCH changes the template row (name, default, locale, default texts) and its
// layout: a whole `document`, or the phase 3 form's `accentColor` and
// `footerBlocks`. A changed layout is saved as the next version only when the
// save gate passes (422 `template_invalid` with the named problems); with
// `baseVersionId` a newer saved version refuses the edit (409
// `concurrent_edit`). `isDefault: true` makes this the company's default and
// clears the previous one in the same transaction. DELETE archives the
// template (its versions stay: issued documents were rendered with them); one
// a draft uses answers 409 `template_in_use`. The repository validates every
// value (400 `invalid_input` with the field names). Another company's id
// answers 404 `template_not_found`.

import { booksRoute, readObject } from '@/server/books/http/route';
import {
  deleteTemplate,
  getTemplate,
  updateTemplate,
  type UpdateTemplateInput,
} from '@/server/books/repository/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json(await getTemplate(ctx.scope, id));
});

export const PATCH = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await updateTemplate(ctx.scope, id, body.body as UpdateTemplateInput, { userId: ctx.userId }));
});

export const DELETE = booksRoute<Params>('write', async (ctx, _req, { params }) => {
  const { id } = await params;
  await deleteTemplate(ctx.scope, id);
  return new Response(null, { status: 204 });
});
