import 'server-only';

// src/server/sites/branches/reviewRoute.ts
//
// The shared shape of a branch's review routes, `/api/projects/<branchId>/branch/...`
// (docs/plans/2026-11-10-site-branches.md, section 6): the guard chain of every branch route, the body read
// through a schema, the outcome as JSON never cached, and a repository refusal as its own answer.

import { z } from 'zod';
import { jsonError, parseBody } from '@/lib/api/respond';
import type { FramerAction } from '@/lib/permissions';
import { SiteRepositoryError, siteRepositoryErrorResponse } from '../errors';
import type { TenantScope } from '../repository';
import type { BranchActor } from './repository';
import { guardBranchRoute } from './routeGuard';
import { MERGE_DRAFT_MAX_ANSWERS, REVIEW_NOTE_MAX_LENGTH } from './merge';

export type ReviewCtx = { params: Promise<{ projectId: string }> };

/**
 * 2,000 answers of the largest allowed size fit in this even with every key character written as a six byte
 * JSON escape (512 x 6 + 128 + punctuation, about 3.3 KB each); anything larger is refused before it is parsed.
 */
const REVIEW_BODY_MAX_BYTES = 7_000_000;
/**
 * A body that carries a token and at most a note (approve, send back, merge): the note is 2,000 characters at
 * most, each at worst a twelve byte escape pair. Anything larger is refused before it is read in full, so a
 * member who may only view cannot make the server parse megabytes.
 */
const SMALL_BODY_MAX_BYTES = 32_000;

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const tokenSchema = z.string().min(1).max(64);

export const resolutionsSchema = z
  .record(z.string().min(1).max(512), z.object({ fingerprint: z.string().min(1).max(128), pick: z.enum(['main', 'branch']) }))
  .refine((r) => Object.keys(r).length <= MERGE_DRAFT_MAX_ANSWERS, { message: `at most ${MERGE_DRAFT_MAX_ANSWERS} answers` });

export const noteSchema = z.string().max(REVIEW_NOTE_MAX_LENGTH * 4);

interface Handler<T> {
  action: FramerAction;
  what: string;
  /** Without one, the route takes no body. */
  body?: z.ZodType<T>;
  /** The body carries conflict answers (update, answers): the large limit. Every other body gets the small one. */
  answers?: true;
  run: (input: { scope: TenantScope; branchId: string; actor: BranchActor; body: T; query: URLSearchParams }) => Promise<unknown>;
}

export function reviewRoute<T>(handler: Handler<T>) {
  return async (req: Request, { params }: ReviewCtx): Promise<Response> => {
    const guarded = await guardBranchRoute(req, handler.action);
    if (!guarded.ok) return guarded.response;
    let body = undefined as T;
    if (handler.body) {
      const parsed = await parseBody(req, handler.body, { maxBytes: handler.answers ? REVIEW_BODY_MAX_BYTES : SMALL_BODY_MAX_BYTES });
      if (!parsed.ok) return parsed.response;
      body = parsed.data;
    }
    const { projectId } = await params;
    try {
      const outcome = await handler.run({
        scope: guarded.scope, branchId: projectId, actor: { kind: 'user', id: guarded.userId }, body, query: new URL(req.url).searchParams,
      });
      return Response.json(outcome, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
      console.error(`[branches] ${handler.what} of branch ${projectId} failed:`, err);
      return jsonError('branch_failed', `${handler.what} failed, nothing was written. Try again.`, 500);
    }
  };
}
