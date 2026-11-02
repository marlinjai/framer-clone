import 'server-only';

// src/server/sites/siteImages.ts
//
// The stored site images (favicon and sharing image, src/lib/site/siteImages.ts)
// in `site_images`, beside the site rows in the public schema. Not in the
// catalogue's `catalog_image`: that table lives in a company's commerce schema,
// which exists only once the catalogue is provisioned, and is keyed by company,
// while every site needs an icon and a site's hosts serve only that site's
// images. The checks on the bytes are the catalogue's (src/lib/images/
// imageHeader.ts).
//
// Adding the same bytes again to a site answers the row already stored (one
// row per site and hash). A site stores at most 100 images and 50 MB; uploads
// and deletes of one site run one at a time under a transaction-scoped
// advisory lock, so concurrent uploads cannot pass the limits.
//
// Rows are never updated. A published revision names an image by its path, so
// an image is deleted only once nothing names it any more: not the settings,
// not a page of the working copy, not any kept revision (deleteSiteImage).
// Deleting the site deletes them all (cascade). Nothing caches these responses
// in front of the app (every framer-clone DNS record is DNS only, custom
// domains must point at the origin's address), so a deleted image stays only in
// the browsers that loaded it, until their copy expires.

import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import {
  MAX_SITE_IMAGES,
  MAX_SITE_IMAGE_TOTAL_BYTES,
  SITE_IMAGE_LIMIT_MESSAGE,
  checkSiteImage,
  siteImagePath,
  type SiteImageContentType,
  type SiteImageKind,
  type SiteImageProblem,
} from '@/lib/site/siteImages';

/** The site an upload belongs to, as the per-project guard resolved it. */
export interface SiteImageOwner {
  id: string;
  workspaceId: string;
  tenantGroupId: string;
}

export interface StoredSiteImage {
  sha256: string;
  contentType: SiteImageContentType;
  byteSize: number;
  width: number;
  height: number;
  /** The public path the settings store: `/site-images/<sha256>.<ext>`. */
  path: string;
}

