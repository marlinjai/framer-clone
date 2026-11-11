import 'server-only';

// src/server/siteOps/branches.ts
//
// Site branches as site operations (docs/plans/2026-11-10-site-branches.md, slice S6): what an agent's
// MCP tools run, beside the operations of ./index.ts. A branch is a hidden copy of a site's working copy
// that keeps its fork point; its id is a site id for every operation of ./index.ts (getSite, applyBatch,
// generatePage, previewUrl), so only what is about the branch itself lives here: listing, creating,
// its status against main, bringing main in, asking for review, merging and discarding.
//
// Nothing here has a write path of its own. Every operation calls the branch repository
// (src/server/sites/branches/repository.ts) or the merge service (src/server/sites/branches/merge.ts),
// the same ones the editor's routes call, as the caller the door verified: its scope in every query,
// its permission checked first, the per-company switch (SITE_BRANCHES_COMPANIES) before anything else.
// With the switch off every operation answers like a missing site, as the routes answer 404.
//
// A person's approval of a merge belongs to the caller's door (the MCP endpoint's), not here, exactly
// as for publish.

import { getPrismaClient } from '@/server/db';
import {
  BranchCannotPublishError,
  BranchClosedError,
  BranchConflictsError,
  BranchLimitError,
  BranchMergeInvalidError,
  BranchNameTakenError,
  BranchNotFoundError,
  BranchReviewStaleError,
  BranchUpdatedFirstError,
  SiteGoneError,
  SiteIsBranchError,
  SiteNotFoundError,
  SiteRepositoryError,
} from '@/server/sites';
import { getSiteBranchRepository, type BranchActor, type BranchSummary, type SiteBranchRepository } from '@/server/sites/branches/repository';
import { getSiteBranchMergeService, type BranchReview, type SiteBranchMergeService } from '@/server/sites/branches/merge';
import { siteBranchesEnabled } from '@/server/sites/branches/switch';
import { MAX_OPEN_BRANCHES_PER_SITE } from '@/lib/sites/branches';
import type { DocumentChanges, MergeAnswers, MergeSide } from '@/lib/siteMerge';
import type { SiteOpsAction, SiteOpsCaller } from '@/lib/siteOps/types';
import { recordSiteOperation, type AuditEntry } from './audit';

/** The message every failure this library did not word itself gets; the cause is in the server log. */
export const GENERIC_BRANCH_FAILURE = 'the branch operation failed unexpectedly; call branch_status again before retrying';

/** Conflicts one answer lists. A branch with more says how many there are; answering some shows the next. */
export const CONFLICTS_LISTED = 50;
/** Answers one update takes. */
export const ANSWERS_PER_UPDATE = 200;

export interface BranchOpsDeps {
  branches?: Pick<SiteBranchRepository, 'listBranches' | 'createBranch' | 'getBranch' | 'siteBranchContext' | 'setBranchReady' | 'discardBranch'>;
  merges?: Pick<SiteBranchMergeService, 'changes' | 'update' | 'merge'>;
  /** The editor's host, for preview and review links (defaults to EDITOR_HOST). */
  editorHost?: string | null;
  /** Whether branches are on for a company (defaults to the SITE_BRANCHES_COMPANIES switch). */
  enabled?: (companyId: string) => boolean;
  /** Writes the audit row of an operation that changed something (defaults to the audit table). */
  audit?: (caller: SiteOpsCaller, entry: AuditEntry) => Promise<void>;
}

/** A refusal: a code an agent acts on, a message that says what to do next, and what the code carries. */
export interface BranchOpsError {
  code:
    | 'forbidden'
    | 'unavailable'
    | 'site_not_found'
    | 'invalid_request'
    | 'not_a_branch'
    | 'site_is_branch'
    | 'branch_closed'
    | 'branch_limit'
    | 'branch_name_taken'
    | 'branch_review_stale'
    | 'branch_conflicts'
    | 'branch_updated_from_main'
    | 'branch_merge_invalid'
    | 'branch_cannot_publish'
    | 'failed';
  message: string;
  [detail: string]: unknown;
}

export type BranchOpsResult<T> = { ok: true; value: T } | { ok: false; error: BranchOpsError };

const ok = <T>(value: T): BranchOpsResult<T> => ({ ok: true, value });
const fail = <T = never>(error: BranchOpsError): BranchOpsResult<T> => ({ ok: false, error });

