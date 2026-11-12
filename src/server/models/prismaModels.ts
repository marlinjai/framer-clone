import 'server-only';

// src/server/models/prismaModels.ts
//
// The Postgres repository of the model store (ports.ts SiteModelRepository) on the `site_models` table
// (prisma/migrations/20261112200000_site_models). It holds metadata only; the bytes are in object storage.
// NOT wired to any route: until the upload and serving routes are built and enabled (a gated, separate step),
// nothing constructs it.
//
// Isolation. Every query is keyed by the site that owns the models, and, when the repository is made for a
// workspace (`new PrismaSiteModels(client, { workspaceId })`, which the upload route must do with the workspace
// its guard resolved), also by that workspace: a row of another workspace is invisible to every method, and an
// insert for a site of another workspace is refused. The serving route resolves the site from the host alone
// and constructs it without a workspace. A branch has no models of its own (its main site owns them, as for
// images): a branch id is refused, so a caller must resolve the main site first (imageSiteId).
//
// The quota is checked inside the insert, under a transaction-scoped advisory lock per site (the same pattern as
// the site images), so parallel uploads cannot pass it. Rows are never updated except `lastUsedAt`.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { InsertOutcome, SiteModelRecord, SiteModelRepository } from './ports';

export interface ModelScope {
  /** Restrict every method to this workspace. */
  workspaceId?: string;
}

const TX = { timeout: 15_000, maxWait: 5_000 } as const;

type Row = Prisma.SiteModelGetPayload<Record<string, never>>;

const names = (v: Prisma.JsonValue): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function record(r: Row): SiteModelRecord {
  return {
    siteId: r.siteId, sha256: r.sha256, bytes: r.byteSize, triangles: r.triangles, materials: r.materialCount, nodes: r.nodeCount,
    clips: r.clipCount, textures: r.textureCount, extensions: r.extensions, materialNames: names(r.materialNames), nodeNames: names(r.nodeNames),
    uploaderId: r.uploadedBy, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, originalSha256: r.originalSha256, originalBytes: r.originalBytes,
  };
}

export class PrismaSiteModels implements SiteModelRepository {
  constructor(private readonly client: PrismaClient, private readonly scope: ModelScope = {}) {}

  private where(siteId: string): Prisma.SiteModelWhereInput {
    return this.scope.workspaceId ? { siteId, workspaceId: this.scope.workspaceId } : { siteId };
  }

  async find(siteId: string, sha256: string): Promise<SiteModelRecord | null> {
    const row = await this.client.siteModel.findFirst({ where: { ...this.where(siteId), sha256 } });
    return row ? record(row) : null;
  }

  async insertWithinQuota(rec: SiteModelRecord, limits: { servedBytes: number; originalBytes: number }): Promise<InsertOutcome> {
    return this.client.$transaction(async (tx) => {
      // One upload or delete of a site at a time (released when the transaction ends).
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`site_models:${rec.siteId}`}))`;
      const site = await tx.site.findUnique({ where: { id: rec.siteId }, select: { workspaceId: true, tenantGroupId: true, branchOfSiteId: true } });
      if (!site || (this.scope.workspaceId && site.workspaceId !== this.scope.workspaceId)) throw new Error('site_models: no such site');
      if (site.branchOfSiteId) throw new Error('site_models: a branch has no models of its own; use its main site');

      const existing = await tx.siteModel.findUnique({ where: { siteId_sha256: { siteId: rec.siteId, sha256: rec.sha256 } }, select: { id: true } });
      if (existing) return { ok: false, reason: 'exists' } as const;

      const served = await tx.siteModel.aggregate({ where: { siteId: rec.siteId }, _sum: { byteSize: true } });
      if ((served._sum.byteSize ?? 0) + rec.bytes > limits.servedBytes) return { ok: false, reason: 'quota' } as const;

      // An original is shared by the rows that came from the same file: it counts once.
      const held = await tx.$queryRaw<{ total: bigint | null; same: bigint }[]>`
        SELECT COALESCE(SUM(o.original_bytes), 0) AS total,
               COUNT(*) FILTER (WHERE o.original_sha256 = ${rec.originalSha256}) AS same
          FROM (SELECT original_sha256, MAX(original_bytes) AS original_bytes
                  FROM public.site_models WHERE site_id = ${rec.siteId} GROUP BY original_sha256) o`;
      const total = Number(held[0]?.total ?? 0);
      if (Number(held[0]?.same ?? 0) === 0 && total + rec.originalBytes > limits.originalBytes) return { ok: false, reason: 'originals-quota' } as const;

      await tx.siteModel.create({
        data: {
          siteId: rec.siteId, workspaceId: site.workspaceId, tenantGroupId: site.tenantGroupId, sha256: rec.sha256, byteSize: rec.bytes,
          triangles: rec.triangles, materialCount: rec.materials, nodeCount: rec.nodes, clipCount: rec.clips, textureCount: rec.textures,
          extensions: rec.extensions, materialNames: rec.materialNames, nodeNames: rec.nodeNames, originalSha256: rec.originalSha256,
          originalBytes: rec.originalBytes, uploadedBy: rec.uploaderId, createdAt: rec.createdAt, lastUsedAt: rec.lastUsedAt,
        },
      });
      return { ok: true } as const;
    }, TX);
  }

  async touch(siteId: string, sha256: string, at: Date): Promise<void> {
    // Never backwards, and never before the row was created (a CHECK holds it).
    const workspace = this.scope.workspaceId;
    await this.client.$executeRaw`
      UPDATE public.site_models SET last_used_at = GREATEST(last_used_at, (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
       WHERE site_id = ${siteId} AND sha256 = ${sha256} AND (${workspace}::text IS NULL OR workspace_id = ${workspace})`;
  }

  async totalBytes(siteId: string): Promise<number> {
    const sum = await this.client.siteModel.aggregate({ where: this.where(siteId), _sum: { byteSize: true } });
    return sum._sum.byteSize ?? 0;
  }

  async list(siteId: string): Promise<SiteModelRecord[]> {
    const rows = await this.client.siteModel.findMany({ where: this.where(siteId), orderBy: [{ createdAt: 'asc' }, { sha256: 'asc' }] });
    return rows.map(record);
  }

  async delete(siteId: string, sha256: string): Promise<void> {
    // Under the site's lock, so a delete cannot interleave with an insert's quota read.
    await this.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`site_models:${siteId}`}))`;
      await tx.siteModel.deleteMany({ where: { ...this.where(siteId), sha256 } });
    }, TX);
  }
}
