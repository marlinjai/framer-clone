// src/app/api/books/documents/[id]/render-input/route.ts
//
// GET /api/books/documents/<id>/render-input  -> RenderInputPayload (JSON)
//
// What the browser's layout engine needs to draw a DRAFT exactly as the draft
// PDF route (GET .../pdf) draws it (WYSIWYG invoice editor plan, phase 1):
// the render input from live data (the company's sender block, the
// customer's current contact, the lines and the server's figures), the current
// version of the draft's template, its font family, and the logos it names
// that the company has. The browser fetches the fonts by digest
// (GET /api/books/fonts/<sha256>) and the logos by hash
// (GET /api/books/assets/<sha256>) and renders in a Web Worker
// (src/lib/books/engine). The server stays the only renderer of record.
//
// Behind the same read guard as the draft PDF route (`viewBooks`, the active
// company): another company's id, an unknown and a malformed id answer 404
// `not_found`. An issued or imported document answers 409 `not_renderable`:
// it is shown and downloaded from its stored document of record, never drawn
// in the browser (decided while building phase 1). Dates are ISO strings in
// the JSON; the client turns them back into dates (payload.ts). Never cached
// (`private, no-store`): it carries the draft's live data.

import { booksRoute } from '@/server/books/http/route';
import { draftRenderSource } from '@/server/books/render/store';
import { RENDER_INPUT_FORMAT, type RenderInputPayload } from '@/lib/books/engine/payload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute<{ id: string }>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const source = await draftRenderSource(ctx.scope, id);
  const payload: RenderInputPayload = {
    format: RENDER_INPUT_FORMAT,
    documentId: id,
    documentVersion: source.version,
    fontFamily: source.template.theme.fontFamily,
    input: source.input,
    template: source.template,
    logos: source.logos,
  };
  return Response.json(payload, {
    status: 200,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
});
