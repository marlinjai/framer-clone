// src/app/api/catalog/images/[sha256]/route.ts
//
// GET /api/catalog/images/<sha256> -> the image bytes
//
// One stored image of the active company, by the SHA-256 of its bytes (the
// table's thumbnails, the panel's photos). The bytes behind a hash never
// change, so the hash is the ETag and a revalidation answers 304 without the
// bytes; the browser keeps it privately for a day. Another company's image, an
// unknown or a malformed hash: 404 (existence never leaks). Only bytes the
// upload checked are served, with nosniff, same-origin only and a content
// security policy that lets nothing load or run.

import { catalogRoute } from '@/server/catalog/http/route';
import { readImage, readImageType } from '@/server/catalog/repository/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = catalogRoute<{ sha256: string }>('read', async (ctx, req, { params }) => {
  const { sha256 } = await params;
  const headers = (contentType: string) => ({
    'content-type': contentType,
    'cache-control': 'private, max-age=86400',
    etag: `"${sha256}"`,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'",
  });
  const known = (req.headers.get('if-none-match') ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
  if (known.includes('*') || known.includes(`"${sha256}"`)) {
    // Checked against the company first, so a 304 never confirms another company's image.
    return new Response(null, { status: 304, headers: headers(await readImageType(ctx.scope, sha256)) });
  }
  const { contentType, bytes } = await readImage(ctx.scope, sha256);
  return new Response(Buffer.from(bytes), { status: 200, headers: { ...headers(contentType), 'content-length': String(bytes.byteLength) } });
});
