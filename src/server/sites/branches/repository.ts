import 'server-only';

// src/server/sites/branches/repository.ts
//
// Site branches, the data model and its repository (plan docs/plans/2026-11-10-site-branches.md, slice S1).
//
// A branch's content is a hidden `sites` row (`branch_of_site_id` names its main site) with its own pages, so
// the editor, autosave, the version lock, the live stream, the preview and every MCP tool work on it unchanged.
// Its record is a `site_branches` row with the same id, which outlives the content row: merging or discarding
// deletes the content and keeps the record, so an old address answers "closed" and a retried request finds the
// first one's outcome.
//
// Isolation, as everywhere in src/server/sites: every read filters by the caller's workspace (a branch or a main
// site of another workspace is indistinguishable from a missing one), every write copies the workspace, tenant
// group and company from the main site's row (never from the request), and the composite foreign keys make any
// other workspace impossible in the database itself.
//
// Locking: a call that changes a branch takes main's row first (`FOR UPDATE`), then the branch's, always in that
// order, as publish and the erase of personal data take main's. Each lock is filtered by the caller's workspace
// (and the branch's by its main), so a foreign or wrong id locks nothing. Creating a branch copies main under that lock, so
// the copy and its `base_version` are of one moment, and the cap of open branches is counted under it too.

import { randomUUID } from 'node:crypto';
import { LIVE_EVENTS } from '@/lib/projects/liveEvents';
import { publishSiteEvent } from '../liveBus';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import {
  BranchClosedError,
  BranchLimitError,
  BranchNameTakenError,
  BranchNotFoundError,
  InvalidBranchNameError,
  InvalidTenantScopeError,
  SiteIsBranchError,
  SiteNotFoundError,
} from '../errors';
import type { TenantScope } from '../repository';
import { buildRevisionDocument } from '../revision';
import { closedBranchError } from './closed';
import { forgetSiteDocuments } from '../liveDocumentCache';
import { endLiveGenerationOfSite } from '../liveGeneration';
import { BRANCH_NAME_MAX_LENGTH, MAX_OPEN_BRANCHES_PER_SITE, validateBranchName, type BranchStatus } from '@/lib/sites/branches';

/** Who acts: a signed-in person or an MCP key, as `site_operation_audits` records actors. */
export interface BranchActor {
  kind: 'user' | 'key';
  id: string;
}

/** One branch as a listing shows it. Closed branches carry no versions: their content is gone. */
export interface BranchSummary {
  branchId: string;
  mainSiteId: string;
  name: string;
  status: BranchStatus;
  createdByKind: 'user' | 'key';
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** The branch's own version (its hidden site row's), or null once closed. */
  version: number | null;
  /** Main's version at the fork or the last update from main, or null once closed. */
  baseVersion: number | null;
  /** Whether main was written since `baseVersion`. Always false once closed. */
  mainMoved: boolean;
  readyBy: string | null;
  readyAt: Date | null;
  reviewNote: string | null;
  /** Whether the approval is still for the branch's current version. */
  approved: boolean;
  mergedAt: Date | null;
  discardedAt: Date | null;
  /** A merged branch: until when its merge can be undone (S7); null when it cannot (any more), or was undone. */
  undoUntil: Date | null;
  /** A merged branch whose merge was undone: the branch that took the merged work back, and when. */
  undoneIntoBranchId: string | null;
  undoneAt: Date | null;
}

/** A site's branches for its switcher: the open ones, then the most recent closed ones. */
export interface BranchList {
  mainSiteId: string;
  mainVersion: number;
  open: BranchSummary[];
  closed: BranchSummary[];
}

/** What a site id is, for the editor and the routes: a main site with its open branches, or a branch. */
export type SiteBranchContext =
  | { kind: 'main'; siteId: string; openBranches: number }
  | { kind: 'branch'; siteId: string; mainSiteId: string; branch: BranchSummary };

/** How many closed branches a listing shows. The records stay; only the listing is bounded. */
const CLOSED_LISTED = 20;

/** Copying a site at the 10 MB limit, page by page, fits in this. */
const BRANCH_WRITE_TRANSACTION = { maxWait: 5_000, timeout: 30_000 } as const;

