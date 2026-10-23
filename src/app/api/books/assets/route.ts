// src/app/api/books/assets/route.ts
//
// POST /api/books/assets   body: the image bytes, content-type image/png or image/jpeg
//   -> 201 { sha256, contentType, byteSize, widthPx, heightPx }   (stored now)
//   -> 200 { ... }                                                 (the same bytes were stored before)
//
// The logo upload of the template composer (visual template composer plan,
// decision 15). The body is the file itself, read as a bounded stream (at most
// 1 MB, also without Content-Length), then checked by its magic bytes, its
// pixel size (at most 2000 px on the longer side), a full decode and a trial
// embed into a PDF (render/logoImage.ts), so a file the PDF writer cannot
// embed is refused here, never at issue. `image/jpg` and `image/pjpeg` are
// read as `image/jpeg`. Behind the Books write guard
// (`editBooks`, the right that edits templates). Errors:
//   409 asset_limit             the company stores the most logos allowed (100)
//   413 asset_too_large         more than 1 MB
//   415 unsupported_asset_type  not image/png or image/jpeg, or the bytes are not what the type says
//   422 asset_invalid           undecodable, not embeddable, or too many pixels (the message says which)
// The log line carries the hash and the size only.

import { BooksError } from '@/server/books/errors';
import { boundedBytes } from '@/server/books/http/boundedBody';
import { booksRoute } from '@/server/books/http/route';
import { LOGO_CONTENT_TYPES, MAX_LOGO_BYTES } from '@/server/books/render/logoImage';
import { storeLogo } from '@/server/books/repository/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Non-standard names some systems send for a JPEG (the magic bytes are checked either way). */
const JPEG_ALIASES = new Set(['image/jpg', 'image/pjpeg']);

export const POST = booksRoute('write', async (ctx, req) => {
  const sent = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const type = JPEG_ALIASES.has(sent) ? 'image/jpeg' : sent;
  // The type is checked before the body is read: nothing else is worth receiving.
  if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw new BooksError('UNSUPPORTED_ASSET_TYPE', 'a logo is a PNG or a JPEG (image/png or image/jpeg)', { contentType: type || null });
  }
  const bytes = await boundedBytes(req, MAX_LOGO_BYTES);
  if (bytes === null) throw new BooksError('ASSET_TOO_LARGE', `a logo has at most ${MAX_LOGO_BYTES} bytes`, { maxBytes: MAX_LOGO_BYTES });
  const { asset, created } = await storeLogo(ctx.scope, bytes, type, { userId: ctx.userId });
  console.info(`[books] logo ${asset.sha256} ${created ? 'stored' : 'already stored'} (${asset.byteSize} bytes)`);
  return Response.json(asset, { status: created ? 201 : 200, headers: { 'cache-control': 'no-store' } });
});
