import 'server-only';

// src/server/sites/branches/merge.ts
//
// A branch's review, its update from main and its merge into main (docs/plans/2026-11-10-site-branches.md,
// sections 5 and 6, slice S3).
//
// - changes: what the branch changed since its fork point, what main changed meanwhile, the conflicts of
//   bringing main in with the answers given so far, and a `token` over the state they were computed from.
// - update: brings main into the branch by the three-way merge (`src/lib/siteMerge`). It writes only when no
//   conflict is open; otherwise it keeps the answers that still apply and says what is left.
// - approve and send back: the reviewer's verdict on the version the token names.
// - merge: only for a branch whose fork point is main's current version, and then main becomes the branch's
//   content, written through the save's own write under main's version lock. A branch behind main is updated
//   first instead (decision 16), and the merge stops there: the branch's version moved, so the review is shown
//   again. A merged branch answers a repeated merge with the first one's result.
//
// The token is over every version and name the result depends on. The site name is the one part of the
// working copy whose writer (a rename) moves no version, so the names are in the token too.
//
// Compute outside, verify inside: the documents are read in one REPEATABLE READ snapshot and merged and
// checked outside any lock (a merge of a large site is slow). The write then locks main's row and the branch's,
// in that order, re-reads the token's state and writes only when it is unchanged, SERIALIZABLE as a save, so
// a failure at any step leaves both sites and the record as they were.

import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  diffDocuments,
  mergeDocuments,
  mergedDocumentProblems,
  type DocumentChanges,
  type MergeAnswers,
  type MergeConflict,
  type MergeDocument,
  type MergeSide,
} from '@/lib/siteMerge';
import { stableStringify } from '@/lib/ai/serializers/normalize';
// A conflict value larger than 4,096 characters (as JSON) is shown as its size: a removed page is a whole page.
import { reviewDocuments, shownValue, type DocumentReview } from '@/lib/siteMerge/elementChanges';
import { getPrismaClient } from '@/server/db';
import {
  BranchClosedError,
  BranchConflictsError,
  BranchMergeInvalidError,
  BranchReviewStaleError,
  BranchUpdatedFirstError,
  InvalidTenantScopeError,
  SiteNotFoundError,
} from '../errors';
import { announceWrite, getSiteRepository, type SiteRepository, type TenantScope, type WorkingCopyWrite } from '../repository';
import { buildRevisionDocument, parseRevisionDocument } from '../revision';
import type { PersistedSite } from '../snapshot';
import { forgetBranchContent, SiteBranchRepository, type BranchActor, type BranchSummary } from './repository';
import { persistedFor, reviewDocument, revisionRow, SITE_DOCUMENT_SELECT, toProjectSnapshot, type SiteDocumentRow } from './documents';

/** How long main's copy from before a merge is kept for "Undo this merge" (S7). */
export const MAIN_BEFORE_KEPT_DAYS = 30;
/** A draft holds at most this many answers; a review asks far fewer. */
export const MERGE_DRAFT_MAX_ANSWERS = 2_000;
/** A note sent back with a branch. */
export const REVIEW_NOTE_MAX_LENGTH = 2_000;

const ID_MAX = 512;
/** Answers stored at the same moment are retried this often before the review is called stale. */
const ANSWER_ATTEMPTS = 5;
const FINGERPRINT_MAX = 128;

