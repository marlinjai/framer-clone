import 'server-only';

// src/server/models/prismaModels.ts
//
// The Postgres repository of the model store (ports.ts SiteModelRepository) and the Postgres implementation of the
// upload and blob-cleanup coordination protocol (coordination.ts ModelCoordinator) on the `site_models` and
// `model_blob_tombstones` tables (prisma/migrations/20261112200000_site_models and 20261112300000_site_model_coordination).
// It holds metadata only; the bytes are in object storage.
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
// Rows are created only by `beginUpload`, as PENDING, under a transaction-scoped advisory lock per site (the quota is a
// sum over the site's rows, as for the site images) and then per blob; every protocol step is one READ COMMITTED
// transaction with a lock timeout and holds no lock across storage I/O. Rows are never updated except `lastUsedAt` and the
// promotion to ready. The cleanup methods (`beginDelete` and the rest) are system level: they count rows across ALL sites
// and ignore any workspace scope, so construct the repository WITHOUT a workspace to run them.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { BeginDeleteOutcome, BeginUploadOutcome, ModelCoordinator } from './coordination';
import type { SiteModelRecord, SiteModelRepository } from './ports';

export interface ModelScope {
  /** Restrict every method to this workspace. */
  workspaceId?: string;
}

// READ COMMITTED, never a snapshot level: the protocol's counts and checks must see what the other side committed while this
// transaction waited for a lock (a REPEATABLE READ snapshot would predate the wait and miss it). A lock wait gives up after
// `LOCK_TIMEOUT` so a stuck holder surfaces as an error (the caller keeps the blob or answers retry) and never wedges.
const TX = { timeout: 15_000, maxWait: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
const LOCK_TIMEOUT = '5s';

const blobLock = (key: string) => `model_blob:${key}`;
const KEY = /^(served|original)\/([0-9a-f]{64})$/;

type Row = Prisma.SiteModelGetPayload<Record<string, never>>;

const names = (v: Prisma.JsonValue): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function record(r: Row): SiteModelRecord {
  return {
    siteId: r.siteId, sha256: r.sha256, bytes: r.byteSize, triangles: r.triangles, materials: r.materialCount, nodes: r.nodeCount,
    clips: r.clipCount, textures: r.textureCount, extensions: r.extensions, materialNames: names(r.materialNames), nodeNames: names(r.nodeNames),
    uploaderId: r.uploadedBy, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, originalSha256: r.originalSha256, originalBytes: r.originalBytes,
  };
}

export class PrismaSiteModels implements SiteModelRepository, ModelCoordinator {
  constructor(private readonly client: PrismaClient, private readonly scope: ModelScope = {}) {}

  private where(siteId: string): Prisma.SiteModelWhereInput {
    return this.scope.workspaceId ? { siteId, workspaceId: this.scope.workspaceId } : { siteId };
  }

  async find(siteId: string, sha256: string): Promise<SiteModelRecord | null> {
    const row = await this.client.siteModel.findFirst({ where: { ...this.where(siteId), sha256, state: 'ready' } });
    return row ? record(row) : null;
  }

  /**
   * Step 1 of an upload (coordination.ts). One READ COMMITTED transaction: the SITE lock first (the quota is a sum over the
   * site's rows), then the served and original BLOB locks in sorted order; refuses while a tombstone exists on either blob
   * (expired or not); inserts the row as PENDING. Pending rows count toward the quota.
   */
  async beginUpload({ record: rec, limits, attempt, now, pendingTtlMs }: Parameters<ModelCoordinator['beginUpload']>[0]): Promise<BeginUploadOutcome> {
    const keys = [`served/${rec.sha256}`, `original/${rec.originalSha256}`].sort();
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
      // One upload or delete of a site at a time (released when the transaction ends), then the blobs, in one global order.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`site_models:${rec.siteId}`}))`;
      for (const key of keys) await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${blobLock(key)}))`;
      const site = await tx.site.findUnique({ where: { id: rec.siteId }, select: { workspaceId: true, tenantGroupId: true, branchOfSiteId: true } });
      if (!site || (this.scope.workspaceId && site.workspaceId !== this.scope.workspaceId)) throw new Error('site_models: no such site');
      if (site.branchOfSiteId) throw new Error('site_models: a branch has no models of its own; use its main site');

      if (await tx.modelBlobTombstone.findFirst({ where: { key: { in: keys } }, select: { key: true } })) return { ok: false, reason: 'busy' } as const;

      const until = new Date(now.getTime() + pendingTtlMs);
      const existing = await tx.siteModel.findUnique({ where: { siteId_sha256: { siteId: rec.siteId, sha256: rec.sha256 } }, select: { id: true, state: true, pendingUntil: true } });
      let takenOver = false;
      if (existing) {
        if (existing.state === 'ready') return { ok: false, reason: 'exists' } as const;
        if (existing.pendingUntil && existing.pendingUntil.getTime() > now.getTime()) return { ok: false, reason: 'in-progress' } as const;
        // An expired pending row is replaced WHOLE (its original hash and size may differ), then checked like a new row.
        await tx.siteModel.delete({ where: { id: existing.id } });
        takenOver = true;
      }

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
          state: 'pending', attempt, pendingUntil: until,
        },
      });
      return { ok: true, attempt, takenOver } as const;
    }, TX);
  }

  /** Step 3: promote THIS attempt's pending row (fenced by its token); false if it is no longer this attempt's. */
  async markReady(siteId: string, sha256: string, attempt: string, at: Date): Promise<boolean> {
    const workspace = this.scope.workspaceId;
    const n = await this.client.$executeRaw`
      UPDATE public.site_models
         SET state = 'ready', pending_until = NULL, attempt = NULL,
             last_used_at = GREATEST(last_used_at, (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
       WHERE site_id = ${siteId} AND sha256 = ${sha256} AND state = 'pending' AND attempt = ${attempt}
         AND (${workspace}::text IS NULL OR workspace_id = ${workspace})`;
    return n === 1;
  }

  async abandonUpload(siteId: string, sha256: string, attempt: string): Promise<boolean> {
    const r = await this.client.siteModel.deleteMany({ where: { ...this.where(siteId), sha256, state: 'pending', attempt } });
    return r.count === 1;
  }

  // ---- the cleanup side: system level, never scoped to a workspace (blobs are shared across sites and companies) ----

  /** A workspace-scoped repository (the upload route's) must never run cleanup: it counts, tombstones and reaps across ALL sites. */
  private requireSystemScope() {
    if (this.scope.workspaceId) throw new Error('model cleanup is system level: construct the repository without a workspace');
  }

  async beginDelete({ key, attempt, now, leaseMs }: Parameters<ModelCoordinator['beginDelete']>[0]): Promise<BeginDeleteOutcome> {
    this.requireSystemScope();
    const m = KEY.exec(key);
    if (!m) throw new Error('model blob key outside the store namespaces');
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${blobLock(key)}))`;
      // ANY row of ANY site, pending or ready, references the blob.
      const refs = m[1] === 'served'
        ? await tx.siteModel.count({ where: { sha256: m[2] } })
        : await tx.siteModel.count({ where: { originalSha256: m[2] } });
      const t = await tx.modelBlobTombstone.findUnique({ where: { key } });
      if (refs > 0) {
        // A tombstone on a referenced blob protects nothing and would block uploads for ever: drop it once it has expired.
        if (t && t.expiresAt.getTime() <= now.getTime()) await tx.modelBlobTombstone.delete({ where: { key } });
        return { kind: 'kept', reason: 'referenced' } as const;
      }
      if (t && t.expiresAt.getTime() > now.getTime()) return { kind: 'busy' } as const;
      const expiresAt = new Date(now.getTime() + leaseMs);
      if (t) await tx.modelBlobTombstone.update({ where: { key }, data: { attempt, expiresAt } });
      else await tx.modelBlobTombstone.create({ data: { key, attempt, expiresAt } });
      return { kind: 'started', attempt, resumed: Boolean(t) } as const;
    }, TX);
  }

  async completeDelete(key: string, attempt: string): Promise<boolean> {
    this.requireSystemScope();
    const r = await this.client.modelBlobTombstone.deleteMany({ where: { key, attempt } });
    return r.count === 1;
  }

  async expiredTombstones(now: Date, limit: number): Promise<string[]> {
    this.requireSystemScope();
    const rows = await this.client.modelBlobTombstone.findMany({ where: { expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: limit, select: { key: true } });
    return rows.map((r) => r.key);
  }

  async reapPendingUploads(now: Date, limit: number): Promise<{ siteId: string; sha256: string }[]> {
    this.requireSystemScope();
    const rows = await this.client.$queryRaw<{ site_id: string; sha256: string }[]>`
      DELETE FROM public.site_models
       WHERE id IN (SELECT id FROM public.site_models
                     WHERE state = 'pending' AND pending_until <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
                     ORDER BY pending_until LIMIT ${limit} FOR UPDATE SKIP LOCKED)
         AND state = 'pending'
      RETURNING site_id, sha256`;
    return rows.map((r) => ({ siteId: r.site_id, sha256: r.sha256 }));
  }

  async touch(siteId: string, sha256: string, at: Date): Promise<void> {
    // Never backwards, and never before the row was created (a CHECK holds it).
    const workspace = this.scope.workspaceId;
    await this.client.$executeRaw`
      UPDATE public.site_models SET last_used_at = GREATEST(last_used_at, (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
       WHERE site_id = ${siteId} AND sha256 = ${sha256} AND state = 'ready' AND (${workspace}::text IS NULL OR workspace_id = ${workspace})`;
  }

  async totalBytes(siteId: string): Promise<number> {
    const sum = await this.client.siteModel.aggregate({ where: this.where(siteId), _sum: { byteSize: true } });
    return sum._sum.byteSize ?? 0;
  }

  async list(siteId: string): Promise<SiteModelRecord[]> {
    const rows = await this.client.siteModel.findMany({ where: { ...this.where(siteId), state: 'ready' }, orderBy: [{ createdAt: 'asc' }, { sha256: 'asc' }] });
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