/** Whether branches are on for the caller's company. */
export function branchesEnabledFor(caller: Pick<SiteOpsCaller, 'companyId'>, deps: BranchOpsDeps = {}): boolean {
  return (deps.enabled ?? ((companyId: string) => siteBranchesEnabled(companyId)))(caller.companyId);
}

const branches = (deps: BranchOpsDeps) => deps.branches ?? getSiteBranchRepository();
const merges = (deps: BranchOpsDeps) => deps.merges ?? getSiteBranchMergeService();
const actorOf = (caller: SiteOpsCaller): BranchActor => ({ kind: caller.actor.kind, id: caller.actor.id });
const missing = (id: string): BranchOpsResult<never> => fail({ code: 'site_not_found', message: `no site or branch "${id}" for this caller` });

/** The switch, then the permission: a company without branches learns nothing about them, a caller without the right is told so. */
async function entry(caller: SiteOpsCaller, action: SiteOpsAction, id: string, deps: BranchOpsDeps): Promise<BranchOpsResult<true>> {
  if (!branchesEnabledFor(caller, deps)) return missing(id);
  let allowed = false;
  try {
    allowed = await caller.can(action);
  } catch (err) {
    // A permission service that cannot answer is an outage, never a "no" and never a "yes".
    console.error(`[site-ops] permission check for ${action} failed`, err instanceof Error ? err.name : err);
    return fail({ code: 'unavailable', message: 'the permission check could not be made; try again', retryAfterSec: 5 });
  }
  if (allowed) return ok(true);
  return fail({ code: 'forbidden', message: `this caller may not ${action === 'mergeBranch' ? 'merge branches into their site' : action}` });
}

/** A thrown repository error as the refusal an agent acts on. The repository's own wording speaks to an editor tab. */
function fromError(err: unknown, id: string): BranchOpsResult<never> {
  if (err instanceof BranchClosedError) {
    return fail({
      code: 'branch_closed',
      message: `branch "${id}" was ${err.branchStatus} and is closed: nothing can be read from or written to it.${err.branchStatus === 'merged' ? ` Its work is on its site, "${err.mainSiteId}".` : ` Its site is "${err.mainSiteId}".`}`,
      branchStatus: err.branchStatus,
      siteId: err.mainSiteId,
    });
  }
  if (err instanceof BranchNotFoundError || err instanceof SiteNotFoundError || err instanceof SiteGoneError) return missing(id);
  if (err instanceof BranchReviewStaleError) {
    return fail({
      code: 'branch_review_stale',
      message: 'main or the branch changed since that token was read; nothing was written. Call branch_status again and use its token',
    });
  }
  if (err instanceof BranchConflictsError) {
    return fail({
      code: 'branch_conflicts',
      message: `${err.conflicts.length} conflict(s) with main need an answer before the branch can be updated; nothing was written to the branch.${err.answersKept ? ' The answers given so far were kept.' : ' The answers given were not kept, because main or the branch changed meanwhile.'} Answer each with update_branch (answers), or leave them to the person in the review`,
      conflicts: err.conflicts.slice(0, CONFLICTS_LISTED),
      conflictsTotal: err.conflicts.length,
      token: err.token,
      answersKept: err.answersKept,
    });
  }
  if (err instanceof BranchUpdatedFirstError) {
    return fail({
      code: 'branch_updated_from_main',
      message:
        'main had changed, so the branch was updated from main first and nothing was merged. The branch has a new version: look at it again (branch_status, preview_url), then ask for the merge with the new token',
      token: err.token,
    });
  }
  if (err instanceof BranchMergeInvalidError) {
    return fail({
      code: 'branch_merge_invalid',
      message: `the result would not be a valid site, so nothing was written: ${err.problems.map((p) => p.message).slice(0, 3).join('; ')}. Fix these on the branch with apply_batch (or pick the other side of a conflict), then call branch_status and try again`,
      problems: err.problems.slice(0, CONFLICTS_LISTED),
      ...(err.answersKept === undefined ? {} : { answersKept: err.answersKept }),
    });
  }
  if (err instanceof BranchLimitError) {
    return fail({ code: 'branch_limit', message: `a site has at most ${err.limit} open branches; one must be merged or discarded first`, limit: err.limit });
  }
  if (err instanceof BranchNameTakenError) return fail({
      code: 'branch_name_taken',
      message:
        'an open branch of this site already has that name. If an earlier create_branch of yours got no answer, list_branches shows it: it may be the branch you just made, so continue on it. Otherwise pick another name',
    });
  if (err instanceof SiteIsBranchError) {
    return fail({ code: 'site_is_branch', message: `"${id}" is itself a branch: a branch is made from a site, never from a branch` });
  }
  if (err instanceof BranchCannotPublishError) {
    return fail({ code: 'branch_cannot_publish', message: 'a branch is never published: merge it into its site, then publish the site' });
  }
  if (err instanceof SiteRepositoryError && err.status === 400) return fail({ code: 'invalid_request', message: err.message });
  if (err instanceof SiteRepositoryError && err.code === 'erased_since_load') {
    return fail({
      code: 'failed',
      message: 'personal data was erased from this site meanwhile, so nothing was written. Call branch_status again and redo the step on what it answers',
    });
  }
  // The error's own text (a database driver's, say) stays in the server log.
  console.error('[site-ops] unexpected branch failure', err);
  return fail({ code: 'failed', message: GENERIC_BRANCH_FAILURE });
}

