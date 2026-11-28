import 'server-only';

// src/server/sites/repository.ts
//
// The site-persistence repository: the server-only door that makes Prisma the
// source of truth for the visual editor and the MST ProjectModel a working copy
// snapshotted in (load) and out (save).
//
// HARD ISOLATION CONTRACT (the whole point of P1b):
//   - EVERY read filters by `workspace_id`. A site that exists in another
//     workspace is invisible: a load/save for the wrong workspace returns
//     SiteNotFoundError, never another workspace's data.
//   - EVERY write stamps BOTH `workspace_id` AND `tenant_group_id` from the
//     caller-supplied tenant scope (resolved from the verified auth-brain
//     session, NEVER from the client-controlled MST tree). tenant_group_id is
//     denormalised onto every child row (site_pages / site_domains /
//     site_experiments) so a tenant_group-wide operation is index-backed and a
//     future B2B2C promotion needs no reshaping.
//
// framer-clone models NO identity here: these ids are opaque strings owned by
// auth-brain. This layer never reads a users/memberships table — authorization
// (can the caller act in this workspace) is the route's `can()` boundary; this
// layer is the data-scoping boundary.

import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import {
  mergeKeptSiteSettings,
  projectToPersisted,
  persistedToProjectSnapshot,
  type PersistedSite,
  type SiteRowData,
} from './snapshot';
import {
  InvalidPageSlugError,
  InvalidSiteThemeError,
  InvalidTenantScopeError,
  SiteDeleteConfirmationError,
  SiteGoneError,
  SiteNameConflictError,
  SiteNotFoundError,
  SiteRevisionNotFoundError,
  SubdomainAllocationError,
  SiteErasedSinceLoadError,
  SiteChangedError,
  SiteVersionRequiredError,
  ErasePreviewStaleError,
  NothingToEraseError,
  SiteImageMissingError,
  CustomCodeBudgetError,
  BranchCannotPublishError,
  SiteIsBranchError,
} from './errors';
import { closedBranchError } from './branches/closed';
import {
  SITE_CODE_BUDGET_BYTES,
  allNamed,
  bytesOfBlobs,
  namedHashes,
  namedOutside,
  pruneUnnamedBlobs,
  siteHoldsBlobs,
  workingCopyHashes,
  type NamedHashes,
} from '@/server/customCode/named';
import { sizeInWords } from '@/lib/customCode/authoring';
import { BOX_LIMITS, canonicalDeclarationJson, customCodeHash, parseDeclaration, utf8ByteLength } from '@/lib/customCode/contract';
import { isDatabaseConflict } from './dbConflict';
import { validateBranchName } from '@/lib/sites/branches';
import { clearExpiredKeptCopies, forgetBranchContent, freeOpenName } from './branches/repository';
import { namedSiteImages } from '@/lib/site/siteImages';
import { fxSiteImagePaths } from '@/lib/fxScene/fxScene';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { themeBoundsErrors } from '@/lib/site/theme';
import { siteCardColors, type SiteCardColors } from '@/lib/site/cardColors';
import { findProjectSlugProblem } from '@/lib/pages/slug';
import { pickPrimaryHost } from './primaryHost';
import { nextSiteRedirects, parseSiteRedirects } from '@/lib/pages/redirects';
import { generateSubdomain } from './subdomain';
import { buildRevisionDocument, parseRevisionDocument, revisionPublishCheck } from './revision';
import { publishSiteEvent } from './liveBus';
import { endLiveGenerationOfSite } from './liveGeneration';
import { forgetSiteDocuments } from './liveDocumentCache';
import { checkPlanAnchors, hasPlans, noteSiteWrite } from '@/server/mcp/livePlans';
import { boundedWriteEvent, LIVE_EVENTS, type SiteVersionEvent, type SiteWriteEvent } from '@/lib/projects/liveEvents';
import type { PublishCheck } from '@/lib/legal/publishCheck';
import {
  assertShapeKept,
  eraseMatcher,
  ERASE_LIMITS,
  findMatches,
  matchesToken,
  redactedId,
  redactedPath,
  redactionMatcher,
  replacementProblem,
  rewriteDocument,
  type EraseArea,
  type EraseLocation,
  type EraseMatch,
  type EraseQuery,
  renameCustomCodeHashes,
  EraseCodeRefusedError,
} from './erase';

/**
 * Bounded retries for the DB-enforced subdomain allocation. Each attempt
 * generates a fresh random label and tries to INSERT it; a `P2002` against the
 * `@@unique([subdomain])` index means another site already holds that label, so
 * we regenerate and retry. At length-12 over a 36-char alphabet a single
 * collision is ~nil, so 5 attempts is a generous ceiling whose only purpose is
 * to never loop forever — exhaustion throws a loud 500 rather than spinning.
 */
const SUBDOMAIN_ALLOCATION_ATTEMPTS = 5;

/** How often a save that lost a serialization conflict (P2034) is retried. */
const SERIALIZATION_ATTEMPTS = 4;

/**
 * How many revisions of a site are kept. A project body may be up to 10 MB, so
 * unbounded history would be unbounded growth. Pruned at publish, when the live
 * revision is the newest, so the live one is never at risk.
 */
export const REVISIONS_KEPT = 30;

/**
 * Limits of a transaction that writes a whole project. Prisma's default of 5
 * seconds is within reach of a body at the 10 MB limit, and more so of a site's
 * first publish, which also writes two full revision documents.
 */
const PROJECT_WRITE_TRANSACTION = { maxWait: 5_000, timeout: 30_000 } as const;

/**
 * Run a transaction, retrying when Postgres aborted it because a concurrent
 * transaction touched the same rows (Prisma code P2034), or when two writers took
 * the same revision number (P2002 on `site_id, number`). Any other error, or the
 * last conflict, is rethrown unchanged.
 */
async function withSerializationRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      // P2002 (a unique violation on the revision number, or on a first save two creators raced on) and the
      // database's own aborts, whether a Prisma query or a raw lock query reported them (dbConflict.ts).
      const conflict = isDatabaseConflict(err) || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002');
      if (!conflict || attempt >= SERIALIZATION_ATTEMPTS) throw err;
      // A short wait that grows and differs per caller, so transactions that collided do not start again in
      // step and collide again.
      await new Promise((resolve) => setTimeout(resolve, attempt * (20 + Math.random() * 60)));
    }
  }
}

/** The path of an uploaded image in any text, the pattern deleteSiteImage's scan (referencedHashes) searches for. */
const SITE_IMAGE_PATH = /site-images\/[0-9a-f]{64}/;

/** Whether the document a save carries holds an uploaded image's path anywhere: settings, definitions, any page. */
function carriesSiteImagePath(persisted: PersistedSite): boolean {
  return (
    SITE_IMAGE_PATH.test(JSON.stringify(persisted.siteSettings)) ||
    (persisted.components != null && SITE_IMAGE_PATH.test(JSON.stringify(persisted.components))) ||
    persisted.pages.some((p) => SITE_IMAGE_PATH.test(JSON.stringify(p.snapshot)))
  );
}

/** A custom code block's hash in any text: a save carrying one may bring code to life (D114). */
const CUSTOM_CODE_HASH = /"sha256":"[0-9a-f]{64}"/;

/** Whether the working copy a save carries names a custom code hash: on a page or in a component definition. */
function carriesCustomCodeHash(persisted: PersistedSite): boolean {
  return (
    (persisted.components != null && CUSTOM_CODE_HASH.test(JSON.stringify(persisted.components))) ||
    persisted.pages.some((p) => CUSTOM_CODE_HASH.test(JSON.stringify(p.snapshot)))
  );
}

/** The uploaded images a save names: in the settings, as a page's sharing image, in an FX scene on a page or in a component. */
function namedImagesOf(persisted: PersistedSite): ReturnType<typeof namedSiteImages> {
  return namedSiteImages(persisted.siteSettings, [
    ...persisted.pages.map((p) => (p.snapshot as { metadata?: { ogImage?: unknown } }).metadata?.ogImage),
    ...persisted.pages.flatMap((p) => fxSiteImagePaths(p.snapshot)),
    // Reusable component definitions hold nodes too. A save that sends none
    // leaves the stored ones as they are, checked when they were saved.
    ...fxSiteImagePaths(persisted.components),
  ]);
}

/**
 * The tenant scope every repository call is bound to. Resolved by the caller
 * from the verified session (the workspace the request acts in, and that
 * workspace's tenant_group). Both are required and non-empty; an empty scope is
 * rejected so a query can never accidentally widen past the isolation boundary.
 */
export interface TenantScope {
  workspaceId: string;
  tenantGroupId: string;
}

/** A lightweight site summary for listings (no page snapshots loaded). */
export interface SiteSummary {
  siteId: string;
  name: string;
  description: string;
  status: string;
  lumitraEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** The `<label>` of `<label>.sites.lumitra.co`, once first published. */
  subdomain: string | null;
  /** Connected custom domains (requested hostnames), oldest first. */
  customDomains: string[];
  /** Open branches of the site (docs/plans/2026-11-10-site-branches.md); a branch itself is never listed. */
  openBranches: number;
  /** The site's own colours for its card on the projects home (src/lib/site/cardColors.ts), or null. */
  cardColors: SiteCardColors | null;
}

/** One published revision for a listing (no document loaded). */
export interface SiteRevisionSummary {
  number: number;
  kind: 'publish' | 'baseline';
  /** The auth-brain user who published; null for a baseline. */
  publishedBy: string | null;
  createdAt: Date;
  /** When an erase of personal data last rewrote it; null when none did. */
  rewrittenAt: Date | null;
}

/** A site's published history, newest first. */
export interface SiteRevisionList {
  /** The number visitors are served, or null: not published, or no revision yet. */
  live: number | null;
  /** The site's status (a pointer survives an unpublish, so `live` needs both). */
  status: string;
  revisions: SiteRevisionSummary[];
}

/** How many matches one stored document holds, for the preview's overview. */
export interface ErasureLocationSummary {
  location: EraseLocation;
  /** For a revision: when it was published, its kind and whether visitors are served it. */
  createdAt: Date | null;
  kind: 'publish' | 'baseline' | null;
  live: boolean;
  matches: number;
  erasable: number;
}

/** A search for one personal value across a site's history (the erase preview). */
export interface PersonalDataSearch {
  /** Repeated by the erase: a digest of every match, so a change in between is caught. */
  token: string;
  total: number;
  erasable: number;
  blocked: number;
  /** The first ERASE_LIMITS.listed matches: the working copy first, then the revisions, newest first. */
  matches: EraseMatch[];
  truncated: boolean;
  locations: ErasureLocationSummary[];
}

/** One place an erase changed, as the audit keeps it: never a value. */
export interface ErasurePlace {
  location: EraseLocation['kind'];
  revision: number | null;
  /** For a place a site branch keeps: the branch's id (never its name, which may hold the value). */
  branchId: string | null;
  pageId: string | null;
  area: EraseArea;
  path: string;
}

/** What an erase did. */
export interface PersonalDataErasure {
  erasureId: string;
  erased: number;
  places: ErasurePlace[];
  /** Matches left in the rewritten documents, counted in the same transaction. */
  remaining: number;
  /**
   * The custom code blocks whose code the erase rewrote, by their title after the erase (D9): the code may break
   * where a string literal changed, so the owner checks each of them.
   */
  rewrittenCode: string[];
}

/** One audit row, for the owner's list. */
export interface SiteErasureSummary {
  id: string;
  erasedBy: string;
  erasedCount: number;
  remainingCount: number;
  places: ErasurePlace[];
  createdAt: Date;
}

/**
 * Limits of an erase: up to 30 revisions of up to 10 MB each, and the copies a site's
 * branches keep (up to 10 open working copies and their fork points, one kept
 * pre-merge copy), are rewritten one at a time in one transaction, which a
 * publish's 30 seconds do not cover. The search reads the same copies, so it has the same budget.
 */
