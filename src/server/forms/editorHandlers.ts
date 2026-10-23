import 'server-only';

// src/server/forms/editorHandlers.ts
//
// The editor's form submissions API, behind resolveEditorForms (editSite):
//
//   GET    /api/projects/<id>/forms/submissions?form=&limit=&cursor=
//            -> { submissions, hasMore, nextCursor, forms }   newest first
//   PATCH  /api/projects/<id>/forms/submissions/<submissionId>  { read: boolean }
//            -> { id, readAt }                                 mark read / unread
//   DELETE /api/projects/<id>/forms/submissions/<submissionId>
//            -> { id, deleted: true }                          a real DELETE
//   GET    /api/projects/<id>/forms/submissions/export?form=
//            -> text/csv attachment                            (at most EXPORT_MAX rows)
//
// A submission of another site answers 404, like an unknown id. Every answer is
// `no-store`: it carries personal data.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { submissionsToCsv } from '@/lib/forms/csv';
import type { EditorFormsContext, EditorFormsScope } from './editorScope';
import {
  deleteFormSubmission,
  exportFormSubmissions,
  listFormSubmissions,
  setFormSubmissionRead,
  summarizeForms,
  type FormSubmission,
} from './repository';

export const EXPORT_MAX = 10_000;

export interface EditorFormsDeps {
  resolve(req: Request, projectId: string): Promise<EditorFormsContext>;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

function submissionView(s: FormSubmission) {
  return {
    id: s.id,
    formId: s.formId,
    formName: s.formName,
    pageId: s.pageId,
    pagePath: s.pagePath,
    fields: s.fields,
    readAt: s.readAt ? s.readAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}

export type SubmissionView = ReturnType<typeof submissionView>;

function encodeCursor(s: FormSubmission): string {
  return Buffer.from(JSON.stringify({ c: s.createdAt.toISOString(), i: s.id }), 'utf8').toString('base64url');
}

const cursorSchema = z.object({ c: z.string().datetime(), i: z.string().min(1).max(200) });

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? { createdAt: new Date(parsed.data.c), id: parsed.data.i } : null;
  } catch {
    return null;
  }
}

function refOf(scope: EditorFormsScope) {
  return { tenantId: scope.tenantGroupId, siteId: scope.siteId };
}

function failure(action: string, projectId: string, err: unknown): Response {
  console.error(`[forms] ${action} for project ${projectId} failed:`, err);
  return jsonError('forms_failed', 'the form submissions could not be loaded or changed, try again', 500);
}

export async function handleListSubmissions(req: Request, projectId: string, deps: EditorFormsDeps): Promise<Response> {
  const ctx = await deps.resolve(req, projectId);
  if (!ctx.ok) return ctx.response;
  const url = new URL(req.url);
  const formId = url.searchParams.get('form')?.trim() || undefined;
  const limitRaw = Number(url.searchParams.get('limit') ?? '50');
  const cursorRaw = url.searchParams.get('cursor');
  const before = cursorRaw ? decodeCursor(cursorRaw) : undefined;
  if (cursorRaw && !before) return jsonError('bad_cursor', 'the cursor is not valid', 400);
  try {
    const ref = refOf(ctx.scope);
    const [page, forms] = await Promise.all([
      listFormSubmissions(ctx.scope.db, ref, {
        formId,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        before: before ?? undefined,
      }),
      summarizeForms(ctx.scope.db, ref),
    ]);
    const last = page.submissions[page.submissions.length - 1];
    return Response.json(
      {
        submissions: page.submissions.map(submissionView),
        hasMore: page.hasMore,
        nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        forms,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failure('listing submissions', projectId, err);
  }
}

const patchSchema = z.object({ read: z.boolean() }).strict();

export async function handlePatchSubmission(
  req: Request,
  projectId: string,
  submissionId: string,
  deps: EditorFormsDeps,
): Promise<Response> {
  const ctx = await deps.resolve(req, projectId);
  if (!ctx.ok) return ctx.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('bad_json', 'invalid JSON body', 400);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  try {
    const found = await setFormSubmissionRead(ctx.scope.db, refOf(ctx.scope), submissionId, parsed.data.read);
    if (!found) return jsonError('not_found', 'no such submission', 404);
    return Response.json({ id: submissionId, read: parsed.data.read }, { headers: NO_STORE });
  } catch (err) {
    return failure('marking a submission', projectId, err);
  }
}

export async function handleDeleteSubmission(
  req: Request,
  projectId: string,
  submissionId: string,
  deps: EditorFormsDeps,
): Promise<Response> {
  const ctx = await deps.resolve(req, projectId);
  if (!ctx.ok) return ctx.response;
  try {
    const found = await deleteFormSubmission(ctx.scope.db, refOf(ctx.scope), submissionId);
    if (!found) return jsonError('not_found', 'no such submission', 404);
    return Response.json({ id: submissionId, deleted: true }, { headers: NO_STORE });
  } catch (err) {
    return failure('deleting a submission', projectId, err);
  }
}

export async function handleExportSubmissions(req: Request, projectId: string, deps: EditorFormsDeps): Promise<Response> {
  const ctx = await deps.resolve(req, projectId);
  if (!ctx.ok) return ctx.response;
  const formId = new URL(req.url).searchParams.get('form')?.trim() || undefined;
  try {
    const { submissions, truncated } = await exportFormSubmissions(ctx.scope.db, refOf(ctx.scope), { formId, max: EXPORT_MAX });
    const csv = submissionsToCsv(submissions);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="form-submissions-${date}.csv"`,
        // The client says so when the export stopped at the cap.
        'x-export-truncated': truncated ? 'true' : 'false',
        ...NO_STORE,
      },
    });
  } catch (err) {
    return failure('exporting submissions', projectId, err);
  }
}