/** Copying a site at the 10 MB limit, page by page, fits in this, as a branch create. */
const WRITE_TRANSACTION = { maxWait: 5_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
const SERIALIZATION_ATTEMPTS = 4;

/** A step a test can make fail just before the commit (the plan's injected failure at the last write). */
export interface BranchMergeHooks {
  beforeCommit?: (tx: Prisma.TransactionClient, step: 'update' | 'merge') => Promise<void>;
}

/** A conflict as the review shows it: large values replaced by their size. */
export interface ShownConflict extends Omit<MergeConflict, 'base' | 'main' | 'branch'> {
  base: unknown;
  main: unknown;
  branch: unknown;
}

export interface BranchReview {
  branch: BranchSummary;
  token: string;
  /** Whether the branch's fork point is main's current version: merging is then a plain write. */
  upToDate: boolean;
  /** What the branch changed since its fork point. */
  branchChanges: DocumentChanges;
  /** What main changed since the fork point; null when up to date. */
  mainChanges: DocumentChanges | null;
  /** Conflicts of bringing main in that still need an answer; empty when up to date. */
  conflicts: ShownConflict[];
  /** Conflicts an answer in the draft settles, with the side picked and the values, so the answer can be changed. */
  settled: Array<{ id: string; pick: MergeSide; conflict: ShownConflict }>;
  /** What the branch changes since its fork point, per page and element, with old and new values (the change list). */
  review: DocumentReview;
  /** The versions the review was computed from: a page drawn from older reads reloads (S5). */
  versions: { main: number; branch: number };
  /** Why the result would not be a valid site, once no conflict is open. */
  problems: Array<{ code: string; message: string; pageId?: string; componentId?: string }>;
}

export type BranchUpdateOutcome = { updated: boolean; branch: BranchSummary; token: string };
export type BranchMergeOutcome = { merged: boolean; branch: BranchSummary; mainVersion: number };

/** The state a token is over: read cheaply, without the documents. */
interface Stamp {
  mainId: string;
  branchId: string;
  status: 'open' | 'ready' | 'merged' | 'discarded';
  recordName: string;
  baseVersion: number | null;
  mainVersion: number;
  mainName: string;
  mainEpoch: number;
  branchVersion: number | null;
  branchName: string | null;
  branchEpoch: number | null;
  mergeDraft: Prisma.JsonValue;
  mergedMainVersion: number | null;
}

/** A stamp of an open branch, with the three documents read in the same snapshot. */
interface ReviewState {
  stamp: Stamp & { branchVersion: number; branchName: string; branchEpoch: number; baseVersion: number };
  mainRow: SiteDocumentRow;
  branchRow: SiteDocumentRow;
  base: MergeDocument;
  main: MergeDocument;
  branch: MergeDocument;
}

function assertScope(scope: TenantScope): void {
  if (!scope || !scope.workspaceId || !scope.tenantGroupId) throw new InvalidTenantScopeError();
}

/** The token over the versions and names a review's result depends on. Not a secret: the server rechecks it. */
export function reviewToken(stamp: Pick<Stamp, 'baseVersion' | 'mainVersion' | 'mainName' | 'mainEpoch' | 'branchVersion' | 'branchName' | 'branchEpoch'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([stamp.baseVersion, stamp.mainVersion, stamp.mainName, stamp.mainEpoch, stamp.branchVersion, stamp.branchName, stamp.branchEpoch]),
    )
    .digest('base64url')
    .slice(0, 32);
}

/** A draft's answers, read defensively: anything malformed (or a draft from before this shape) reads as none. */
export function draftAnswers(raw: Prisma.JsonValue | null | undefined): Record<string, { fingerprint: string; pick: MergeSide }> {
  const out: Record<string, { fingerprint: string; pick: MergeSide }> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const answers = (raw as Record<string, unknown>).answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return out;
  let n = 0;
  for (const [id, answer] of Object.entries(answers)) {
    if (++n > MERGE_DRAFT_MAX_ANSWERS) break;
    if (id.length > ID_MAX || typeof answer !== 'object' || answer === null) continue;
    const { fingerprint, pick } = answer as Record<string, unknown>;
    if (typeof fingerprint !== 'string' || fingerprint.length > FINGERPRINT_MAX) continue;
    if (pick !== 'main' && pick !== 'branch') continue;
    out[id] = { fingerprint, pick };
  }
  return out;
}

function draftOf(answers: Record<string, { fingerprint: string; pick: MergeSide }>): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return Object.keys(answers).length === 0 ? Prisma.DbNull : ({ v: 1, answers } as Prisma.InputJsonValue);
}


function shown(conflict: MergeConflict): ShownConflict {
  return { ...conflict, base: shownValue(conflict.base), main: shownValue(conflict.main), branch: shownValue(conflict.branch) };
}

/** Text a person typed, for storing: control and bidirectional characters removed, trimmed, bounded. */
function cleanNote(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g, '').trim();
  return Array.from(cleaned).slice(0, REVIEW_NOTE_MAX_LENGTH).join('');
}

async function withSerializationRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      // P2034 from a Prisma query; a raw query (the row locks) reports Postgres' 40001 as P2010.
      const conflict =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === 'P2034' || (err.code === 'P2010' && (err.meta as { code?: unknown } | undefined)?.code === '40001'));
      if (!conflict || attempt >= SERIALIZATION_ATTEMPTS) throw err;
    }
  }
}

