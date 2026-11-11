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
  run: (input: { scope: TenantScope; branchId: string; actor: BranchActor; body: T }) => Promise<unknown>;
}

export function reviewRoute<T>(handler: Handler<T>) {
  return async (req: Request, { params }: ReviewCtx): Promise<Response> => {
    const guarded = await guardBranchRoute(req, handler.action);
    if (!guarded.ok) return guarded.response;
    let body = undefined as T;
    if (handler.body) {
      const parsed = await parseBody(req, handler.body);
      if (!parsed.ok) return parsed.response;
      body = parsed.data;
    }
    const { projectId } = await params;
    try {
      const outcome = await handler.run({ scope: guarded.scope, branchId: projectId, actor: { kind: 'user', id: guarded.userId }, body });
      return Response.json(outcome, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
      console.error(`[branches] ${handler.what} of branch ${projectId} failed:`, err);
      return jsonError('branch_failed', `${handler.what} failed, nothing was written. Try again.`, 500);
    }
  };
}
