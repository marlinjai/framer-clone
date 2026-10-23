// src/app/api/books/fonts/[sha256]/route.ts
//
// GET /api/books/fonts/<sha256>  -> font/ttf
//
// The font files of the Books for the browser's layout engine (WYSIWYG invoice
// editor plan, phase 1): exactly the files pinned in render/fontPins.ts, named
// by their SHA-256, read from assets/fonts by the server's own loader
// (render/fonts.ts, which refuses a file on disk that differs from its pin).
// The browser fetches only the family a template uses and checks each file's
// digest again before drawing with it (src/lib/books/engine/fonts.ts).
//
// A file behind a digest never changes (a family id never changes its files,
// decision 6 of the composer plan), so the answer is cached for a year,
// `immutable`; `public` is right because the files are the same open-licensed
// fonts for everyone (Bitstream Vera and SIL Open Font licences,
// assets/fonts). Behind the Books read guard like every /api/books route, so
// only a signed-in user of a company with the Books opens it. Any digest that
// is not a pinned font (malformed, unknown, a logo's) answers 404 `not_found`.
// The standalone build traces assets/fonts for every Books route
// (next.config.ts `outputFileTracingIncludes`).

import { jsonError } from '@/lib/api/respond';
import { booksRoute } from '@/server/books/http/route';
import { fontFileByDigest } from '@/server/books/render/fonts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHA256 = /^[0-9a-f]{64}$/;

export const GET = booksRoute<{ sha256: string }>('read', async (_ctx, _req, { params }) => {
  const { sha256 } = await params;
  const bytes = SHA256.test(sha256) ? fontFileByDigest(sha256) : null;
  if (!bytes) return jsonError('not_found', 'There is no font file with this digest.', 404);
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': 'font/ttf',
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${sha256}"`,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
});