/**
 * A refusal of an operation that takes a branch id: when the id is not a branch but a site of the caller,
 * say so (`not_a_branch`) instead of "no such site or branch", so an agent that mixed the two ids up knows.
 */
async function fromBranchIdError(err: unknown, caller: SiteOpsCaller, id: string, deps: BranchOpsDeps): Promise<BranchOpsResult<never>> {
  const refusal = fromError(err, id);
  if (refusal.ok || refusal.error.code !== 'site_not_found') return refusal;
  try {
    const context = await branches(deps).siteBranchContext(caller.scope, id);
    if (context.kind === 'main') return notABranch(id);
  } catch {
    // Not the caller's, or gone: the refusal above stands.
  }
  return refusal;
}

/** Write an audit row; a failure is logged loudly but never undoes a write that committed. */
async function audit(caller: SiteOpsCaller, deps: BranchOpsDeps, entryRow: AuditEntry): Promise<void> {
  try {
    await (deps.audit ?? ((c, e) => recordSiteOperation(getPrismaClient(), c, e)))(caller, entryRow);
  } catch (err) {
    console.error(`[site-ops] audit row for ${entryRow.operation} on ${entryRow.siteId} could not be written`, err);
  }
}

// ---------- what an answer shows of a branch ----------

/**
 * A branch as an agent reads it. Who made it is told as a kind and whether it was this caller, never as a
 * person's id; the review note is the person's own words to the author and is passed on as data.
 */
export interface BranchView {
  branchId: string;
  /** The site this is a branch of (main). */
  siteId: string;
  name: string;
  status: BranchSummary['status'];
  /** The branch's own version, which every write to it names as expectedVersion; null once closed. */
  version: number | null;
  /** Main's version at the fork or the last update from main; null once closed. */
  baseVersion: number | null;
  /** Whether main changed since then: update_branch brings those changes in. */
  mainMoved: boolean;
  /** Whether a person approved the branch as it is now. */
  approved: boolean;
  reviewNote: string | null;
  createdByKind: 'user' | 'key';
  /** Whether this caller made it (an agent may discard only such a branch). */
  createdByCaller: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  discardedAt: string | null;
}

function viewOf(summary: BranchSummary, caller: SiteOpsCaller): BranchView {
  return {
    branchId: summary.branchId,
    siteId: summary.mainSiteId,
    name: summary.name,
    status: summary.status,
    version: summary.version,
    baseVersion: summary.baseVersion,
    mainMoved: summary.mainMoved,
    approved: summary.approved,
    reviewNote: summary.reviewNote,
    createdByKind: summary.createdByKind,
    createdByCaller: summary.createdByKind === caller.actor.kind && summary.createdBy === caller.actor.id,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    mergedAt: summary.mergedAt?.toISOString() ?? null,
    discardedAt: summary.discardedAt?.toISOString() ?? null,
  };
}

