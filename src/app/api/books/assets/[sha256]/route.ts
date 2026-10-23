// src/app/api/books/assets/[sha256]/route.ts
//
// GET /api/books/assets/<sha256>  -> the image bytes with their content type
//
// A logo of the active company, by its hash (visual template composer plan,
// decision 15): the composer shows it in the inspector and the block outline.
// An asset is append-only and named by the hash of its bytes, so the answer
// never changes and may be cached for a year (`immutable`), privately (behind
// the session). Another company's asset, an unknown hash or a malformed one
// all answer 404 `asset_not_found` (existence never leaks). Only bytes the
// upload checked are ever served, with nosniff and same-origin only.

import { booksRoute } from '@/server/books/http/route';
import { readAsset } from '@/server/books/repository/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute<{ sha256: string }>('read', async (ctx, _req, { params }) => {
  const { sha256 } = await params;
  const { asset, bytes } = await readAsset(ctx.scope, sha256);
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
});
