// src/app/api/books/documents/route.ts
//
// GET  /api/books/documents[?status=&docType=&number=&year=&cursor=]  -> { items, nextCursor, total }
// POST /api/books/documents                              -> 201 DocumentDetail
//
// The active company's documents (Books plan P1.6, phase 2), drafts first, then
// by issue date, 50 a page (`nextCursor` fetches the next, `total` counts every
// match). `number` finds documents whose number contains it (case-insensitive),
// `year` those issued in that year (a draft has no issue date and is not in
// any year). Each item carries its number (null on a draft: a draft never
// has one), status, dates, total and the customer's current contact name.
//
// POST starts a NEW draft invoice, always a fresh row with a new id: no number,
// no snapshots, only its own `draft_created` event (the re-entry path of the
// stateful-flow standard). Optional starting values: `customerId`, `templateId`,
// `netOrGross`, `serviceDate`, `servicePeriod`, `contractReference`, `subject`,
// `introText`, `outroText`. Without a template the company's default template
// (if any) is put on the draft, and its default intro and outro texts fill
// whatever the request leaves out. A draft that is never issued consumes nothing:
// numbers are allocated at issue only. There is no DELETE: a draft is never
// deleted (it carries its audit event), an abandoned one simply stays a draft.

import { z } from 'zod';

import { richTextSchema } from '@/server/books/render/richText';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail, documentListItems } from '@/server/books/http/views';
import { getCustomer, getCustomers } from '@/server/books/repository/customers';
import { createDraft } from '@/server/books/repository/documents';
import { listDocuments } from '@/server/books/repository/read';
import { defaultTemplateId, getTemplate } from '@/server/books/repository/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['draft', 'issued', 'sent', 'accepted', 'rejected', 'paid', 'cancelled'] as const;
const DOC_TYPES = ['offer', 'invoice', 'credit_note'] as const;

const createBody = z
  .object({
    customerId: z.string().min(1).optional(),
    templateId: z.string().min(1).optional(),
    netOrGross: z.enum(['net', 'gross']).optional(),
    serviceDate: z.string().optional(),
    servicePeriod: z.object({ start: z.string(), end: z.string() }).optional(),
    contractReference: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    introText: z.string().nullable().optional(),
    outroText: z.string().nullable().optional(),
    // A formatted text (bold, italic, bullets); the repository derives its plain text.
    introFormat: richTextSchema.optional(),
    outroFormat: richTextSchema.optional(),
  })
  .strict();

export const GET = booksRoute('read', async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const status = q.get('status');
  const docType = q.get('docType');
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return jsonError('bad_query', 'unknown status', 400);
  }
  if (docType && !(DOC_TYPES as readonly string[]).includes(docType)) {
    return jsonError('bad_query', 'unknown document type', 400);
  }
  const number = q.get('number')?.trim() || undefined;
  if (number !== undefined && number.length > 40) return jsonError('bad_query', 'number is at most 40 characters', 400);
  const year = q.get('year')?.trim() || undefined;
  if (year !== undefined && !/^(19|20)\d{2}$/.test(year)) return jsonError('bad_query', 'year is a four-digit year', 400);
  const page = await listDocuments(ctx.scope, {
    status: (status as (typeof STATUSES)[number] | null) ?? undefined,
    docType: (docType as (typeof DOC_TYPES)[number] | null) ?? undefined,
    numberContains: number,
    issuedFrom: year ? `${year}-01-01` : undefined,
    issuedTo: year ? `${year}-12-31` : undefined,
    cursor: q.get('cursor') ?? undefined,
    limit: 50,
  });
  const items = await documentListItems(ctx.contactBook, ctx.companyId, page.items, (ids) =>
    getCustomers(ctx.scope, ids),
  );
  return Response.json({ items, nextCursor: page.nextCursor, total: page.total });
});

export const POST = booksRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = createBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const templateId = parsed.data.templateId ?? (await defaultTemplateId(ctx.scope)) ?? undefined;
  // The template's default texts fill what the request leaves out.
  const template = templateId ? await getTemplate(ctx.scope, templateId) : null;
  const view = await createDraft(ctx.scope, {
    ...parsed.data,
    introText: parsed.data.introText !== undefined ? parsed.data.introText : (template?.defaultIntroText ?? undefined),
    outroText: parsed.data.outroText !== undefined ? parsed.data.outroText : (template?.defaultOutroText ?? undefined),
    templateId,
    docType: 'invoice',
    actorUserId: ctx.userId,
  });
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (id) => getCustomer(ctx.scope, id));
  return Response.json(detail, { status: 201 });
});
