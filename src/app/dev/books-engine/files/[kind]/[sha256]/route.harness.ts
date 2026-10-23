// src/app/dev/books-engine/files/[kind]/[sha256]/route.harness.ts
//
// GET /dev/books-engine/files/<fonts|assets>/<sha256>: the harness's stand-in
// for the font and asset routes, which need a signed-in Books session. In a
// BOOKS_ENGINE_HARNESS=1 build, next.config.ts rewrites /api/books/fonts/* and
// /api/books/assets/* here, so the worker fetches exactly the paths it fetches
// in production. Fonts come from the server's loader (pinned files), logos
// generated as in the harness cases. Never shipped.

import { fontFileByDigest } from '@/server/books/render/fonts';

import { logoCase } from '@/server/books/__tests__/testImages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string; sha256: string }> }): Promise<Response> {
  const { kind, sha256 } = await params;
  if (kind === 'fonts') {
    const bytes = fontFileByDigest(sha256);
    return bytes ? new Response(Buffer.from(bytes), { headers: { 'content-type': 'font/ttf' } }) : new Response('not found', { status: 404 });
  }
  if (kind !== 'assets') return new Response('not found', { status: 404 });
  // The generated logos are deterministic: the same bytes as in the cases route.
  const logo = (['png', 'jpeg'] as const).map((k) => logoCase('dejavu-sans', k)).find((c) => c.sha === sha256)?.assets.get(sha256);
  return logo ? new Response(Buffer.from(logo.bytes), { headers: { 'content-type': logo.contentType } }) : new Response('not found', { status: 404 });
}
