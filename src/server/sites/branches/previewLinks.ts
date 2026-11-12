import 'server-only';

// src/server/sites/branches/previewLinks.ts
//
// The public preview link of a branch (site branches, slice S8,
// docs/plans/2026-11-10-site-branches.md, section 7): the address
// `preview-<token>.<sites base host>` shows the branch's working copy, read
// only, to anyone who holds it. It is how an agency shows a client a branch
// without giving them an account.
//
//   - The token is 160 random bits. Only its SHA-256 is stored, so neither the
//     table nor a backup of it opens a preview, and the address can be shown
//     exactly once: when the link is made.
//   - A branch has at most one link. Making a new one replaces the old address,
//     revoking deletes it, and closing the branch (merge, discard) deletes it in
//     the same transaction (SiteBranchRepository.closeRecord).
//   - Resolving is one indexed read per request, never cached: a revoked or
//     expired link, a closed branch and the per-company switch going off all
//     end the preview on the next request.
//
// What a preview may do is decided elsewhere: the middleware gives a preview
// host GET on the site pages and nothing else (src/middleware.ts,
// src/lib/hostRoutes.ts), and the renderer shows forms and checkout inert.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { parseComponents } from '@/lib/components/definition';
import { parseSiteRedirects } from '@/lib/pages/redirects';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import type { PageSnapshotOut } from '@/models/PageModel';
import { isEditorHost } from '@/lib/editorHost';
import { PREVIEW_TOKEN_PATTERN, previewHostOf, previewTokenOfHost, type PreviewOf } from '@/lib/sites/previewHost';
import { BranchClosedError, BranchNotFoundError, SiteNotFoundError, SiteRepositoryError } from '../errors';
import type { PublishedSite } from '../publicResolver';
import { assertScope, type TenantScope } from '../repository';
import type { BranchActor } from './repository';
import { siteBranchesEnabled } from './switch';

/** For how many days a link may be made. The plan's default is 7. */
export const PREVIEW_LINK_DAYS = [1, 7, 30] as const;
export type PreviewLinkDays = (typeof PREVIEW_LINK_DAYS)[number];
export const PREVIEW_LINK_DEFAULT_DAYS: PreviewLinkDays = 7;

/** The sites base host is not configured, so no preview address exists on this deployment. 409. */
export class PreviewLinkUnavailableError extends SiteRepositoryError {
  constructor() {
    super('preview_link_unavailable', 'Public preview links are not available here: the address for published sites is not configured.', 409);
  }
}

/** The site is not linked to a company with site branches on, so its link would show nothing. 409. */
export class PreviewLinkNoCompanyError extends SiteRepositoryError {
  constructor() {
    super(
      'preview_link_no_company',
      'This site is not linked to its company yet, so a preview link would show nothing. Open the site itself in the editor once, then make the link.',
      409,
    );
  }
}

/** A link as the editor shows it. Never the address: only its hash is stored. */
export interface PreviewLinkSummary {
  expiresAt: string;
  expired: boolean;
  createdBy: string;
  createdAt: string;
}