const ERASE_TRANSACTION = { maxWait: 5_000, timeout: 240_000 } as const;

/**
 * One copy of a site that a branch keeps, as an erase searches and rewrites it
 * (docs/plans/2026-11-10-site-branches.md, section 7). `write` stores the
 * rewritten document; `branchSiteId` names an open branch's content row, whose
 * erasure epoch and version move with main's.
 */
/** The code of one stored custom code block or proposal, for an erase (D9). */
interface CustomCodeEraseSource {
  location: EraseLocation;
  /** `{ code, title }`, the text the erase searches. */
  document: { code: string; title: string };
  /**
   * For a block: deletes its old row, before any block's new row is written, so blocks whose rewritten code meets
   * another's old code or another's new code each end up with exactly one row under that hash.
   */
  removeOld?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Writes the rewritten document; for a block, under the hash `renamed` maps its old one to. */
  /** Writes the rewritten code; resolves to the title the row serving it holds (a converged row keeps its own). */
  write: (tx: Prisma.TransactionClient, rewritten: { code: string; title: string }, renamed: ReadonlyMap<string, string>, erasedBy: string, scope: TenantScope) => Promise<string>;
  /** For a block: the hash its rewritten code and declaration give, or why the code cannot be rewritten. */
  hashAfter?: (rewritten: { code: string; title: string }) => Promise<string>;
}

interface BranchEraseSource {
  location: EraseLocation;
  document: unknown;
  /** Checked like a revision (it must still parse as one): a fork point or a pre-merge copy. */
  revision: boolean;
  write: (tx: Prisma.TransactionClient, rewritten: unknown) => Promise<void>;
  /**
   * Set on a copy that is later written over main whole (the one kept for "Undo this merge"): when the erase
   * leaves a match in it, the copy is removed instead of rewritten, since the undo would carry that match back
   * into the working copy the owner has just cleaned.
   */
  drop?: (tx: Prisma.TransactionClient) => Promise<void>;
  branchSiteId: string | null;
}

/** What the working copy reads for an erase: the `sites` columns, the pages, and what is only reported. */
const WORKING_COPY_SELECT = {
  name: true,
  description: true,
  siteSettings: true,
  components: true,
  redirects: true,
  pages: { select: { pageId: true, slug: true, snapshot: true } },
  // Searched and reported (blocked as `separate`), never rewritten: a domain and an A/B test
  // are changed where they are set.
  domains: { orderBy: { id: 'asc' }, select: { subdomain: true, hostname: true, customHostname: true } },
  experiments: { orderBy: { experimentKey: 'asc' }, select: { experimentKey: true, config: true } },
} as const;

/** The working copy as one document, in the shape the walker reads (pages by id, so the order is stable). */
function workingDocument(site: {
  name: string;
  description: string;
  siteSettings: unknown;
  components: unknown;
  redirects: unknown;
  pages: Array<{ pageId: string; slug: string; snapshot: unknown }>;
  domains: unknown[];
  experiments: unknown[];
}): Record<string, unknown> {
  return {
    name: site.name,
    description: site.description,
    siteSettings: site.siteSettings,
    components: site.components,
    redirects: site.redirects,
    pages: [...site.pages]
      .sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0))
      .map((p) => ({ pageId: p.pageId, slug: p.slug, snapshot: p.snapshot })),
    domains: site.domains,
    experiments: site.experiments,
  };
}

/** A place as the audit keeps it: a key or an id that holds the value is replaced by a marker. */
function placeOf(match: EraseMatch, holdsValue: (segment: string) => boolean): ErasurePlace {
  return {
    location: match.location.kind,
    revision: match.location.kind === 'revision' ? match.location.number : null,
    branchId: 'branchId' in match.location ? match.location.branchId : null,
    pageId: redactedId(match.pageId, holdsValue),
    area: match.area,
    path: redactedPath(match.path, holdsValue),
  };
}

function parsePlaces(raw: unknown): ErasurePlace[] {
  return Array.isArray(raw) ? (raw as ErasurePlace[]) : [];
}

export function assertScope(scope: TenantScope): void {
  if (
    !scope ||
    typeof scope.workspaceId !== 'string' ||
    scope.workspaceId.length === 0 ||
    typeof scope.tenantGroupId !== 'string' ||
    scope.tenantGroupId.length === 0
  ) {
    throw new InvalidTenantScopeError();
  }
}

/** What a write of the working copy (save, publish) takes besides the project. */
export interface WorkingCopyWriteOptions {
  /**
   * The written copy is one this site stored before, put back whole (undoing a merge): its slugs are taken as
   * stored, so the slug rules for new and changed slugs do not refuse a copy the site already held.
   */
  restoresStoredCopy?: boolean;
  /** Update an existing site only, never create one (the editor's Save and Publish). */
  mustExist?: boolean;
  /** The verified session's company, stamped on the site while it has none. */
  companyId?: string;
  /**
   * The site version the written copy was based on. Required whenever the site
   * already exists; only creating a new site goes without.
   */
  expectedVersion?: number;
  /**
   * The editor's key for this attempt (save only). A repeat of the site's last
   * write (the stored key, bound to the version it wrote, which is still the
   * current one) returns that write's version and writes nothing: its first
   * answer was lost on the way back.
   */
  requestKey?: string;
  /**
   * The editor's earlier attempts on the same base whose answers were lost
   * (save and publish). When the stored write is one of them, still the latest
   * (its key bound to the current version), this write goes on top of it
   * instead of a 409: every version it moved past was this tab's own.
   */
  previousRequestKeys?: readonly string[];
  /**
   * Who writes, for the site's live stream (src/server/sites/liveBus.ts): open
   * editors hear a `site:version` with it once the write commits. A write that
   * names none is announced as the editor's, with no tab and no actor.
   */
  event?: SiteWriteEvent;
  /**
   * Run once the write committed and before open editors hear of it (save only;
   * never for a write that wrote nothing). An MCP batch fulfils the skeleton
   * plans it wrote here, so their `plan:update` always reaches an editor before
   * the `site:version` that makes it fetch the new copy. A failure is logged and
   * never undoes the write.
   */
  beforeAnnounce?: (version: number) => void;
  /**
   * Save only: when it aborts before the transaction commits, the write rolls
   * back and the save throws SaveAbortedError (nothing is written, nothing is
   * announced). An abort after the commit changes nothing.
   */
  signal?: AbortSignal;
}

/** A save whose signal aborted before its transaction committed: nothing was written. */
export class SaveAbortedError extends Error {
  constructor() {
    super('the save was aborted before it committed; nothing was written');
    this.name = 'SaveAbortedError';
  }
}

/** What the shared working-copy write did. */
export interface WorkingCopyWrite {
  version: number;
  /** The version before; equal to `version` when nothing was written (a repeat of a lost answer). */
  versionBefore: number;
  wrote: boolean;
}

/**
 * Tell the site's open editors about a committed write. Called after the
 * transaction resolved, never inside it, so a refused or rolled back write is
 * never announced. A failure is logged and never undoes the write.
 */
export function announceWrite(siteId: string, write: WorkingCopyWrite, event: SiteWriteEvent | undefined, written?: PersistedSite): void {
  if (!write.wrote) return;
  // The newest written version, so an announcement checked against an older read is refused (src/server/mcp/livePlans.ts).
  noteSiteWrite(siteId, write.version);
  // An agent's announced skeletons stand on a page and after a section: a write
  // that removed either ends them (src/server/mcp/livePlans.ts). Only when the
  // site holds a plan, so an ordinary save pays nothing.
  if (written && hasPlans(siteId)) checkPlanAnchors(siteId, written.pages);
  try {
    const payload: SiteVersionEvent = {
      ...boundedWriteEvent(event ?? { origin: 'editor' }),
      version: write.version,
      versionBefore: write.versionBefore,
    };
    publishSiteEvent(siteId, LIVE_EVENTS.siteVersion, payload);
  } catch (err) {
    console.error(`[live] the write of site ${siteId} at version ${write.version} could not be announced`, err);
  }
}