function links(branchId: string, deps: BranchOpsDeps): { previewUrl: string; reviewUrl: string } {
  const host = (deps.editorHost !== undefined ? deps.editorHost : process.env.EDITOR_HOST)?.trim();
  const base = `${host ? `https://${host}` : ''}/projects/${encodeURIComponent(branchId)}`;
  return { previewUrl: `${base}/preview`, reviewUrl: `${base}/review` };
}

function changeCount(changes: DocumentChanges): number {
  return (
    changes.site.length +
    changes.settings.length +
    changes.pages.added.length +
    changes.pages.removed.length +
    changes.pages.changed.length +
    changes.components.added.length +
    changes.components.removed.length +
    changes.components.changed.length +
    changes.nodes.added +
    changes.nodes.removed +
    changes.nodes.changed +
    (changes.pageOrder ? 1 : 0)
  );
}

// ---------- the operations ----------

export interface BranchListing {
  siteId: string;
  /** Main's current version. */
  version: number;
  openLimit: number;
  open: BranchView[];
  /** The most recently merged or discarded ones, without content. */
  closed: BranchView[];
}

/** A site's branches: the open ones, then the most recently closed. */
export async function listBranches(caller: SiteOpsCaller, input: { siteId: string }, deps: BranchOpsDeps = {}): Promise<BranchOpsResult<BranchListing>> {
  const allowed = await entry(caller, 'viewSite', input.siteId, deps);
  if (!allowed.ok) return allowed;
  try {
    const list = await branches(deps).listBranches(caller.scope, input.siteId);
    return ok({
      siteId: list.mainSiteId,
      version: list.mainVersion,
      openLimit: MAX_OPEN_BRANCHES_PER_SITE,
      open: list.open.map((b) => viewOf(b, caller)),
      closed: list.closed.map((b) => viewOf(b, caller)),
    });
  } catch (err) {
    if (err instanceof SiteIsBranchError) {
      const of = await branchOfSite(caller, { siteId: input.siteId }, deps);
      const mainSiteId = of.ok && of.value ? of.value.mainSiteId : undefined;
      return fail({
        code: 'site_is_branch',
        message: `"${input.siteId}" is itself a branch; branches are listed on their site${mainSiteId ? `, "${mainSiteId}"` : ''}`,
        ...(mainSiteId ? { siteId: mainSiteId } : {}),
      });
    }
    return fromError(err, input.siteId);
  }
}

export interface BranchCreated {
  branch: BranchView;
  /** The branch's id: a site id for every read and write tool. */
  branchId: string;
  /** The branch's version, for the first write to it. */
  version: number | null;
  previewUrl: string;
}

/** Make a branch of a site: a copy of its working copy as stored now, with that moment kept as the fork point. */
export async function createBranch(
  caller: SiteOpsCaller,
  input: { siteId: string; name: string },
  deps: BranchOpsDeps = {},
): Promise<BranchOpsResult<BranchCreated>> {
  const allowed = await entry(caller, 'editSite', input.siteId, deps);
  if (!allowed.ok) return allowed;
  try {
    const { branch } = await branches(deps).createBranch(caller.scope, input.siteId, { name: input.name, actor: actorOf(caller) });
    await audit(caller, deps, { siteId: branch.mainSiteId, operation: 'branch_create', branchId: branch.branchId, versionBefore: branch.baseVersion ?? undefined });
    return ok({ branch: viewOf(branch, caller), branchId: branch.branchId, version: branch.version, previewUrl: links(branch.branchId, deps).previewUrl });
  } catch (err) {
    return fromError(err, input.siteId);
  }
}

export interface BranchStatus {
  branch: BranchView;
  /** Names the state this answer was computed from; update_branch and merge_branch take it and are refused when it is stale. */
  token: string;
  /** Whether the branch holds everything main has: only then can it be merged. */
  upToDate: boolean;
  /** How many things the branch changes against its fork point, and what kind. */
  changeCount: number;
  branchChanges: DocumentChanges;
  /** What main changed since the fork point; null when up to date. */
  mainChanges: DocumentChanges | null;
  /** Conflicts of bringing main in that still need an answer (at most CONFLICTS_LISTED of conflictsTotal). */
  conflicts: BranchReview['conflicts'];
  conflictsTotal: number;
  /** Conflicts already answered, by id and the side picked. */
  settled: Array<{ id: string; pick: MergeSide }>;
  /** Why the result would not be a valid site, once no conflict is open. */
  problems: BranchReview['problems'];
  /** Whether a merge would go through as things are: up to date, something changed, no conflict, no problem. */
  mergeable: boolean;
  previewUrl: string;
  reviewUrl: string;
}

