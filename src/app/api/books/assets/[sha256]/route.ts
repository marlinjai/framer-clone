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
// upload checked are ever served, with nosniff, same-origin only and a
// content security policy that lets nothing load or run. The hash is the ETag,
// so a revalidation answers 304.

import { booksRoute } from '@/server/books/http/route';
import { readAsset, readAssetView, type AssetView } from '@/server/books/repository/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute<{ sha256: string }>('read', async (ctx, req, { params }) => {
  const { sha256 } = await params;
  const headersOf = (asset: AssetView) => ({
    'content-type': asset.contentType,
    'cache-control': 'private, max-age=31536000, immutable',
    etag: `"${asset.sha256}"`,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    // An image is shown, never run: nothing it might contain may load or execute anything.
    'content-security-policy': "default-src 'none'",
  });
  // The bytes behind a hash never change: a client that has them gets a 304, read without the bytes
  // (after the guard and the company filter, so no one learns of another company's asset).
  const known = (req.headers.get('if-none-match') ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
  if (known.length > 0 && known[0] !== '') {
    const asset = await readAssetView(ctx.scope, sha256);
    const headers = headersOf(asset);
    if (known.includes('*') || known.includes(headers.etag)) return new Response(null, { status: 304, headers });
  }
  const { asset, bytes } = await readAsset(ctx.scope, sha256);
  return new Response(Buffer.from(bytes), { status: 200, headers: { ...headersOf(asset), 'content-length': String(bytes.byteLength) } });
});
