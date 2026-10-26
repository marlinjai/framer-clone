// src/app/api/catalog/images/route.ts
//
// POST /api/catalog/images   body: the image bytes -> 201 { sha256, width, height, contentType }
//
// Store one image for the company without placing it (a collection's image is
// then set by its hash). PNG, JPEG or WebP, at most 2 MB; the same file again
// answers the stored one (200).

import { jsonError } from '@/lib/api/respond';
import { boundedBytes } from '@/server/books/http/boundedBody';
import { withDbErrors } from '@/server/catalog/errors';
import { catalogRoute } from '@/server/catalog/http/route';
import { MAX_IMAGE_BYTES } from '@/server/catalog/imageHeader';
import { storeImage } from '@/server/catalog/repository/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = catalogRoute('write', async (ctx, req) => {
  const bytes = await boundedBytes(req, MAX_IMAGE_BYTES);
  if (bytes === null) return jsonError('image_too_large', 'an image may have at most 2 MB', 413);
  if (bytes.byteLength === 0) return jsonError('invalid_input', 'send the image file as the request body', 422);
  const { image, created } = await withDbErrors(() => storeImage(ctx.scope, bytes));
  return Response.json(
    { sha256: image.sha256, width: image.width, height: image.height, contentType: image.contentType },
    { status: created ? 201 : 200 },
  );
});