function statusOf(review: BranchReview, caller: SiteOpsCaller, deps: BranchOpsDeps): BranchStatus {
  const count = changeCount(review.branchChanges);
  return {
    branch: viewOf(review.branch, caller),
    token: review.token,
    upToDate: review.upToDate,
    changeCount: count,
    branchChanges: review.branchChanges,
    mainChanges: review.mainChanges,
    conflicts: review.conflicts.slice(0, CONFLICTS_LISTED),
    conflictsTotal: review.conflicts.length,
    settled: review.settled.map((s) => ({ id: s.id, pick: s.pick })),
    problems: review.problems.slice(0, CONFLICTS_LISTED),
    mergeable: review.upToDate && count > 0 && review.conflicts.length === 0 && review.problems.length === 0,
    ...links(review.branch.branchId, deps),
  };
}

/** What a branch changes against main, whether main moved, and the conflicts of bringing main in. */
export async function branchStatus(caller: SiteOpsCaller, input: { branchId: string }, deps: BranchOpsDeps = {}): Promise<BranchOpsResult<BranchStatus>> {
  const allowed = await entry(caller, 'viewSite', input.branchId, deps);
  if (!allowed.ok) return allowed;
  try {
    return ok(statusOf(await merges(deps).changes(caller.scope, input.branchId), caller, deps));
  } catch (err) {
    return fromBranchIdError(err, caller, input.branchId, deps);
  }
}

export interface BranchAnswer {
  conflictId: string;
  fingerprint: string;
  pick: MergeSide;
}

export interface BranchUpdated {
  /** False when the branch already held everything main has: nothing was written. */
  updated: boolean;
  branch: BranchView;
  /** The branch's version after the update, for the next write to it. */
  version: number | null;
  token: string;
}

/**
 * Bring main's changes into the branch. Writes only when no conflict is left open and the result is a valid
 * site; otherwise the answers that applied are kept and the refusal lists what is left.
 */
export async function updateBranch(
  caller: SiteOpsCaller,
  input: { branchId: string; token: string; answers?: BranchAnswer[] },
  deps: BranchOpsDeps = {},
): Promise<BranchOpsResult<BranchUpdated>> {
  const allowed = await entry(caller, 'editSite', input.branchId, deps);
  if (!allowed.ok) return allowed;
  const resolutions: Record<string, { fingerprint: string; pick: MergeSide }> = {};
  for (const answer of input.answers ?? []) resolutions[answer.conflictId] = { fingerprint: answer.fingerprint, pick: answer.pick };
  try {
    // The merge service writes the audit row of an update itself, in the update's transaction.
    const outcome = await merges(deps).update(caller.scope, input.branchId, { token: input.token, resolutions: resolutions as MergeAnswers }, actorOf(caller));
    return ok({ updated: outcome.updated, branch: viewOf(outcome.branch, caller), version: outcome.branch.version, token: outcome.token });
  } catch (err) {
    return fromBranchIdError(err, caller, input.branchId, deps);
  }
}

export interface BranchReviewRequested {
  branch: BranchView;
  previewUrl: string;
  reviewUrl: string;
}

/** Mark the branch ready for review and answer the links a person opens. The branch stays editable. */
export async function requestReview(
  caller: SiteOpsCaller,
  input: { branchId: string },
  deps: BranchOpsDeps = {},
): Promise<BranchOpsResult<BranchReviewRequested>> {
  const allowed = await entry(caller, 'editSite', input.branchId, deps);
  if (!allowed.ok) return allowed;
  try {
    const context = await branches(deps).siteBranchContext(caller.scope, input.branchId);
    if (context.kind !== 'branch') return notABranch(input.branchId);
    const was = context.branch.status;
    const branch = await branches(deps).setBranchReady(caller.scope, context.mainSiteId, input.branchId, true, actorOf(caller));
    if (was !== 'ready') await audit(caller, deps, { siteId: context.mainSiteId, operation: 'branch_review', branchId: input.branchId });
    return ok({ branch: viewOf(branch, caller), ...links(input.branchId, deps) });
  } catch (err) {
    return fromError(err, input.branchId);
  }
}

