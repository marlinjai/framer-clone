// src/app/api/machine/books/documents/route.ts
//
// The read-only Books endpoint for machine callers (receipt-ocr-app's income
// mirror). Company API keys only: the handler (src/server/books/machine.ts)
// verifies the key on every request itself; the middleware never does.

import { handleMirrorRequest } from '@/server/books/machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handleMirrorRequest(req);
}