export class SiteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * List the sites in the caller's workspace, newest first. No page snapshots
   * loaded — a cheap index-backed scan for a dashboard listing.
   */
  async listSites(scope: TenantScope): Promise<SiteSummary[]> {
    assertScope(scope);
    const rows = await this.prisma.site.findMany({
      // Main sites only: a branch is a hidden site row, shown inside its site, never as a site of its own.
      where: { workspaceId: scope.workspaceId, branchOfSiteId: null },
      orderBy: { createdAt: 'desc' },
      select: {
        _count: { select: { branchSites: true } },
        id: true,
        name: true,
        description: true,
        status: true,
        lumitraEnabled: true,
        createdAt: true,
        updatedAt: true,
        siteSettings: true,
        domains: {
          select: { subdomain: true, hostname: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return rows.map((r) => ({
      subdomain: r.domains.find((d) => d.subdomain)?.subdomain ?? null,
      customDomains: r.domains.flatMap((d) => (d.hostname ? [d.hostname] : [])),
      siteId: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      lumitraEnabled: r.lumitraEnabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      openBranches: r._count.branchSites,
      cardColors: siteCardColors(normalizeSiteSettings(r.siteSettings).theme),
    }));
  }

  /**
   * Which of `workspaceIds` (the caller's OWN workspaces, from the verified
   * session) holds `siteId`, or null. The query is restricted to those
   * workspaces, so a site in a workspace the caller is not a member of is
   * indistinguishable from a missing one: existence never leaks. Used to offer
   * "switch workspace" for a project link that belongs to another of the
   * caller's workspaces instead of a bare 404.
   */
  async findSiteWorkspaceAmong(siteId: string, workspaceIds: string[]): Promise<string | null> {
    if (workspaceIds.length === 0) return null;
    const row = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: { in: workspaceIds } },
      select: { workspaceId: true },
    });
    return row?.workspaceId ?? null;
  }

  /**
   * Load a site + all its pages, scoped to the caller's workspace, and rebuild
   * a live ProjectModel (the editor working copy). Throws SiteNotFoundError
   * when the site is absent OR belongs to another workspace — the two are
   * indistinguishable so existence never leaks across the boundary.
   */
  /**
   * The site's current version alone, scoped like a load (a site of another
   * workspace reads as missing): what the live stream compares a reconnect's
   * Last-Event-ID with, without loading the project.
   */
  async getSiteVersion(scope: TenantScope, siteId: string): Promise<number> {
    assertScope(scope);
    const row = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: { version: true },
    });
    if (!row) throw (await closedBranchError(this.prisma, scope.workspaceId, siteId)) ?? new SiteNotFoundError(siteId);
    return row.version;
  }

  async loadProject(scope: TenantScope, siteId: string): Promise<ProjectModelType> {
    return (await this.loadProjectWithVersion(scope, siteId)).project;
  }

  /**
   * {@link loadProject}, plus the site's `version` read in the same query: the
   * number a later save or publish of this copy names as its `expectedVersion`.
   */
  async loadProjectWithVersion(
    scope: TenantScope,
    siteId: string,
  ): Promise<{ project: ProjectModelType; version: number; mainSiteId: string | null }> {
    assertScope(scope);
    // workspace_id IS in the where-clause, so a cross-workspace site simply
    // returns null here — never another tenant's data.
    const row = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: {
        id: true,
        name: true,
        description: true,
        analyticsProjectId: true,
        ingestionEndpoint: true,
        apiKeyRef: true,
        lumitraEnabled: true,
        siteSettings: true,
        components: true,
        projectCreatedAt: true,
        projectUpdatedAt: true,
        erasureEpoch: true,
        version: true,
        // Set on a site branch: its main site. Callers that must treat a branch differently (the agent
        // operations hide one while site branches are off) learn it here, without a read of their own.
        branchOfSiteId: true,
        pages: {
          select: { pageId: true, snapshot: true },
        },
      },
    });
    if (!row) throw (await closedBranchError(this.prisma, scope.workspaceId, siteId)) ?? new SiteNotFoundError(siteId);

    const rowData: SiteRowData = {
      id: row.id,
      name: row.name,
      description: row.description,
      analyticsProjectId: row.analyticsProjectId,
      ingestionEndpoint: row.ingestionEndpoint,
      apiKeyRef: row.apiKeyRef,
      lumitraEnabled: row.lumitraEnabled,
      siteSettings: row.siteSettings,
      components: row.components,
      projectCreatedAt: row.projectCreatedAt,
      projectUpdatedAt: row.projectUpdatedAt,
      erasureEpoch: row.erasureEpoch,
      pages: row.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
    };

    return { project: ProjectModel.create(persistedToProjectSnapshot(rowData)), version: row.version, mainSiteId: row.branchOfSiteId ?? null };
  }

  /**
   * Persist a ProjectModel (live instance or its SnapshotOut) into the
   * `sites` + `site_pages` tables, scoped to the caller's workspace. Upsert
   * semantics: the site row is created or updated by id, and pages are
   * reconciled (upsert present, delete removed) so a save reflects the editor
   * state exactly. The whole save runs in one transaction so a site is never
   * left with a half-written page set.
   *
   * A save of a site id that already exists in ANOTHER workspace is rejected
   * (SiteNotFoundError): the id is "taken" by a foreign tenant and must not be
   * silently overwritten or duplicated across the boundary.
   *
   * A save NEVER changes what visitors see: they read a frozen revision
   * (publishProject). This is the editor's working copy, which the draft preview
   * and the next publish read.
   *
   * The version lock: saving a site that already exists needs `expectedVersion`,
   * the version the caller loaded (loadProjectWithVersion) or last saved. A
   * different stored version refuses the save (SiteChangedError, carrying the
   * stored one) and none at all is refused too (SiteVersionRequiredError): there
   * is no "newest wins" path. Only creating a new site goes without one. Returns
   * the version the save wrote.
   */
  async saveProject(
    scope: TenantScope,
    project: ProjectModelType | Parameters<typeof projectToPersisted>[0],
    options: WorkingCopyWriteOptions = {},
  ): Promise<{ version: number }> {
    assertScope(scope);
    const persisted: PersistedSite = projectToPersisted(project);

    // The save locks THE SITE and runs at the default (read committed) level, as publishProject does. The
    // redirect list is read, changed and written back, so two saves of one site must not interleave: the site's
    // lock makes the second wait for the first and then read what it wrote. SERIALIZABLE used to carry this, and
    // it also aborted saves of DIFFERENT sites against each other (Postgres' predicate locks coarsen to pages, so
    // two unrelated saves touching the same index page conflicted, and four immediate retries could all lose;
    // docs/plans/2026-11-12-save-serializable-contention.md). The version lock, the slug rules, the redirects
    // and the image check all read after the lock is taken, so each statement sees everything committed before.
    // Still retried: a deadlock (P2034) or a first save of one id that two creators race on (P2002).
    const write = await withSerializationRetry(() => this.prisma.$transaction(
      async (tx) => {
        if (options.signal?.aborted) throw new SaveAbortedError();
        const mainId = await this.lockSiteForSave(tx, scope, persisted);
        const written = await this.aroundCustomCode(tx, persisted.siteId, mainId, 'save', () => this.writeWorkingCopy(tx, scope, persisted, options));
        // Thrown inside the transaction, so an abort that came while it waited rolls the write back.
        if (options.signal?.aborted) throw new SaveAbortedError();
        return written;
      },
      PROJECT_WRITE_TRANSACTION,
    ));
    if (write.wrote && options.beforeAnnounce) {
      try {
        options.beforeAnnounce(write.version);
      } catch (err) {
        console.error(`[live] the write of site ${persisted.siteId} at version ${write.version} could not run its pre-announcement step`, err);
      }
    }
    announceWrite(persisted.siteId, write, options.event, persisted);
    return { version: write.version };
  }

  /**
   * Custom code around a working-copy write of `siteId` (a save, or a publish's write), in its transaction (plan
   * docs/plans/2026-11-02-sandboxed-custom-code.md, D113 and D114). Every write that can be refused or prune holds the
   * main site's row: a main save or publish FOR UPDATE, a branch save that names code FOR NO KEY UPDATE
   * (lockSiteForSave), and the guarded write FOR NO KEY UPDATE, all conflicting, so their reads of the site's code
   * never interleave and the budget is a hard limit, not a per-transaction one. A branch save that names no code
   * holds only its own row; it can only remove names, so it is never refused and prunes nothing.
   *
   *  - A site whose main site stores no blob pays one indexed read and nothing else: it names no live code, so it
   *    can never be over budget, and there is nothing to prune.
   *  - Otherwise the hashes the site's own working copy names are read before and after the write. When they did
   *    not change (every save that edits text, styles or layout), nothing more happens.
   *  - When the write names a hash that nothing else named, the code that brings to life is counted with all the
   *    site's live code, and a total over the budget refuses the write (CustomCodeBudgetError, the transaction rolls
   *    back). A write that only removes blocks, or names code something else already keeps, is never refused.
   *  - When the names changed on the main site, its unnamed blobs older than a week are pruned (D4). A branch's save
   *    prunes nothing: the blobs are its main site's, whose next save, publish or code write prunes them.
   *
   * `mainId` is the site's main site as the caller's lock read it (the site itself for a main site), or null for a
   * site being created, which stores no blob yet (blobs are keyed by an existing site's id). `kind` is for the
   * reasons only; the publish prunes once more after freezing its revision.
   */
  private async aroundCustomCode(
    tx: Prisma.TransactionClient,
    siteId: string,
    mainId: string | null,
    kind: 'save' | 'publish',
    write: () => Promise<WorkingCopyWrite>,
  ): Promise<WorkingCopyWrite> {
    if (mainId === null) return write();
    if (!(await siteHoldsBlobs(tx, mainId))) return write();
    const before = await workingCopyHashes(tx, siteId);
    const written = await write();
    if (!written.wrote) return written;
    const after = await workingCopyHashes(tx, siteId);
    const added = [...after.keys()].filter((sha256) => !before.has(sha256));
    const removed = [...before.keys()].some((sha256) => !after.has(sha256));
    if (added.length === 0 && !removed) return written;
    let named: NamedHashes | undefined;
    if (added.length > 0) {
      named = await namedHashes(tx, mainId);
      const outside = namedOutside(named, siteId, mainId);
      const broughtToLife = new Set(added.filter((sha256) => !outside.has(sha256)));
      if ((await bytesOfBlobs(tx, mainId, broughtToLife)) > 0) {
        const total = await bytesOfBlobs(tx, mainId, allNamed(named));
        if (total > SITE_CODE_BUDGET_BYTES) {
          console.info(`[custom code] site ${siteId}: a ${kind} was refused, it would name ${total} bytes of code`);
          throw new CustomCodeBudgetError(total, SITE_CODE_BUDGET_BYTES, sizeInWords);
        }
      }
    }
    if (siteId === mainId) await pruneUnnamedBlobs(tx, mainId, new Date(), named);
    return written;
  }

  /**
   * The locks a save takes before it reads anything, in this order:
   *
   *  1. A transaction advisory lock on the site id, so two creators of one id queue even though there is no row
   *     to lock yet (the second then finds the first's site and is refused by the version lock).
   *  2. For a branch whose document carries an uploaded image's path ANYWHERE (an image is its main site's): the main
   *     site's row, FOR SHARE. This is the text search the delete does (referencedHashes), not only the places the
   *     save checks (namedImagesOf), because the delete protects every place the path can sit.
   *     Deleting an image takes main's row FOR UPDATE (siteImages.ts), so a delete and this save cannot overlap:
   *     the delete then sees this branch's pages, or this save then finds the image gone. Shared, so branch saves
   *     do not wait for one another here. Main is always taken before the branch, the order of the branch merge
   *     (lockPair) and of an erase of personal data, so no two writers wait for each other in a circle.
   *     A branch whose document names a custom code hash takes main's row FOR NO KEY UPDATE instead (D113, D114):
   *     its budget reads main's blobs and every copy naming them, so it must not interleave with a guarded write
   *     (FOR NO KEY UPDATE), a main save or publish (FOR UPDATE), or another branch save naming code. That lock also
   *     conflicts with an image delete's FOR UPDATE, so it covers what FOR SHARE was taken for. A branch save naming
   *     no code can only remove names, is never refused and never prunes, so it keeps the shared lock.
   *  3. The site's own row FOR UPDATE, as publish takes it: every other writer of this site's row waits.
   *
   * A site in another workspace matches no row here; writeWorkingCopy refuses it as before. Returns the site's main
   * site as that last lock read it (the site itself for a main site), or null when there is no such row yet.
   */
  private async lockSiteForSave(tx: Prisma.TransactionClient, scope: TenantScope, persisted: PersistedSite): Promise<string | null> {
    const siteId = persisted.siteId;
    await tx.$queryRaw`SELECT 1 FROM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`site_save:${siteId}`}))`;
    const namesCode = carriesCustomCodeHash(persisted);
    if (namesCode || carriesSiteImagePath(persisted)) {
      const own = await tx.$queryRaw<{ branch_of_site_id: string | null }[]>`SELECT branch_of_site_id FROM public.sites WHERE id = ${siteId} AND workspace_id = ${scope.workspaceId}`;
      const mainId = own[0]?.branch_of_site_id;
      if (mainId && namesCode) {
        await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${mainId} AND workspace_id = ${scope.workspaceId} FOR NO KEY UPDATE`;
      } else if (mainId) {
        await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${mainId} AND workspace_id = ${scope.workspaceId} FOR SHARE`;
      }
    }
    const locked = await tx.$queryRaw<{ branch_of_site_id: string | null }[]>`SELECT branch_of_site_id FROM public.sites WHERE id = ${siteId} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
    // Read under the lock, so it is the site's main site for the whole transaction (a branch is never re-parented).
    return locked.length === 0 ? null : (locked[0].branch_of_site_id ?? siteId);
  }

  /**
   * The working-copy write inside the caller's transaction, for a site branch's update and merge
   * (src/server/sites/branches/merge.ts), which lock main and the branch first and write the record in the same
   * transaction. The caller holds the site's lock (main's and the branch's, in that order) and announces with
   * `announceWrite` after the commit.
   */
  writeWorkingCopyIn(
    tx: Prisma.TransactionClient,
    scope: TenantScope,
    persisted: PersistedSite,
    options: WorkingCopyWriteOptions,
  ): Promise<WorkingCopyWrite> {
    assertScope(scope);
    return this.writeWorkingCopy(tx, scope, persisted, options);
  }

  /**
   * The working-copy write shared by save and publish: the `sites` row and the
   * reconciled `site_pages` rows, inside the caller's transaction. Writes
   * nothing a visitor reads, apart from the one baseline freeze below. Returns
   * the site's new version, the one before, and whether anything was written.
   */
  private async writeWorkingCopy(
    tx: Prisma.TransactionClient,
    scope: TenantScope,
    persisted: PersistedSite,
    options: WorkingCopyWriteOptions,
  ): Promise<WorkingCopyWrite> {
    // Guard: if this site id already exists, it MUST be in the caller's
    // workspace. A row in another workspace means a cross-tenant collision:
    // refuse rather than overwrite or leak.
    const existing = await tx.site.findUnique({
      where: { id: persisted.siteId },
      select: {
        id: true,
        workspaceId: true,
        redirects: true,
        siteSettings: true,
        status: true,
        publishedRevisionId: true,
        erasureEpoch: true,
        version: true,
        lastWriteKey: true,
        lastWriteVersion: true,
        branchOfSiteId: true,
      },
    });
    if (existing && existing.workspaceId !== scope.workspaceId) {
      throw new SiteNotFoundError(persisted.siteId);
    }
    // A tab loaded before personal data was erased may still hold it: its Save or
    // Publish would write the value back into the working copy, and a publish
    // into a new revision. Refused, before anything is written or frozen.
    // A higher number than the server's cannot come from an honest tab either.
    if (existing && persisted.erasureEpoch !== existing.erasureEpoch) {
      throw new SiteErasedSinceLoadError();
    }
    // The editor's Save and Publish pass `mustExist`: they update a site, never
    // create one. Without this, an editor tab still open on a DELETED project
    // would bring it back on its next save (the upsert below creates).
    if (options.mustExist && !existing) {
      // A merged or discarded branch answers 410 `branch_closed`, naming its site, so the tab can say what happened.
      throw (await closedBranchError(tx, scope.workspaceId, persisted.siteId)) ?? new SiteGoneError();
    }
    // The version lock, after the erasure check (a tab that may hold erased data
    // must reload, never "save over"): an existing site is only written by a
    // caller that names the version it was based on, and only while that is
    // still the stored one. Below, the UPDATE repeats the comparison in its
    // WHERE, so the check holds even where the row lock is not held (a branch's update and merge).
    // The stored key counts only while the write it names is still the latest:
    // the key is bound to the version it wrote. A writer that does not know the
    // key (an older container during a rolling deploy) moves the version
    // without touching the key, and that unbinds it.
    const latestKey =
      existing && existing.lastWriteKey && existing.lastWriteVersion === existing.version ? existing.lastWriteKey : undefined;
    // A retry of the last write whose answer was lost: answered again, nothing written.
    if (existing && options.requestKey && latestKey === options.requestKey) {
      return { version: existing.version, versionBefore: existing.version, wrote: false };
    }
    // The latest write is one of this tab's lost ones (one or several in a
    // row): build on the version it produced.
    const ownLostWrite = !!latestKey && !!options.previousRequestKeys?.includes(latestKey);
    if (existing && !ownLostWrite) {
      if (options.expectedVersion === undefined) throw new SiteVersionRequiredError();
      if (options.expectedVersion !== existing.version) throw new SiteChangedError(existing.version);
    }
    const nextVersion = existing ? existing.version + 1 : 1;

    // Slug rules (src/lib/pages/slug.ts), checked against the slugs stored
    // today: an unchanged slug is grandfathered, a new or changed one must be
    // valid and unique, the home page's empty slug never changes. A request
    // that breaks them writes nothing (400).
    const storedRows = existing
      ? await tx.sitePage.findMany({
          where: { siteId: persisted.siteId },
          select: { pageId: true, slug: true },
        })
      : [];
    // A copy this site stored before (an undone merge writes one back) keeps every slug it was stored with: the
    // rules for a new slug may have tightened since, and a slug the merge changed is not "new" on the way back.
    // The redirects below still compare with what is stored today.
    const storedSlugs = new Map(storedRows.map((r) => [r.pageId, r.slug]));
    const grandfathered = options.restoresStoredCopy ? new Map(persisted.pages.map((p) => [p.pageId, p.slug])) : storedSlugs;
    const problem = findProjectSlugProblem(
      persisted.pages.map((p) => ({
        pageId: p.pageId,
        slug: p.slug,
        title: (p.snapshot as { metadata?: { title?: unknown } }).metadata?.title as string | undefined,
      })),
      grandfathered,
    );
    if (problem) throw new InvalidPageSlugError(problem.pageId, problem.code, problem.message);

    // `theme` and `head` the body lacked (a tab built before they existed) keep
    // what the row stores: the column is one blob, replaced whole below.
    // Theme caps (THEME_LIMITS), checked against the stored theme: the editor's own
    // check never runs for a request built by hand. A count already over a cap may stay.
    const siteSettings = mergeKeptSiteSettings(persisted.siteSettings, existing?.siteSettings);
    const themeProblems = themeBoundsErrors(siteSettings.theme, normalizeSiteSettings(existing?.siteSettings).theme);
    if (themeProblems.length > 0) throw new InvalidSiteThemeError(themeProblems);

    // Uploaded images (src/lib/site/siteImages.ts): each one the settings or a
    // page names must be stored for THIS site, or a visitor would get a broken
    // icon or sharing image. Read in this transaction, so an image deleted by a
    // concurrent delete (which takes this site row first, src/server/sites/
    // siteImages.ts) cannot slip through.
    // The same holds for an image an FX scene shows, on a page or in a component
    // definition (src/lib/fxScene/fxScene.ts): its island would draw nothing for a
    // path this site does not store.
    const named = namedImagesOf(persisted);
    if (named.size > 0) {
      // A branch's images are its main site's (stored once there, usable by every branch). An image delete scans
      // every branch's pages under main's row lock, which a branch save naming an image holds shared (see
      // lockSiteForSave), so a delete and a branch save naming the same image cannot both commit: one is refused,
      // as for main.
      const stored = await tx.siteImage.findMany({
        where: { siteId: existing?.branchOfSiteId ?? persisted.siteId, sha256: { in: [...named.keys()] } },
        select: { sha256: true },
      });
      const have = new Set(stored.map((s) => s.sha256));
      const missing = [...named].find(([sha256]) => !have.has(sha256));
      if (missing) throw new SiteImageMissingError(missing[1]);
    }

    // A site published before revisions existed is served from these very rows
    // (publicResolver.ts). Freeze them before they change: the save goes on
    // writing the working copy, and visitors keep what they had.
    if (existing?.status === 'published' && existing.publishedRevisionId === null) {
      const baseline = await this.freezeRevision(tx, scope, persisted.siteId, {
        kind: 'baseline',
        publishedBy: null,
      });
      await tx.site.updateMany({
        where: { id: persisted.siteId, workspaceId: scope.workspaceId },
        data: { publishedRevisionId: baseline.id },
      });
    }

    // Old-slug redirects (src/lib/pages/redirects.ts): once a site has been
    // published (it holds a platform subdomain), a changed slug keeps its old
    // path as a redirect to the page. Cleaned on every save: entries for
    // deleted pages, or whose path a page now claims, are dropped.
    const everPublished = existing
      ? (await tx.siteDomain.findFirst({
          where: { siteId: persisted.siteId, subdomain: { not: null } },
          select: { id: true },
        })) !== null
      : false;
    const redirects = nextSiteRedirects({
      previous: parseSiteRedirects(existing?.redirects),
      storedSlugs,
      pages: persisted.pages,
      everPublished,
      now: new Date(),
    });

    // Only a present key writes: a tab loaded before the column existed sends
    // none, and that must not empty it. In this transaction, so a definition
    // and the pages placing it are never saved apart, and before any freeze
    // below reads the column back.
    const componentsColumn = persisted.components
      ? { components: persisted.components as unknown as Prisma.InputJsonValue }
      : {};

    const updateData = {
      description: persisted.description,
      analyticsProjectId: persisted.analyticsProjectId,
      ingestionEndpoint: persisted.ingestionEndpoint,
      apiKeyRef: persisted.apiKeyRef,
      lumitraEnabled: persisted.lumitraEnabled,
      siteSettings: siteSettings as unknown as Prisma.InputJsonValue,
      // projectCreatedAt is immutable (set on create); only the
      // application "last edited" time advances on update.
      projectUpdatedAt: new Date(persisted.projectUpdatedAt),
      redirects: redirects as unknown as Prisma.InputJsonValue,
      version: nextVersion,
      // Only a save names its attempt; any other write ends the old key's life.
      lastWriteKey: options.requestKey ?? null,
      lastWriteVersion: options.requestKey ? nextVersion : null,
      ...componentsColumn,
    };

    if (options.mustExist) {
      // UPDATE, never INSERT: a delete that committed after the read above
      // leaves zero rows here, so the site is NOT re-created. (A save holds the
      // site's row lock, and a delete takes it too, so they do not overlap: the
      // later one sees the other's outcome.)
      const updated = await tx.site.updateMany({
        where: { id: persisted.siteId, workspaceId: scope.workspaceId, version: existing?.version },
        data: updateData,
      });
      if (updated.count === 0) {
        // Gone, or written by someone else since the read above.
        const current = await tx.site.findFirst({
          where: { id: persisted.siteId, workspaceId: scope.workspaceId },
          select: { version: true },
        });
        if (!current) throw (await closedBranchError(tx, scope.workspaceId, persisted.siteId)) ?? new SiteGoneError();
        throw new SiteChangedError(current.version);
      }
    } else {
      // Upsert the site row. On create, status defaults to `draft` (the DB
      // default); on update, status is left untouched (publish/archive own it).
      await tx.site.upsert({
        where: { id: persisted.siteId },
        create: {
          id: persisted.siteId,
          workspaceId: scope.workspaceId,
          tenantGroupId: scope.tenantGroupId,
          name: persisted.name,
          description: persisted.description,
          analyticsProjectId: persisted.analyticsProjectId,
          ingestionEndpoint: persisted.ingestionEndpoint,
          apiKeyRef: persisted.apiKeyRef,
          lumitraEnabled: persisted.lumitraEnabled,
          siteSettings: siteSettings as unknown as Prisma.InputJsonValue,
          projectCreatedAt: new Date(persisted.projectCreatedAt),
          projectUpdatedAt: new Date(persisted.projectUpdatedAt),
          redirects: redirects as unknown as Prisma.InputJsonValue,
          companyId: options.companyId ?? null,
          version: nextVersion,
          lastWriteKey: options.requestKey ?? null,
          lastWriteVersion: options.requestKey ? nextVersion : null,
          ...componentsColumn,
        },
        // `name` is written on create only. After that the rename action
        // (renameSite, PATCH /api/projects/<id>) and an erase of personal data
        // (erasePersonalData) are its only writers: an editor
        // tab opened before a rename still carries the old title in its
        // snapshot, and a later Save or Publish from it must not silently undo
        // the rename.
        update: updateData,
      });
    }

    // The site's company (sites.company_id, read by the storefront's catalogue): filled from the
    // server-verified session when still empty, never overwritten (a company keeps its workspace).
    if (options.companyId) {
      await tx.site.updateMany({
        where: { id: persisted.siteId, workspaceId: scope.workspaceId, companyId: null },
        data: { companyId: options.companyId },
      });
    }

    // Reconcile pages: upsert every current page, then delete any page row
    // whose pageId is no longer present in the snapshot. tenant_group_id and
    // workspace_id are stamped on every child row.
    const keepPageIds = persisted.pages.map((p) => p.pageId);

    for (const page of persisted.pages) {
      await tx.sitePage.upsert({
        where: {
          siteId_pageId: { siteId: persisted.siteId, pageId: page.pageId },
        },
        create: {
          siteId: persisted.siteId,
          workspaceId: scope.workspaceId,
          tenantGroupId: scope.tenantGroupId,
          pageId: page.pageId,
          slug: page.slug,
          snapshot: page.snapshot as Prisma.InputJsonValue,
        },
        update: {
          slug: page.slug,
          snapshot: page.snapshot as Prisma.InputJsonValue,
        },
      });
    }

    // Delete page rows no longer in the snapshot. When the snapshot has zero
    // pages, `notIn: []` in Prisma matches NOTHING, so the empty case is
    // handled explicitly: delete every page for the site.
    await tx.sitePage.deleteMany({
      where:
        keepPageIds.length > 0
          ? { siteId: persisted.siteId, pageId: { notIn: keepPageIds } }
          : { siteId: persisted.siteId },
    });
    return { version: nextVersion, versionBefore: existing ? existing.version : 0, wrote: true };
  }

  /**
   * Copy what is stored for a site right now into a new revision, inside the
   * caller's transaction, and return it. Read back rather than taken from the
   * request: the name has its own writer, the redirects are computed by the save,
   * and a tab older than the components column sends no definitions, so the
   * column (written just before, or kept) is what freezes. The caller holds the
   * site row (a lock or SERIALIZABLE), so nothing interleaves with that write.
   */
  private async freezeRevision(
    tx: Prisma.TransactionClient,
    scope: TenantScope,
    siteId: string,
    revision: {
      kind: 'publish' | 'baseline';
      publishedBy: string | null;
    },
  ): Promise<{ id: string; number: number }> {
    const site = await tx.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: {
        name: true,
        description: true,
        analyticsProjectId: true,
        ingestionEndpoint: true,
        apiKeyRef: true,
        lumitraEnabled: true,
        redirects: true,
        siteSettings: true,
        components: true,
        pages: { select: { pageId: true, slug: true, snapshot: true } },
      },
    });
    if (!site) throw new SiteNotFoundError(siteId);

    const newest = await tx.siteRevision.findFirst({
      where: { siteId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const number = (newest?.number ?? 0) + 1;

    const created = await tx.siteRevision.create({
      data: {
        siteId,
        workspaceId: scope.workspaceId,
        tenantGroupId: scope.tenantGroupId,
        number,
        kind: revision.kind,
        publishedBy: revision.publishedBy,
        document: buildRevisionDocument(site) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: created.id, number };
  }

  /** Throws BranchCannotPublishError when `siteId` is a branch in the caller's workspace. */
  private async refuseBranch(client: PrismaClient | Prisma.TransactionClient, scope: TenantScope, siteId: string): Promise<void> {
    const row = await client.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: { branchOfSiteId: true },
    });
    if (row && row.branchOfSiteId) throw new BranchCannotPublishError();
  }

  /**
   * Rename a site, scoped to the caller's workspace. The only writer of
   * `Site.name` after creation (saveProject leaves it alone on update), apart
   * from erasePersonalData, which rewrites a matched value inside it.
   *
   * Concurrency: the name itself is the precondition, not the site's version.
   * With `expectedName` the update matches only while the stored name still
   * equals it, in the same UPDATE statement (no read-then-write window); a lost
   * race writes nothing and throws SiteNameConflictError with the current name.
   * Without it, last write wins. A rename leaves `version` alone on purpose: a
   * save never writes the name, so the two cannot overwrite each other, and
   * moving the version would make every open editor tab report a conflict that
   * could lose nothing.
   *
   * The published address never changes here: a site's subdomain is a random
   * label allocated on first publish (ensureSiteDomain) and custom domains are
   * separate rows; neither is derived from the name.
   *
   * A site in another workspace matches zero rows and is reported exactly like
   * a missing one (SiteNotFoundError), so existence never leaks.
   */
  async renameSite(
    scope: TenantScope,
    siteId: string,
    name: string,
    expectedName?: string,
  ): Promise<{ name: string; updatedAt: Date }> {
    assertScope(scope);
    const updatedAt = new Date();
    const result = await this.prisma.site.updateMany({
      where: {
        id: siteId,
        workspaceId: scope.workspaceId,
        // Defence in depth, as the per-project guards do: the row must also
        // carry the tenant group the session names for this workspace.
        tenantGroupId: scope.tenantGroupId,
        ...(expectedName !== undefined ? { name: expectedName } : {}),
      },
      data: { name, projectUpdatedAt: updatedAt },
    });
    if (result.count === 1) {
      // The name is in the editor's document but moves no version: the kept copy of it is stale now.
      forgetSiteDocuments(siteId);
      // On a branch the name is part of what a merge writes, and "Looks good" is bound to the branch's version,
      // which a rename does not move: a reviewer's approval is for the name they saw, so it goes.
      await this.prisma.siteBranch.updateMany({
        where: { branchSiteId: siteId, workspaceId: scope.workspaceId, approvedBranchVersion: { not: null } },
        data: { approvedBy: null, approvedAt: null, approvedBranchVersion: null },
      });
      return { name, updatedAt };
    }

    // Nothing matched: tell a missing (or foreign) site from a lost race.
    const current = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
      select: { name: true, projectUpdatedAt: true },
    });
    if (!current) throw new SiteNotFoundError(siteId);
    if (current.name === name) {
      // Someone (often this same user in another tab) already set exactly this
      // name: the outcome the caller asked for, so it is not a conflict.
      return { name, updatedAt: current.projectUpdatedAt };
    }
    throw new SiteNameConflictError(siteId, current.name);
  }

  /**
   * Publish: write the project as the working copy, freeze a revision of it,
   * point the site at that revision and set it `published`, as ONE transaction
   * (plan 2026-11-01-immutable-published-copy). A failure leaves nothing half
   * done. Like Save, it only ever updates an existing site in the caller's
   * workspace.
   *
   * The lock on the site row comes first and replaces SERIALIZABLE: saves and
   * renames update that row, so they queue behind it (or a SERIALIZABLE save is
   * aborted and retried) and cannot land in the revision, and two publishes of a
   * site run one after the other. SERIALIZABLE here made publishes of UNRELATED
   * sites abort each other: 8 at once already lost 3 to P2034.
   *
   * The version lock applies as for a save (`expectedVersion` required, a stale
   * one refused with SiteChangedError before anything is written or frozen).
   * Returns the revision number and the site's new version.
   */
  async publishProject(
    scope: TenantScope,
    project: ProjectModelType | Parameters<typeof projectToPersisted>[0],
    options: {
      companyId?: string;
      publishedBy?: string;
      expectedVersion?: number;
      previousRequestKeys?: readonly string[];
      /** Who publishes, for the live stream (WorkingCopyWriteOptions.event); its origin is always `publish`. */
      event?: Omit<SiteWriteEvent, 'origin'>;
    } = {},
  ): Promise<{ revision: number; version: number }> {
    assertScope(scope);
    const persisted: PersistedSite = projectToPersisted(project);
    const siteId = persisted.siteId;

    const published = await withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${siteId} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
      // Only main is ever published (the database's CHECK would refuse it too, after the write).
      await this.refuseBranch(tx, scope, siteId);
      // Main only (refused above), and it exists (the write below must find it), so it is its own main site.
      const write = await this.aroundCustomCode(tx, siteId, siteId, 'publish', () => this.writeWorkingCopy(tx, scope, persisted, {
        mustExist: true,
        companyId: options.companyId,
        expectedVersion: options.expectedVersion,
        // A save of this tab whose answer was lost may be the latest write: publish on top of it.
        ...(options.previousRequestKeys ? { previousRequestKeys: options.previousRequestKeys } : {}),
      }));
      const revision = await this.freezeRevision(tx, scope, siteId, {
        kind: 'publish',
        publishedBy: options.publishedBy ?? null,
      });
      const updated = await tx.site.updateMany({
        where: { id: siteId, workspaceId: scope.workspaceId },
        data: { status: 'published', publishedRevisionId: revision.id },
      });
      if (updated.count === 0) throw new SiteNotFoundError(siteId);
      await tx.siteRevision.deleteMany({
        where: { siteId, number: { lte: revision.number - REVISIONS_KEPT } },
      });
      // D4 and D113: in the transaction that prunes revisions, the blobs nothing names any more, once a week old.
      if (await siteHoldsBlobs(tx, siteId)) await pruneUnnamedBlobs(tx, siteId, new Date());
      return { revision: revision.number, write };
    }, PROJECT_WRITE_TRANSACTION));
    announceWrite(siteId, published.write, { ...options.event, origin: 'publish' }, persisted);
    return { revision: published.revision, version: published.write.version };
  }

  /**
   * Make an earlier revision live again: moves the site's pointer and sets it
   * `published`. The revision is not copied and the working copy is not touched,
   * so a rollback destroys nothing and is itself undone by another rollback,
   * except that it brings an offline site back: the dialog asks first.
   * The caller revalidates the cache, exactly as after a publish. Since the
   * working copy stays as it was, the site's version stays too.
   *
   * Scoped like everything here: a site in another workspace reads as missing,
   * and a number this site never had (or that was pruned) changes nothing.
   */
  async rollbackToRevision(scope: TenantScope, siteId: string, number: number): Promise<void> {
    assertScope(scope);
    await withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      const where = { id: siteId, workspaceId: scope.workspaceId };
      const site = await tx.site.findFirst({ where, select: { id: true, branchOfSiteId: true } });
      if (!site) throw new SiteNotFoundError(siteId);
      if (site.branchOfSiteId) throw new BranchCannotPublishError();
      const revision = await tx.siteRevision.findFirst({
        where: { siteId, workspaceId: scope.workspaceId, number },
        select: { id: true },
      });
      if (!revision) throw new SiteRevisionNotFoundError(siteId, number);
      await tx.site.updateMany({
        where,
        data: { status: 'published', publishedRevisionId: revision.id },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /**
   * The publish warnings for one revision (missing Impressum, placeholders), for
   * the confirmation before making it live. Scoped like rollback.
   */
  async checkRevision(scope: TenantScope, siteId: string, number: number): Promise<PublishCheck> {
    assertScope(scope);
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: {
        revisions: { where: { number }, select: { document: true } },
      },
    });
    if (!site) throw new SiteNotFoundError(siteId);
    const [revision] = site.revisions;
    if (!revision) throw new SiteRevisionNotFoundError(siteId, number);
    return revisionPublishCheck(parseRevisionDocument(revision.document));
  }

  /**
   * A site's published history, newest first, without the documents. A site
   * published before revisions existed lists nothing until its first save or
   * publish freezes what it serves.
   */
  async listRevisions(scope: TenantScope, siteId: string): Promise<SiteRevisionList> {
    assertScope(scope);
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: {
        status: true,
        publishedRevisionId: true,
        revisions: {
          orderBy: { number: 'desc' },
          select: { id: true, number: true, kind: true, publishedBy: true, createdAt: true, rewrittenAt: true },
        },
      },
    });
    if (!site) throw new SiteNotFoundError(siteId);
    return {
      status: site.status,
      live: site.revisions.find((r) => r.id === site.publishedRevisionId)?.number ?? null,
      revisions: site.revisions.map(({ number, kind, publishedBy, createdAt, rewrittenAt }) => ({
        number,
        kind,
        publishedBy,
        createdAt,
        rewrittenAt,
      })),
    };
  }

  /**
   * Search every kept revision and the working copy for one personal value (the
   * erase preview, plan 2026-11-01-immutable-published-copy, "Erasing personal
   * data from the history"). One RepeatableRead snapshot, so the token describes
   * one consistent state; documents are read one at a time, never all at once.
   * Throws EraseQueryError for a value outside the bounds.
   */
  async searchPersonalData(scope: TenantScope, siteId: string, query: EraseQuery): Promise<PersonalDataSearch> {
    assertScope(scope);
    const matcher = eraseMatcher(query);
    return this.prisma.$transaction(async (tx) => {
      const site = await tx.site.findFirst({
        where: { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
        select: {
          ...WORKING_COPY_SELECT,
          branchOfSiteId: true,
          publishedRevisionId: true,
          revisions: { orderBy: { number: 'desc' }, select: { id: true, number: true, kind: true, createdAt: true } },
        },
      });
      if (!site) throw new SiteNotFoundError(siteId);
      if (site.branchOfSiteId) throw new SiteIsBranchError('erase personal data from its site; that covers every branch.');

      const all: EraseMatch[] = [];
      const locations: ErasureLocationSummary[] = [];
      const record = (matches: EraseMatch[], summary: Omit<ErasureLocationSummary, 'matches' | 'erasable'>) => {
        all.push(...matches);
        locations.push({ ...summary, matches: matches.length, erasable: matches.filter((m) => m.blocked === null).length });
      };

      const working: EraseLocation = { kind: 'working' };
      record(findMatches(workingDocument(site), working, matcher), {
        location: working,
        createdAt: null,
        kind: null,
        live: false,
      });
      for (const revision of site.revisions) {
        const row = await tx.siteRevision.findUnique({ where: { id: revision.id }, select: { document: true } });
        if (!row) continue; // pruned by a publish that committed after the list was read: not part of this snapshot
        const location: EraseLocation = { kind: 'revision', number: revision.number };
        record(findMatches(row.document, location, matcher), {
          location,
          createdAt: revision.createdAt,
          kind: revision.kind,
          live: revision.id === site.publishedRevisionId,
        });
      }
      for await (const source of this.branchEraseSources(tx, scope, siteId)) {
        record(findMatches(source.document, source.location, matcher), {
          location: source.location,
          createdAt: null,
          kind: null,
          live: false,
        });
      }
      // The code of the site's custom code blocks and proposals (D9), last, as the erase reads them.
      for await (const source of this.customCodeEraseSources(tx, scope, siteId)) {
        record(findMatches(source.document, source.location, matcher), {
          location: source.location,
          createdAt: null,
          kind: null,
          live: false,
        });
      }

      const erasable = all.filter((m) => m.blocked === null).length;
      return {
        token: matchesToken(all),
        total: all.length,
        erasable,
        blocked: all.length - erasable,
        matches: all.slice(0, ERASE_LIMITS.listed),
        truncated: all.length > ERASE_LIMITS.listed,
        locations,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, ...ERASE_TRANSACTION });
  }

  /**
   * Erase one personal value from every kept revision and the working copy, as
   * ONE transaction behind the site row's lock (publish and rollback queue behind
   * it). The search is run again under the lock: a token other than the
   * preview's means something changed in between, and nothing is written
   * (ErasePreviewStaleError). Only the matches in `chosen` change, and each of
   * them must be among the ones the preview listed: nothing the owner was not
   * shown and did not tick is ever rewritten. Every rewritten document, the
   * working copy included, must keep its shape, or everything rolls back. The site's erasure
   * epoch goes up, so editor tabs loaded before cannot write the value back, and
   * one audit row records the places, never the value.
   *
   * The caller revalidates the cache, as after a rollback.
   */
  async erasePersonalData(
    scope: TenantScope,
    siteId: string,
    input: {
      query: EraseQuery;
      replacement: string;
      token: string;
      /** The ids of the matches the owner saw and ticked. */
      chosen: readonly string[];
      erasedBy: string;
    },
  ): Promise<PersonalDataErasure> {
    assertScope(scope);
    const { query, replacement, token, erasedBy } = input;
    const matcher = eraseMatcher(query);
    const problem = replacementProblem(replacement, query);
    if (problem) throw problem;
    const chosen = new Set(input.chosen);
    if (chosen.size === 0) throw new NothingToEraseError();

    const erasure = await withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${siteId} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
      const where = { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId };
      const site = await tx.site.findFirst({
        where,
        select: {
          ...WORKING_COPY_SELECT,
          version: true,
          branchOfSiteId: true,
          revisions: { orderBy: { number: 'desc' }, select: { id: true, number: true } },
        },
      });
      if (!site) throw new SiteNotFoundError(siteId);
      if (site.branchOfSiteId) throw new SiteIsBranchError('erase personal data from its site; that covers every branch.');
      // Then the branches' rows, in id order (main first, as every branch write takes them), so no branch save
      // lands between the search below and the rewrite.
      await tx.$queryRaw`SELECT id FROM public.sites WHERE branch_of_site_id = ${siteId} AND workspace_id = ${scope.workspaceId} ORDER BY id FOR UPDATE`;

      const now = new Date();
      const found: EraseMatch[] = [];
      const erased: EraseMatch[] = [];
      let remaining = 0;

      // D9: the code of every stored block and proposal first, without writing, so every copy below can follow a
      // block whose code changed to its new hash. Its matches join `found` after the branches', the order of the
      // search, and its rows are written once the copies are.
      // Only what changes is kept (the matches of the rest are counted for the token, their code released), so
      // the erase holds the code of the rewritten blocks only, not of every stored blob.
      const codeFound: EraseMatch[] = [];
      let codeLeft = 0;
      const codeRewrites: Array<{ source: CustomCodeEraseSource; rewrite: ReturnType<typeof rewriteDocument>; codeChanged: boolean }> = [];
      const renamed = new Map<string, string>();
      // A block the erase cannot rewrite is said after the staleness checks, so a stale preview is told it is stale.
      let codeRefusal: EraseCodeRefusedError | null = null;
      for await (const source of this.customCodeEraseSources(tx, scope, siteId)) {
        const rewrite = rewriteDocument(source.document, source.location, matcher, replacement, chosen);
        codeFound.push(...findMatches(source.document, source.location, matcher));
        codeLeft += findMatches(rewrite.document, source.location, matcher).length;
        if (rewrite.erased.length === 0) continue;
        const rewritten = rewrite.document as { code: string; title: string };
        const codeChanged = rewritten.code !== source.document.code;
        codeRewrites.push({ source, rewrite, codeChanged });
        if (!codeChanged || !source.hashAfter || source.location.kind !== 'custom-code' || codeRefusal) continue;
        try {
          const after = await source.hashAfter(rewritten);
          if (after !== source.location.sha256) renamed.set(source.location.sha256, after);
        } catch (err) {
          if (!(err instanceof EraseCodeRefusedError)) throw err;
          codeRefusal = err;
        }
      }

      // The working copy: the `sites` columns and each changed `site_pages` row.
      const working: EraseLocation = { kind: 'working' };
      const before = workingDocument(site);
      found.push(...findMatches(before, working, matcher));
      const workingRewrite = rewriteDocument(before, working, matcher, replacement, chosen);
      erased.push(...workingRewrite.erased);
      // A block whose code was rewritten names its new hash (D9).
      const after = renameCustomCodeHashes(workingRewrite.document, renamed) as Record<string, unknown>;
      remaining += findMatches(after, working, matcher).length;
      if (workingRewrite.erased.length > 0 || after !== workingRewrite.document) {
        // The next Publish freezes exactly this copy, so it passes the same checks a revision does.
        assertShapeKept(before, after, { revision: false });
        const beforePages = before.pages as Array<{ pageId: string; slug: string; snapshot: unknown }>;
        const afterPages = after.pages as Array<{ pageId: string; slug: string; snapshot: unknown }>;
        for (let i = 0; i < afterPages.length; i++) {
          if (afterPages[i].snapshot === beforePages[i].snapshot) continue;
          await tx.sitePage.update({
            where: { siteId_pageId: { siteId, pageId: afterPages[i].pageId } },
            data: { snapshot: afterPages[i].snapshot as Prisma.InputJsonValue },
          });
        }
        await tx.site.updateMany({
          where,
          data: {
            name: after.name as string,
            description: after.description as string,
            siteSettings: after.siteSettings as Prisma.InputJsonValue,
            components: after.components as Prisma.InputJsonValue,
            redirects: after.redirects as Prisma.InputJsonValue,
          },
        });
      }

      // Every kept revision, one document at a time, rewritten in place.
      for (const revision of site.revisions) {
        const row = await tx.siteRevision.findUnique({ where: { id: revision.id }, select: { document: true } });
        if (!row) throw new ErasePreviewStaleError();
        const location: EraseLocation = { kind: 'revision', number: revision.number };
        found.push(...findMatches(row.document, location, matcher));
        const rewrite = rewriteDocument(row.document, location, matcher, replacement, chosen);
        const document = renameCustomCodeHashes(rewrite.document, renamed);
        remaining += findMatches(document, location, matcher).length;
        if (rewrite.erased.length === 0 && document === rewrite.document) continue;
        assertShapeKept(row.document, document, { revision: true });
        await tx.siteRevision.update({
          where: { id: revision.id },
          data: { document: document as Prisma.InputJsonValue, rewrittenAt: now },
        });
        erased.push(...rewrite.erased);
      }

      // Every copy the site's branches keep, in the same transaction: otherwise a merge could bring an erased
      // value back into main (plan docs/plans/2026-11-10-site-branches.md, section 7).
      // A kept pre-merge copy past its 30 days goes first, with whatever it held: it is not rewritten, not counted.
      await clearExpiredKeptCopies(tx, scope.workspaceId, siteId);
      for await (const source of this.branchEraseSources(tx, scope, siteId)) {
        found.push(...findMatches(source.document, source.location, matcher));
        const rewrite = rewriteDocument(source.document, source.location, matcher, replacement, chosen);
        const document = renameCustomCodeHashes(rewrite.document, renamed);
        const left = findMatches(document, source.location, matcher).length;
        if (left > 0 && source.drop) {
          // Gone with everything it held: what was ticked in it counts as erased, nothing of it remains.
          await source.drop(tx);
          erased.push(...rewrite.erased);
          continue;
        }
        remaining += left;
        if (rewrite.erased.length === 0 && document === rewrite.document) continue;
        assertShapeKept(source.document, document, { revision: source.revision });
        await source.write(tx, document);
        erased.push(...rewrite.erased);
      }

      // The code itself (D9): each block whose code changed is written under its new hash and its old row goes;
      // a proposal is rewritten in place. After the copies, which already name the new hashes.
      const rewrittenCode: string[] = [];
      found.push(...codeFound);
      remaining += codeLeft;
      if (!codeRefusal) {
        for (const { source } of codeRewrites) await source.removeOld?.(tx);
        for (const { source, rewrite, codeChanged } of codeRewrites) {
          const heldTitle = await source.write(tx, rewrite.document as { code: string; title: string }, renamed, erasedBy, scope);
          erased.push(...rewrite.erased);
          // Named so the owner checks it: code can stop working where a text in it changed. A changed title is not.
          if (source.location.kind === 'custom-code' && codeChanged) rewrittenCode.push(heldTitle);
        }
      }

      // Checked last: throwing here rolls every write above back.
      if (matchesToken(found) !== token) throw new ErasePreviewStaleError();
      // Only an erasable match the preview listed can have been ticked; anything else
      // (an id beyond the list, a blocked match, an unknown id) is not the owner's choice.
      const offered = new Set(found.slice(0, ERASE_LIMITS.listed).filter((m) => m.blocked === null).map((m) => m.id));
      if ([...chosen].some((id) => !offered.has(id))) throw new ErasePreviewStaleError();
      if (codeRefusal) throw codeRefusal;
      if (erased.length === 0) throw new NothingToEraseError();

      // Every erase moves the epoch, also one that found the value only in old
      // revisions: a tab loaded long ago may hold it even if the working copy does not.
      // The version moves too: the working copy may have been rewritten, and an
      // agent holding the old version must load again before it writes.
      // A branch forked from main as it is now stays up to date, but only when the erase left the value nowhere:
      // then its fork point and main were rewritten alike, and it moves with main's version (an erase must not
      // make every branch "behind main"). An erase of only some matches may have rewritten main and not the fork
      // point; the branch is then behind main, and the three-way merge keeps main's erased text.
      if (remaining === 0) await tx.$executeRaw`
        UPDATE public.site_branches SET base_version = base_version + 1
        WHERE site_id = ${siteId} AND workspace_id = ${scope.workspaceId} AND status IN ('open', 'ready')
          AND base_version = (SELECT version FROM public.sites WHERE id = ${siteId} AND workspace_id = ${scope.workspaceId})`;
      await tx.site.updateMany({ where, data: { erasureEpoch: { increment: 1 }, version: { increment: 1 }, lastWriteKey: null, lastWriteVersion: null } });
      // Every open branch moves with main: a branch tab loaded before cannot write the value back, and an agent
      // holding the branch's old version loads again. Under the rows' locks, so each version moved by exactly one.
      const branchVersions = await tx.site.findMany({
        where: { branchOfSiteId: siteId, workspaceId: scope.workspaceId },
        select: { id: true, version: true },
      });
      await tx.site.updateMany({
        where: { branchOfSiteId: siteId, workspaceId: scope.workspaceId },
        data: { erasureEpoch: { increment: 1 }, version: { increment: 1 }, lastWriteKey: null, lastWriteVersion: null },
      });
      // A conflict answer is keyed by a hash of the values it was given for, and a hash of a value is still a
      // trace of it: every review in progress on the site starts over.
      await tx.siteBranch.updateMany({ where: { siteId, workspaceId: scope.workspaceId }, data: { mergeDraft: Prisma.DbNull } });

      const holdsValue = redactionMatcher(query);
      const places = erased.map((match) => placeOf(match, holdsValue));
      const audit = await tx.siteErasure.create({
        data: {
          siteId,
          workspaceId: scope.workspaceId,
          tenantGroupId: scope.tenantGroupId,
          erasedBy,
          erasedCount: erased.length,
          remainingCount: remaining,
          places: places as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      // Under the row lock taken above, so the version moved by exactly one.
      const write: WorkingCopyWrite = { version: site.version + 1, versionBefore: site.version, wrote: true };
      const branchWrites = branchVersions.map((b) => ({
        branchId: b.id,
        write: { version: b.version + 1, versionBefore: b.version, wrote: true } satisfies WorkingCopyWrite,
      }));
      return { result: { erasureId: audit.id, erased: erased.length, places, remaining, rewrittenCode }, write, branchWrites };
    }, ERASE_TRANSACTION));
    // Open editors must load again: their copy may hold the erased value. An erasure
    // blanks values and removes no node or page, so skeleton anchors are left alone.
    // A generate_page still running drafted from the copy before the erasure: its
    // previews could repeat the erased value, so the run ends here and sends no more.
    endLiveGenerationOfSite(siteId, 'site_changed');
    // The kept document of the old version may hold the erased value: never kept past the erasure.
    forgetSiteDocuments(siteId);
    announceWrite(siteId, erasure.write, { origin: 'erasure' });
    // The same for every open branch: its editors reload and clear their undo history, its generation ends, its
    // kept documents go.
    for (const branch of erasure.branchWrites) {
      endLiveGenerationOfSite(branch.branchId, 'site_changed');
      forgetSiteDocuments(branch.branchId);
      announceWrite(branch.branchId, branch.write, { origin: 'erasure' });
    }
    return erasure.result;
  }

  /**
   * The copies of a main site that its branches keep, for an erase (search and rewrite): each open branch's
   * working copy with its record's name and review note, each closed branch's record text, every fork point and
   * every kept pre-merge copy. Ordered by branch id, so a search and the erase after it list them alike.
   */
  private async *branchEraseSources(tx: Prisma.TransactionClient, scope: TenantScope, siteId: string): AsyncGenerator<BranchEraseSource> {
    // Up front only what is small: each record's name, note and status, and WHETHER it holds a document. The
    // documents are loaded when a record's turn comes and released after it, so ten large branches never sit in
    // memory together, and a closed record without a kept copy (most of them) costs no read of its own. A kept
    // copy whose 30 days are over is not a copy any more (the erase removes it before it gets here, a search
    // leaves it alone), so it is not listed. One without a date, which no code writes, is read to be safe.
    const records = await tx.$queryRaw<
      Array<{ id: string; name: string; status: 'open' | 'ready' | 'merged' | 'discarded'; reviewNote: string | null; branchSiteId: string | null; hasBase: boolean; hasKept: boolean }>
    >`
      SELECT b.id, b.name, b.status::text AS status, b.review_note AS "reviewNote", b.branch_site_id AS "branchSiteId",
             (b.base_document IS NOT NULL) AS "hasBase",
             -- The column is a timestamp without zone holding UTC, so it is compared with UTC now, whatever the session's zone.
             (b.main_before_document IS NOT NULL AND (b.main_before_expires_at IS NULL OR b.main_before_expires_at > (pg_catalog.now() AT TIME ZONE 'UTC'))) AS "hasKept"
      FROM public.site_branches b
      WHERE b.site_id = ${siteId} AND b.workspace_id = ${scope.workspaceId}
      ORDER BY b.id ASC`;
    // A rewritten name stays a valid branch name, unique among the open ones as the index compares them (a
    // number is added when the rewrite makes it equal another, checked in SQL): an erase never fails on the
    // name's own rules.
    const nameAfter = async (client: Prisma.TransactionClient, record: { id: string; status: string }, rewritten: unknown): Promise<string> => {
      const cleaned = validateBranchName(rewritten);
      const stem = cleaned.ok ? cleaned.name : 'Branch';
      if (record.status !== 'open' && record.status !== 'ready') return stem;
      return freeOpenName(client, siteId, stem, record.id);
    };
    for (const listed of records) {
      const documents =
        listed.hasBase || listed.hasKept
          ? await tx.siteBranch.findFirst({
              where: { id: listed.id, siteId, workspaceId: scope.workspaceId },
              select: { baseDocument: listed.hasBase, mainBeforeDocument: listed.hasKept },
            })
          : null;
      const record = {
        ...listed,
        baseDocument: (documents?.baseDocument ?? null) as Prisma.JsonValue | null,
        mainBeforeDocument: (documents?.mainBeforeDocument ?? null) as Prisma.JsonValue | null,
      };
      const label = { branchId: record.id, name: record.name, branchStatus: record.status };
      const content = record.branchSiteId
        ? await tx.site.findFirst({ where: { id: record.branchSiteId, workspaceId: scope.workspaceId }, select: WORKING_COPY_SELECT })
        : null;
      const branchSiteId = content ? record.branchSiteId : null;
      yield {
        location: { kind: 'branch', ...label },
        document: { ...(content ? workingDocument(content) : {}), branchName: record.name, reviewNote: record.reviewNote ?? '' },
        revision: false,
        branchSiteId,
        write: async (client, rewritten) => {
          const doc = rewritten as Record<string, unknown>;
          await client.siteBranch.update({
            where: { id: record.id },
            data: { name: await nameAfter(client, record, doc.branchName), reviewNote: record.reviewNote === null ? null : String(doc.reviewNote ?? '') },
          });
          if (!content || !branchSiteId) return;
          // The rewrite keeps an unchanged snapshot as the same object, as for main's working copy above.
          const before = workingDocument(content).pages as Array<{ pageId: string; snapshot: unknown }>;
          const after = doc.pages as Array<{ pageId: string; snapshot: unknown }>;
          for (let i = 0; i < after.length; i++) {
            if (after[i].snapshot === before[i].snapshot) continue;
            await client.sitePage.update({
              where: { siteId_pageId: { siteId: branchSiteId, pageId: after[i].pageId } },
              data: { snapshot: after[i].snapshot as Prisma.InputJsonValue },
            });
          }
          await client.site.updateMany({
            where: { id: branchSiteId, workspaceId: scope.workspaceId },
            data: {
              name: doc.name as string,
              description: doc.description as string,
              siteSettings: doc.siteSettings as Prisma.InputJsonValue,
              components: doc.components as Prisma.InputJsonValue,
              redirects: doc.redirects as Prisma.InputJsonValue,
            },
          });
        },
      };
      if (record.baseDocument !== null) {
        yield {
          location: { kind: 'branch-base', ...label },
          document: record.baseDocument,
          revision: true,
          branchSiteId: null,
          write: async (client, rewritten) => {
            await client.siteBranch.update({ where: { id: record.id }, data: { baseDocument: rewritten as Prisma.InputJsonValue } });
          },
        };
      }
      if (record.mainBeforeDocument !== null) {
        yield {
          location: { kind: 'merge-undo', ...label },
          document: record.mainBeforeDocument,
          revision: true,
          branchSiteId: null,
          write: async (client, rewritten) => {
            await client.siteBranch.update({ where: { id: record.id }, data: { mainBeforeDocument: rewritten as Prisma.InputJsonValue } });
          },
          drop: async (client) => {
            await client.siteBranch.update({
              where: { id: record.id },
              data: { mainBeforeDocument: Prisma.DbNull, mainBeforeExpiresAt: null, mainBeforeEnded: 'erased' },
            });
          },
        };
      }
    }
  }

  /**
   * The code of the site's custom code blocks and proposals, for an erase (plan
   * docs/plans/2026-11-02-sandboxed-custom-code.md, D9 and D115): every stored blob of the site, named or not,
   * blocked or not, and every proposal, ordered by hash and by id so a search and the erase after it list them
   * alike. Only the hashes and ids are read up front; each text is loaded when its turn comes.
   *
   * Writing a block whose code changed: the rewritten code is stored under the hash it gives with the old
   * declaration, the old row is deleted, and `blob-erase` goes to the audit with both hashes (never the code or the
   * value). A blob that was taken down stays taken down under its new hash: its new row is blocked when the old row
   * was blocked or listed, or when the new hash is listed or blocked anywhere; the takedown list itself is never
   * written from here. When the new hash is one the site already stores, that row is kept and blocked if this one
   * is taken down. Only the title changed: the row is written again under the same hash, since a blob row is never
   * updated (D27).
   */
  private async *customCodeEraseSources(tx: Prisma.TransactionClient, scope: TenantScope, siteId: string): AsyncGenerator<CustomCodeEraseSource> {
    const blobs = await tx.customCodeBlob.findMany({ where: { siteId }, select: { sha256: true }, orderBy: { sha256: 'asc' } });
    for (const { sha256 } of blobs) {
      const row = await tx.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId, sha256 } } });
      if (!row) continue; // pruned by a write that committed after the list was read: not part of this snapshot
      const parsed = parseDeclaration(row.declaration);
      let listed = false;
      yield {
        location: { kind: 'custom-code', sha256, title: row.title },
        document: { code: row.document, title: row.title },
        hashAfter: async (rewritten) => {
          // Only the title changed: the hash names code and declaration, so it stays (no parse needed).
          if (rewritten.code === row.document) return sha256;
          if (!parsed.ok) throw new EraseCodeRefusedError('custom_code_unreadable', 'A custom code block that holds this text has a stored declaration that can no longer be read, so its code cannot be rewritten. Untick the matches in custom code, or contact support. Nothing was changed.');
          if (rewritten.code.trim() === '') throw new EraseCodeRefusedError('custom_code_empty', 'Erasing would leave a custom code block with no code at all. Erase with a replacement text instead. Nothing was changed.');
          if (utf8ByteLength(rewritten.code) + utf8ByteLength(canonicalDeclarationJson(parsed.declaration)) > BOX_LIMITS.documentBytes) {
            throw new EraseCodeRefusedError('custom_code_too_large', 'With this replacement a custom code block would grow past the 256 KB a block may hold. Use a shorter replacement. Nothing was changed.');
          }
          return customCodeHash(rewritten.code, parsed.declaration);
        },
        removeOld: async (client) => {
          listed = (await client.customCodeBlockedHash.findUnique({ where: { sha256 }, select: { sha256: true } })) !== null;
          await client.customCodeBlob.delete({ where: { siteId_sha256: { siteId, sha256 } } });
        },
        write: async (client, rewritten, renamed, erasedBy, writeScope) => {
          const to = renamed.get(sha256) ?? sha256;
          // Code taken down anywhere stays down here (D3, D32): the old row was blocked or its hash listed, or the
          // new hash is listed or blocked on any site's row, the check the guarded write makes. Nothing is ever put
          // on the takedown list from here: the new hash follows the owner's replacement, so listing it could take
          // down another site's identical code that no operator judged (security review of C5 part 2, B1).
          const elsewhere =
            to !== sha256 &&
            (
              await client.$queryRaw<{ found: number }[]>`
                SELECT 1 AS found FROM public.custom_code_blocked_hashes h WHERE h.sha256 = ${to}
                UNION ALL
                SELECT 1 FROM public.custom_code_blobs b WHERE b.sha256 = ${to} AND b.blocked_at IS NOT NULL
                LIMIT 1`
            ).length > 0;
          const takenDown = row.blockedAt !== null || listed || elsewhere;
          // A row under the new hash that is still there after every rewritten block's old row went: code no block
          // of this erase held before, or a block of this erase that met the same code first. It is kept, and
          // blocked when this one was taken down, so an erase never brings taken-down code back to life.
          // A blob row is never updated but for its block (D27), so a kept row keeps its own title; the old row and
          // its title are gone either way, and the owner is shown the title the code is served under.
          const existing = await client.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId, sha256: to } }, select: { blockedAt: true, title: true } });
          const heldTitle = existing ? existing.title : rewritten.title;
          if (existing) {
            if (takenDown && existing.blockedAt === null) {
              await client.customCodeBlob.update({ where: { siteId_sha256: { siteId, sha256: to } }, data: { blockedAt: row.blockedAt ?? new Date() } });
            }
          } else {
            await client.customCodeBlob.create({
              data: {
                siteId,
                sha256: to,
                document: rewritten.code,
                declaration: row.declaration as Prisma.InputJsonValue,
                title: rewritten.title,
                createdBy: row.createdBy,
                // The blob keeps its age, so pruning treats it exactly as it would have treated the old one.
                createdAt: row.createdAt,
                blockedAt: takenDown ? (row.blockedAt ?? new Date()) : null,
              },
            });
          }
          await client.customCodeAudit.create({
            data: {
              siteId,
              workspaceId: writeScope.workspaceId,
              tenantGroupId: writeScope.tenantGroupId,
              actor: erasedBy,
              action: 'blob-erase',
              sha256: to,
              // Both hashes and nothing else (D3, D9).
              detail: { replaces: sha256 },
            },
          });
          return heldTitle;
        },
      };
    }
    const proposals = await tx.customCodeProposal.findMany({ where: { siteId, workspaceId: scope.workspaceId }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const { id } of proposals) {
      const row = await tx.customCodeProposal.findFirst({ where: { id, siteId, workspaceId: scope.workspaceId }, select: { document: true, title: true } });
      if (!row) continue;
      yield {
        location: { kind: 'custom-code-proposal', proposalId: id, title: row.title },
        document: { code: row.document, title: row.title },
        write: async (client, rewritten) => {
          await client.customCodeProposal.update({ where: { id }, data: { document: rewritten.code, title: rewritten.title } });
          return rewritten.title;
        },
      };
    }
  }

  /** The erasures of a site, newest first (the owner's audit list). */
  async listErasures(scope: TenantScope, siteId: string): Promise<SiteErasureSummary[]> {
    assertScope(scope);
    const rows = await this.prisma.siteErasure.findMany({
      where: { siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, erasedBy: true, erasedCount: true, remainingCount: true, places: true, createdAt: true },
    });
    return rows.map((row) => ({ ...row, places: parsePlaces(row.places) }));
  }

  /**
   * Allocate (or return the already-allocated) `*.sites.lumitra.co` subdomain
   * for a site, scoped to the caller's workspace. This is the first-publish
   * door the publish route calls AFTER `publishProject`.
   *
   * IDEMPOTENT: if the site already has a `SiteDomain` row carrying a non-null
   * `subdomain`, that label is returned UNCHANGED — re-publishing a site never
   * moves its URL. Only the first publish allocates.
   *
   * The site is verified to live in the caller's workspace first; a site id in
   * another workspace throws SiteNotFoundError and NEVER reaches the allocator,
   * so a subdomain is never minted across the isolation boundary.
   *
   * Collision-avoidance is DB-ENFORCED, not check-then-insert: the allocator
   * generates a label and INSERTs it, relying on the `@@unique([subdomain])`
   * index to reject a clash with a Prisma `P2002`. On `P2002` it regenerates and
   * retries, bounded by {@link SUBDOMAIN_ALLOCATION_ATTEMPTS}; exhausting the
   * retries throws a loud {@link SubdomainAllocationError} (500) rather than a
   * silent success. The written label is ALWAYS non-null (a NULL subdomain does
   * not participate in the partial-unique index and would defeat enforcement).
   */
  async ensureSiteDomain(
    scope: TenantScope,
    siteId: string,
  ): Promise<{ subdomain: string }> {
    assertScope(scope);

    // Verify the site is in THIS workspace before allocating. A site in another
    // workspace returns null (workspace_id is in the where-clause) and is
    // indistinguishable from a missing site — existence never leaks, and a
    // subdomain is never minted across the boundary.
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: { id: true, branchOfSiteId: true },
    });
    if (!site) throw new SiteNotFoundError(siteId);
    // A branch never holds an address (the database trigger refuses the row too).
    if (site.branchOfSiteId) throw new BranchCannotPublishError();

    // Idempotency: a re-publish must keep the SAME URL. If any domain row for
    // this site already carries a non-null subdomain, return it untouched.
    const existing = await this.prisma.siteDomain.findFirst({
      where: { siteId, subdomain: { not: null } },
      select: { subdomain: true },
    });
    if (existing?.subdomain) {
      return { subdomain: existing.subdomain };
    }

    // First publish: allocate. Generate a fresh label and INSERT it, letting the
    // unique index referee uniqueness. On a P2002 clash, regenerate and retry.
    for (let attempt = 1; attempt <= SUBDOMAIN_ALLOCATION_ATTEMPTS; attempt++) {
      const subdomain = generateSubdomain();
      try {
        await this.prisma.siteDomain.create({
          data: {
            siteId,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            subdomain,
            verificationStatus: 'active',
            isPrimary: true,
          },
        });
        return { subdomain };
      } catch (err) {
        // P2002 = unique-constraint violation. Only the subdomain index can
        // realistically clash here; regenerate and retry within the bound. Any
        // other error (or exhaustion) is not swallowed.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }

    // Every attempt collided — astronomically unlikely, so a real occurrence is
    // a loud signal, never a silent publish-with-no-URL.
    throw new SubdomainAllocationError(siteId, SUBDOMAIN_ALLOCATION_ATTEMPTS);
  }

  /**
   * Where a site lives for its owner's eyes (the page settings URL preview),
   * scoped to the caller's workspace. `host` is the address visitors use: a
   * connected custom domain that serves the site (verified or active, the one
   * connected first), else `<subdomain>.<baseHost>`, else null when the site
   * has never been published or no base host is configured. `everPublished`
   * is true once a platform subdomain was allocated (the first publish), which
   * is also when changed slugs start keeping redirects. A missing or foreign
   * site throws SiteNotFoundError.
   */
  async getSiteAddress(
    scope: TenantScope,
    siteId: string,
    baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST,
  ): Promise<{ host: string | null; everPublished: boolean }> {
    assertScope(scope);
    const row = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: { branchOfSiteId: true },
    });
    if (!row) throw new SiteNotFoundError(siteId);
    // A branch has no address of its own: its pages will live at its site's once merged and published.
    const site = await this.prisma.site.findFirst({
      where: { id: row.branchOfSiteId ?? siteId, workspaceId: scope.workspaceId },
      select: {
        domains: {
          select: {
            subdomain: true,
            customHostname: true,
            verificationStatus: true,
            activatedAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!site) throw new SiteNotFoundError(siteId);

    const platform = site.domains.find((d) => d.subdomain);
    // The same rule the published head uses for canonical URLs (primaryHost.ts).
    const host = pickPrimaryHost(site.domains, baseHost);
    return { host, everPublished: Boolean(platform) };
  }

  /**
   * Transition a site back to `draft`, scoped to the caller's workspace, which
   * takes it offline. The status flip is scoped by BOTH id AND workspace_id (via
   * updateMany), so an unpublish of a site owned by another workspace matches
   * zero rows and throws SiteNotFoundError rather than silently un-publishing a
   * foreign tenant's row. The pointer to its revision stays: a draft is not served.
   *
   * The `SiteDomain` row is deliberately PRESERVED (decision D3): re-publishing
   * the site reuses its existing slug so the URL is stable across a
   * publish/unpublish/re-publish cycle.
   */
  async unpublishProject(scope: TenantScope, siteId: string): Promise<void> {
    assertScope(scope);
    const result = await this.prisma.site.updateMany({
      where: { id: siteId, workspaceId: scope.workspaceId, branchOfSiteId: null },
      data: { status: 'draft' },
    });
    if (result.count === 0) {
      await this.refuseBranch(this.prisma, scope, siteId);
      throw new SiteNotFoundError(siteId);
    }
  }

  /**
   * Delete a site for good, scoped to the caller's workspace and tenant group,
   * in ONE transaction. The database cascade removes everything that belongs
   * only to this site: its pages, its domain rows (the platform subdomain and
   * every custom domain, which releases their live claims) and its experiment
   * references. Company-wide data is never touched: CMS collections are per
   * workspace, the commerce catalog, orders and Books live in the company's
   * tenant schema without any site column.
   *
   * A PUBLISHED site is only deleted when `confirmName` equals its current
   * name exactly (SiteDeleteConfirmationError otherwise, nothing deleted).
   *
   * Returns what the caller must invalidate AFTER the commit: the subdomain
   * and every custom hostname (requested and live claim). They are captured
   * here, before the cascade, because afterwards no row names them any more.
   *
   * A site in another workspace or tenant group is reported exactly like a
   * missing one (SiteNotFoundError), so existence never leaks.
   */
  async deleteSite(
    scope: TenantScope,
    siteId: string,
    options: { confirmName?: string } = {},
  ): Promise<DeletedSite> {
    assertScope(scope);
    const where = { id: siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId };
    const deleted = await this.prisma.$transaction(async (tx) => {
      // Take the row lock BEFORE reading the status: a publish or save that is
      // in flight finishes first, so the status checked below (and the domains
      // captured) are the ones this delete really removes. Touching only the
      // row's own write timestamp, which is deleted with it.
      const locked = await tx.site.updateMany({ where, data: { updatedAt: new Date() } });
      if (locked.count === 0) throw new SiteNotFoundError(siteId);

      const site = await tx.site.findFirst({
        where,
        select: {
          name: true,
          status: true,
          branchOfSiteId: true,
          domains: { select: { subdomain: true, hostname: true, customHostname: true } },
          // The cascade deletes them in the database; this process forgets their content after the commit.
          branchSites: { select: { id: true } },
        },
      });
      if (!site) throw new SiteNotFoundError(siteId);
      // Deleting a branch as a site would leave its record open with no content: it is discarded from its site.
      if (site.branchOfSiteId) throw new SiteIsBranchError('discard it from its site\'s branches instead of deleting it.');
      if (site.status === 'published' && options.confirmName !== site.name) {
        throw new SiteDeleteConfirmationError(site.name);
      }

      let subdomain: string | null = null;
      const hostnames = new Set<string>();
      for (const d of site.domains) {
        if (d.subdomain) subdomain = d.subdomain;
        if (d.hostname) hostnames.add(d.hostname);
        if (d.customHostname) hostnames.add(d.customHostname);
      }

      const result = await tx.site.deleteMany({ where });
      // Deleted by a concurrent request between the read and here.
      if (result.count === 0) throw new SiteNotFoundError(siteId);

      return {
        deleted: {
          siteId,
          name: site.name,
          wasPublished: site.status === 'published',
          subdomain,
          hostnames: [...hostnames],
        },
        branchIds: site.branchSites.map((b) => b.id),
      };
    });
    // A deleted site's content is not kept in memory either: no kept copy, no running draft, nor of its branches.
    forgetSiteDocuments(siteId);
    endLiveGenerationOfSite(siteId, 'site_changed');
    for (const branchId of deleted.branchIds) forgetBranchContent(branchId);
    return deleted.deleted;
  }
}

/** What {@link SiteRepository.deleteSite} removed, for the caller's cache invalidation. */
export interface DeletedSite {
  siteId: string;
  name: string;
  wasPublished: boolean;
  subdomain: string | null;
  hostnames: string[];
}

let cached: SiteRepository | null = null;

/**
 * The process-wide site repository over the shared PrismaClient. Constructed
 * lazily so importing this module costs nothing and `next build` needs no live
 * database.
 */
export function getSiteRepository(): SiteRepository {
  if (!cached) cached = new SiteRepository(getPrismaClient());
  return cached;
}
// ci-replay touch
