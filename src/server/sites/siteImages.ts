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
// row per site and hash, also under a concurrent upload of the same file).
// Rows are never updated or deleted here: a published revision names an image
// by its path, so the bytes must outlive any change of the settings. Deleting
// the site deletes them (cascade).

import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import {
  MAX_SITE_IMAGES,
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
    readonly code: SiteImageProblem['code'] | 'image_limit',
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
): Promise<{ image: StoredSiteImage; created: boolean }> {
  const check = checkSiteImage(bytes, kind);
  if (!check.ok) throw new SiteImageError(check.problem.code, check.problem.status, check.problem.message);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const existing = await prisma.siteImage.findUnique({ where: { siteId_sha256: { siteId: site.id, sha256 } }, select: columns });
  if (existing) return { image: view(existing), created: false };

  const count = await prisma.siteImage.count({ where: { siteId: site.id } });
  if (count >= MAX_SITE_IMAGES) {
    throw new SiteImageError(
      'image_limit',
      409,
      `This site already stores the most images allowed (${MAX_SITE_IMAGES}). Use an image uploaded before or enter an https address instead.`,
    );
  }
  try {
    const created = await prisma.siteImage.create({
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
  } catch (err) {
    // A concurrent upload of the same file won the unique (site, hash): answer its row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.siteImage.findUniqueOrThrow({ where: { siteId_sha256: { siteId: site.id, sha256 } }, select: columns });
      return { image: view(winner), created: false };
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
 * and the row is never deleted while the site exists, so the hash is the ETag
 * and the response may be kept for a year. Only checked bytes are served, with
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