/** A refused upload: the check's problem, or the per-site limit. */
export class SiteImageError extends Error {
  constructor(
    readonly code: SiteImageProblem['code'] | 'image_limit' | 'image_not_found' | 'image_in_use' | 'image_busy',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SiteImageError';
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

const columns = { sha256: true, contentType: true, byteSize: true, width: true, height: true } as const;

function view(row: { sha256: string; contentType: string; byteSize: number; width: number; height: number }): StoredSiteImage {
  const contentType = row.contentType as SiteImageContentType;
  return { ...row, contentType, path: siteImagePath(row.sha256, contentType) };
}

/**
 * Check the bytes for their use and store them for the site, or answer the row
 * already stored with the same hash (`created: false`). Throws SiteImageError.
 */
export async function storeSiteImage(
  site: SiteImageOwner,
  bytes: Uint8Array,
  kind: SiteImageKind,
  userId: string,
  prisma: PrismaClient = getPrismaClient(),
  limits: SiteImageLimits = SITE_IMAGE_LIMITS,
): Promise<{ image: StoredSiteImage; created: boolean }> {
  const check = checkSiteImage(bytes, kind);
  if (!check.ok) throw new SiteImageError(check.problem.code, check.problem.status, check.problem.message);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return prisma.$transaction(async (tx) => {
    // One upload or delete per site at a time: the count and the bytes below
    // cannot be raced past the limits, and the same file uploaded twice at once
    // finds the first row.
    await lockSiteImages(tx, site.id);
    const existing = await tx.siteImage.findUnique({ where: { siteId_sha256: { siteId: site.id, sha256 } }, select: columns });
    if (existing) return { image: view(existing), created: false };

    const usage = await tx.siteImage.aggregate({ where: { siteId: site.id }, _count: { _all: true }, _sum: { byteSize: true } });
    if (usage._count._all >= limits.maxImages || (usage._sum.byteSize ?? 0) + bytes.byteLength > limits.maxBytes) {
      throw new SiteImageError('image_limit', 409, SITE_IMAGE_LIMIT_MESSAGE);
    }
    const created = await tx.siteImage.create({
      data: {
        id: randomUUID(),
        siteId: site.id,
        workspaceId: site.workspaceId,
        tenantGroupId: site.tenantGroupId,
        sha256,
        contentType: check.contentType,
        byteSize: bytes.byteLength,
        width: check.width,
        height: check.height,
        content: Buffer.from(bytes),
        uploadedBy: userId,
      },
      select: columns,
    });
    return { image: view(created), created: true };
  }, PROJECT_IMAGE_TRANSACTION);
}

/** The per-site limits (the defaults, or smaller ones in a test). */
export interface SiteImageLimits {
  maxImages: number;
  maxBytes: number;
}
export const SITE_IMAGE_LIMITS: SiteImageLimits = { maxImages: MAX_SITE_IMAGES, maxBytes: MAX_SITE_IMAGE_TOTAL_BYTES };

/** A 2 MB insert and a scan of up to 30 revisions both fit in this. */
const PROJECT_IMAGE_TRANSACTION = { timeout: 30_000, maxWait: 5_000 } as const;

/** Serialize the uploads and deletes of one site (released when the transaction ends). */
async function lockSiteImages(tx: Prisma.TransactionClient, siteId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`site_images:${siteId}`}))`;
}

/**
 * Every uploaded image a site still names anywhere it keeps: its settings, its
 * component definitions, every page of the working copy, every kept revision
 * (each one a version a rollback can make live again), its A/B test settings
 * (a variant may name one), and the undo records of the content agent in the
 * site's workspace (an undo may write one back; agent runs carry the workspace,
 * not the site, so every site of the workspace counts them, which can only keep
 * an image longer). A text search for the path, so a field added later is
 * covered without a change here.
 */
async function referencedHashes(tx: Prisma.TransactionClient, siteId: string): Promise<Set<string>> {
  const pattern = 'site-images/([0-9a-f]{64})';
  const rows = await tx.$queryRaw<{ sha256: string }[]>`
    SELECT DISTINCT m[1] AS sha256 FROM (
      SELECT regexp_matches(s.site_settings::text || ' ' || s.components::text, ${pattern}, 'g') AS m
        FROM public.sites s WHERE s.id = ${siteId}
      UNION ALL
      SELECT regexp_matches(p.snapshot::text, ${pattern}, 'g') FROM public.site_pages p WHERE p.site_id = ${siteId}
      UNION ALL
      SELECT regexp_matches(r.document::text, ${pattern}, 'g') FROM public.site_revisions r WHERE r.site_id = ${siteId}
      UNION ALL
      SELECT regexp_matches(e.config::text, ${pattern}, 'g')
        FROM public.site_experiments e WHERE e.site_id = ${siteId} AND e.config IS NOT NULL
      UNION ALL
      SELECT regexp_matches(c.inverse_payload::text, ${pattern}, 'g')
        FROM public.agent_changes c
        JOIN public.agent_runs ar ON ar.id = c.run_id
        JOIN public.sites s ON s.workspace_id = ar.workspace_id
       WHERE s.id = ${siteId}
    ) found`;
  return new Set(rows.map((r) => r.sha256));
}

export interface ListedSiteImage extends StoredSiteImage {
  /** True while the settings, a page or a kept published version names it: it cannot be deleted. */
  inUse: boolean;
  createdAt: string;
}

/** The site's uploaded images, newest first, with what is in use and the totals against the limits. */
export async function listSiteImages(
  siteId: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<{ items: ListedSiteImage[]; totalBytes: number; maxImages: number; maxBytes: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.siteImage.findMany({
      where: { siteId },
      select: { ...columns, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const used = rows.length > 0 ? await referencedHashes(tx, siteId) : new Set<string>();
    return {
      items: rows.map((r) => ({ ...view(r), inUse: used.has(r.sha256), createdAt: r.createdAt.toISOString() })),
      totalBytes: rows.reduce((sum, r) => sum + r.byteSize, 0),
      maxImages: MAX_SITE_IMAGES,
      maxBytes: MAX_SITE_IMAGE_TOTAL_BYTES,
    };
  }, { ...PROJECT_IMAGE_TRANSACTION, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/**
 * Delete an uploaded image nothing names any more (no setting, no page, no
 * kept revision). Takes the site row first, as publish does, and runs
 * serializable like save, so neither can start naming the image while it goes:
 * the save then finds it missing and refuses (SiteImageMissingError).
 * Throws SiteImageError: 404 `image_not_found`, 409 `image_in_use`, 409
 * `image_busy` when a concurrent save or publish won (try again).
 */
export async function deleteSiteImage(siteId: string, sha256: string, prisma: PrismaClient = getPrismaClient()): Promise<void> {
  if (!SHA256.test(sha256)) throw new SiteImageError('image_not_found', 404, 'This image does not exist on this site.');
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${siteId} FOR UPDATE`;
      await lockSiteImages(tx, siteId);
      const row = await tx.siteImage.findUnique({ where: { siteId_sha256: { siteId, sha256 } }, select: { id: true } });
      if (!row) throw new SiteImageError('image_not_found', 404, 'This image does not exist on this site.');
      if ((await referencedHashes(tx, siteId)).has(sha256)) {
        throw new SiteImageError(
          'image_in_use',
          409,
          'This image is still in use: by the settings, a page, or a published version kept for rollback. Remove it there first; a published version keeps it until it is no longer kept.',
        );
      }
      await tx.siteImage.delete({ where: { id: row.id } });
    }, { ...PROJECT_IMAGE_TRANSACTION, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new SiteImageError('image_busy', 409, 'The site changed while the image was being deleted. Nothing was deleted; try again.');
    }
    throw err;
  }
}

