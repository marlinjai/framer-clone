// src/app/dev/books-engine/cases/route.harness.ts
//
// GET /dev/books-engine/cases: the parity harness's cases with the server's
// SHA-256 for each (harnessCases.ts). Exists only in a build with
// BOOKS_ENGINE_HARNESS=1 (next.config.ts); never shipped.

import { harnessCases } from '../harnessCases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(await harnessCases(), { headers: { 'cache-control': 'no-store' } });
}