export const RECORD_SELECT = {
  id: true,
  siteId: true,
  name: true,
  status: true,
  createdByKind: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  baseVersion: true,
  readyBy: true,
  readyAt: true,
  reviewNote: true,
  approvedBranchVersion: true,
  mergedAt: true,
  discardedAt: true,
  mainBeforeExpiresAt: true,
  undoneIntoBranchId: true,
  undoneAt: true,
  branchSite: { select: { version: true } },
} as const;

export type RecordRow = Prisma.SiteBranchGetPayload<{ select: typeof RECORD_SELECT }>;

/**
 * `renamed`: main's name is no longer the fork point's. A rename moves no version, yet the branch is behind
 * main then, as the review and the merge count it (src/server/sites/branches/merge.ts, decision 37).
 */
export function summaryOf(row: RecordRow, mainVersion: number, renamed = false): BranchSummary {
  const open = row.status === 'open' || row.status === 'ready';
  const version = open ? (row.branchSite?.version ?? null) : null;
  return {
    branchId: row.id,
    mainSiteId: row.siteId,
    name: row.name,
    status: row.status,
    createdByKind: row.createdByKind === 'key' ? 'key' : 'user',
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version,
    baseVersion: open ? row.baseVersion : null,
    mainMoved: open && row.baseVersion !== null && (row.baseVersion !== mainVersion || renamed),
    readyBy: row.readyBy,
    readyAt: row.readyAt,
    reviewNote: row.reviewNote,
    approved: version !== null && row.approvedBranchVersion === version,
    mergedAt: row.mergedAt,
    discardedAt: row.discardedAt,
    // The kept copy is selected by its expiry alone: it is set and cleared together with the document.
    undoUntil:
      row.status === 'merged' && !row.undoneIntoBranchId && row.mainBeforeExpiresAt && row.mainBeforeExpiresAt.getTime() > Date.now()
        ? row.mainBeforeExpiresAt
        : null,
    undoneIntoBranchId: row.status === 'merged' ? row.undoneIntoBranchId : null,
    undoneAt: row.status === 'merged' ? row.undoneAt : null,
  };
}

function assertScope(scope: TenantScope): void {
  if (!scope || !scope.workspaceId || !scope.tenantGroupId) throw new InvalidTenantScopeError();
}

function cleanName(raw: unknown): string {
  const result = validateBranchName(raw);
  if (!result.ok) throw new InvalidBranchNameError(result.message);
  return result.name;
}

/** A unique violation of the open-name index (`site_branches_open_name_key`), which Prisma reports as P2002. */
function isNameClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const named = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return named.includes('name');
}

/**
 * Whether another open branch of the site holds this name. Compared in SQL with `lower()`, exactly as the
 * unique index `site_branches_open_name_key` compares, so no check here disagrees with the index.
 */
export async function openNameTaken(
  client: Prisma.TransactionClient | PrismaClient,
  mainSiteId: string,
  name: string,
  exceptBranchId: string | null = null,
): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.site_branches
    WHERE site_id = ${mainSiteId} AND status IN ('open', 'ready') AND lower(name) = lower(${name})
      AND (${exceptBranchId}::text IS NULL OR id <> ${exceptBranchId}::text)
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * A name for an open branch that no other open branch of the site holds: `stem`, or `stem 2`, `stem 3`, ...
 * within the length limit. For a rewrite that must not fail on the name's uniqueness (the erase of personal data).
 */
export async function freeOpenName(
  client: Prisma.TransactionClient,
  mainSiteId: string,
  stem: string,
  branchId: string,
): Promise<string> {
  let name = stem;
  for (let n = 2; await openNameTaken(client, mainSiteId, name, branchId); n++) {
    name = `${Array.from(stem).slice(0, BRANCH_NAME_MAX_LENGTH - 1 - String(n).length).join('').trimEnd()} ${n}`;
  }
  return name;
}

/** A unique violation of a primary key (`sites` or `site_branches`) or of `branch_site_id`: the chosen id is taken. */
export function isIdClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const named = Array.isArray(target) ? target : [String(target ?? '')];
  return named.every((t) => t === 'id' || t === 'branch_site_id' || /_pkey$|branch_site_id/.test(String(t)));
}

