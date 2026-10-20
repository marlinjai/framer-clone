// src/app/api/books/imports/[id]/extract/route.ts
//
// POST /api/books/imports/<id>/extract -> ImportItemView
//
// Read one staged PDF with Claude (src/server/books/upload/extract.ts) and
// validate the transcription. Synchronous (one invoice is a short call); the
// call is aborted when the client disconnects, and the row is then free to be
// read again. Refusals before any model call: 429 `extract_busy` (four
// invoices of the company are being read; retry-after), 429 `import_limit`
// (the daily ceiling), 409 `extraction_running` (this file is being read),
// 409 `concurrent_edit` (imported or discarded). A missing ANTHROPIC_API_KEY
// answers 401 `missing_anthropic_key` like the other AI routes; an unknown
// AI_INVOICE_EXTRACT_MODEL answers 500 `extract_model_unknown`.

import type Anthropic from '@anthropic-ai/sdk';

import { jsonError } from '@/lib/api/respond';
import { AI_MODELS, getAnthropicClient, MissingAnthropicKeyError, type AiModelKey } from '@/lib/ai/anthropicClient';
import { booksRoute } from '@/server/books/http/route';
import { ExtractModelConfigError, extractModelKey } from '@/server/books/upload/extract';
import { companySlots, dailyExtractLimit } from '@/server/books/upload/limits';
import { extractItem } from '@/server/books/upload/service';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One invoice is read in well under a minute; the ceiling leaves room for a repair turn.
export const maxDuration = 300;

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  let anthropic: Anthropic;
  let modelKey: AiModelKey;
  try {
    anthropic = getAnthropicClient();
    modelKey = extractModelKey();
  } catch (e) {
    if (e instanceof MissingAnthropicKeyError) return jsonError(e.code, e.message, 401);
    if (e instanceof ExtractModelConfigError) {
      console.error('[books-import] extraction model misconfigured');
      return jsonError(e.code, 'the invoice reading model is not configured on this server', 500);
    }
    throw e;
  }
  const item = await extractItem(ctx.scope, id, {
    anthropic,
    modelKey,
    modelId: AI_MODELS[modelKey],
    slots: companySlots(),
    dailyLimit: dailyExtractLimit(),
    signal: req.signal,
    contactBook: ctx.contactBook,
  });
  console.info(`[books-import] item ${item.id}: ${item.status}, ${item.problems.length} problem(s)`);
  return Response.json(importItemView(item));
});