/** One stored image of the site with its bytes, or null (unknown, malformed or another site's hash). */
export async function readSiteImage(
  siteId: string,
  sha256: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<{ contentType: SiteImageContentType; bytes: Uint8Array } | null> {
  if (!SHA256.test(sha256)) return null;
  const row = await prisma.siteImage.findUnique({
    where: { siteId_sha256: { siteId, sha256 } },
    select: { contentType: true, content: true },
  });
  return row ? { contentType: row.contentType as SiteImageContentType, bytes: new Uint8Array(row.content) } : null;
}

/** The content type of one stored image of the site (without its bytes), or null. */
export async function readSiteImageType(
  siteId: string,
  sha256: string,
  prisma: PrismaClient = getPrismaClient(),
): Promise<SiteImageContentType | null> {
  if (!SHA256.test(sha256)) return null;
  const row = await prisma.siteImage.findUnique({ where: { siteId_sha256: { siteId, sha256 } }, select: { contentType: true } });
  return row ? (row.contentType as SiteImageContentType) : null;
}

/**
 * The response headers of a stored image. The bytes behind a hash never change
 * and a row is deleted only once nothing names it, so the hash is the ETag and
 * the response may be kept for a year. Only checked bytes are served, with
 * nosniff and a content security policy that lets nothing load or run.
 */
export function siteImageHeaders(sha256: string, contentType: string, visibility: 'public' | 'private'): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': `${visibility}, max-age=31536000, immutable`,
    etag: `"${sha256}"`,
    'x-content-type-options': 'nosniff',
    // A published image is public: sharing previews and other origins may load it. The editor's copy stays same-origin.
    'cross-origin-resource-policy': visibility === 'public' ? 'cross-origin' : 'same-origin',
    'content-security-policy': "default-src 'none'; sandbox",
  };
}

/** True when an If-None-Match header names this hash (or `*`). */
export function matchesEtag(ifNoneMatch: string | null, sha256: string): boolean {
  const known = (ifNoneMatch ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
  return known.includes('*') || known.includes(`"${sha256}"`);
}
