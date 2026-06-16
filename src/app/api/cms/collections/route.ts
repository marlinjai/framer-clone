// src/app/api/cms/collections/route.ts
//
// GET /api/cms/collections
//
// Thin READ route: lists every CMS collection by delegating to the server-only
// read repository (src/server/cms). UNAUTHENTICATED for v1 (reads are public).
// Runs on the Node runtime because the repository reaches Postgres through
// adapter-prisma. A repository throw SURFACES as a 5xx error envelope; it is
// never swallowed into an empty 200.

import { getCmsRepository } from '@/server/cms';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const collections = await getCmsRepository().listCollections();
    return Response.json(collections);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to list collections',
      500,
    );
  }
}
