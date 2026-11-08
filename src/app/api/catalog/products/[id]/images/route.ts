// src/app/api/catalog/products/[id]/images/route.ts
//
// POST /api/catalog/products/<id>/images   body: the image bytes -> 201 ProductDetail
// PUT  /api/catalog/products/<id>/images   { imageIds: [...] }    -> ProductDetail (the new order)
//
// POST adds one PNG, JPEG or WebP image (at most 2 MB, read bounded; 413, 415,
// 422 otherwise) to the end of the product's images; the type and size come
// from the bytes. The same file again is stored once and placed once. At most
// 30 upload attempts per user in 10 minutes, with the catalogue's other image
// upload (src/server/uploads/rateLimit.ts): 429 with Retry-After beyond.

import { jsonError } from '@/lib/api/respond';
import { boundedBytes } from '@/server/books/http/boundedBody';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { MAX_IMAGE_BYTES } from '@/server/catalog/imageHeader';
import { addProductImage, reorderProductImages } from '@/server/catalog/repository/images';
import { getUploadRateLimiter, uploadRateLimitedResponse } from '@/server/uploads/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const POST = catalogRoute<Params>('write', async (ctx, req, { params }) => {
  const limited = getUploadRateLimiter().hit('catalog-images', ctx.userId, Date.now());
  if (!limited.ok) return uploadRateLimitedResponse(limited.retryAfterSec);
  const bytes = await boundedBytes(req, MAX_IMAGE_BYTES);
  if (bytes === null) return jsonError('image_too_large', 'an image may have at most 2 MB', 413);
  if (bytes.byteLength === 0) return jsonError('invalid_input', 'send the image file as the request body', 422);
  return Response.json(await addProductImage(ctx.scope, (await params).id, bytes), { status: 201 });
});

export const PUT = catalogRoute<Params>('write', async (ctx, req, { params }) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (!Array.isArray(body.body.imageIds)) return jsonError('invalid_input', 'send { imageIds: [...] }', 422);
  return Response.json(await reorderProductImages(ctx.scope, (await params).id, body.body.imageIds as string[]));
});
