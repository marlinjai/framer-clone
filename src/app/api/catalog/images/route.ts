// src/app/api/catalog/images/route.ts
//
// POST /api/catalog/images   body: the image bytes -> 201 { sha256, width, height, contentType }
//
// Store one image for the company without placing it (a collection's image is
// then set by its hash). PNG, JPEG or WebP, at most 2 MB; the same file again
// answers the stored one (200). At most 30 upload attempts per user in 10
// minutes, with the product image upload (src/server/uploads/rateLimit.ts):
// 429 with Retry-After beyond.

import { jsonError } from '@/lib/api/respond';
import { boundedBytes } from '@/server/books/http/boundedBody';
import { withDbErrors } from '@/server/catalog/errors';
import { catalogRoute } from '@/server/catalog/http/route';
import { MAX_IMAGE_BYTES } from '@/server/catalog/imageHeader';
import { storeImage } from '@/server/catalog/repository/images';
import { getUploadRateLimiter, uploadRateLimitedResponse } from '@/server/uploads/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = catalogRoute('write', async (ctx, req) => {
  const limited = getUploadRateLimiter().hit('catalog-images', ctx.userId, Date.now());
  if (!limited.ok) return uploadRateLimitedResponse(limited.retryAfterSec);
  const bytes = await boundedBytes(req, MAX_IMAGE_BYTES);
  if (bytes === null) return jsonError('image_too_large', 'an image may have at most 2 MB', 413);
  if (bytes.byteLength === 0) return jsonError('invalid_input', 'send the image file as the request body', 422);
  const { image, created } = await withDbErrors(() => storeImage(ctx.scope, bytes));
  return Response.json(
    { sha256: image.sha256, width: image.width, height: image.height, contentType: image.contentType },
    { status: created ? 201 : 200 },
  );
});