/**
 * The open branches of a main site whose fork point names the site differently from main now; with `branchId`,
 * that one branch only. Compared with `base_name`, the fork document's name as a stored column, so no fork
 * document is unpacked for it (the whole document of every open branch was, on every status read).
 */
async function renamedSinceFork(
  client: Prisma.TransactionClient | PrismaClient,
  mainSiteId: string,
  workspaceId: string,
  branchId: string | null = null,
): Promise<Set<string>> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM public.site_branches b JOIN public.sites s ON s.id = b.site_id AND s.workspace_id = b.workspace_id
    WHERE b.site_id = ${mainSiteId} AND b.workspace_id = ${workspaceId} AND b.status IN ('open', 'ready')
      AND (${branchId}::text IS NULL OR b.id = ${branchId}::text)
      AND b.base_version IS NOT NULL AND b.base_name IS DISTINCT FROM s.name`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Remove the copies kept for "Undo this merge" whose 30 days are over (S7), for one main site. No timer looks
 * for them: every place that reads a site's branches calls this (the branch list, the editor's page, an erase
 * of personal data), and it writes only when its read found one, so a plain read stays a read. Until it runs,
 * every reader treats an expired copy as gone: the undo refuses it by its date, the summaries offer no undo,
 * and the image delete check does not count it.
 */
export async function clearExpiredKeptCopies(
  client: Prisma.TransactionClient | PrismaClient,
  workspaceId: string,
  mainSiteId: string,
  now: Date = new Date(),
): Promise<void> {
  const where = { siteId: mainSiteId, workspaceId, mainBeforeExpiresAt: { lt: now } };
  const expired = await client.siteBranch.findFirst({ where, select: { id: true } });
  if (!expired) return;
  await client.siteBranch.updateMany({
    where,
    data: { mainBeforeDocument: Prisma.DbNull, mainBeforeExpiresAt: null, mainBeforeEnded: 'expired' },
  });
}

/**
 * How many merged and discarded records a site keeps. They hold a name and a review note and no content, and
 * exist so an old address can say what happened to its branch. Without a bound they grow for ever, and an
 * erase of personal data reads every one.
 */
export const CLOSED_RECORDS_KEPT = 50;

/**
 * Delete a main site's oldest closed records beyond {@link CLOSED_RECORDS_KEPT}. Run when a branch is closed,
 * in that transaction and under main's row lock, never by a read. Kept whatever their age: a merged record
 * whose copy for the undo is still live, and a record that another one names as where its undone merge went.
 * A record's age is when it was closed, not when it was last touched (clearing an expired copy or an erase of
 * personal data rewrites old records). A pruned record's old address then answers as a missing site.
 */
async function pruneClosedRecords(tx: Prisma.TransactionClient, mainSiteId: string): Promise<void> {
  const old = await tx.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM public.site_branches b
    WHERE b.site_id = ${mainSiteId} AND b.status IN ('merged', 'discarded')
      AND (b.main_before_expires_at IS NULL OR b.main_before_expires_at <= (now() AT TIME ZONE 'UTC'))
      AND NOT EXISTS (
        SELECT 1 FROM public.site_branches o WHERE o.site_id = b.site_id AND o.undone_into_branch_id = b.id
      )
    ORDER BY coalesce(b.merged_at, b.discarded_at, b.updated_at) DESC, b.id DESC
    OFFSET ${CLOSED_RECORDS_KEPT}`;
  if (old.length === 0) return;
  await tx.siteBranch.deleteMany({ where: { id: { in: old.map((r) => r.id) }, siteId: mainSiteId, status: { in: ['merged', 'discarded'] } } });
}