const notABranch = (id: string): BranchOpsResult<never> =>
  fail({ code: 'not_a_branch', message: `"${id}" is a site, not a branch; list_branches shows a site's branches` });

export interface BranchMerged {
  /** False when the branch had been merged before this call: this answers that merge's result, nothing was written again. */
  merged: boolean;
  branch: BranchView;
  /** The site the branch was merged into. */
  siteId: string;
  /** The site's version after the merge. */
  version: number;
}

/**
 * Merge the branch into its site: the site's working copy becomes the branch's content as one new version,
 * and the branch is closed. Nothing is published. A branch behind main is updated from main instead and
 * nothing is merged (`branch_updated_from_main`, or `branch_conflicts` when that needs answers).
 */
export async function mergeBranch(
  caller: SiteOpsCaller,
  input: { branchId: string; token: string },
  deps: BranchOpsDeps = {},
): Promise<BranchOpsResult<BranchMerged>> {
  const allowed = await entry(caller, 'mergeBranch', input.branchId, deps);
  if (!allowed.ok) return allowed;
  try {
    // The merge service writes the audit row of a merge itself, in the merge's transaction.
    const outcome = await merges(deps).merge(caller.scope, input.branchId, { token: input.token }, actorOf(caller));
    return ok({ merged: outcome.merged, branch: viewOf(outcome.branch, caller), siteId: outcome.branch.mainSiteId, version: outcome.mainVersion });
  } catch (err) {
    return fromBranchIdError(err, caller, input.branchId, deps);
  }
}

export interface BranchDiscarded {
  discarded: boolean;
  branch: BranchView;
}

/**
 * Discard a branch: its content is deleted, its record stays as discarded. A key may discard only a branch
 * that key created (an agent cleans up its own work, never a person's or another agent's); a person's own
 * door decides for a person.
 */
export async function discardBranch(
  caller: SiteOpsCaller,
  input: { branchId: string },
  deps: BranchOpsDeps = {},
): Promise<BranchOpsResult<BranchDiscarded>> {
  const allowed = await entry(caller, 'editSite', input.branchId, deps);
  if (!allowed.ok) return allowed;
  try {
    const context = await branches(deps).siteBranchContext(caller.scope, input.branchId);
    if (context.kind !== 'branch') return notABranch(input.branchId);
    if (caller.actor.kind === 'key' && !(context.branch.createdByKind === 'key' && context.branch.createdBy === caller.actor.id)) {
      return fail({
        code: 'forbidden',
        message: 'this key did not create that branch, so it may not discard it; ask the person to discard it in the editor',
      });
    }
    const outcome = await branches(deps).discardBranch(caller.scope, context.mainSiteId, input.branchId, actorOf(caller));
    if (outcome.discarded) await audit(caller, deps, { siteId: context.mainSiteId, operation: 'branch_discard', branchId: input.branchId });
    return ok({ discarded: outcome.discarded, branch: viewOf(outcome.branch, caller) });
  } catch (err) {
    // A repeat of a discard (the first answer was lost): the same outcome, for the caller that may discard it.
    if (err instanceof BranchClosedError && err.branchStatus === 'discarded') {
      try {
        const record = await branches(deps).getBranch(caller.scope, err.mainSiteId, input.branchId);
        const own = caller.actor.kind !== 'key' || (record.createdByKind === 'key' && record.createdBy === caller.actor.id);
        if (own) return ok({ discarded: false, branch: viewOf(record, caller) });
      } catch {
        // Falls through to the closed refusal.
      }
    }
    return fromError(err, input.branchId);
  }
}

/**
 * Whether `siteId` is an open branch, for the doors that must refuse one before they ask a person anything
 * (publish, rollback). Answers the branch's site when it is; null for a site. Independent of the switch: a
 * branch made while it was on is still a branch when it is off.
 */
export async function branchOfSite(
  caller: SiteOpsCaller,
  input: { siteId: string },
  deps: BranchOpsDeps = {},
): Promise<BranchOpsResult<{ mainSiteId: string } | null>> {
  try {
    const context = await branches(deps).siteBranchContext(caller.scope, input.siteId);
    return ok(context.kind === 'branch' ? { mainSiteId: context.mainSiteId } : null);
  } catch (err) {
    return fromError(err, input.siteId);
  }
}