export class SiteBranchMergeService {
  private readonly branches: SiteBranchRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sites: SiteRepository,
    private readonly hooks: BranchMergeHooks = {},
  ) {
    this.branches = new SiteBranchRepository(prisma);
  }

  /**
   * The stamp of a branch, resolved through the caller's workspace: the record by its id, its main by the
   * record (in the scope's tenant group, and a main site), the content row by both. Anything of another
   * workspace, or missing, is a missing site (404).
   */
  private async stamp(client: Prisma.TransactionClient | PrismaClient, scope: TenantScope, branchId: string): Promise<Stamp> {
    const record = await client.siteBranch.findFirst({
      where: { id: branchId, workspaceId: scope.workspaceId },
      select: { siteId: true, status: true, name: true, baseVersion: true, mergeDraft: true, mergedMainVersion: true },
    });
    if (!record) throw new SiteNotFoundError(branchId);
    const main = await client.site.findFirst({
      where: { id: record.siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, branchOfSiteId: null },
      select: { id: true, version: true, name: true, erasureEpoch: true },
    });
    if (!main) throw new SiteNotFoundError(branchId);
    const branch =
      record.status === 'open' || record.status === 'ready'
        ? await client.site.findFirst({
            where: { id: branchId, workspaceId: scope.workspaceId, branchOfSiteId: main.id },
            select: { version: true, name: true, erasureEpoch: true },
          })
        : null;
    return {
      mainId: main.id,
      branchId,
      status: record.status,
      recordName: record.name,
      baseVersion: record.baseVersion,
      mainVersion: main.version,
      mainName: main.name,
      mainEpoch: main.erasureEpoch,
      branchVersion: branch?.version ?? null,
      branchName: branch?.name ?? null,
      branchEpoch: branch?.erasureEpoch ?? null,
      mergeDraft: record.mergeDraft,
      mergedMainVersion: record.mergedMainVersion,
    };
  }

  /** Throws BranchClosedError (410) for a closed branch; narrows to an open one. */
  private open(stamp: Stamp): asserts stamp is Stamp & { branchVersion: number; branchName: string; branchEpoch: number; baseVersion: number } {
    if (stamp.status === 'merged' || stamp.status === 'discarded') throw new BranchClosedError(stamp.status, stamp.mainId);
    if (stamp.branchVersion === null || stamp.baseVersion === null) throw new BranchClosedError('discarded', stamp.mainId);
  }

  /** The stamp and the three documents, in one snapshot. */
  private async readState(scope: TenantScope, branchId: string): Promise<ReviewState> {
    const read = await this.prisma.$transaction(
      async (tx) => {
        const stamp = await this.stamp(tx, scope, branchId);
        this.open(stamp);
        const [mainRow, branchRow, record] = await Promise.all([
          tx.site.findFirst({ where: { id: stamp.mainId, workspaceId: scope.workspaceId }, select: SITE_DOCUMENT_SELECT }),
          tx.site.findFirst({ where: { id: branchId, workspaceId: scope.workspaceId }, select: SITE_DOCUMENT_SELECT }),
          tx.siteBranch.findFirst({ where: { id: branchId, workspaceId: scope.workspaceId }, select: { baseDocument: true } }),
        ]);
        if (!mainRow || !branchRow || !record?.baseDocument) throw new BranchClosedError('discarded', stamp.mainId);
        return { stamp, mainRow, branchRow, baseDocument: record.baseDocument };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 30_000 },
    );
    const { stamp, mainRow, branchRow } = read;
    this.open(stamp);
    const fork = parseRevisionDocument(read.baseDocument);
    return {
      stamp,
      mainRow,
      branchRow,
      base: reviewDocument(revisionRow(stamp.mainId, fork, stamp.mainEpoch), 'base'),
      main: reviewDocument(mainRow, 'main'),
      branch: reviewDocument(branchRow, 'branch'),
    };
  }

  /**
   * Whether main is what the branch was forked from (or last updated from): its version, and its name, which a
   * rename changes without a version (decision 37). A branch whose main was only renamed is behind too, so the
   * update asks when both renamed, never dropping one name silently.
   */
  private upToDate(state: Pick<ReviewState, 'stamp' | 'main' | 'base'>): boolean {
    return state.stamp.baseVersion === state.stamp.mainVersion && state.main.name === state.base.name;
  }

  /** Bringing main into the branch with these answers: the merge, and once nothing is open, its validity. */
  private bringMainIn(state: ReviewState, answers: MergeAnswers) {
    const merge = mergeDocuments(state.base, state.main, state.branch, answers);
    const problems = merge.conflicts.length === 0 ? mergedDocumentProblems(merge.document, state.branch, toProjectSnapshot) : [];
    return { merge, problems };
  }

  /**
   * The answers that applied in this run replace the draft, when the draft is still what was read: an answer
   * whose conflict changed or vanished is gone for good, and does not come back when a value flips back.
   */
  /**
   * `checked`: confirm under the locks even when nothing changes, so the answer says whether the answers are
   * stored now (an erase may have cleared the draft since the read). The review read takes the fast path.
   */
  private async keepDraft(
    scope: TenantScope,
    stamp: Stamp,
    kept: Record<string, { fingerprint: string; pick: MergeSide }>,
    checked = false,
  ): Promise<boolean> {
    const same = stableStringify(draftAnswers(stamp.mergeDraft)) === stableStringify(kept);
    if (same && !checked) return true;
    return this.prisma.$transaction(async (tx) => {
      await this.lockPair(tx, scope, stamp);
      const now = await this.stamp(tx, scope, stamp.branchId);
      if (reviewToken(now) !== reviewToken(stamp) || stableStringify(now.mergeDraft) !== stableStringify(stamp.mergeDraft)) return false;
      if (same) return true;
      await tx.siteBranch.update({ where: { id: stamp.branchId }, data: { mergeDraft: draftOf(kept) } });
      return true;
    });
  }

  /** Main's row lock, then the branch's, both scoped (decision 28). */
  private async lockPair(tx: Prisma.TransactionClient, scope: TenantScope, stamp: Pick<Stamp, 'mainId' | 'branchId'>): Promise<void> {
    await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${stamp.mainId} AND workspace_id = ${scope.workspaceId} AND tenant_group_id = ${scope.tenantGroupId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${stamp.branchId} AND workspace_id = ${scope.workspaceId} AND branch_of_site_id = ${stamp.mainId} FOR UPDATE`;
  }

  /** Under the locks: the state must still be the one the work was computed from. */
  private async verify(tx: Prisma.TransactionClient, scope: TenantScope, read: Stamp): Promise<Stamp> {
    await this.lockPair(tx, scope, read);
    const now = await this.stamp(tx, scope, read.branchId);
    if (now.status === 'merged' || now.status === 'discarded') return now;
    if (reviewToken(now) !== reviewToken(read)) throw new BranchReviewStaleError();
    return now;
  }

  /** The review of a branch. A read: it writes nothing but the pruning of answers that no longer apply. */
  async changes(scope: TenantScope, branchId: string): Promise<BranchReview> {
    assertScope(scope);
    const state = await this.readState(scope, branchId);
    const { stamp } = state;
    const upToDate = this.upToDate(state);
    const answers = draftAnswers(stamp.mergeDraft);
    let conflicts: ShownConflict[] = [];
    let settled: BranchReview['settled'] = [];
    let problems: BranchReview['problems'] = [];
    let kept: Record<string, { fingerprint: string; pick: MergeSide }> = {};
    if (upToDate) {
      problems = mergedDocumentProblems(state.branch, state.main, toProjectSnapshot);
    } else {
      const brought = this.bringMainIn(state, answers);
      conflicts = brought.merge.conflicts.map(shown);
      settled = brought.merge.settled.map(({ conflict, pick }) => ({ id: conflict.id, pick, conflict: shown(conflict) }));
      kept = Object.fromEntries(brought.merge.settled.map(({ conflict, pick }) => [conflict.id, { fingerprint: conflict.fingerprint, pick }]));
      problems = brought.problems;
    }
    await this.keepDraft(scope, stamp, kept);
    return {
      branch: await this.branches.getBranch(scope, stamp.mainId, branchId),
      token: reviewToken(stamp),
      upToDate,
      branchChanges: diffDocuments(state.base, state.branch),
      mainChanges: upToDate ? null : diffDocuments(state.base, state.main),
      conflicts,
      settled,
      problems,
      review: reviewDocuments(state.base, state.branch),
      versions: { main: stamp.mainVersion, branch: stamp.branchVersion },
    };
  }

  /**
   * Store conflict answers without bringing main in (slice S5): the review saves each answer as it is given, so a
   * reload, another tab or the next day finds it (section 6, "Resume"). Only answers that settle a conflict of the
   * state the token names are kept; the branch's content is not touched, and nothing is applied until Update.
   * Answers the review afresh; 409 `branch_review_stale` when the state moved (the review reloads).
   */
  async answer(scope: TenantScope, branchId: string, input: { token: string; resolutions: MergeAnswers }): Promise<BranchReview> {
    assertScope(scope);
    // The token names the documents, not the draft: another answer stored in between (a second click, another tab)
    // is laid under this one and tried again; only documents that moved make the review stale.
    for (let attempt = 1; ; attempt++) {
      const state = await this.readState(scope, branchId);
      if (reviewToken(state.stamp) !== input.token) throw new BranchReviewStaleError();
      if (this.upToDate(state)) break;
      const { merge } = this.bringMainIn(state, { ...draftAnswers(state.stamp.mergeDraft), ...input.resolutions });
      const kept = Object.fromEntries(merge.settled.map(({ conflict, pick }) => [conflict.id, { fingerprint: conflict.fingerprint, pick }]));
      // Under the locks, and only when the state is still the one read: an answer is never stored against a newer one.
      if (await this.keepDraft(scope, state.stamp, kept, true)) break;
      if (attempt >= ANSWER_ATTEMPTS) throw new BranchReviewStaleError();
    }
    return this.changes(scope, branchId);
  }

  /**
   * Bring main into the branch. `resolutions` are new answers, laid over the draft's. Writes only when no
   * conflict is left and the result is a valid site; otherwise the answers that applied are kept and the
   * request answers what is left (409 `branch_conflicts`) or why (422 `branch_merge_invalid`).
   */
  async update(
    scope: TenantScope,
    branchId: string,
    input: { token: string; resolutions?: MergeAnswers },
    actor: BranchActor,
  ): Promise<BranchUpdateOutcome> {
    assertScope(scope);
    const state = await this.readState(scope, branchId);
    if (reviewToken(state.stamp) !== input.token) throw new BranchReviewStaleError();
    return this.updateFrom(scope, state, { ...draftAnswers(state.stamp.mergeDraft), ...(input.resolutions ?? {}) }, actor);
  }

  private async updateFrom(
    scope: TenantScope,
    state: ReviewState,
    answers: MergeAnswers,
    actor: BranchActor,
  ): Promise<BranchUpdateOutcome> {
    const { stamp } = state;
    if (this.upToDate(state)) {
      return { updated: false, branch: await this.branches.getBranch(scope, stamp.mainId, stamp.branchId), token: reviewToken(stamp) };
    }
    const { merge, problems } = this.bringMainIn(state, answers);
    const kept = Object.fromEntries(merge.settled.map(({ conflict, pick }) => [conflict.id, { fingerprint: conflict.fingerprint, pick }]));
    // Stored before anything else is tried: a request refused below, or one whose write finds the state moved,
    // keeps the answers that applied, so the person never gives them twice.
    const answersKept = await this.keepDraft(scope, stamp, kept, true);
    if (merge.conflicts.length > 0) throw new BranchConflictsError(merge.conflicts.map(shown), reviewToken(stamp), answersKept);
    if (problems.length > 0) throw new BranchMergeInvalidError(problems, answersKept);

    const now = new Date();
    const persisted = persistedFor(merge.document, state.branchRow, now);
    const written = await withSerializationRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await this.verify(tx, scope, stamp);
        if (current.status === 'merged' || current.status === 'discarded') throw new BranchClosedError(current.status, current.mainId);
        const write = await this.sites.writeWorkingCopyIn(tx, scope, persisted, { mustExist: true, expectedVersion: stamp.branchVersion });
        if (merge.document.name !== stamp.branchName) {
          await tx.site.updateMany({ where: { id: stamp.branchId, workspaceId: scope.workspaceId }, data: { name: merge.document.name } });
        }
        await tx.siteBranch.update({
          where: { id: stamp.branchId },
          data: {
            baseVersion: stamp.mainVersion,
            // Main as stored (not through the model), as a create forks it: the next update compares with it.
            baseDocument: buildRevisionDocument(state.mainRow as Parameters<typeof buildRevisionDocument>[0]) as unknown as Prisma.InputJsonValue,
            mergeDraft: Prisma.DbNull,
            approvedBy: null,
            approvedAt: null,
            approvedBranchVersion: null,
          },
        });
        await tx.siteOperationAudit.create({
          data: {
            siteId: stamp.branchId,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            actorKind: actor.kind,
            actorId: actor.id,
            // Ids and versions only: the erase of personal data does not rewrite audit rows.
            actorDetail: { mainSiteId: stamp.mainId, mainVersion: stamp.mainVersion },
            operation: 'branch_update',
            versionBefore: write.versionBefore,
            versionAfter: write.version,
          },
        });
        await this.hooks.beforeCommit?.(tx, 'update');
        return write;
      }, WRITE_TRANSACTION),
    );
    this.announce(stamp.branchId, written, persisted, 'update', ['Brought in the changes from main']);
    // The token of exactly what this update wrote, never read again afterwards: a save landing after the commit
    // must not be carried into a merge unseen (section 6, "the merge names the branch version it reviewed").
    const token = reviewToken({
      baseVersion: stamp.mainVersion,
      mainVersion: stamp.mainVersion,
      mainName: stamp.mainName,
      mainEpoch: stamp.mainEpoch,
      branchVersion: written.version,
      branchName: merge.document.name,
      branchEpoch: stamp.branchEpoch,
    });
    return { updated: true, branch: await this.branches.getBranch(scope, stamp.mainId, stamp.branchId), token };
  }

  /** Approve the branch version the token names. Keeps the ready state; an edit later withdraws it. */
  async approve(scope: TenantScope, branchId: string, input: { token: string }, actor: BranchActor): Promise<BranchSummary> {
    return this.verdict(scope, branchId, input.token, (stamp) => ({
      approvedBy: actor.id,
      approvedAt: new Date(),
      approvedBranchVersion: stamp.branchVersion,
    }));
  }

  /** Send the branch back to open with a note; any approval is withdrawn. */
  async sendBack(scope: TenantScope, branchId: string, input: { token: string; note: string }): Promise<BranchSummary> {
    const note = cleanNote(input.note);
    return this.verdict(scope, branchId, input.token, () => ({
      status: 'open',
      readyBy: null,
      readyAt: null,
      reviewNote: note === '' ? null : note,
      approvedBy: null,
      approvedAt: null,
      approvedBranchVersion: null,
    }));
  }

  private async verdict(
    scope: TenantScope,
    branchId: string,
    token: string,
    data: (stamp: Stamp) => Prisma.SiteBranchUncheckedUpdateInput,
  ): Promise<BranchSummary> {
    assertScope(scope);
    const read = await this.stamp(this.prisma, scope, branchId);
    this.open(read);
    if (reviewToken(read) !== token) throw new BranchReviewStaleError();
    await this.prisma.$transaction(async (tx) => {
      const now = await this.verify(tx, scope, read);
      this.open(now);
      await tx.siteBranch.update({ where: { id: branchId }, data: data(now) });
    });
    return this.branches.getBranch(scope, read.mainId, branchId);
  }

  /**
   * Merge the branch into main. Main becomes the branch's content in one new version, never published by it.
   * A branch behind main is updated from main instead (BranchUpdatedFirstError, or BranchConflictsError when
   * that needs answers). A repeat on a merged branch answers the first merge's result (`merged: false`).
   */
  async merge(scope: TenantScope, branchId: string, input: { token: string }, actor: BranchActor): Promise<BranchMergeOutcome> {
    assertScope(scope);
    const first = await this.stamp(this.prisma, scope, branchId);
    if (first.status === 'merged') return this.mergedOutcome(scope, first);
    let state: ReviewState;
    try {
      state = await this.readState(scope, branchId);
    } catch (err) {
      // Merged by a concurrent request between the two reads: its result is this one's too.
      const now = err instanceof BranchClosedError ? await this.stamp(this.prisma, scope, branchId) : null;
      if (now?.status === 'merged') return this.mergedOutcome(scope, now);
      throw err;
    }
    const { stamp } = state;
    if (reviewToken(stamp) !== input.token) throw new BranchReviewStaleError();

    if (!this.upToDate(state)) {
      const updated = await this.updateFrom(scope, state, draftAnswers(stamp.mergeDraft), actor);
      throw new BranchUpdatedFirstError(updated.token);
    }

    // Up to date: main's name is the fork point's, so the branch's name (renamed or not) is the merged one.
    const merged: MergeDocument = state.branch;
    const problems = mergedDocumentProblems(merged, state.main, toProjectSnapshot);
    if (problems.length > 0) throw new BranchMergeInvalidError(problems);
    if (stamp.branchEpoch !== stamp.mainEpoch) throw new BranchReviewStaleError();

    const now = new Date();
    const persisted = persistedFor(merged, state.mainRow, now);
    const outcome = await withSerializationRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await this.verify(tx, scope, stamp);
        if (current.status === 'merged') return { kind: 'repeat', stamp: current } as const;
        if (current.status === 'discarded') throw new BranchClosedError('discarded', current.mainId);
        const write = await this.sites.writeWorkingCopyIn(tx, scope, persisted, { mustExist: true, expectedVersion: stamp.mainVersion });
        if (merged.name !== stamp.mainName) {
          await tx.site.updateMany({ where: { id: stamp.mainId, workspaceId: scope.workspaceId }, data: { name: merged.name } });
        }
        // Only the site's latest merge keeps main's copy from before it (S7).
        await tx.siteBranch.updateMany({
          where: { siteId: stamp.mainId, workspaceId: scope.workspaceId, id: { not: stamp.branchId } },
          data: { mainBeforeDocument: Prisma.DbNull, mainBeforeExpiresAt: null },
        });
        await this.branches.closeRecord(tx, stamp.branchId, {
          status: 'merged',
          mergedBy: actor.id,
          mergedAt: now,
          mergedFromVersion: stamp.branchVersion,
          mergedMainVersion: write.version,
          mainBeforeDocument: buildRevisionDocument(state.mainRow as Parameters<typeof buildRevisionDocument>[0]) as unknown as Prisma.InputJsonValue,
          mainBeforeExpiresAt: new Date(now.getTime() + MAIN_BEFORE_KEPT_DAYS * 24 * 60 * 60 * 1000),
        });
        await tx.siteOperationAudit.create({
          data: {
            siteId: stamp.mainId,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            actorKind: actor.kind,
            actorId: actor.id,
            // Ids and versions only: the erase of personal data does not rewrite audit rows (a branch name could hold such data).
            actorDetail: { branchId: stamp.branchId, branchVersion: stamp.branchVersion },
            operation: 'branch_merge',
            versionBefore: write.versionBefore,
            versionAfter: write.version,
          },
        });
        await this.hooks.beforeCommit?.(tx, 'merge');
        return { kind: 'written', write } as const;
      }, WRITE_TRANSACTION),
    );
    if (outcome.kind === 'repeat') return this.mergedOutcome(scope, outcome.stamp);
    forgetBranchContent(stamp.branchId);
    this.announce(stamp.mainId, outcome.write, persisted, 'merge', [`Merged branch ${stamp.recordName}`]);
    return { merged: true, branch: await this.branches.getBranch(scope, stamp.mainId, stamp.branchId), mainVersion: outcome.write.version };
  }

  private async mergedOutcome(scope: TenantScope, stamp: Stamp): Promise<BranchMergeOutcome> {
    return {
      merged: false,
      branch: await this.branches.getBranch(scope, stamp.mainId, stamp.branchId),
      mainVersion: stamp.mergedMainVersion ?? stamp.mainVersion,
    };
  }

  private announce(siteId: string, write: WorkingCopyWrite, persisted: PersistedSite, origin: 'update' | 'merge', summary: string[]): void {
    announceWrite(siteId, write, { origin, summary }, persisted);
  }
}

let cached: SiteBranchMergeService | null = null;

/** The process-wide merge service over the shared PrismaClient, constructed lazily. */
export function getSiteBranchMergeService(): SiteBranchMergeService {
  if (!cached) cached = new SiteBranchMergeService(getPrismaClient(), getSiteRepository());
  return cached;
}