export class SiteBranchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Make a branch of a main site: a hidden copy of main's working copy as stored right now (not of what is
   * published), with main's version and document kept as the fork point. One transaction under main's row lock.
   *
   * `branchId` makes a retry safe: a request whose answer was lost sends the same id again, and finds the branch
   * it made (`created: false`) instead of a second one. An id this main site's branches do not hold as one made
   * by the same actor is refused like a missing site.
   */
  async createBranch(
    scope: TenantScope,
    mainSiteId: string,
    input: { name: unknown; actor: BranchActor; branchId?: string },
  ): Promise<{ branch: BranchSummary; created: boolean }> {
    assertScope(scope);
    const name = cleanName(input.name);
    const branchId = input.branchId ?? randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${mainSiteId} AND workspace_id = ${scope.workspaceId} AND tenant_group_id = ${scope.tenantGroupId} FOR UPDATE`;
        const main = await tx.site.findFirst({
          where: { id: mainSiteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
          select: {
            id: true,
            branchOfSiteId: true,
            companyId: true,
            version: true,
            erasureEpoch: true,
            name: true,
            description: true,
            analyticsProjectId: true,
            ingestionEndpoint: true,
            apiKeyRef: true,
            lumitraEnabled: true,
            siteSettings: true,
            components: true,
            redirects: true,
            projectCreatedAt: true,
            projectUpdatedAt: true,
            pages: { select: { pageId: true, slug: true, snapshot: true } },
          },
        });
        if (!main) throw new SiteNotFoundError(mainSiteId);
        if (main.branchOfSiteId) throw new SiteIsBranchError('a branch cannot be branched again. Branch its site instead.');

        // A retry of this very create: answered with what the first one made.
        const earlier = await tx.siteBranch.findFirst({
          where: { id: branchId, workspaceId: scope.workspaceId },
          select: { ...RECORD_SELECT, createdByKind: true, createdBy: true },
        });
        if (earlier) {
          if (earlier.siteId !== main.id || earlier.createdBy !== input.actor.id || earlier.createdByKind !== input.actor.kind) {
            throw new BranchNotFoundError(branchId);
          }
          return { branch: summaryOf(earlier, main.version), created: false };
        }
        // Any other row under that id (another workspace's site or record): refused the same way. A caller learns
        // only that an id it already holds is in use, never whose or what; ids are random, so none can be guessed.
        const taken = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT (SELECT count(*) FROM public.sites WHERE id = ${branchId}) + (SELECT count(*) FROM public.site_branches WHERE id = ${branchId}) AS n`;
        if (Number(taken[0]?.n ?? 0) > 0) throw new BranchNotFoundError(branchId);

        const open = await tx.siteBranch.count({ where: { siteId: main.id, status: { in: ['open', 'ready'] }, } });
        if (open >= MAX_OPEN_BRANCHES_PER_SITE) throw new BranchLimitError(MAX_OPEN_BRANCHES_PER_SITE);
        if (await openNameTaken(tx, main.id, name)) throw new BranchNameTakenError(name);

        const now = new Date();
        await tx.site.create({
          data: {
            id: branchId,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            companyId: main.companyId,
            branchOfSiteId: main.id,
            name: main.name,
            description: main.description,
            status: 'draft',
            analyticsProjectId: main.analyticsProjectId,
            ingestionEndpoint: main.ingestionEndpoint,
            apiKeyRef: main.apiKeyRef,
            lumitraEnabled: main.lumitraEnabled,
            siteSettings: main.siteSettings as Prisma.InputJsonValue,
            components: main.components as Prisma.InputJsonValue,
            // Redirects are main's alone: a merge writes main through the save, which derives them (section 4).
            redirects: [],
            projectCreatedAt: main.projectCreatedAt,
            projectUpdatedAt: main.projectUpdatedAt,
            // Equal to main's, so a tab of the branch and the erase of personal data agree from the start.
            erasureEpoch: main.erasureEpoch,
            version: 1,
          },
        });
        // One statement for all pages, as the undo of a merge copies them: main's row lock is held meanwhile.
        await tx.sitePage.createMany({
          data: main.pages.map((page) => ({
            siteId: branchId,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            pageId: page.pageId,
            slug: page.slug,
            snapshot: page.snapshot as Prisma.InputJsonValue,
          })),
        });
        const record = await tx.siteBranch.create({
          data: {
            id: branchId,
            siteId: main.id,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            companyId: main.companyId,
            branchSiteId: branchId,
            name,
            status: 'open',
            baseVersion: main.version,
            baseDocument: buildRevisionDocument(main) as unknown as Prisma.InputJsonValue,
            createdByKind: input.actor.kind,
            createdBy: input.actor.id,
            createdAt: now,
          },
          select: RECORD_SELECT,
        });
        return { branch: summaryOf(record, main.version), created: true };
      }, BRANCH_WRITE_TRANSACTION);
    } catch (err) {
      // Two creates with the same name racing past the check above: the partial unique index decides.
      if (isNameClash(err)) throw new BranchNameTakenError(name);
      // The same chosen id sent for two different sites at once (each create holds only its own main's lock):
      // the primary key decides, and the loser is answered as any other id already in use.
      if (isIdClash(err)) throw new BranchNotFoundError(branchId);
      throw err;
    }
  }

  /** A main site's branches: every open one, then the most recent closed ones without content. */
  async listBranches(scope: TenantScope, mainSiteId: string): Promise<BranchList> {
    assertScope(scope);
    const main = await this.loadMain(this.prisma, scope, mainSiteId);
    await clearExpiredKeptCopies(this.prisma, scope.workspaceId, main.id);
    const [open, closed, renamed] = await Promise.all([
      this.prisma.siteBranch.findMany({
        where: { siteId: main.id, workspaceId: scope.workspaceId, status: { in: ['open', 'ready'] } },
        orderBy: { createdAt: 'asc' },
        select: RECORD_SELECT,
      }),
      this.prisma.siteBranch.findMany({
        where: { siteId: main.id, workspaceId: scope.workspaceId, status: { in: ['merged', 'discarded'] } },
        orderBy: { updatedAt: 'desc' },
        take: CLOSED_LISTED,
        select: RECORD_SELECT,
      }),
      renamedSinceFork(this.prisma, main.id, scope.workspaceId),
    ]);
    return {
      mainSiteId: main.id,
      mainVersion: main.version,
      open: open.map((row) => summaryOf(row, main.version, renamed.has(row.id))),
      closed: closed.map((row) => summaryOf(row, main.version)),
    };
  }

  /** One branch of a main site, open or closed. */
  async getBranch(scope: TenantScope, mainSiteId: string, branchId: string): Promise<BranchSummary> {
    assertScope(scope);
    const main = await this.loadMain(this.prisma, scope, mainSiteId);
    const row = await this.prisma.siteBranch.findFirst({
      where: { id: branchId, siteId: main.id, workspaceId: scope.workspaceId },
      select: RECORD_SELECT,
    });
    if (!row) throw new BranchNotFoundError(branchId);
    return summaryOf(row, main.version, (await renamedSinceFork(this.prisma, main.id, scope.workspaceId, row.id)).has(row.id));
  }

  /**
   * What a site id is: a main site (with its count of open branches) or an open branch. A closed branch's id
   * throws BranchClosedError (410), so its old address can say what happened; anything else of another workspace,
   * or missing, throws SiteNotFoundError.
   */
  async siteBranchContext(scope: TenantScope, siteId: string): Promise<SiteBranchContext> {
    assertScope(scope);
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
      select: { id: true, branchOfSiteId: true, version: true, _count: { select: { branchSites: true } } },
    });
    if (!site) {
      await this.throwIfClosedBranch(scope, siteId);
      throw new SiteNotFoundError(siteId);
    }
    if (!site.branchOfSiteId) return { kind: 'main', siteId: site.id, openBranches: site._count.branchSites };
    const main = await this.prisma.site.findFirst({
      where: { id: site.branchOfSiteId, workspaceId: scope.workspaceId },
      select: { version: true },
    });
    const row = await this.prisma.siteBranch.findFirst({
      where: { id: site.id, workspaceId: scope.workspaceId },
      select: RECORD_SELECT,
    });
    if (!main || !row) throw new SiteNotFoundError(siteId);
    const renamed = (await renamedSinceFork(this.prisma, site.branchOfSiteId, scope.workspaceId, row.id)).has(row.id);
    return { kind: 'branch', siteId: site.id, mainSiteId: site.branchOfSiteId, branch: summaryOf(row, main.version, renamed) };
  }

  /**
   * For a site id that no `sites` row in the caller's workspace holds: throw BranchClosedError when it names a
   * merged or discarded branch of that workspace. Returns normally otherwise (the caller throws its own 404).
   */
  async throwIfClosedBranch(scope: TenantScope, siteId: string): Promise<void> {
    const closed = await closedBranchError(this.prisma, scope.workspaceId, siteId);
    if (closed) throw closed;
  }

  /**
   * Change a branch's record: a new name, the ready state, or both in one transaction, so a request that asks
   * for both gets both or neither. Ready keeps the branch editable (an edit withdraws an approval, never the
   * ready state); back to open clears the ready marks and any approval. The site name inside the branch is part
   * of its content, not this.
   */
  async changeBranch(
    scope: TenantScope,
    mainSiteId: string,
    branchId: string,
    change: { name?: unknown; ready?: boolean },
    actor: BranchActor | null,
  ): Promise<BranchSummary> {
    assertScope(scope);
    const name = change.name === undefined ? undefined : cleanName(change.name);
    if (change.ready !== undefined && !actor) throw new Error('changeBranch: the ready state needs an actor');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { main, record } = await this.lockOpen(tx, scope, mainSiteId, branchId);
        const data: Prisma.SiteBranchUncheckedUpdateInput = {};
        if (name !== undefined && name !== record.name) {
          if (await openNameTaken(tx, main.id, name, branchId)) throw new BranchNameTakenError(name);
          data.name = name;
        }
        if (change.ready !== undefined && (record.status === 'ready') !== change.ready) {
          Object.assign(
            data,
            change.ready
              ? { status: 'ready', readyBy: actor!.id, readyAt: new Date(), reviewNote: null }
              : { status: 'open', readyBy: null, readyAt: null, approvedBy: null, approvedAt: null, approvedBranchVersion: null },
          );
        }
        if (Object.keys(data).length === 0) return summaryOf(record, main.version);
        const row = await tx.siteBranch.update({ where: { id: branchId }, data, select: RECORD_SELECT });
        return summaryOf(row, main.version);
      });
    } catch (err) {
      if (isNameClash(err) && name !== undefined) throw new BranchNameTakenError(name);
      throw err;
    }
  }

  /** Rename a branch (its record). */
  renameBranch(scope: TenantScope, mainSiteId: string, branchId: string, rawName: unknown): Promise<BranchSummary> {
    return this.changeBranch(scope, mainSiteId, branchId, { name: rawName }, null);
  }

  /** Mark a branch ready for review, or back to open. */
  setBranchReady(scope: TenantScope, mainSiteId: string, branchId: string, ready: boolean, actor: BranchActor): Promise<BranchSummary> {
    return this.changeBranch(scope, mainSiteId, branchId, { ready }, actor);
  }

  /**
   * Discard a branch: its content row (and with it its pages) is deleted, the record stays as `discarded`
   * without content. A repeat of a discard answers the same outcome; a merged branch is closed already
   * (BranchClosedError). After the commit, what this process holds of the branch's content goes too.
   */
  async discardBranch(
    scope: TenantScope,
    mainSiteId: string,
    branchId: string,
    actor: BranchActor,
  ): Promise<{ branch: BranchSummary; discarded: boolean }> {
    assertScope(scope);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const main = await this.lockMain(tx, scope, mainSiteId);
      await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${branchId} AND workspace_id = ${scope.workspaceId} AND branch_of_site_id = ${main.id} FOR UPDATE`;
      const record = await tx.siteBranch.findFirst({
        where: { id: branchId, siteId: main.id, workspaceId: scope.workspaceId },
        select: RECORD_SELECT,
      });
      if (!record) throw new BranchNotFoundError(branchId);
      if (record.status === 'merged') throw new BranchClosedError('merged', main.id, record.undoneIntoBranchId);
      if (record.status === 'discarded') return { branch: summaryOf(record, main.version), discarded: false };
      const row = await this.closeRecord(tx, branchId, {
        status: 'discarded',
        discardedBy: actor.id,
        discardedAt: new Date(),
      });
      return { branch: summaryOf(row, main.version), discarded: true };
    }, BRANCH_WRITE_TRANSACTION);
    if (outcome.discarded) forgetBranchContent(branchId, 'discarded');
    return outcome;
  }

  /**
   * Close a branch inside the caller's transaction (discard now, merge in S3): the record loses its content
   * pointer and every content-derived field, then the hidden site row is deleted (its pages cascade). The caller
   * holds main's and the branch's row locks and runs {@link forgetBranchContent} after the commit.
   */
  async closeRecord(
    tx: Prisma.TransactionClient,
    branchId: string,
    data: Prisma.SiteBranchUncheckedUpdateInput & { status: 'merged' | 'discarded' },
  ): Promise<RecordRow> {
    const row = await tx.siteBranch.update({
      where: { id: branchId },
      data: {
        ...data,
        branchSiteId: null,
        baseVersion: null,
        baseDocument: Prisma.DbNull,
        mergeDraft: Prisma.DbNull,
        approvedBranchVersion: null,
      },
      select: RECORD_SELECT,
    });
    await tx.site.deleteMany({ where: { id: branchId, branchOfSiteId: { not: null } } });
    // The public preview link ends with the branch (S8): there is nothing left for it to show.
    await tx.siteBranchPreview.deleteMany({ where: { branchId } });
    await pruneClosedRecords(tx, row.siteId);
    return row;
  }

  private async loadMain(
    client: PrismaClient | Prisma.TransactionClient,
    scope: TenantScope,
    mainSiteId: string,
  ): Promise<{ id: string; version: number }> {
    const main = await client.site.findFirst({
      where: { id: mainSiteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
      select: { id: true, version: true, branchOfSiteId: true },
    });
    if (!main) throw new SiteNotFoundError(mainSiteId);
    if (main.branchOfSiteId) throw new SiteIsBranchError('branches are listed and changed on its site, not on a branch.');
    return { id: main.id, version: main.version };
  }

  private async lockMain(tx: Prisma.TransactionClient, scope: TenantScope, mainSiteId: string) {
    await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${mainSiteId} AND workspace_id = ${scope.workspaceId} AND tenant_group_id = ${scope.tenantGroupId} FOR UPDATE`;
    return this.loadMain(tx, scope, mainSiteId);
  }

  /** Main's and the branch's row locks, in that order, and the branch's record, which must be open or ready. */
  private async lockOpen(tx: Prisma.TransactionClient, scope: TenantScope, mainSiteId: string, branchId: string) {
    const main = await this.lockMain(tx, scope, mainSiteId);
    await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${branchId} AND workspace_id = ${scope.workspaceId} AND branch_of_site_id = ${main.id} FOR UPDATE`;
    const record = await tx.siteBranch.findFirst({
      where: { id: branchId, siteId: main.id, workspaceId: scope.workspaceId },
      select: RECORD_SELECT,
    });
    if (!record) throw new BranchNotFoundError(branchId);
    if (record.status === 'merged') throw new BranchClosedError('merged', main.id, record.undoneIntoBranchId);
    if (record.status === 'discarded') throw new BranchClosedError('discarded', main.id);
    if (record.branchSite === null) throw new BranchClosedError('discarded', main.id);
    return { main, record };
  }
}

/**
 * What this process holds of a closed or deleted branch's content: the document route's kept copies and a
 * running generation's draft. Run after the commit that closed it, as a site delete does.
 */
export function forgetBranchContent(branchId: string, closed?: 'merged' | 'discarded'): void {
  // An editor tab open on the branch hears it at once (plan section 6): its unsaved work can go nowhere on
  // this branch any more, and the tab says so with a way on, instead of at its next failed save.
  if (closed) publishSiteEvent(branchId, LIVE_EVENTS.branchClosed, { status: closed });
  forgetSiteDocuments(branchId);
  endLiveGenerationOfSite(branchId, 'site_changed');
}

let cached: SiteBranchRepository | null = null;

/** The process-wide branch repository over the shared PrismaClient, constructed lazily. */
export function getSiteBranchRepository(): SiteBranchRepository {
  if (!cached) cached = new SiteBranchRepository(getPrismaClient());
  return cached;
}