/** A link just made: the only moment its address exists outside the visitor's hands. */
export interface PreviewLinkCreated extends PreviewLinkSummary {
  url: string;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 160 random bits as 32 characters of lowercase base32 (5 bits each, no padding). */
export function newPreviewToken(): string {
  const bytes = randomBytes(20);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** What is stored and looked up: the SHA-256 of the token, lowercase hex. */
export function previewTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function summaryOf(row: { expiresAt: Date; createdBy: string; createdAt: Date }, now: Date): PreviewLinkSummary {
  return {
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= now.getTime(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The branch's record, through the caller's workspace and its main site; it must be open or ready. */
async function openBranch(client: Prisma.TransactionClient | PrismaClient, scope: TenantScope, mainSiteId: string, branchId: string) {
  const main = await client.site.findFirst({
    where: { id: mainSiteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, branchOfSiteId: null },
    select: { id: true, companyId: true },
  });
  if (!main) throw new SiteNotFoundError(mainSiteId);
  const record = await client.siteBranch.findFirst({
    where: { id: branchId, siteId: main.id, workspaceId: scope.workspaceId },
    select: { id: true, status: true, workspaceId: true, tenantGroupId: true, companyId: true },
  });
  if (!record) throw new BranchNotFoundError(branchId);
  if (record.status === 'merged' || record.status === 'discarded') throw new BranchClosedError(record.status, main.id);
  return { main, record };
}

export class SiteBranchPreviewLinks {
  constructor(private readonly prisma: PrismaClient) {}

  /** The branch's link as the editor shows it, or null when it has none. */
  async get(scope: TenantScope, mainSiteId: string, branchId: string): Promise<PreviewLinkSummary | null> {
    assertScope(scope);
    const { record } = await openBranch(this.prisma, scope, mainSiteId, branchId);
    const row = await this.prisma.siteBranchPreview.findFirst({
      where: { branchId: record.id, workspaceId: scope.workspaceId },
      select: { expiresAt: true, createdBy: true, createdAt: true },
    });
    return row ? summaryOf(row, new Date()) : null;
  }

  /**
   * Make the branch's link, replacing the one it had: the old address stops working in the same transaction.
   * Returns the new address, which is not stored and cannot be shown again.
   */
  async create(
    scope: TenantScope,
    mainSiteId: string,
    branchId: string,
    actor: BranchActor,
    days: PreviewLinkDays = PREVIEW_LINK_DEFAULT_DAYS,
  ): Promise<PreviewLinkCreated> {
    assertScope(scope);
    if (!PREVIEW_LINK_DAYS.includes(days)) throw new SiteRepositoryError('invalid_preview_link', `A preview link lasts ${PREVIEW_LINK_DAYS.join(', ')} days.`, 400);
    const token = newPreviewToken();
    const host = previewHostOf(token);
    if (!host) throw new PreviewLinkUnavailableError();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const row = await this.prisma.$transaction(async (tx) => {
      // Main's row lock, as every change of a branch takes it: a merge or a discard that is closing the branch
      // either finishes first (then the branch is closed here) or deletes the link made here.
      await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${mainSiteId} AND workspace_id = ${scope.workspaceId} AND tenant_group_id = ${scope.tenantGroupId} FOR UPDATE`;
      const { main, record } = await openBranch(tx, scope, mainSiteId, branchId);
      // A link is shown only for a company with site branches on (resolvePreviewLink): without a company the
      // address would answer 404 for ever, so none is made and the person is told what to do.
      if (!siteBranchesEnabled(main.companyId ?? record.companyId)) throw new PreviewLinkNoCompanyError();
      await tx.siteBranchPreview.deleteMany({ where: { branchId: record.id, workspaceId: scope.workspaceId } });
      const created = await tx.siteBranchPreview.create({
        data: {
          id: randomUUID(),
          branchId: record.id,
          workspaceId: record.workspaceId,
          tenantGroupId: record.tenantGroupId,
          companyId: main.companyId ?? record.companyId,
          tokenHash: previewTokenHash(token),
          expiresAt,
          createdBy: actor.id,
          createdAt: now,
        },
        select: { expiresAt: true, createdBy: true, createdAt: true },
      });
      await tx.siteOperationAudit.create({
        data: {
          siteId: main.id,
          workspaceId: scope.workspaceId,
          tenantGroupId: scope.tenantGroupId,
          actorKind: actor.kind,
          actorId: actor.id,
          // Ids and the day count only: never the token, its hash or the address.
          actorDetail: { branchId: record.id, days },
          operation: 'branch_preview_create',
        },
      });
      return created;
    });
    return { ...summaryOf(row, now), url: `https://${host}/` };
  }

  /** Revoke the branch's link. True when there was one. A closed branch has none left: false. */
  async revoke(scope: TenantScope, mainSiteId: string, branchId: string, actor: BranchActor): Promise<boolean> {
    assertScope(scope);
    return this.prisma.$transaction(async (tx) => {
      const main = await tx.site.findFirst({
        where: { id: mainSiteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, branchOfSiteId: null },
        select: { id: true },
      });
      if (!main) throw new SiteNotFoundError(mainSiteId);
      const record = await tx.siteBranch.findFirst({ where: { id: branchId, siteId: main.id, workspaceId: scope.workspaceId }, select: { id: true } });
      if (!record) throw new BranchNotFoundError(branchId);
      const { count } = await tx.siteBranchPreview.deleteMany({ where: { branchId: record.id, workspaceId: scope.workspaceId } });
      if (count === 0) return false;
      await tx.siteOperationAudit.create({
        data: {
          siteId: main.id,
          workspaceId: scope.workspaceId,
          tenantGroupId: scope.tenantGroupId,
          actorKind: actor.kind,
          actorId: actor.id,
          actorDetail: { branchId: record.id },
          operation: 'branch_preview_revoke',
        },
      });
      return true;
    });
  }
}

/** A branch's working copy in the shape the published renderer takes, marked as a preview. */
export type PreviewSite = PublishedSite & { preview: PreviewOf };

/**
 * The preview a request host names, or null: a host of another shape, an unknown token, an expired link, a
 * closed branch, a company with site branches off. One indexed read by the token's hash, then the branch's
 * working copy in one snapshot. A public, anonymous read, and never cached.
 *
 * The site it returns is the BRANCH's content under MAIN's id: the catalogue's hidden-product rules and the
 * uploaded images are per site and belong to main. Its `revision` names the branch and its version, so nothing
 * memoised for it can ever be served for main (whose keys are a revision id or `working:<time>`). Analytics
 * are off whatever the site says: a preview is not a visit.
 */
export async function resolvePreviewSite(
  host: string | null | undefined,
  prisma: PrismaClient = getPrismaClient(),
  now: Date = new Date(),
): Promise<PreviewSite | null> {
  const link = await resolvePreviewLink(host, prisma, now);
  if (!link) return null;
  const branch = { id: link.branchId, siteId: link.siteId, name: link.branchName, branchSiteId: link.branchSiteId };

  // One snapshot, as the published resolver reads: the row and its pages never from two different saves.
  const site = await prisma.$transaction(
    (tx) =>
      tx.site.findFirst({
        where: { id: branch.branchSiteId, workspaceId: link.workspaceId, branchOfSiteId: branch.siteId },
        select: {
          workspaceId: true,
          tenantGroupId: true,
          companyId: true,
          name: true,
          description: true,
          redirects: true,
          siteSettings: true,
          components: true,
          version: true,
          erasureEpoch: true,
          pages: { select: { pageId: true, slug: true, snapshot: true } },
        },
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 30_000 },
  );
  if (!site) return null;

  return {
    siteId: branch.siteId,
    workspaceId: site.workspaceId,
    tenantGroupId: site.tenantGroupId,
    companyId: link.companyId,
    name: site.name,
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    pages: site.pages.map((p) => ({ pageId: p.pageId, slug: p.slug, snapshot: p.snapshot as unknown as PageSnapshotOut })),
    redirects: parseSiteRedirects(site.redirects),
    siteSettings: normalizeSiteSettings(site.siteSettings),
    components: parseComponents(site.components ?? {}).definitions,
    revisionNumber: null,
    revision: `preview:${branch.id}:${site.version}:${site.erasureEpoch}`,
    preview: { branchId: branch.id, branchName: branch.name, expiresAt: link.expiresAt.toISOString() },
  };
}

/** A live preview link and what it is of, without the branch's content. */
export interface PreviewLinkTarget {
  /** Main's site id: what the catalogue and the images are keyed by. */
  siteId: string;
  branchId: string;
  branchSiteId: string;
  branchName: string;
  workspaceId: string;
  tenantGroupId: string;
  companyId: string | null;
  expiresAt: Date;
}

/**
 * The live link a request host names, or null, by one indexed read and without loading the branch: what the
 * image route and the catalogue reads need (a page with thirty pictures asks thirty times), and the first step
 * of {@link resolvePreviewSite}. Null for a host of another shape, the editor host (with no EDITOR_HOST, in
 * development, every host is the editor and gets none of the preview rules of the middleware, so no preview is
 * served there at all), an unknown token, an expired link, a closed branch, and a company with branches off.
 */
export async function resolvePreviewLink(
  host: string | null | undefined,
  prisma: PrismaClient = getPrismaClient(),
  now: Date = new Date(),
): Promise<PreviewLinkTarget | null> {
  if (isEditorHost(host)) return null;
  const token = previewTokenOfHost(host);
  if (!token || !PREVIEW_TOKEN_PATTERN.test(token)) return null;
  const link = await prisma.siteBranchPreview.findUnique({
    where: { tokenHash: previewTokenHash(token) },
    select: {
      expiresAt: true,
      workspaceId: true,
      tenantGroupId: true,
      branch: { select: { id: true, siteId: true, name: true, status: true, branchSiteId: true, companyId: true, site: { select: { companyId: true } } } },
    },
  });
  if (!link || link.expiresAt.getTime() <= now.getTime()) return null;
  const { branch } = link;
  if ((branch.status !== 'open' && branch.status !== 'ready') || !branch.branchSiteId) return null;
  // The branch's company as it is today: the record copies it when the branch is made, and a site stamped with
  // its company only later would otherwise have a link that never shows anything.
  const companyId = branch.site.companyId ?? branch.companyId;
  if (!siteBranchesEnabled(companyId)) return null;
  return {
    siteId: branch.siteId,
    branchId: branch.id,
    branchSiteId: branch.branchSiteId,
    branchName: branch.name,
    workspaceId: link.workspaceId,
    tenantGroupId: link.tenantGroupId,
    companyId,
    expiresAt: link.expiresAt,
  };
}

let cached: SiteBranchPreviewLinks | null = null;

/** The process-wide preview link service over the shared PrismaClient, constructed lazily. */
export function getSiteBranchPreviewLinks(): SiteBranchPreviewLinks {
  if (!cached) cached = new SiteBranchPreviewLinks(getPrismaClient());
  return cached;
}
