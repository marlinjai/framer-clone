// src/app/api/books/assets/[sha256]/route.ts
//
// GET    /api/books/assets/<sha256>  -> the image bytes with their content type
// DELETE /api/books/assets/<sha256>  -> 204, the logo is gone
//
// A logo of the active company, by its hash (visual template composer plan,
// decision 15): the composer shows it in the inspector, the block outline and
// the logo list. An asset is named by the hash of its bytes and never changed,
// but it can be DELETED (decision 9, possibly for a person's right to
// erasure), so a browser keeps it privately and asks again each time
// (`no-cache`): the ETag makes that a 304 without the bytes while it exists,
// and a deleted logo answers 404 at once instead of showing from a cache for a
// year (which `immutable` did, found in the production proof on 2026-10-23).
// Another company's asset, an unknown hash or
// a malformed one all answer 404 `asset_not_found` (existence never leaks).
// Only bytes the upload checked are ever served, with nosniff, same-origin
// only and a content security policy that lets nothing load or run. The hash
// is the ETag, so a revalidation answers 304.
//
// DELETE removes a logo nobody uses (phase 4 decision 9, migration 014),
// behind the Books write guard (`editBooks`, the right that uploads logos):
//   204                 deleted
//   404 asset_not_found unknown, malformed or another company's
//   409 asset_in_use    an issued document froze it, or a live template's current version names it
// The log line carries the hash only.

import { booksRoute } from '@/server/books/http/route';
import { deleteAsset, readAsset, readAssetView, type AssetView } from '@/server/books/repository/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute<{ sha256: string }>('read', async (ctx, req, { params }) => {
  const { sha256 } = await params;
  const headersOf = (asset: AssetView) => ({
    'content-type': asset.contentType,
    'cache-control': 'private, no-cache',
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

export const DELETE = booksRoute<{ sha256: string }>('write', async (ctx, _req, { params }) => {
  const { sha256 } = await params;
  await deleteAsset(ctx.scope, sha256);
  console.info(`[books] logo ${sha256} deleted`);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
});
